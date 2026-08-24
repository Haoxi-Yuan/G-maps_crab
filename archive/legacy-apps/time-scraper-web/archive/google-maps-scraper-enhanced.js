/**
 * Google Maps Data Scraper Pipeline - Enhanced Version
 *
 * Aligned with notebook data structure, new features:
 * 1. About information extraction (multiple categorized attributes)
 * 2. Metadata extraction (data-tooltip, aria-label)
 * 3. Categories extraction fix (ensure successful extraction)
 * 4. Main category extraction
 * 5. Detailed reviews extraction (via API)
 *
 * Based on original v3.4 version with extensions
 */

(function() {
    'use strict';

    console.log('=== Google Maps Scraper Pipeline - Enhanced ===');
    console.log('New features: About, Metadata, Reviews, Enhanced Categories\n');

    // ============================================
    // Original utility functions retained (reused)
    // ============================================

    const ADDRESS_HINT_RE = /(street|st\b|road|rd\b|avenue|ave\b|drive|dr\b|lane|ln\b|boulevard|blvd\b|way\b|circle|cir\b|court|ct\b|place|pl\b|square|sq\b|parkway|pkwy\b|highway|hwy\b|jalan|lorong|plaza|mall|center|centre|park|building|blk|block|suite|unit|floor|level|#)/i;
    const CATEGORY_HINT_RE = /(restaurant|cafe|hospital|clinic|shop|store|mall|hotel|bank|school|park|museum|gym|salon|spa|bar|hawker|stall|food|eatery|diner|bistro|grill|kitchen|bakery|pharmacy|supermarket|market|station|terminal|airport|beach|garden|trail|boardwalk|viewpoint|library|temple|church|mosque|shrine|theater|theatre)/i;
    const CATEGORY_BLACKLIST_RE = /(review|open|closed|direction|website|phone|address|rating)/i;

    function safeText(el) {
        return el ? String(el.textContent || '').trim() : '';
    }

    function normalizeLabel(label) {
        return String(label || '')
            .replace(/\u202f/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
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

    // ============================================
    // NEW: About information extraction
    // ============================================

    async function extractAboutData() {
        console.log('[Enhanced] Extracting About data...');

        const aboutData = {};

        try {
            // Find and click About tab
            const tabs = Array.from(document.querySelectorAll('button.hh2c6, button[role="tab"]'));
            const aboutTab = tabs.find(tab =>
                tab.textContent.toLowerCase().includes('about') ||
                tab.getAttribute('aria-label')?.toLowerCase().includes('about')
            );

            if (aboutTab) {
                console.log('  Found About tab, clicking...');
                aboutTab.click();

                // Wait for content to load
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Extract About categorized data
                const sections = document.querySelectorAll('div.iP2t7d.fontBodyMedium, div.iP2t7d');

                sections.forEach(section => {
                    // Extract category name
                    const h2 = section.querySelector('h2.iL3Qke, h2');
                    if (!h2) return;

                    const category = h2.textContent.trim();
                    if (!category) return;

                    const items = [];

                    // Extract list items
                    const ul = section.querySelector('ul.ZQ6we, ul');
                    if (ul) {
                        const listItems = ul.querySelectorAll('li');
                        listItems.forEach(li => {
                            const div = li.querySelector('div');
                            if (div) {
                                const spans = div.querySelectorAll('span');
                                // Usually the second span contains actual content
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

                console.log('  About categories found:', Object.keys(aboutData).length);
            } else {
                console.log('  About tab not found');
            }
        } catch (err) {
            console.error('  Error extracting About data:', err.message);
        }

        return aboutData;
    }

    // ============================================
    // NEW: Metadata extraction
    // ============================================

    function extractMetadata() {
        console.log('[Enhanced] Extracting metadata...');

        const metadata = {};

        try {
            // Extract metadata from RcCsl containers
            const metadataContainers = document.querySelectorAll('div.RcCsl');

            metadataContainers.forEach(container => {
                // Extract data-tooltip from buttons
                const button = container.querySelector('button[data-tooltip]');
                if (button) {
                    const key = button.getAttribute('data-tooltip');
                    const value = button.textContent.trim();
                    if (key && value) {
                        metadata[key] = value;
                    }
                }

                // Extract data-tooltip from links
                const link = container.querySelector('a[data-tooltip]');
                if (link) {
                    const key = link.getAttribute('data-tooltip');
                    const value = link.textContent.trim();
                    if (key && value) {
                        metadata[key] = value;
                    }
                }

                // Extract aria-label from spans
                const spans = container.querySelectorAll('span[aria-label]');
                spans.forEach(span => {
                    const label = span.getAttribute('aria-label');
                    if (label) {
                        const key = 'Additional Info';
                        const value = label.trim();
                        // Merge multiple Additional Info
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

            console.log('  Metadata fields found:', Object.keys(metadata).length);
        } catch (err) {
            console.error('  Error extracting metadata:', err.message);
        }

        return metadata;
    }

    // ============================================
    // NEW: Enhanced Categories extraction
    // ============================================

    function extractCategoriesEnhanced() {
        console.log('[Enhanced] Extracting categories (enhanced)...');

        let categories = [];

        try {
            // Method 1: Extract from category buttons in DOM
            const categorySelectors = [
                'button[jsaction*="pane.rating.category"]',
                'button[jsaction*="pane.rating.more"]',
                'button[aria-label*="categories"]',
                '[data-item-id="category"]'
            ];

            for (const selector of categorySelectors) {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    const text = el.textContent.trim();
                    if (text) {
                        // Use original parseCategoryText logic
                        const parts = text
                            .replace(/\(\s*\d+[^\)]*\)/g, '')
                            .replace(/\d+(\.\d+)?/g, '')
                            .split(/[\u00b7\u2022|]/)
                            .map(item => item.trim())
                            .filter(item =>
                                item.length >= 3 &&
                                item.length <= 60 &&
                                !CATEGORY_BLACKLIST_RE.test(item)
                            );
                        categories.push(...parts);
                    }
                });

                if (categories.length > 0) break;
            }

            // Method 2: Extract from aria-label
            if (categories.length === 0) {
                const ariaElements = document.querySelectorAll('[aria-label]');
                ariaElements.forEach(el => {
                    const label = el.getAttribute('aria-label') || '';
                    const categoryMatch = label.match(/^(.+?)\s+\d+\s*reviews?/i);
                    if (categoryMatch) {
                        const cat = categoryMatch[1].trim();
                        if (cat.length >= 3 && cat.length <= 60 && CATEGORY_HINT_RE.test(cat)) {
                            categories.push(cat);
                        }
                    }
                });
            }

            categories = uniqueStrings(categories);
            console.log('  Categories found:', categories.length);
            if (categories.length > 0) {
                console.log('  Categories:', categories);
            }
        } catch (err) {
            console.error('  Error extracting categories:', err.message);
        }

        return categories.length > 0 ? categories : null;
    }

    // ============================================
    // NEW: Reviews data extraction (basic version - DOM)
    // ============================================

    async function extractReviewsBasic() {
        console.log('[Enhanced] Extracting reviews (basic DOM extraction)...');

        const reviews = [];

        try {
            // Click reviews tab
            const reviewsTab = Array.from(document.querySelectorAll('button[role="tab"]'))
                .find(tab => tab.textContent.toLowerCase().includes('review'));

            if (reviewsTab) {
                reviewsTab.click();
                await new Promise(resolve => setTimeout(resolve, 1500));

                // Extract visible reviews
                const reviewElements = document.querySelectorAll('[data-review-id], div[jsaction*="review"]');

                reviewElements.forEach((el, index) => {
                    if (index >= 10) return; // Only extract first 10 reviews

                    try {
                        const review = {
                            review_id: el.getAttribute('data-review-id') || `dom_${index}`,
                            rating: null,
                            review_text: null,
                            published_at: null,
                            reviewer_name: null
                        };

                        // Extract rating
                        const ratingEl = el.querySelector('[role="img"][aria-label*="star"]');
                        if (ratingEl) {
                            const match = (ratingEl.getAttribute('aria-label') || '').match(/(\d+)\s*star/i);
                            if (match) review.rating = parseInt(match[1]);
                        }

                        // Extract review text
                        const textEl = el.querySelector('span[jsan], span.wiI7pd, div.MyEned');
                        if (textEl) review.review_text = textEl.textContent.trim();

                        // Extract published time
                        const timeEl = el.querySelector('span.rsqaWe, span[class*="time"]');
                        if (timeEl) review.published_at = timeEl.textContent.trim();

                        // Extract reviewer name
                        const nameEl = el.querySelector('button[aria-label], div.d4r55');
                        if (nameEl) review.reviewer_name = nameEl.textContent.trim();

                        if (review.review_text || review.rating) {
                            reviews.push(review);
                        }
                    } catch (err) {
                        // Skip this review
                    }
                });

                console.log('  Reviews extracted:', reviews.length);
            } else {
                console.log('  Reviews tab not found');
            }
        } catch (err) {
            console.error('  Error extracting reviews:', err.message);
        }

        return reviews;
    }

    // ============================================
    // Main extraction function (enhanced version)
    // ============================================

    async function extractEnhancedData() {
        console.log('\n=== Starting Enhanced Extraction ===\n');

        // Get basic data (using original pipeline logic)
        const h1 = document.querySelector('h1');
        const businessName = h1 ? h1.innerText.trim() : null;

        console.log('Business name:', businessName);

        // Extract enhanced data
        const enhancedData = {
            timestamp: new Date().toISOString(),
            url: window.location.href,
            place_id: null,
            name: businessName,

            // Basic information (retain original extraction logic)
            main_category: null,
            categories: null,
            rating: null,
            reviews: null,
            address: null,
            website: null,
            phone: null,
            coordinates: null,

            // New fields
            About: {},
            metadata: {},
            popular_times: {},
            open_hours: {},
            detailed_reviews: [],

            status: 'success'
        };

        // 1. Extract Categories (enhanced version)
        enhancedData.categories = extractCategoriesEnhanced();
        if (enhancedData.categories && enhancedData.categories.length > 0) {
            enhancedData.main_category = enhancedData.categories[0];
        }

        // 2. Extract basic information (reuse original logic)
        // Rating
        const ratingSpan = document.querySelector('[role="img"][aria-label*="star"]');
        if (ratingSpan) {
            const match = (ratingSpan.getAttribute('aria-label') || '').match(/([\d.]+)\s*star/i);
            if (match) enhancedData.rating = parseFloat(match[1]);
        }

        // Review count
        const reviewBtn = document.querySelector('button[jsaction*="pane.reviewChart.moreReviews"], button[aria-label*="review"]');
        if (reviewBtn) {
            const label = reviewBtn.getAttribute('aria-label') || reviewBtn.textContent;
            const match = label.match(/([\d,]+)/);
            if (match) {
                enhancedData.reviews = parseInt(match[1].replace(/,/g, ''), 10);
            }
        }

        // Address
        const addressEl = document.querySelector('[data-item-id="address"] .fontBodyMedium, [data-item-id="address"]');
        if (addressEl) enhancedData.address = addressEl.textContent.trim();

        // Website
        const websiteLink = document.querySelector('[data-item-id="authority"] a, a[data-item-id="authority"]');
        if (websiteLink) {
            enhancedData.website = websiteLink.getAttribute('href') || websiteLink.textContent.trim();
        }

        // Phone
        const phoneEl = document.querySelector('[data-item-id^="phone"] .fontBodyMedium, [data-item-id^="phone"]');
        if (phoneEl) enhancedData.phone = phoneEl.textContent.trim();

        // Place ID from URL
        const urlPlaceIdMatch = enhancedData.url.match(/place_id[=:]([A-Za-z0-9_-]+)/);
        if (urlPlaceIdMatch) {
            enhancedData.place_id = urlPlaceIdMatch[1];
        } else {
            // Try ChIJ format
            const chijMatch = enhancedData.url.match(/!1s(ChIJ[^!]+)/);
            if (chijMatch) enhancedData.place_id = decodeURIComponent(chijMatch[1]);
        }

        // Coordinates from URL
        const coordMatch = enhancedData.url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
        if (coordMatch) {
            enhancedData.coordinates = {
                latitude: parseFloat(coordMatch[1]),
                longitude: parseFloat(coordMatch[2])
            };
        }

        // 3. Extract Metadata
        enhancedData.metadata = extractMetadata();

        // 4. Extract About information
        enhancedData.About = await extractAboutData();

        // 5. Extract Popular Times (simplified version - from aria-label)
        const popularLabels = Array.from(document.querySelectorAll('[aria-label]'))
            .map(el => el.getAttribute('aria-label'))
            .filter(label => label && /\d+%\s*busy\s*at/i.test(label));

        if (popularLabels.length > 0) {
            // Organize data by day
            const dayMap = {
                0: "Monday", 1: "Tuesday", 2: "Wednesday", 3: "Thursday",
                4: "Friday", 5: "Saturday", 6: "Sunday"
            };

            let currentDay = 0;
            enhancedData.popular_times[dayMap[currentDay]] = {};

            popularLabels.forEach(label => {
                const match = label.match(/(\d+)%\s*busy\s*at\s*(\d{1,2})\s*([ap])\.?m/i);
                if (match) {
                    const percentage = parseInt(match[1]);
                    const hour = match[2];
                    const ampm = match[3].toLowerCase() + 'm';
                    const timeKey = `${hour} ${ampm}.`;

                    if (!enhancedData.popular_times[dayMap[currentDay]]) {
                        enhancedData.popular_times[dayMap[currentDay]] = {};
                    }
                    enhancedData.popular_times[dayMap[currentDay]][timeKey] = percentage;
                }
            });
        }

        // 6. Extract opening hours
        const hoursRows = document.querySelectorAll('[role="row"]');
        hoursRows.forEach(row => {
            const text = row.innerText.trim();
            const dayMatch = text.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(.+)/i);
            if (dayMatch) {
                const day = dayMatch[1];
                const hours = dayMatch[2];
                if (!enhancedData.open_hours) enhancedData.open_hours = {};
                enhancedData.open_hours[day] = hours;
            }
        });

        // 7. Extract reviews (basic version)
        // Note: Full reviews require API calls, here we only extract visible DOM reviews
        enhancedData.detailed_reviews = await extractReviewsBasic();

        console.log('\n=== Enhanced Extraction Complete ===\n');
        console.log('Summary:');
        console.log('  Name:', enhancedData.name);
        console.log('  Place ID:', enhancedData.place_id);
        console.log('  Main Category:', enhancedData.main_category);
        console.log('  Categories:', enhancedData.categories ? enhancedData.categories.length : 0);
        console.log('  Rating:', enhancedData.rating);
        console.log('  Reviews:', enhancedData.reviews);
        console.log('  Address:', enhancedData.address ? 'Found' : 'N/A');
        console.log('  Website:', enhancedData.website ? 'Found' : 'N/A');
        console.log('  Phone:', enhancedData.phone ? 'Found' : 'N/A');
        console.log('  Metadata fields:', Object.keys(enhancedData.metadata).length);
        console.log('  About categories:', Object.keys(enhancedData.About).length);
        console.log('  Popular times days:', Object.keys(enhancedData.popular_times).length);
        console.log('  Open hours days:', Object.keys(enhancedData.open_hours).length);
        console.log('  Detailed reviews:', enhancedData.detailed_reviews.length);

        return enhancedData;
    }

    // ============================================
    // Execute extraction
    // ============================================

    // Export as global variable for external calls
    window.__extractEnhancedData = extractEnhancedData;

    // Execute immediately and return
    return extractEnhancedData();

})();
