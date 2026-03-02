#!/usr/bin/env node
'use strict';

/**
 * Automated test for reviews extraction
 * Runs completely automatically and exits
 */

const { chromium } = require('playwright');
const fs = require('fs');

async function testReviewsAuto() {
    console.log('=== Automated Reviews Extraction Test ===\n');

    const browser = await chromium.launch({
        headless: false,
        slowMo: 500  // Match direct_url test config
    });

    const context = await browser.newContext({
        locale: 'en-SG',
        timezoneId: 'Asia/Singapore'
    });

    const page = await context.newPage();

    // Listen to browser console for debugging
    page.on('console', msg => {
        const text = msg.text();
        // Output all console messages from the browser
        console.log('Browser:', text);
    });

    const testPlaceId = 'ChIJo3EXjvAZ2jERRdFfHa-rqT8'; // Cappadocia Restaurant

    console.log('Testing place:', testPlaceId);

    try {
        // First try: load with search API to initialize
        console.log('Step 1: Initial load...');
        await page.goto(`https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${testPlaceId}`,
                       { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        // Second try: load with full interface URL
        console.log('Step 2: Loading full interface...\n');
        await page.goto(`https://www.google.com/maps/place/?q=place_id:${testPlaceId}&hl=en`,
                       { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('h1', { timeout: 30000 });
        await page.waitForTimeout(4000);

        console.log('Page fully loaded. Checking available tabs...\n');

        // First check tabs outside of evaluate
        const availableTabs = await page.evaluate(() => {
            const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
            return tabs.map(t => t.textContent.trim());
        });

        console.log('Available tabs:', availableTabs.join(', '));
        console.log('');

        const result = await page.evaluate(async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));

            // Debug: find all possible tab selectors
            const tabSelectors = [
                'button[role="tab"]',
                'button.hh2c6',
                'div[role="tab"]',
                'button'
            ];

            let tabs = [];
            let reviewsTab = null;

            for (const selector of tabSelectors) {
                tabs = Array.from(document.querySelectorAll(selector));
                reviewsTab = tabs.find(tab => {
                    const text = tab.textContent.toLowerCase();
                    const aria = (tab.getAttribute('aria-label') || '').toLowerCase();
                    return text.includes('review') || aria.includes('review');
                });
                if (reviewsTab) break;
            }

            // If no explicit Reviews tab, try Overview
            if (!reviewsTab) {
                reviewsTab = tabs.find(tab =>
                    tab.textContent.toLowerCase().includes('overview')
                );
            }

            if (!reviewsTab) {
                const availableTabs = tabs.map(t => t.textContent.trim()).filter(Boolean);
                return {
                    error: 'No suitable tab found',
                    debug: {
                        totalTabs: tabs.length,
                        availableTabs: availableTabs.slice(0, 10)
                    }
                };
            }

            reviewsTab.click();
            await sleep(2000);

            // Look for and click reviews section/button
            const reviewsButtons = [
                'button[aria-label*="reviews" i]',
                'button[aria-label*="Reviews"]',
                'a[href*="reviews"]',
                'div[aria-label*="reviews" i]'
            ];

            for (const selector of reviewsButtons) {
                const btn = document.querySelector(selector);
                if (btn) {
                    btn.click();
                    await sleep(2000);
                    break;
                }
            }

            const scrollableSelectors = [
                'div.m6QErb.DxyBCb.kA9KIf.dS8AEf',
                'div[role="main"]'
            ];

            let scrollContainer = null;
            for (const selector of scrollableSelectors) {
                const container = document.querySelector(selector);
                if (container && container.scrollHeight > container.clientHeight) {
                    scrollContainer = container;
                    break;
                }
            }

            if (!scrollContainer) {
                return { error: 'Scrollable container not found' };
            }

            // Initial scroll to trigger review loading
            scrollContainer.scrollBy(0, 300);
            await sleep(2000); // Wait for reviews to load after scroll

            // Strategy: Find star ratings first, then locate review containers
            const starRatings = document.querySelectorAll('[role="img"][aria-label*="star"]');

            const debug = {
                starRatingsFound: starRatings.length,
                selectorsAttempted: [],
                elementsFound: [],
                reviewContainerPatterns: []
            };

            // If we found star ratings, analyze their container structure
            if (starRatings.length > 0) {
                const firstStar = starRatings[0];
                let parent = firstStar.parentElement;
                let depth = 0;

                // Walk up the DOM tree to find the review container
                while (parent && depth < 10) {
                    const className = parent.className || '';
                    const hasDataReviewId = parent.hasAttribute('data-review-id');
                    const hasJslog = parent.hasAttribute('jslog');
                    const childCount = parent.children.length;

                    debug.reviewContainerPatterns.push({
                        depth: depth,
                        tagName: parent.tagName,
                        className: className,
                        hasDataReviewId: hasDataReviewId,
                        hasJslog: hasJslog,
                        childCount: childCount,
                        textLength: parent.textContent.length
                    });

                    // Likely review container if:
                    // - Has 3-10 children
                    // - Text length > 50 characters
                    // - Has specific attributes
                    if ((childCount >= 3 && childCount <= 15 && parent.textContent.length > 50) ||
                        hasDataReviewId || hasJslog) {
                        debug.likelyContainer = {
                            className: className,
                            depth: depth,
                            selector: className.split(' ')[0]
                        };
                        break;
                    }

                    parent = parent.parentElement;
                    depth++;
                }
            }

            // Now try to find all reviews using the identified pattern
            const reviewSelectors = [
                'div.jftiEf',
                'div.jJc9Ad',
                'div[data-review-id]',
                'div[jslog*="review"]'
            ];

            // Add the likely container class if found
            if (debug.likelyContainer && debug.likelyContainer.selector) {
                reviewSelectors.unshift(`div.${debug.likelyContainer.selector}`);
            }

            for (const selector of reviewSelectors) {
                const elements = document.querySelectorAll(selector);
                debug.selectorsAttempted.push({
                    selector: selector,
                    count: elements.length
                });
                if (elements.length > 0) {
                    debug.elementsFound.push({
                        selector: selector,
                        count: elements.length,
                        firstElementClasses: elements[0].className,
                        firstElementText: elements[0].textContent.substring(0, 100)
                    });
                }
            }

            const reviews = [];
            const seenReviewIds = new Set();
            const maxScrolls = 10;
            let scrollAttempts = 0;

            // Determine which selector to use
            let reviewSelector = 'div.jftiEf, div.jJc9Ad, div[data-review-id]';
            if (debug.likelyContainer && debug.likelyContainer.selector) {
                reviewSelector = `div.${debug.likelyContainer.selector}`;
            } else if (starRatings.length > 0) {
                // Fallback: use parent of star rating
                const firstStar = starRatings[0];
                const containers = Array.from(starRatings).map(star => {
                    let p = star.parentElement;
                    for (let i = 0; i < 5 && p; i++) {
                        if (p.textContent.length > 100) return p;
                        p = p.parentElement;
                    }
                    return null;
                }).filter(Boolean);

                if (containers.length > 0) {
                    const className = containers[0].className.split(' ')[0];
                    if (className) reviewSelector = `div.${className}`;
                }
            }

            debug.finalSelector = reviewSelector;

            while (scrollAttempts < maxScrolls) {
                // Find all star ratings and their containers
                const starElements = scrollContainer.querySelectorAll('[role="img"][aria-label*="star"]');

                starElements.forEach((starEl) => {
                    // Find the review container (go up the tree)
                    // Need to find a container that includes reviewer name (.d4r55)
                    let container = starEl.parentElement;
                    let foundContainer = null;

                    for (let i = 0; i < 12 && container; i++) {
                        // Check if this container has a .d4r55 element (reviewer name)
                        const hasReviewerName = container.querySelector('.d4r55');
                        const hasSubstantialContent = container.textContent.length > 80;

                        // Found a good container if it has both reviewer name and content
                        if (hasReviewerName && hasSubstantialContent) {
                            foundContainer = container;
                            break;
                        }

                        container = container.parentElement;
                    }

                    container = foundContainer;
                    if (!container) return;

                    // Create a unique ID based on position or content
                    const reviewId = container.getAttribute('data-review-id') ||
                                   container.getAttribute('jslog') ||
                                   `review_${reviews.length}`;

                    if (seenReviewIds.has(reviewId)) return;
                    seenReviewIds.add(reviewId);

                    const review = {
                        review_id: reviewId,
                        rating: null,
                        review_text: null,
                        published_at: null,
                        reviewer_name: null
                    };

                    // Extract rating - handle both formats
                    const ariaLabel = starEl.getAttribute('aria-label');
                    if (ariaLabel) {
                        // Try "X stars" or "X star" format
                        let match = ariaLabel.match(/(\d+)\s*stars?/i);
                        if (match) {
                            review.rating = parseInt(match[1]);
                        } else {
                            // Try "X out of 5 stars" format
                            match = ariaLabel.match(/(\d+)\s*out of/i);
                            if (match) review.rating = parseInt(match[1]);
                        }
                    }

                    // Extract review text - try multiple selectors
                    const textSelectors = [
                        'span.wiI7pd',
                        'div.MyEned span',
                        'span[jsan]',
                        'span.review-full-text'
                    ];

                    for (const selector of textSelectors) {
                        const textEl = container.querySelector(selector);
                        if (textEl && textEl.textContent.trim().length > 10) {
                            review.review_text = textEl.textContent.trim();
                            break;
                        }
                    }

                    // Extract time
                    const timeSelectors = [
                        'span.rsqaWe',
                        'span[class*="time"]',
                        'span.DZSIDd span'
                    ];

                    for (const selector of timeSelectors) {
                        const timeEl = container.querySelector(selector);
                        if (timeEl && timeEl.textContent.trim()) {
                            review.published_at = timeEl.textContent.trim();
                            break;
                        }
                    }

                    // Extract reviewer name
                    // Debug: Log structure for first 3 review containers (BEFORE de-duplication)
                    const currentCount = seenReviewIds.size;
                    if (currentCount < 3) {
                        console.log(`\n[Debug Review #${currentCount}]`);
                        console.log(`  Container tag: ${container.tagName}, class: "${container.className}"`);
                        console.log(`  Container has ${container.children.length} children`);
                        console.log(`  Text content length: ${container.textContent.length}`);

                        // Check for common name elements
                        const d4r55 = container.querySelectorAll('.d4r55');
                        const buttons = container.querySelectorAll('button');
                        const links = container.querySelectorAll('a');

                        console.log(`  Found: ${d4r55.length} .d4r55 elements, ${buttons.length} buttons, ${links.length} links`);

                        if (d4r55.length > 0) {
                            console.log(`  First .d4r55 text: "${Array.from(d4r55).map(e => e.textContent.trim().substring(0, 50)).join(' | ')}"`);
                        }
                        if (buttons.length > 0) {
                            console.log(`  Button texts: ${Array.from(buttons).slice(0, 3).map(b => '"' + b.textContent.trim().substring(0, 30) + '"').join(', ')}`);
                        }
                    }

                    const nameSelectors = [
                        '.d4r55.fontTitleMedium',
                        'button[data-href*="/maps/contrib/"]',
                        'a[href*="/maps/contrib/"]',
                        '.d4r55',
                        'div.d4r55',
                        'button.WEBjve'
                    ];

                    for (const selector of nameSelectors) {
                        const nameEl = container.querySelector(selector);

                        if (currentCount < 3) {
                            if (nameEl) {
                                const text = nameEl.textContent.trim();
                                console.log(`[Debug] Selector "${selector}" found: "${text.substring(0, 100)}"`);
                            } else {
                                console.log(`[Debug] Selector "${selector}" NOT found`);
                            }
                        }

                        if (nameEl) {
                            const text = nameEl.textContent.trim();
                            const textLower = text.toLowerCase();

                            // Filter out unwanted texts
                            if (text &&
                                !textLower.includes('more') &&
                                !textLower.includes('photo') &&
                                !textLower.includes('local guide') &&
                                text.length < 100 &&
                                text.split(' ').length <= 5) {  // Names are usually 1-5 words
                                review.reviewer_name = text;
                                if (currentCount < 3) {
                                    console.log(`[Debug] ✓ Selected name: "${text}"`);
                                }
                                break;
                            }
                        }
                    }

                    // Fallback: Try to parse from button aria-label
                    if (!review.reviewer_name) {
                        const btnWithAria = container.querySelector('button[aria-label]');
                        if (btnWithAria) {
                            const aria = btnWithAria.getAttribute('aria-label');
                            if (aria && !aria.toLowerCase().includes('more')) {
                                // Extract from patterns like "Photo of John Doe" or "Profile of John Doe"
                                const match = aria.match(/(?:photo|profile)\s+of\s+(.+)/i);
                                if (match) {
                                    review.reviewer_name = match[1].trim();
                                    if (reviews.length < 2) {
                                        console.log(`[Debug] ✓ Extracted from aria-label: "${review.reviewer_name}"`);
                                    }
                                }
                            }
                        }
                    }

                    // Only add if we have meaningful data
                    if (review.rating || (review.review_text && review.review_text.length > 10)) {
                        reviews.push(review);
                    }
                });

                // Check if we got new reviews
                const reviewCountBefore = reviews.length;

                // Scroll down
                const scrollBefore = scrollContainer.scrollTop;
                scrollContainer.scrollBy(0, scrollContainer.clientHeight * 0.8);
                await sleep(1000); // Increased wait time

                // Check if we reached bottom or no new reviews
                if (scrollBefore === scrollContainer.scrollTop) {
                    console.log('Reached bottom');
                    break;
                }

                scrollAttempts++;

                // Stop if no new reviews after scrolling
                if (reviews.length === reviewCountBefore && scrollAttempts > 2) {
                    console.log('No new reviews after scroll');
                }
            }

            return {
                success: true,
                totalReviews: reviews.length,
                scrollAttempts: scrollAttempts,
                reviews: reviews,
                debug: debug
            };
        });

        if (result.error) {
            console.error('ERROR:', result.error);
            process.exit(1);
        }

        console.log('=== Test Results ===\n');
        console.log('Success:', result.success);
        console.log('Total reviews extracted:', result.totalReviews);
        console.log('Scroll attempts:', result.scrollAttempts);

        // Show debug info
        if (result.debug) {
            console.log('\n=== Debug Information ===');
            console.log('Star ratings found:', result.debug.starRatingsFound);

            if (result.debug.likelyContainer) {
                console.log('Likely container identified:');
                console.log(`  Depth: ${result.debug.likelyContainer.depth}`);
                console.log(`  Class: ${result.debug.likelyContainer.className}`);
                console.log(`  Selector: ${result.debug.likelyContainer.selector}`);
            }

            if (result.debug.finalSelector) {
                console.log('Final selector used:', result.debug.finalSelector);
            }

            if (result.totalReviews === 0) {
                console.log('\nSelectors attempted:');
                result.debug.selectorsAttempted.forEach(s => {
                    console.log(`  ${s.selector}: ${s.count} elements`);
                });

                if (result.debug.reviewContainerPatterns && result.debug.reviewContainerPatterns.length > 0) {
                    console.log('\nContainer hierarchy from star rating:');
                    result.debug.reviewContainerPatterns.slice(0, 5).forEach(p => {
                        console.log(`  Depth ${p.depth}: ${p.tagName}.${p.className.split(' ')[0] || 'no-class'}`);
                        console.log(`    Children: ${p.childCount}, Text length: ${p.textLength}`);
                    });
                }
            }
        }

        const reviewsWithText = result.reviews.filter(r => r.review_text).length;
        const reviewsWithRating = result.reviews.filter(r => r.rating).length;

        if (result.totalReviews > 0) {
            console.log('\nData Quality:');
            console.log(`  Reviews with text: ${reviewsWithText} (${((reviewsWithText/result.totalReviews)*100).toFixed(1)}%)`);
            console.log(`  Reviews with rating: ${reviewsWithRating} (${((reviewsWithRating/result.totalReviews)*100).toFixed(1)}%)`);
        }

        if (result.reviews.length > 0) {
            console.log('\nSample Review:');
            console.log(JSON.stringify(result.reviews[0], null, 2));
        }

        const outputPath = '/Volumes/Data/time_scraper/output/test_reviews_auto.json';
        fs.mkdirSync('/Volumes/Data/time_scraper/output', { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
        console.log('\nFull results saved to:', outputPath);

        console.log('\n=== Conclusion ===');
        if (result.totalReviews > 5 && reviewsWithText > result.totalReviews * 0.7) {
            console.log('SUCCESS: Scrolling method works! Can extract reviews effectively.');
        } else {
            console.log('PARTIAL: Method works but may need selector adjustments.');
        }

    } catch (err) {
        console.error('\nTest Failed:', err.message);
        await browser.close();
        process.exit(1);
    }

    await browser.close();
    console.log('\nTest completed.');
}

testReviewsAuto().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
