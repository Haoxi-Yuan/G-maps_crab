/**
 * Browser-side extraction script for POI monitoring.
 * Injected via page.evaluate() to extract 4 monitoring fields:
 * rating, reviewCount, openingHours, popularTimes
 *
 * Adapted from google-maps-scraper-pipeline.js (v3.4) but
 * stripped down to only the fields needed for change detection.
 */
(function() {
    'use strict';

    const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const DAY_NAMES_SUN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const DAY_NAME_SET = new Set(DAY_NAMES);

    const result = {
        rating: null,
        reviewCount: null,
        openingHours: null,
        popularTimes: null,
        name: null,
        pageStatus: 'ok',
        error: null
    };

    // --- Page status detection ---

    const body = document.body ? document.body.innerText : '';
    if (body.includes('The web address is not found') ||
        body.includes('didn\'t match any location') ||
        body.includes('page you requested was not found')) {
        result.pageStatus = 'not_found';
        return result;
    }

    // Get expected placeId from scanner (set via window.__expectedPlaceId)
    var expectedPlaceId = window.__expectedPlaceId || null;

    // Try to get business name from h1 first
    var h1 = document.querySelector('h1');
    if (h1) {
        result.name = h1.innerText.trim();
    }

    // Verify page loaded by checking if expected placeId exists in page data
    // This is more reliable than h1 which may render late in Google Maps SPA
    var pageHasPlaceData = false;
    if (expectedPlaceId) {
        // Check URL for placeId (Google Maps redirects to canonical URL with placeId)
        var currentUrl = window.location.href;
        if (currentUrl.indexOf(expectedPlaceId) !== -1) {
            pageHasPlaceData = true;
        }
        // Check APP_STATE for placeId
        var appStateRaw = window.APP_INITIALIZATION_STATE || window.__APP_INITIALIZATION_STATE;
        if (!pageHasPlaceData && appStateRaw) {
            try {
                var stateStr = JSON.stringify(appStateRaw);
                if (stateStr.indexOf(expectedPlaceId) !== -1) {
                    pageHasPlaceData = true;
                }
            } catch(e) {
                // JSON.stringify might fail on circular refs, try string conversion
                var stateText = String(appStateRaw);
                if (stateText.indexOf(expectedPlaceId) !== -1) {
                    pageHasPlaceData = true;
                }
            }
        }
        // Also check if URL has any resolved placeId (hex format after redirect)
        if (!pageHasPlaceData) {
            var urlPlaceIdCheck = currentUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) ||
                currentUrl.match(/place_id:([A-Za-z0-9_-]+)/) ||
                currentUrl.match(/!1s(ChIJ[^!]+)/);
            if (urlPlaceIdCheck) {
                pageHasPlaceData = true;
            }
        }
    } else {
        // No expected placeId provided, fall back to h1 check
        pageHasPlaceData = !!result.name;
    }

    // If page doesn't have place data and no name, it truly didn't load
    if (!pageHasPlaceData && !result.name) {
        result.pageStatus = 'error';
        result.error = 'Page did not load - placeId not found in page data';
        return result;
    }

    // Try additional name sources if h1 failed but page has data
    if (!result.name) {
        var nameEl = document.querySelector('.DUwDvf, .fontHeadlineLarge');
        if (nameEl) result.name = nameEl.innerText.trim();
    }
    if (!result.name && document.title) {
        var titleMatch = document.title.match(/^(.+?)(?:\s*[-\u2013\u2014]\s*Google\s*Maps?)?$/i);
        if (titleMatch && titleMatch[1] && titleMatch[1].length > 1 && titleMatch[1].length < 200) {
            result.name = titleMatch[1].trim();
        }
    }

    // --- Deep search utility ---

    function deepSearch(obj, condition, maxDepth, currentDepth) {
        if (maxDepth === undefined) maxDepth = 20;
        if (currentDepth === undefined) currentDepth = 0;
        if (currentDepth > maxDepth) return [];
        var results = [];
        if (obj === null || obj === undefined) return results;
        if (condition(obj)) results.push(obj);
        if (typeof obj === 'object') {
            for (var key in obj) {
                if (obj.hasOwnProperty(key)) {
                    var found = deepSearch(obj[key], condition, maxDepth, currentDepth + 1);
                    for (var i = 0; i < found.length; i++) results.push(found[i]);
                }
            }
        }
        return results;
    }

    function deepSearchFirstAvailable(roots, condition) {
        for (var i = 0; i < roots.length; i++) {
            var results = deepSearch(roots[i], condition);
            if (results.length > 0) return results;
        }
        return [];
    }

    // --- Candidate detection functions ---

    function isOpeningHoursArrayCandidate(obj) {
        if (!Array.isArray(obj)) return false;
        if (obj.length !== 7) return false;
        return obj.every(function(item) {
            return Array.isArray(item) && DAY_NAME_SET.has(item[0]);
        });
    }

    function isFlatHoursArray(arr) {
        if (!Array.isArray(arr) || arr.length < 14) return false;
        var dayCount = 0;
        var hasHours = false;
        for (var i = 0; i < arr.length; i++) {
            if (typeof arr[i] === 'string' && DAY_NAME_SET.has(arr[i])) {
                dayCount++;
                var next = arr[i + 1];
                if (typeof next === 'string' && !DAY_NAME_SET.has(next)) hasHours = true;
                var nextArr = arr[i + 2];
                if (Array.isArray(nextArr) && nextArr.length >= 2 &&
                    typeof nextArr[0] === 'number' && typeof nextArr[1] === 'number') {
                    hasHours = true;
                }
            }
        }
        return dayCount >= 6 && hasHours;
    }

    function isHourlyDataArray(arr) {
        return Array.isArray(arr) && arr.some(function(hour) {
            return Array.isArray(hour) && hour.length >= 2 &&
                typeof hour[0] === 'number' && typeof hour[1] === 'number';
        });
    }

    function isPopularTimesArrayCandidate(obj) {
        if (!Array.isArray(obj) || obj.length !== 7) return false;
        return obj.every(function(day) {
            if (!Array.isArray(day)) return false;
            if (isHourlyDataArray(day)) return true;
            if (Array.isArray(day[1]) && isHourlyDataArray(day[1])) return true;
            return false;
        });
    }

    // --- Parsing functions ---

    function parseWeeklyHoursFromArray(hoursData) {
        if (!Array.isArray(hoursData)) return [];
        var weekly = [];
        for (var d = 0; d < hoursData.length; d++) {
            var dayData = hoursData[d];
            if (!Array.isArray(dayData) || dayData.length < 1) continue;
            var dayName = dayData[0];
            if (!DAY_NAME_SET.has(dayName)) continue;
            var dayEntry = { day: dayName };

            if (typeof dayData[1] === 'string') dayEntry.hours = dayData[1];

            var hoursInfo = dayData[3];
            if (!hoursInfo && Array.isArray(dayData[1])) hoursInfo = dayData[1];
            if (!hoursInfo && Array.isArray(dayData[2])) hoursInfo = dayData[2];

            if (Array.isArray(hoursInfo)) {
                if (hoursInfo.length === 2 && typeof hoursInfo[0] === 'number' && typeof hoursInfo[1] === 'number') {
                    dayEntry.openHour = hoursInfo[0];
                    dayEntry.closeHour = hoursInfo[1];
                } else {
                    var timeData = hoursInfo[0];
                    if (Array.isArray(timeData)) {
                        if (timeData[0] === 'Closed') {
                            dayEntry.hours = 'Closed';
                        } else {
                            if (!dayEntry.hours && typeof timeData[0] === 'string') dayEntry.hours = timeData[0];
                            if (timeData.length > 1 && Array.isArray(timeData[1]) && timeData[1].length >= 2) {
                                if (Array.isArray(timeData[1][0]) && timeData[1][0].length > 0) dayEntry.openHour = timeData[1][0][0];
                                if (Array.isArray(timeData[1][1]) && timeData[1][1].length > 0) dayEntry.closeHour = timeData[1][1][0];
                            }
                        }
                    }
                }
            }

            if (!dayEntry.hours) {
                for (var i = 1; i < dayData.length; i++) {
                    if (typeof dayData[i] === 'string' && dayData[i].length <= 80) {
                        dayEntry.hours = dayData[i];
                        break;
                    }
                }
            }

            var hasTime = typeof dayEntry.hours === 'string' ||
                dayEntry.openHour !== undefined || dayEntry.closeHour !== undefined;
            if (hasTime) weekly.push(dayEntry);
        }
        return weekly;
    }

    function parseWeeklyHoursFromFlatArray(arr) {
        if (!Array.isArray(arr)) return [];
        var weekly = [];
        for (var i = 0; i < arr.length; i++) {
            var dayName = arr[i];
            if (!DAY_NAME_SET.has(dayName)) continue;
            var dayEntry = { day: dayName };
            if (typeof arr[i + 1] === 'string' && !DAY_NAME_SET.has(arr[i + 1])) {
                dayEntry.hours = arr[i + 1];
            }
            if (Array.isArray(arr[i + 2]) && arr[i + 2].length >= 2 &&
                typeof arr[i + 2][0] === 'number' && typeof arr[i + 2][1] === 'number') {
                dayEntry.openHour = arr[i + 2][0];
                dayEntry.closeHour = arr[i + 2][1];
            }
            var hasTime = typeof dayEntry.hours === 'string' ||
                dayEntry.openHour !== undefined || dayEntry.closeHour !== undefined;
            if (hasTime) weekly.push(dayEntry);
        }
        return weekly;
    }

    function parsePopularTimesWeek(weekData) {
        if (!Array.isArray(weekData) || weekData.length !== 7) return [];
        var weekly = [];
        for (var dayIdx = 0; dayIdx < weekData.length; dayIdx++) {
            var dayData = weekData[dayIdx];
            if (!Array.isArray(dayData)) continue;
            var directHourly = isHourlyDataArray(dayData);
            var hourlyDataRaw = null;
            if (directHourly) {
                hourlyDataRaw = dayData;
            } else if (Array.isArray(dayData[1]) && isHourlyDataArray(dayData[1])) {
                hourlyDataRaw = dayData[1];
            }
            if (!hourlyDataRaw) continue;
            var dayInfo = { day: DAY_NAMES_SUN[dayIdx], hourlyData: [] };
            for (var h = 0; h < hourlyDataRaw.length; h++) {
                var hourInfo = hourlyDataRaw[h];
                if (!Array.isArray(hourInfo) || hourInfo.length < 2) continue;
                var hourEntry = { hour: hourInfo[0], popularity: hourInfo[1] };
                if (hourInfo.length > 4 && hourInfo[4]) {
                    hourEntry.timeLabel = String(hourInfo[4]).replace(/\u202f/g, ' ');
                }
                dayInfo.hourlyData.push(hourEntry);
            }
            if (dayInfo.hourlyData.length > 0) weekly.push(dayInfo);
        }
        return weekly;
    }

    function selectBestParsed(candidates, parser) {
        var best = [];
        if (!Array.isArray(candidates)) return best;
        for (var i = 0; i < candidates.length; i++) {
            var parsed = parser(candidates[i]);
            if (parsed.length > best.length) best = parsed;
        }
        return best;
    }

    // --- Scope finding (simplified from scraper) ---

    function createStringMatchPredicate(target, exact) {
        if (!target) return function() { return false; };
        var normalized = String(target).toLowerCase();
        return function(value) {
            if (typeof value !== 'string') return false;
            var val = value.toLowerCase();
            return exact ? val === normalized : val.includes(normalized);
        };
    }

    function findScopesByPredicate(root, predicate, maxDepth) {
        if (maxDepth === undefined) maxDepth = 12;
        var scopes = [];
        var visited = new WeakSet();
        function walk(node, depth) {
            if (!node || depth > maxDepth || typeof node !== 'object') return;
            if (visited.has(node)) return;
            visited.add(node);
            var matched = false;
            if (Array.isArray(node)) {
                for (var i = 0; i < node.length; i++) {
                    if (predicate(node[i])) { matched = true; break; }
                }
            } else {
                for (var key in node) {
                    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
                    if (predicate(node[key])) { matched = true; break; }
                }
            }
            if (matched) scopes.push(node);
            if (Array.isArray(node)) {
                for (var j = 0; j < node.length; j++) walk(node[j], depth + 1);
            } else {
                for (var k in node) {
                    if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
                    walk(node[k], depth + 1);
                }
            }
        }
        walk(root, 0);
        return scopes;
    }

    function scoreScope(scope) {
        var opening = deepSearch(scope, isOpeningHoursArrayCandidate).length;
        var flat = deepSearch(scope, isFlatHoursArray).length;
        var popular = deepSearch(scope, isPopularTimesArrayCandidate).length;
        return opening * 6 + flat * 4 + popular * 6;
    }

    function pickBestScope(appState, placeId, businessName) {
        if (!appState || typeof appState !== 'object') return null;
        var scopes = [];
        if (placeId) {
            var pp = createStringMatchPredicate(placeId, true);
            scopes = scopes.concat(findScopesByPredicate(appState, pp));
        }
        if (businessName) {
            var np = createStringMatchPredicate(businessName, false);
            scopes = scopes.concat(findScopesByPredicate(appState, np));
        }
        if (scopes.length === 0) return null;
        var unique = [];
        var seen = new WeakSet();
        for (var i = 0; i < scopes.length; i++) {
            if (!scopes[i] || typeof scopes[i] !== 'object') continue;
            if (seen.has(scopes[i])) continue;
            seen.add(scopes[i]);
            unique.push(scopes[i]);
        }
        var best = null;
        var bestScore = -Infinity;
        for (var j = 0; j < unique.length; j++) {
            var score = scoreScope(unique[j]);
            if (score > bestScore) {
                bestScore = score;
                best = unique[j];
            }
        }
        return best || unique[0];
    }

    // --- Parse Place ID from URL ---

    function parsePlaceIdFromUrl(url) {
        if (!url) return null;
        var match = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
        if (match) return match[1];
        match = url.match(/1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
        if (match) return match[1];
        match = url.match(/place_id:([A-Za-z0-9_-]+)/);
        if (match) return match[1];
        match = url.match(/!1s(ChIJ[^!]+)/);
        if (match) return decodeURIComponent(match[1]);
        return null;
    }

    // --- Main extraction ---

    try {
        var appState = window.APP_INITIALIZATION_STATE || window.__APP_INITIALIZATION_STATE;
        if (!appState) {
            // Fallback to DOM-only extraction
            extractFromDOM();
            return result;
        }

        // DOM first for rating and reviewCount (most reliable)
        // APP_STATE deep search for numbers is too noisy (integers 1-5 appear everywhere)
        extractFromDOM();

        var urlPlaceId = parsePlaceIdFromUrl(window.location.href);
        var scopeRoot = pickBestScope(appState, urlPlaceId, result.name);
        var searchRoots = scopeRoot && scopeRoot !== appState ? [scopeRoot, appState] : [appState];

        // APP_STATE fallback for rating (only if DOM failed)
        if (result.rating === null) {
            var ratingCandidates = deepSearchFirstAvailable(searchRoots, function(obj) {
                if (typeof obj !== 'number' || obj < 1 || obj > 5) return false;
                var rounded = Math.round(obj * 10) / 10;
                return Math.abs(obj - rounded) < 0.0001;
            });
            if (ratingCandidates.length > 0) {
                // Prefer decimal ratings (4.3, 4.6) over integers (1, 2, 3) to avoid noise
                var decimalRatings = ratingCandidates.filter(function(r) { return r % 1 !== 0; });
                result.rating = decimalRatings[0] || ratingCandidates[0];
            }
        }

        // APP_STATE fallback for reviewCount (only if DOM failed)
        // Locale-independent: match formatted numbers with comma or dot separators
        if (result.reviewCount === null) {
            var reviewCountCandidates = deepSearchFirstAvailable(searchRoots, function(obj) {
                if (typeof obj !== 'string') return false;
                var trimmed = obj.trim();
                // Match: "1,234" or "1.234" or "12345" (at least 1 digit, no letters)
                return /^[\d][,.\d]*$/.test(trimmed) && trimmed.replace(/[\D]/g, '').length >= 1;
            });
            if (reviewCountCandidates.length > 0) {
                var bestCount = null;
                for (var rc = 0; rc < reviewCountCandidates.length; rc++) {
                    var parsed = parseInt(reviewCountCandidates[rc].replace(/,/g, ''), 10);
                    if (!isNaN(parsed) && (bestCount === null || parsed > bestCount)) {
                        bestCount = parsed;
                    }
                }
                result.reviewCount = bestCount;
            }
        }

        // Extract opening hours (APP_STATE only, DOM doesn't have this)
        var openingHoursArrays = deepSearchFirstAvailable(searchRoots, isOpeningHoursArrayCandidate);
        var weeklyHours = selectBestParsed(openingHoursArrays, parseWeeklyHoursFromArray);
        if (weeklyHours.length === 0) {
            var flatArrays = deepSearchFirstAvailable(searchRoots, isFlatHoursArray);
            weeklyHours = selectBestParsed(flatArrays, parseWeeklyHoursFromFlatArray);
        }
        if (weeklyHours.length > 0) {
            result.openingHours = { weeklyHours: weeklyHours };
        }

        // Extract popular times (APP_STATE only, DOM doesn't have this)
        var popularTimesArrays = deepSearchFirstAvailable(searchRoots, isPopularTimesArrayCandidate);
        var popularWeek = selectBestParsed(popularTimesArrays, parsePopularTimesWeek);
        if (popularWeek.length > 0) {
            result.popularTimes = { weeklyData: popularWeek };
        }

    } catch (e) {
        result.error = 'Extraction error: ' + e.message;
        extractFromDOM();
    }

    function extractFromDOM() {
        // Rating from star aria-label
        if (result.rating === null) {
            var ratingEl = document.querySelector('[role="img"][aria-label*="star"]');
            if (ratingEl) {
                var match = (ratingEl.getAttribute('aria-label') || '').match(/([\d.]+)\s*star/i);
                if (match) result.rating = parseFloat(match[1]);
            }
        }
        // Review count - multiple strategies
        if (result.reviewCount === null) {
            // Strategy 1: Find button/element with text matching "N reviews"
            var allButtons = document.querySelectorAll('button, span, a');
            for (var bi = 0; bi < allButtons.length; bi++) {
                var btnText = allButtons[bi].textContent.trim();
                var revMatch = btnText.match(/^([\d,]+)\s+reviews?$/i);
                if (revMatch) {
                    var val = parseInt(revMatch[1].replace(/,/g, ''), 10);
                    if (!isNaN(val) && val > 0) {
                        result.reviewCount = val;
                        break;
                    }
                }
            }
            // Strategy 2: aria-label "More reviews (N)"
            if (result.reviewCount === null) {
                var moreBtn = document.querySelector('button[aria-label^="More reviews"]');
                if (moreBtn) {
                    var moreMatch = (moreBtn.getAttribute('aria-label') || '').match(/([\d,]+)/);
                    if (moreMatch) {
                        var moreVal = parseInt(moreMatch[1].replace(/,/g, ''), 10);
                        if (!isNaN(moreVal)) result.reviewCount = moreVal;
                    }
                }
            }
            // Strategy 3: Search body text for "N reviews" pattern
            if (result.reviewCount === null) {
                var bodyText = document.body ? document.body.innerText : '';
                var bodyMatch = bodyText.match(/([\d,]+)\s+reviews?/i);
                if (bodyMatch) {
                    var bodyVal = parseInt(bodyMatch[1].replace(/,/g, ''), 10);
                    if (!isNaN(bodyVal) && bodyVal > 0) result.reviewCount = bodyVal;
                }
            }
        }
    }

    return result;
})();
