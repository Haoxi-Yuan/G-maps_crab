/**
 * Google Maps Data Scraper Pipeline v3.4
 *
 * Strategy: Extract raw data first, then clean
 * Based on original scraper logic with improvements
 */

(function() {
    'use strict';

    console.log('=== Google Maps Scraper Pipeline v3.4 ===');
    console.log('Strategy: Extract first, then clean\n');

    const ADDRESS_HINT_RE = /(street|st\b|road|rd\b|avenue|ave\b|drive|dr\b|lane|ln\b|boulevard|blvd\b|way\b|circle|cir\b|court|ct\b|place|pl\b|square|sq\b|parkway|pkwy\b|highway|hwy\b|jalan|lorong|plaza|mall|center|centre|park|building|blk|block|suite|unit|floor|level|#)/i;
    const CATEGORY_HINT_RE = /(restaurant|cafe|hospital|clinic|shop|store|mall|hotel|bank|school|park|museum|gym|salon|spa|bar|hawker|stall|food|eatery|diner|bistro|grill|kitchen|bakery|pharmacy|supermarket|market|station|terminal|airport|beach|garden|trail|boardwalk|viewpoint|library|temple|church|mosque|shrine|theater|theatre)/i;
    const CATEGORY_BLACKLIST_RE = /(review|open|closed|direction|website|phone|address|rating)/i;
    const PRICE_RE = /^[$\u20ac\u00a3\u00a5]{1,4}$|^[$\u20ac\u00a3\u00a5]\s*\d+(?:\s*[\-\u2013]\s*[$\u20ac\u00a3\u00a5]?\d+)?$/;
    const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const DAY_NAMES_SUN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const DAY_NAME_SET = new Set(DAY_NAMES);

    function safeText(el) {
        return el ? String(el.textContent || '').trim() : '';
    }

    function isValidLatLng(lat, lng) {
        return typeof lat === 'number' &&
            typeof lng === 'number' &&
            Number.isFinite(lat) &&
            Number.isFinite(lng) &&
            lat >= -90 && lat <= 90 &&
            lng >= -180 && lng <= 180;
    }

    function normalizeWebsite(url) {
        if (!url) return null;
        const value = String(url).trim();
        if (!value) return null;
        if (/^https?:\/\//i.test(value)) return value;
        if (value.startsWith('//')) return 'https:' + value;
        if (/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(value)) {
            return 'https://' + value;
        }
        return value;
    }

    function parseCoordsFromUrl(url) {
        if (!url) return null;
        let match = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
        if (match) {
            const lat = parseFloat(match[1]);
            const lng = parseFloat(match[2]);
            if (isValidLatLng(lat, lng)) {
                return { latitude: lat, longitude: lng };
            }
        }
        match = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (match) {
            const lat = parseFloat(match[1]);
            const lng = parseFloat(match[2]);
            if (isValidLatLng(lat, lng)) {
                return { latitude: lat, longitude: lng };
            }
        }
        return null;
    }

    function parsePlaceIdFromUrl(url) {
        if (!url) return null;
        let match = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
        if (match) return match[1];
        match = url.match(/1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
        if (match) return match[1];
        match = url.match(/place_id:([A-Za-z0-9_-]+)/);
        if (match) return match[1];
        match = url.match(/!1s(ChIJ[^!]+)/);
        if (match) return decodeURIComponent(match[1]);
        return null;
    }

    function normalizeAddressArray(arr) {
        if (!Array.isArray(arr)) return null;
        const cleaned = arr.map(item => String(item).trim()).filter(Boolean);
        return cleaned.length ? cleaned : null;
    }

    function splitAddressToArray(str) {
        if (!str) return null;
        const parts = String(str)
            .split(/,|\n/)
            .map(item => item.trim())
            .filter(Boolean);
        return parts.length ? parts : null;
    }

    function scoreAddressString(str) {
        if (!str) return -1;
        let score = 0;
        if (/\d/.test(str)) score += 2;
        if (/,/.test(str)) score += 1;
        if (ADDRESS_HINT_RE.test(str)) score += 2;
        if (str.length > 12) score += 1;
        if (str.length > 40) score += 1;
        if (/^\s*[A-Za-z\s]+$/.test(str) && str.length < 15) score -= 1;
        return score;
    }

    function scoreAddressArray(arr) {
        if (!Array.isArray(arr)) return -1;
        const joined = arr.join(', ');
        let score = scoreAddressString(joined);
        if (arr.length > 2) score += 1;
        return score;
    }

    function scoreCategoryArray(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return -1;
        let score = 0;
        if (arr.length === 1) score += 2;
        if (arr.length === 2) score += 1;
        const text = arr.join(' ');
        if (CATEGORY_HINT_RE.test(text)) score += 2;
        if (arr.some(item => item.length > 40)) score -= 1;
        return score;
    }

    function scoreStatusString(str) {
        if (!str) return -1;
        let score = 0;
        if (/open|closed/i.test(str)) score += 2;
        if (/(am|pm|a\.m\.|p\.m\.|\d{1,2}:\d{2})/i.test(str)) score += 2;
        if (/[\u00b7\u2022\.]/.test(str)) score += 1;
        if (str.length > 10) score += 1;
        if (str.length > 25) score += 1;
        return score;
    }

    function isAddressArrayCandidate(obj) {
        if (!Array.isArray(obj)) return false;
        if (obj.length < 2 || obj.length > 8) return false;
        let hasLetter = false;
        let hasDigit = false;

        for (const item of obj) {
            if (typeof item !== 'string') return false;
            if (item.length === 0 || item.length > 120) return false;
            if (item.includes('http') || /\u2605/.test(item)) return false;
            if (/[A-Za-z]/.test(item)) hasLetter = true;
            if (/\d/.test(item)) hasDigit = true;
        }

        const joined = obj.join(' ');
        const hasHint = ADDRESS_HINT_RE.test(joined);

        return hasLetter && (hasDigit || hasHint);
    }

    function isFullAddressCandidate(obj) {
        if (typeof obj !== 'string') return false;
        const value = obj.trim();
        if (value.length < 6 || value.length > 200) return false;
        if (value.includes('http') || /\u2605/.test(value)) return false;
        if (!/[A-Za-z]/.test(value)) return false;
        return scoreAddressString(value) > 0;
    }

    function isCoordinateArrayCandidate(obj) {
        if (!Array.isArray(obj)) return false;
        if (obj.length === 4 && obj[0] === null && obj[1] === null) {
            return isValidLatLng(obj[2], obj[3]);
        }
        if (obj.length === 2) {
            return isValidLatLng(obj[0], obj[1]);
        }
        return false;
    }

    function isOpeningHoursArrayCandidate(obj) {
        if (!Array.isArray(obj)) return false;
        if (obj.length !== 7) return false;
        return obj.every(item => Array.isArray(item) && DAY_NAME_SET.has(item[0]));
    }

    function isPopularTimesArrayCandidate(obj) {
        if (!Array.isArray(obj) || obj.length !== 7) return false;
        return obj.every(day => {
            if (!Array.isArray(day)) return false;
            if (isHourlyDataArray(day)) return true;
            if (Array.isArray(day[1]) && isHourlyDataArray(day[1])) return true;
            return false;
        });
    }

    function selectBestString(candidates, scorer) {
        if (!Array.isArray(candidates) || candidates.length === 0) return null;
        let best = null;
        let bestScore = -Infinity;
        for (const candidate of candidates) {
            if (typeof candidate !== 'string') continue;
            const value = candidate.trim();
            if (!value) continue;
            const score = scorer ? scorer(value) : 0;
            if (score > bestScore) {
                bestScore = score;
                best = value;
            }
        }
        return best;
    }

    function selectBestArray(candidates, scorer) {
        if (!Array.isArray(candidates) || candidates.length === 0) return null;
        let best = null;
        let bestScore = -Infinity;
        for (const candidate of candidates) {
            if (!Array.isArray(candidate)) continue;
            const score = scorer ? scorer(candidate) : 0;
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }
        return best;
    }

    function uniqueStrings(values) {
        const seen = new Set();
        const output = [];
        for (const item of values || []) {
            if (typeof item !== 'string') continue;
            const value = item.trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            output.push(value);
        }
        return output;
    }

    function normalizeCoordinateCandidate(candidate) {
        if (!Array.isArray(candidate)) return null;
        if (candidate.length === 4 && candidate[0] === null && candidate[1] === null) {
            const lat = candidate[2];
            const lng = candidate[3];
            if (isValidLatLng(lat, lng)) return { latitude: lat, longitude: lng };
        }
        if (candidate.length >= 2) {
            const lat = candidate[0];
            const lng = candidate[1];
            if (isValidLatLng(lat, lng)) return { latitude: lat, longitude: lng };
        }
        return null;
    }

    function selectBestCoordinates(candidates, urlCoords) {
        const normalized = [];
        if (Array.isArray(candidates)) {
            for (const candidate of candidates) {
                const coord = normalizeCoordinateCandidate(candidate);
                if (coord) normalized.push(coord);
            }
        }
        if (urlCoords && isValidLatLng(urlCoords.latitude, urlCoords.longitude)) {
            if (normalized.length === 0) return urlCoords;
            let best = normalized[0];
            let bestDist = Infinity;
            for (const coord of normalized) {
                const dLat = coord.latitude - urlCoords.latitude;
                const dLng = coord.longitude - urlCoords.longitude;
                const dist = dLat * dLat + dLng * dLng;
                if (dist < bestDist) {
                    bestDist = dist;
                    best = coord;
                }
            }
            if (bestDist > 0.01) {
                return urlCoords;
            }
            return best;
        }
        return normalized.length ? normalized[0] : null;
    }

    function filterRatingCandidates(ratings, urlCoords, coords) {
        if (!Array.isArray(ratings)) return [];
        const filtered = [];
        for (const rating of ratings) {
            if (typeof rating !== 'number' || !Number.isFinite(rating)) continue;
            if (rating < 1 || rating > 5) continue;
            let isLikelyCoord = false;
            if (urlCoords) {
                if (Math.abs(rating - urlCoords.latitude) < 0.02 || Math.abs(rating - urlCoords.longitude) < 0.02) {
                    isLikelyCoord = true;
                }
            }
            if (coords) {
                if (Math.abs(rating - coords.latitude) < 0.02 || Math.abs(rating - coords.longitude) < 0.02) {
                    isLikelyCoord = true;
                }
            }
            if (!isLikelyCoord) filtered.push(rating);
        }
        return filtered;
    }

    function parseReviewCountString(text) {
        if (!text) return null;
        const match = String(text).match(/([\d,]+)/);
        if (!match) return null;
        const value = parseInt(match[1].replace(/,/g, ''), 10);
        return Number.isFinite(value) ? value : null;
    }

    function selectBestReviewCount(values) {
        let best = null;
        for (const value of values || []) {
            const parsed = parseReviewCountString(value);
            if (parsed === null) continue;
            if (best === null || parsed > best) {
                best = parsed;
            }
        }
        return best;
    }

    function getTextBySelectors(selectors) {
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            const text = safeText(el);
            if (text) return text;
        }
        return null;
    }

    function parseCategoryText(text) {
        if (!text) return null;
        let cleaned = String(text);
        cleaned = cleaned.replace(/\(\s*\d+[^\)]*\)/g, '');
        cleaned = cleaned.replace(/\d+(\.\d+)?/g, '');
        const parts = cleaned.split(/[\u00b7\u2022|]/).map(item => item.trim()).filter(Boolean);
        const filtered = parts.filter(item =>
            item.length >= 3 &&
            item.length <= 60 &&
            !CATEGORY_BLACKLIST_RE.test(item)
        );
        return filtered.length ? filtered : null;
    }

    function parsePriceText(text) {
        if (!text) return null;
        const cleaned = String(text).replace(/\s+/g, ' ').trim();
        const match = cleaned.match(/([$\u20ac\u00a3\u00a5]{1,4}|[$\u20ac\u00a3\u00a5]\s*\d+(?:\s*[\-\u2013]\s*[$\u20ac\u00a3\u00a5]?\d+)?)/);
        if (match && PRICE_RE.test(match[0])) {
            return match[0].trim();
        }
        return null;
    }

    function normalizeLabel(label) {
        return String(label || '')
            .replace(/\u202f/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function collectAriaLabels() {
        const labels = [];
        document.querySelectorAll('[aria-label]').forEach(el => {
            const label = el.getAttribute('aria-label');
            if (label) labels.push(label);
        });
        return labels;
    }

    function parseHourTo24(hourStr, minuteStr, ampmChar) {
        const rawHour = parseInt(hourStr, 10);
        if (!Number.isFinite(rawHour)) return null;
        const minutes = minuteStr ? parseInt(minuteStr, 10) : 0;
        const ampm = String(ampmChar || '').toLowerCase();
        let hour = rawHour;
        if (ampm.startsWith('p') && hour !== 12) hour += 12;
        if (ampm.startsWith('a') && hour === 12) hour = 0;
        if (!Number.isFinite(minutes) || minutes === 0) return hour;
        return hour + (minutes / 60);
    }

    function formatTimeLabel(hourStr, minuteStr, ampmChar) {
        const ampm = String(ampmChar || '').toLowerCase().startsWith('a') ? 'am' : 'pm';
        const hour = parseInt(hourStr, 10);
        if (!Number.isFinite(hour)) return null;
        const minute = minuteStr ? String(minuteStr).padStart(2, '0') : null;
        const time = minute && minute !== '00' ? `${hour}:${minute}` : `${hour}`;
        return `${time} ${ampm}`;
    }

    function parseHoursRangeText(text) {
        const cleaned = normalizeLabel(text).replace(/,?\s*copy open hours.*$/i, '').trim();
        if (!cleaned) return null;
        if (/closed/i.test(cleaned)) {
            return { hours: 'Closed' };
        }
        if (/open 24 hours/i.test(cleaned) || /^24 hours$/i.test(cleaned)) {
            return { hours: 'Open 24 hours', openHour: 0, closeHour: 24 };
        }
        const rangeMatch = cleaned.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*(?:to|[\u2013-])\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
        if (!rangeMatch) {
            return { hours: cleaned };
        }
        const openHour = parseHourTo24(rangeMatch[1], rangeMatch[2], rangeMatch[3]);
        const closeHour = parseHourTo24(rangeMatch[4], rangeMatch[5], rangeMatch[6]);
        const result = { hours: cleaned };
        if (openHour !== null) result.openHour = openHour;
        if (closeHour !== null) result.closeHour = closeHour;
        return result;
    }

    function parseWeeklyHoursFromAriaLabels(labels) {
        if (!Array.isArray(labels)) return [];
        const weekly = [];
        const seenDays = new Set();

        for (const label of labels) {
            const text = normalizeLabel(label);
            const match = text.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*(?:,|:)\s*(.+)$/i);
            if (!match) continue;
            const day = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
            if (seenDays.has(day)) continue;
            const parsed = parseHoursRangeText(match[2]);
            if (!parsed || !parsed.hours) continue;

            const entry = { day: day, hours: parsed.hours };
            if (parsed.openHour !== undefined) entry.openHour = parsed.openHour;
            if (parsed.closeHour !== undefined) entry.closeHour = parsed.closeHour;
            weekly.push(entry);
            seenDays.add(day);
        }

        return weekly;
    }

    function parsePopularTimesFromAriaLabels(labels) {
        if (!Array.isArray(labels)) return [];
        const entries = [];

        for (const label of labels) {
            const text = normalizeLabel(label).replace(/\.$/, '');
            const match = text.match(/(\d{1,3})%\s*busy\s*at\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
            if (!match) continue;
            const popularity = parseInt(match[1], 10);
            const hour = parseHourTo24(match[2], match[3], match[4]);
            const timeLabel = formatTimeLabel(match[2], match[3], match[4]);
            if (!Number.isFinite(popularity) || hour === null || !timeLabel) continue;
            entries.push({ hour: hour, popularity: popularity, timeLabel: timeLabel });
        }

        if (entries.length === 0) return [];

        const groups = [];
        let current = [];
        const startHour = entries[0].hour;
        for (const entry of entries) {
            if (entry.hour === startHour && current.length >= 6) {
                groups.push(current);
                current = [];
            }
            current.push(entry);
        }
        if (current.length > 0) groups.push(current);

        const weekly = [];
        const groupCount = Math.min(groups.length, DAY_NAMES_SUN.length);
        for (let i = 0; i < groupCount; i++) {
            weekly.push({ day: DAY_NAMES_SUN[i], hourlyData: groups[i] });
        }
        return weekly;
    }

    function isCategoryString(item) {
        if (typeof item !== 'string') return false;
        const value = item.trim();
        if (!value) return false;
        if (value.length < 3 || value.length > 60) return false;
        if (!/[A-Za-z]/.test(value)) return false;
        if (/http|\u2605/.test(value)) return false;
        if (/\d/.test(value)) return false;
        if (CATEGORY_BLACKLIST_RE.test(value)) return false;
        return true;
    }

    function isFlatHoursArray(arr) {
        if (!Array.isArray(arr) || arr.length < 14) return false;
        let dayCount = 0;
        let hasHours = false;

        for (let i = 0; i < arr.length; i++) {
            const item = arr[i];
            if (typeof item === 'string' && DAY_NAME_SET.has(item)) {
                dayCount += 1;
                const next = arr[i + 1];
                if (typeof next === 'string' && !DAY_NAME_SET.has(next)) {
                    hasHours = true;
                }
                const nextArray = arr[i + 2];
                if (Array.isArray(nextArray) &&
                    nextArray.length >= 2 &&
                    typeof nextArray[0] === 'number' &&
                    typeof nextArray[1] === 'number') {
                    hasHours = true;
                }
            }
        }

        return dayCount >= 6 && hasHours;
    }

    function parseWeeklyHoursFromArray(hoursData) {
        if (!Array.isArray(hoursData)) return [];
        const weekly = [];

        for (const dayData of hoursData) {
            if (!Array.isArray(dayData) || dayData.length < 1) continue;

            const dayName = dayData[0];
            if (!DAY_NAME_SET.has(dayName)) continue;

            const dayEntry = { day: dayName };

            if (typeof dayData[1] === 'string') {
                dayEntry.hours = dayData[1];
            }

            let hoursInfo = dayData[3];
            if (!hoursInfo && Array.isArray(dayData[1])) {
                hoursInfo = dayData[1];
            }
            if (!hoursInfo && Array.isArray(dayData[2])) {
                hoursInfo = dayData[2];
            }

            if (Array.isArray(hoursInfo)) {
                if (hoursInfo.length === 2 &&
                    typeof hoursInfo[0] === 'number' &&
                    typeof hoursInfo[1] === 'number') {
                    dayEntry.openHour = hoursInfo[0];
                    dayEntry.closeHour = hoursInfo[1];
                } else {
                    const timeData = hoursInfo[0];
                    if (Array.isArray(timeData)) {
                        if (timeData[0] === 'Closed') {
                            dayEntry.hours = 'Closed';
                        } else {
                            if (!dayEntry.hours && typeof timeData[0] === 'string') {
                                dayEntry.hours = timeData[0];
                            }
                            if (timeData.length > 1 && Array.isArray(timeData[1]) && timeData[1].length >= 2) {
                                if (Array.isArray(timeData[1][0]) && timeData[1][0].length > 0) {
                                    dayEntry.openHour = timeData[1][0][0];
                                }
                                if (Array.isArray(timeData[1][1]) && timeData[1][1].length > 0) {
                                    dayEntry.closeHour = timeData[1][1][0];
                                }
                            }
                        }
                    }
                }
            }

            if (!dayEntry.hours) {
                for (let i = 1; i < dayData.length; i++) {
                    if (typeof dayData[i] === 'string' && dayData[i].length <= 80) {
                        dayEntry.hours = dayData[i];
                        break;
                    }
                }
            }

            const hasTime = typeof dayEntry.hours === 'string' ||
                dayEntry.openHour !== undefined ||
                dayEntry.closeHour !== undefined;

            if (hasTime) {
                weekly.push(dayEntry);
            }
        }

        return weekly;
    }

    function parseWeeklyHoursFromFlatArray(arr) {
        if (!Array.isArray(arr)) return [];
        const weekly = [];

        for (let i = 0; i < arr.length; i++) {
            const dayName = arr[i];
            if (!DAY_NAME_SET.has(dayName)) continue;

            const dayEntry = { day: dayName };

            if (typeof arr[i + 1] === 'string' && !DAY_NAME_SET.has(arr[i + 1])) {
                dayEntry.hours = arr[i + 1];
            }
            if (Array.isArray(arr[i + 2]) &&
                arr[i + 2].length >= 2 &&
                typeof arr[i + 2][0] === 'number' &&
                typeof arr[i + 2][1] === 'number') {
                dayEntry.openHour = arr[i + 2][0];
                dayEntry.closeHour = arr[i + 2][1];
            }

            const hasTime = typeof dayEntry.hours === 'string' ||
                dayEntry.openHour !== undefined ||
                dayEntry.closeHour !== undefined;

            if (hasTime) {
                weekly.push(dayEntry);
            }
        }

        return weekly;
    }

    function selectBestParsed(candidates, parser) {
        let best = [];
        if (!Array.isArray(candidates)) return best;

        for (const candidate of candidates) {
            const parsed = parser(candidate);
            if (parsed.length > best.length) {
                best = parsed;
            }
        }
        return best;
    }

    function isHourlyDataArray(arr) {
        return Array.isArray(arr) && arr.some(hour =>
            Array.isArray(hour) &&
            hour.length >= 2 &&
            typeof hour[0] === 'number' &&
            typeof hour[1] === 'number'
        );
    }

    function parsePopularTimesWeek(weekData) {
        if (!Array.isArray(weekData) || weekData.length !== 7) return [];
        const weekly = [];

        for (let dayIdx = 0; dayIdx < weekData.length; dayIdx++) {
            const dayData = weekData[dayIdx];
            if (!Array.isArray(dayData)) continue;

            const directHourly = isHourlyDataArray(dayData);
            let hourlyDataRaw = null;

            if (directHourly) {
                hourlyDataRaw = dayData;
            } else if (Array.isArray(dayData[1]) && isHourlyDataArray(dayData[1])) {
                hourlyDataRaw = dayData[1];
            }

            if (!hourlyDataRaw) continue;

            const dayInfo = {
                day: DAY_NAMES_SUN[dayIdx],
                hourlyData: []
            };

            for (const hourInfo of hourlyDataRaw) {
                if (!Array.isArray(hourInfo) || hourInfo.length < 2) continue;

                const hourEntry = {
                    hour: hourInfo[0],
                    popularity: hourInfo[1]
                };

                if (hourInfo.length > 2 && hourInfo[2] && typeof hourInfo[2] === 'string' && hourInfo[2] !== '') {
                    hourEntry.busyLabel = hourInfo[2];
                }
                if (hourInfo.length > 3 && hourInfo[3] && hourInfo[3] !== 'None' && hourInfo[3] !== '') {
                    hourEntry.waitTime = hourInfo[3];
                }
                if (hourInfo.length > 4 && hourInfo[4]) {
                    hourEntry.timeLabel = String(hourInfo[4]).replace(/\u202f/g, ' ');
                }

                dayInfo.hourlyData.push(hourEntry);
            }

            if (!directHourly) {
                if (dayData.length > 3 && Array.isArray(dayData[3]) && dayData[3].length > 0) {
                    if (typeof dayData[3][0] === 'string') {
                        dayInfo.peakWaitInfo = dayData[3][0].replace(/\u202f/g, ' ');
                    }
                }
            }

            if (dayInfo.hourlyData.length > 0) {
                weekly.push(dayInfo);
            }
        }

        return weekly;
    }

    // ============================================
    // PART 1: RAW DATA EXTRACTION (from original script)
    // ============================================

    function deepSearch(obj, condition, maxDepth = 20, currentDepth = 0) {
        if (currentDepth > maxDepth) return [];
        const results = [];
        if (obj === null || obj === undefined) return results;

        if (condition(obj)) {
            results.push(obj);
        }

        if (typeof obj === 'object') {
            for (let key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const found = deepSearch(obj[key], condition, maxDepth, currentDepth + 1);
                    results.push(...found);
                }
            }
        }

        return results;
    }

    function deepSearchFirstAvailable(roots, condition) {
        for (const root of roots) {
            const results = deepSearch(root, condition);
            if (results.length > 0) return results;
        }
        return [];
    }

    function createStringMatchPredicate(target, exact) {
        if (!target) return () => false;
        const normalized = String(target).toLowerCase();
        return (value) => {
            if (typeof value !== 'string') return false;
            const val = value.toLowerCase();
            if (exact) return val === normalized;
            return val.includes(normalized);
        };
    }

    function findScopesByPredicate(root, predicate, maxDepth = 12) {
        const scopes = [];
        const visited = new WeakSet();

        function walk(node, depth) {
            if (!node || depth > maxDepth || typeof node !== 'object') return;
            if (visited.has(node)) return;
            visited.add(node);

            let matched = false;
            if (Array.isArray(node)) {
                for (const item of node) {
                    if (predicate(item)) {
                        matched = true;
                        break;
                    }
                }
            } else {
                for (const key in node) {
                    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
                    if (predicate(node[key])) {
                        matched = true;
                        break;
                    }
                }
            }

            if (matched) {
                scopes.push(node);
            }

            if (Array.isArray(node)) {
                for (const item of node) {
                    walk(item, depth + 1);
                }
            } else {
                for (const key in node) {
                    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
                    walk(node[key], depth + 1);
                }
            }
        }

        walk(root, 0);
        return scopes;
    }

    function estimateNodeSize(node) {
        if (!node || typeof node !== 'object') return 0;
        if (Array.isArray(node)) return node.length;
        return Object.keys(node).length;
    }

    function scoreScope(scope) {
        const opening = deepSearch(scope, isOpeningHoursArrayCandidate).length;
        const flat = deepSearch(scope, isFlatHoursArray).length;
        const popular = deepSearch(scope, isPopularTimesArrayCandidate).length;
        const address = deepSearch(scope, isAddressArrayCandidate).length;
        const fullAddress = deepSearch(scope, isFullAddressCandidate).length;
        const coords = deepSearch(scope, isCoordinateArrayCandidate).length;
        const score = opening * 6 + flat * 4 + popular * 6 + address * 2 + fullAddress * 2 + coords * 2;
        const penalty = Math.min(estimateNodeSize(scope), 200) / 50;
        return score - penalty;
    }

    function pickBestScope(appState, placeId, businessName) {
        if (!appState || typeof appState !== 'object') return null;
        const scopes = [];

        if (placeId) {
            const placePredicate = createStringMatchPredicate(placeId, true);
            scopes.push(...findScopesByPredicate(appState, placePredicate));
        }
        if (businessName) {
            const namePredicate = createStringMatchPredicate(businessName, false);
            scopes.push(...findScopesByPredicate(appState, namePredicate));
        }
        if (scopes.length === 0) return null;

        const unique = [];
        const seen = new WeakSet();
        for (const scope of scopes) {
            if (!scope || typeof scope !== 'object') continue;
            if (seen.has(scope)) continue;
            seen.add(scope);
            unique.push(scope);
        }

        let best = null;
        let bestScore = -Infinity;
        let bestSize = Infinity;

        for (const scope of unique) {
            const score = scoreScope(scope);
            const size = estimateNodeSize(scope);
            if (score > bestScore || (score === bestScore && size < bestSize)) {
                bestScore = score;
                bestSize = size;
                best = scope;
            }
        }

        return best || unique[0];
    }

    function extractRawData() {
        console.log('[Step 1] Extracting raw data...\n');

        const rawData = {
            extractedAt: new Date().toISOString(),
            url: window.location.href,
            businessName: null,

            // Raw extracted data (to be cleaned)
            _raw: {
                urlCoordinates: null,
                urlPlaceId: null,
                addresses: [],
                fullAddresses: [],
                coordinates: [],
                placeIds: [],
                categories: [],
                priceRanges: [],
                ratings: [],
                reviewCounts: [],
                phones: [],
                websites: [],
                currentStatuses: [],
                openingHoursArrays: [],
                openingHoursFlatArrays: [],
                popularTimesArrays: []
            }
        };

        // Get business name from DOM
        const h1 = document.querySelector('h1');
        if (h1) {
            rawData.businessName = h1.innerText.trim();
            console.log('Business name:', rawData.businessName);
        }

        const urlCoords = parseCoordsFromUrl(rawData.url);
        const urlPlaceId = parsePlaceIdFromUrl(rawData.url);
        rawData._raw.urlCoordinates = urlCoords;
        rawData._raw.urlPlaceId = urlPlaceId;

        if (urlCoords) {
            console.log('URL coords:', urlCoords);
        }
        if (urlPlaceId) {
            console.log('URL place id:', urlPlaceId);
        }

        const appState = window.APP_INITIALIZATION_STATE || window.__APP_INITIALIZATION_STATE;
        if (!appState) {
            console.error('APP_INITIALIZATION_STATE not found!');
            return rawData;
        }

        const scopeRoot = pickBestScope(appState, urlPlaceId, rawData.businessName);
        const searchRoots = scopeRoot && scopeRoot !== appState ? [scopeRoot, appState] : [appState];
        if (scopeRoot && scopeRoot !== appState) {
            console.log('Scoped extraction enabled');
        }

        // 1. Extract addresses (arrays of address lines)
        console.log('Searching addresses...');
        rawData._raw.addresses = deepSearchFirstAvailable(searchRoots, isAddressArrayCandidate);
        console.log('  Found:', rawData._raw.addresses.length, 'candidates');

        // 2. Extract full address strings
        console.log('Searching full addresses...');
        rawData._raw.fullAddresses = deepSearchFirstAvailable(searchRoots, isFullAddressCandidate);
        console.log('  Found:', rawData._raw.fullAddresses.length, 'candidates');

        // 3. Extract coordinates
        console.log('Searching coordinates...');
        rawData._raw.coordinates = deepSearchFirstAvailable(searchRoots, isCoordinateArrayCandidate);
        console.log('  Found:', rawData._raw.coordinates.length, 'candidates');

        // 4. Extract Place IDs
        console.log('Searching Place IDs...');
        rawData._raw.placeIds = deepSearchFirstAvailable(searchRoots, (obj) => {
            if (typeof obj !== 'string') return false;
            return /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(obj) || /^ChIJ[A-Za-z0-9_-]+$/.test(obj);
        });
        console.log('  Found:', rawData._raw.placeIds.length, 'candidates');

        // 5. Extract categories
        console.log('Searching categories...');
        rawData._raw.categories = deepSearchFirstAvailable(searchRoots, (obj) => {
            if (!Array.isArray(obj)) return false;
            if (obj.length < 1 || obj.length > 4) return false;
            return obj.every(isCategoryString);
        });
        console.log('  Found:', rawData._raw.categories.length, 'candidates');

        // 6. Extract price ranges
        console.log('Searching price ranges...');
        rawData._raw.priceRanges = deepSearchFirstAvailable(searchRoots, (obj) => {
            if (typeof obj !== 'string') return false;
            const value = obj.trim();
            return PRICE_RE.test(value);
        });
        console.log('  Found:', rawData._raw.priceRanges.length, 'candidates');

        // 7. Extract ratings (1.0-5.0)
        console.log('Searching ratings...');
        rawData._raw.ratings = deepSearchFirstAvailable(searchRoots, (obj) => {
            if (typeof obj !== 'number') return false;
            return obj >= 1.0 && obj <= 5.0 && Number.isFinite(obj);
        });
        console.log('  Found:', rawData._raw.ratings.length, 'candidates');

        // 8. Extract review counts
        console.log('Searching review counts...');
        rawData._raw.reviewCounts = deepSearchFirstAvailable(searchRoots, (obj) => {
            if (typeof obj !== 'string') return false;
            return /^[\d,]+\s*reviews?$/i.test(obj);
        });
        console.log('  Found:', rawData._raw.reviewCounts.length, 'candidates');

        // 9. Extract phone numbers
        console.log('Searching phones...');
        rawData._raw.phones = deepSearchFirstAvailable(searchRoots, (obj) => {
            if (typeof obj !== 'string') return false;
            const value = obj.trim();
            if (!value) return false;
            if (/[A-Za-z]/.test(value)) return false;
            const digits = value.replace(/\D/g, '');
            if (digits.length < 7 || digits.length > 15) return false;
            return /^(\+?\d[\d\s\-()]{6,}\d)$/.test(value);
        });
        console.log('  Found:', rawData._raw.phones.length, 'candidates');

        // 10. Extract websites (exclude Google URLs)
        console.log('Searching websites...');
        rawData._raw.websites = deepSearchFirstAvailable(searchRoots, (obj) => {
            if (typeof obj !== 'string') return false;
            const value = obj.trim();
            if (!value) return false;
            if (/google|gstatic|googleapis|googleusercontent/i.test(value)) return false;
            return /^(https?:\/\/)?[a-z0-9]+([\-\.][a-z0-9]+)*\.[a-z]{2,}(\/.*)?$/i.test(value);
        });
        console.log('  Found:', rawData._raw.websites.length, 'candidates');

        // 11. Extract current status
        console.log('Searching current status...');
        const strictStatuses = deepSearchFirstAvailable(searchRoots, (obj) => {
            if (typeof obj !== 'string') return false;
            if (obj.length > 80) return false;
            return /^(Open|Closed)\s*[\u00b7\.\u2022]/i.test(obj);
        });
        const looseStatuses = deepSearchFirstAvailable(searchRoots, (obj) => {
            if (typeof obj !== 'string') return false;
            if (obj.length > 120) return false;
            if (!/(Open|Closed)/i.test(obj)) return false;
            return /(am|pm|a\.m\.|p\.m\.|\d{1,2}:\d{2})/i.test(obj);
        });
        rawData._raw.currentStatuses = uniqueStrings(strictStatuses.concat(looseStatuses));
        console.log('  Found:', rawData._raw.currentStatuses.length, 'candidates');

        // 12. Extract opening hours arrays (7-element with day names)
        console.log('Searching opening hours...');
        rawData._raw.openingHoursArrays = deepSearchFirstAvailable(searchRoots, isOpeningHoursArrayCandidate);
        console.log('  Found:', rawData._raw.openingHoursArrays.length, 'candidates');

        // 13. Extract opening hours flat arrays
        console.log('Searching opening hours flat arrays...');
        rawData._raw.openingHoursFlatArrays = deepSearchFirstAvailable(searchRoots, isFlatHoursArray);
        console.log('  Found:', rawData._raw.openingHoursFlatArrays.length, 'candidates');

        // 14. Extract Popular Times arrays
        console.log('Searching Popular Times...');
        rawData._raw.popularTimesArrays = deepSearchFirstAvailable(searchRoots, isPopularTimesArrayCandidate);
        console.log('  Found:', rawData._raw.popularTimesArrays.length, 'candidates');

        return rawData;
    }

    // ============================================
    // PART 2: DATA CLEANING
    // ============================================

    function cleanData(rawData) {
        console.log('\n[Step 2] Cleaning data...\n');

        const cleaned = {
            extractedAt: rawData.extractedAt,
            cleanedAt: new Date().toISOString(),
            sourceUrl: rawData.url,
            business: {
                name: rawData.businessName,
                address: null,
                fullAddress: null,
                coordinates: null,
                placeId: null,
                categories: null,
                priceRange: null,
                rating: null,
                reviewCount: null,
                phone: null,
                website: null,
                plusCode: null
            },
            openingHours: {
                currentStatus: null,
                weeklyHours: []
            },
            popularTimes: {
                weeklyData: []
            }
        };

        const raw = rawData._raw;
        const urlCoords = raw.urlCoordinates;
        const urlPlaceId = raw.urlPlaceId;

        // Clean address - select best candidate
        const bestAddressArray = selectBestArray(raw.addresses, scoreAddressArray);
        if (bestAddressArray) {
            cleaned.business.address = normalizeAddressArray(bestAddressArray);
            console.log('Address: Selected best candidate');
        }

        // Clean full address
        const bestFullAddress = selectBestString(raw.fullAddresses, scoreAddressString);
        if (bestFullAddress) {
            cleaned.business.fullAddress = bestFullAddress;
            console.log('Full Address: Selected best candidate');
        }

        if (!cleaned.business.fullAddress && cleaned.business.address) {
            cleaned.business.fullAddress = cleaned.business.address.join(', ');
        }
        if (!cleaned.business.address && cleaned.business.fullAddress) {
            cleaned.business.address = splitAddressToArray(cleaned.business.fullAddress);
        }

        // Clean coordinates - prefer URL coords, then nearest candidate
        const bestCoords = selectBestCoordinates(raw.coordinates, urlCoords);
        if (bestCoords) {
            cleaned.business.coordinates = bestCoords;
            console.log('Coordinates:', cleaned.business.coordinates);
        }

        // Clean Place ID - prefer URL if available
        if (urlPlaceId) {
            cleaned.business.placeId = urlPlaceId;
            console.log('Place ID: From URL');
        } else if (raw.placeIds.length > 0) {
            const chij = raw.placeIds.find(id => id.startsWith('ChIJ'));
            cleaned.business.placeId = chij || raw.placeIds[0];
            console.log('Place ID: Selected candidate');
        }

        // Clean categories
        if (raw.categories.length > 0) {
            raw.categories.sort((a, b) => scoreCategoryArray(b) - scoreCategoryArray(a));
            cleaned.business.categories = raw.categories[0];
            console.log('Categories:', cleaned.business.categories);
        }

        // Clean price range
        if (raw.priceRanges.length > 0) {
            cleaned.business.priceRange = raw.priceRanges[0];
            console.log('Price Range:', cleaned.business.priceRange);
        }

        // Clean rating
        const ratingCandidates = filterRatingCandidates(raw.ratings, urlCoords, cleaned.business.coordinates);
        if (ratingCandidates.length > 0) {
            const decimalRatings = ratingCandidates.filter(r => r % 1 !== 0);
            cleaned.business.rating = decimalRatings[0] || ratingCandidates[0];
            console.log('Rating:', cleaned.business.rating);
        }

        // Clean review count
        const bestReviewCount = selectBestReviewCount(raw.reviewCounts);
        if (bestReviewCount !== null) {
            cleaned.business.reviewCount = bestReviewCount;
            console.log('Review Count:', cleaned.business.reviewCount);
        }

        // Clean phone
        if (raw.phones.length > 0) {
            let phone = raw.phones[0];
            const digits = phone.replace(/\D/g, '');
            if (digits.length === 8) {
                phone = '+65 ' + digits.slice(0, 4) + ' ' + digits.slice(4);
            } else if (digits.length === 10 && digits.startsWith('65')) {
                phone = '+65 ' + digits.slice(2, 6) + ' ' + digits.slice(6);
            }
            cleaned.business.phone = phone;
            console.log('Phone:', cleaned.business.phone);
        }

        // Clean website
        if (raw.websites.length > 0) {
            const normalized = normalizeWebsite(raw.websites[0]);
            if (normalized) {
                cleaned.business.website = normalized;
                console.log('Website:', cleaned.business.website);
            }
        }

        // Clean current status
        const bestStatus = selectBestString(raw.currentStatuses, scoreStatusString);
        if (bestStatus) {
            cleaned.openingHours.currentStatus = bestStatus.replace(/\u202f/g, ' ');
            console.log('Current Status:', cleaned.openingHours.currentStatus);
        }

        // Clean opening hours
        let weeklyHours = selectBestParsed(raw.openingHoursArrays, parseWeeklyHoursFromArray);
        if (weeklyHours.length === 0) {
            weeklyHours = selectBestParsed(raw.openingHoursFlatArrays, parseWeeklyHoursFromFlatArray);
        }
        if (weeklyHours.length > 0) {
            cleaned.openingHours.weeklyHours = weeklyHours;
            console.log('Opening Hours:', cleaned.openingHours.weeklyHours.length, 'days');
        }

        // Clean Popular Times
        const popularWeek = selectBestParsed(raw.popularTimesArrays, parsePopularTimesWeek);
        if (popularWeek.length > 0) {
            cleaned.popularTimes.weeklyData = popularWeek;
            console.log('Popular Times:', cleaned.popularTimes.weeklyData.length, 'days');
        }

        return cleaned;
    }

    // ============================================
    // PART 3: DOM FALLBACK EXTRACTION
    // ============================================

    function extractFromDOM(cleaned) {
        console.log('\n[Step 3] DOM fallback extraction...\n');
        const ariaLabels = collectAriaLabels();

        // Try to get address from DOM
        const addressText = getTextBySelectors([
            '[data-item-id="address"] .fontBodyMedium',
            '[data-item-id="address"]',
            'button[data-item-id="address"]',
            'button[data-item-id*="address"]'
        ]);
        if (addressText) {
            cleaned.business.fullAddress = addressText;
            cleaned.business.address = splitAddressToArray(addressText);
            console.log('Address from DOM:', cleaned.business.fullAddress);
        }

        // Try to get phone from DOM
        const phoneText = getTextBySelectors([
            '[data-item-id^="phone"] .fontBodyMedium',
            '[data-item-id^="phone"]'
        ]);
        if (phoneText) {
            cleaned.business.phone = phoneText;
            console.log('Phone from DOM:', cleaned.business.phone);
        }

        // Try to get Plus Code from DOM
        const plusCodeEl = document.querySelector('[data-item-id="oloc"]');
        if (plusCodeEl) {
            const plusCodeText = plusCodeEl.textContent.trim();
            if (plusCodeText) {
                cleaned.business.plusCode = plusCodeText;
                console.log('Plus Code from DOM:', cleaned.business.plusCode);
            }
        }

        // Try to get website from DOM
        let websiteText = null;
        const websiteLink = document.querySelector('[data-item-id="authority"] a, a[data-item-id="authority"]');
        if (websiteLink) {
            websiteText = websiteLink.getAttribute('href') || websiteLink.textContent;
        } else {
            websiteText = getTextBySelectors([
                '[data-item-id="authority"] .fontBodyMedium',
                '[data-item-id="authority"]'
            ]);
        }
        if (websiteText) {
            const normalized = normalizeWebsite(websiteText);
            if (normalized) {
                cleaned.business.website = normalized;
                console.log('Website from DOM:', cleaned.business.website);
            }
        }

        // Try to get rating from DOM
        const ratingSpan = document.querySelector('[role="img"][aria-label*="star"]');
        if (ratingSpan) {
            const match = (ratingSpan.getAttribute('aria-label') || '').match(/([\d.]+)\s*star/i);
            if (match) {
                cleaned.business.rating = parseFloat(match[1]);
                console.log('Rating from DOM:', cleaned.business.rating);
            }
        }

        // Try to get review count from DOM
        const reviewBtn = document.querySelector('button[jsaction*="pane.reviewChart.moreReviews"], button[aria-label*="review"]');
        if (reviewBtn) {
            const label = reviewBtn.getAttribute('aria-label') || reviewBtn.textContent;
            const value = parseReviewCountString(label);
            if (value !== null) {
                cleaned.business.reviewCount = value;
                console.log('Review count from DOM:', cleaned.business.reviewCount);
            }
        }

        // Try to get categories from DOM
        if (!cleaned.business.categories || cleaned.business.categories.length === 0) {
            // Primary: button.DkEaL is the current Google Maps category button
            const categoryBtn = document.querySelector('button.DkEaL');
            if (categoryBtn) {
                const catText = categoryBtn.textContent.trim();
                if (catText && catText.length >= 3 && catText.length <= 60) {
                    cleaned.business.categories = [catText];
                    console.log('Categories from button.DkEaL:', cleaned.business.categories);
                }
            }
        }
        if (!cleaned.business.categories || cleaned.business.categories.length === 0) {
            // Fallback: legacy selectors
            const categoryText = getTextBySelectors([
                'button[jsaction*="pane.rating.category"]',
                'button[jsaction*="category"]',
                'button[jsaction*="pane.rating.more"]',
                '[data-item-id="category"]',
                'button[aria-label*="category"]'
            ]);
            const categories = parseCategoryText(categoryText);
            if (categories) {
                cleaned.business.categories = categories;
                console.log('Categories from DOM:', cleaned.business.categories);
            }
        }

        // Try to get price range from DOM
        const priceText = getTextBySelectors([
            '[data-item-id="price"]',
            'button[aria-label*="Price"]',
            'span[aria-label*="Price"]'
        ]);
        const priceRange = parsePriceText(priceText);
        if (priceRange) {
            cleaned.business.priceRange = priceRange;
            console.log('Price Range from DOM:', cleaned.business.priceRange);
        }

        // Try opening hours from DOM
        if (cleaned.openingHours.weeklyHours.length === 0) {
            console.log('Trying opening hours from DOM...');
            const rows = document.querySelectorAll('[role="row"]');
            rows.forEach(row => {
                const text = row.innerText.trim();
                const dayMatch = text.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(.+)/i);
                if (dayMatch) {
                    cleaned.openingHours.weeklyHours.push({
                        day: dayMatch[1],
                        hours: dayMatch[2]
                    });
                }
            });
            if (cleaned.openingHours.weeklyHours.length > 0) {
                console.log('Opening hours from DOM:', cleaned.openingHours.weeklyHours.length, 'days');
            }
        }

        // Current status from DOM
        const statusEl = document.querySelector('[data-hide-tooltip-on-mouse-move] span[aria-label]');
        if (statusEl) {
            const label = statusEl.getAttribute('aria-label');
            if (label && /open|closed/i.test(label)) {
                cleaned.openingHours.currentStatus = label;
                console.log('Current status from DOM:', cleaned.openingHours.currentStatus);
            }
        }

        if (!cleaned.openingHours.currentStatus) {
            const hoursBtn = document.querySelector('button[data-item-id="oh"], button[aria-label*="Hours"]');
            const hoursText = safeText(hoursBtn);
            if (hoursText && /open|closed/i.test(hoursText)) {
                cleaned.openingHours.currentStatus = hoursText;
                console.log('Current status from hours button:', cleaned.openingHours.currentStatus);
            }
        }

        if (!cleaned.openingHours.currentStatus && ariaLabels.length > 0) {
            const statusCandidates = ariaLabels
                .map(normalizeLabel)
                .filter(label => label && /open|closed/i.test(label) && label.length <= 120);
            const bestStatus = selectBestString(statusCandidates, scoreStatusString);
            if (bestStatus) {
                cleaned.openingHours.currentStatus = bestStatus;
                console.log('Current status from aria labels:', cleaned.openingHours.currentStatus);
            }
        }

        if (cleaned.openingHours.weeklyHours.length === 0 && ariaLabels.length > 0) {
            const weeklyHours = parseWeeklyHoursFromAriaLabels(ariaLabels);
            if (weeklyHours.length > 0) {
                cleaned.openingHours.weeklyHours = weeklyHours;
                console.log('Opening hours from aria labels:', cleaned.openingHours.weeklyHours.length, 'days');
            }
        }

        if (cleaned.popularTimes.weeklyData.length === 0 && ariaLabels.length > 0) {
            const popularWeek = parsePopularTimesFromAriaLabels(ariaLabels);
            if (popularWeek.length > 0) {
                cleaned.popularTimes.weeklyData = popularWeek;
                console.log('Popular times from aria labels:', cleaned.popularTimes.weeklyData.length, 'days');
            }
        }

        if (!cleaned.business.fullAddress && cleaned.business.address) {
            cleaned.business.fullAddress = cleaned.business.address.join(', ');
        }
        if (!cleaned.business.address && cleaned.business.fullAddress) {
            cleaned.business.address = splitAddressToArray(cleaned.business.fullAddress);
        }

        return cleaned;
    }

    // ============================================
    // PART 4: ENHANCED EXTRACTION (About, Metadata)
    // ============================================

    async function extractAboutData() {
        console.log('\n[Step 4] Extracting About data...\n');
        const aboutData = {};

        try {
            const tabs = Array.from(document.querySelectorAll('button.hh2c6, button[role="tab"]'));
            const aboutTab = tabs.find(tab =>
                tab.textContent.toLowerCase().includes('about') ||
                tab.getAttribute('aria-label')?.toLowerCase().includes('about')
            );

            if (aboutTab) {
                console.log('Found About tab, clicking...');
                aboutTab.click();
                await new Promise(resolve => setTimeout(resolve, 1000));

                const sections = document.querySelectorAll('div.iP2t7d.fontBodyMedium, div.iP2t7d');
                sections.forEach(section => {
                    const h2 = section.querySelector('h2.iL3Qke, h2');
                    if (!h2) return;

                    const category = h2.textContent.trim();
                    if (!category) return;

                    const items = [];
                    const ul = section.querySelector('ul.ZQ6we, ul');
                    if (ul) {
                        const listItems = ul.querySelectorAll('li');
                        listItems.forEach(li => {
                            const div = li.querySelector('div');
                            if (div) {
                                const spans = div.querySelectorAll('span');
                                if (spans.length >= 2) {
                                    const item = spans[1].textContent.trim();
                                    if (item) items.push(item);
                                } else if (spans.length === 1) {
                                    const item = spans[0].textContent.trim();
                                    if (item) items.push(item);
                                }
                            }
                        });
                    }

                    if (items.length > 0) {
                        aboutData[category] = items;
                    }
                });

                console.log('About categories found:', Object.keys(aboutData).length);
            }
        } catch (err) {
            console.error('Error extracting About:', err.message);
        }

        return aboutData;
    }

    function extractMetadata() {
        console.log('[Step 4] Extracting metadata...\n');
        const metadata = {};

        try {
            const metadataContainers = document.querySelectorAll('div.RcCsl');
            metadataContainers.forEach(container => {
                const button = container.querySelector('button[data-tooltip]');
                if (button) {
                    const key = button.getAttribute('data-tooltip');
                    const value = button.textContent.trim();
                    if (key && value) metadata[key] = value;
                }

                const link = container.querySelector('a[data-tooltip]');
                if (link) {
                    const key = link.getAttribute('data-tooltip');
                    const value = link.textContent.trim();
                    if (key && value) metadata[key] = value;
                }

                const spans = container.querySelectorAll('span[aria-label]');
                spans.forEach(span => {
                    const label = span.getAttribute('aria-label');
                    if (label) {
                        const key = 'Additional Info';
                        const value = label.trim();
                        if (metadata[key]) {
                            if (Array.isArray(metadata[key])) {
                                metadata[key].push(value);
                            } else {
                                metadata[key] = [metadata[key], value];
                            }
                        } else {
                            metadata[key] = value;
                        }
                    }
                });
            });

            console.log('Metadata fields found:', Object.keys(metadata).length);
        } catch (err) {
            console.error('Error extracting metadata:', err.message);
        }

        return metadata;
    }

    async function enhanceData(cleaned) {
        console.log('\n[Step 4] Enhancing data structure...\n');

        const aboutData = await extractAboutData();
        const metadata = extractMetadata();

        const mainCategory = cleaned.business.categories && cleaned.business.categories.length > 0
            ? cleaned.business.categories[0]
            : null;

        cleaned.business.mainCategory = mainCategory;
        cleaned.about = aboutData;
        cleaned.metadata = metadata;

        console.log('Main Category:', mainCategory || 'N/A');
        console.log('About categories:', Object.keys(aboutData).length);
        console.log('Metadata fields:', Object.keys(metadata).length);

        return cleaned;
    }

    // ============================================
    // PART 5: EXECUTION
    // ============================================

    function downloadJSON(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async function executeExtraction() {
        // Step 1: Extract raw data
        const rawData = extractRawData();

        // Step 2: Clean data
        let cleanedData = cleanData(rawData);

        // Step 3: DOM fallback
        cleanedData = extractFromDOM(cleanedData);

        // Step 4: Enhanced data (About, Metadata)
        cleanedData = await enhanceData(cleanedData);

        // Generate filename
        const timestamp = Date.now();
        const businessSlug = (cleanedData.business.name || 'unknown')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .substring(0, 30);
        const filename = `gmap-${businessSlug}-${timestamp}.json`;

        // Download
        downloadJSON(cleanedData, filename);

        if (cleanedData.openingHours.weeklyHours.length === 0) {
            console.warn('Opening hours not found. Tip: open the Hours panel and rerun.');
        }
        if (cleanedData.popularTimes.weeklyData.length === 0) {
            console.warn('Popular times not found. Tip: scroll to Popular times section and rerun.');
        }

        // Summary
        console.log('\n=== Extraction Complete ===');
        console.log('File:', filename);
        console.log('\nSummary:');
        console.log('  Name:', cleanedData.business.name || 'N/A');
        console.log('  Address:', cleanedData.business.address ? 'Found' : 'N/A');
        console.log('  Coordinates:', cleanedData.business.coordinates ? 'Found' : 'N/A');
        console.log('  Categories:', cleanedData.business.categories || 'N/A');
        console.log('  Rating:', cleanedData.business.rating || 'N/A');
        console.log('  Reviews:', cleanedData.business.reviewCount || 'N/A');
        console.log('  Phone:', cleanedData.business.phone || 'N/A');
        console.log('  Plus Code:', cleanedData.business.plusCode || 'N/A');
        console.log('  Website:', cleanedData.business.website || 'N/A');
        console.log('  Opening Hours:', cleanedData.openingHours.weeklyHours.length, 'days');
        console.log('  Popular Times:', cleanedData.popularTimes.weeklyData.length, 'days');
        console.log('  Main Category:', cleanedData.business.mainCategory || 'N/A');
        console.log('  About:', Object.keys(cleanedData.about || {}).length, 'categories');
        console.log('  Metadata:', Object.keys(cleanedData.metadata || {}).length, 'fields');

        console.log('\nPreview:');
        console.log(JSON.stringify(cleanedData, null, 2).substring(0, 2500));

        return cleanedData;
    }

    return executeExtraction().catch(error => {
        console.error('Error:', error.message);
        console.error(error.stack);
        return null;
    });

})();
