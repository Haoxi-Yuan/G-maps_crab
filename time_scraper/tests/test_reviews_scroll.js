#!/usr/bin/env node
'use strict';

/**
 * Test script for extracting reviews by scrolling
 * Tests if we can get review data by scrolling the reviews sidebar
 */

const { chromium } = require('playwright');
const fs = require('fs');

async function testReviewsScrolling() {
    console.log('=== Testing Reviews Extraction by Scrolling ===\n');

    const browser = await chromium.launch({
        headless: false,
        slowMo: 100
    });

    const context = await browser.newContext({
        locale: 'en-SG',
        timezoneId: 'Asia/Singapore'
    });

    const page = await context.newPage();

    // Use a place with many reviews for testing
    const testPlaceId = 'ChIJo3EXjvAZ2jERRdFfHa-rqT8'; // Cappadocia Restaurant (7958 reviews)
    const url = `https://www.google.com/maps/place/?q=place_id:${testPlaceId}&hl=en`;

    console.log('Testing with:', url);
    console.log('This place has ~8000 reviews\n');

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('h1', { timeout: 30000 });
        await page.waitForTimeout(2000);

        console.log('Page loaded, extracting reviews...\n');

        const result = await page.evaluate(async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));

            // Find and click Reviews tab
            const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
            const reviewsTab = tabs.find(tab =>
                tab.textContent.toLowerCase().includes('review')
            );

            if (!reviewsTab) {
                return { error: 'Reviews tab not found' };
            }

            console.log('Clicking Reviews tab...');
            reviewsTab.click();
            await sleep(2000);

            // Find scrollable reviews container
            const scrollableContainers = [
                'div.m6QErb.DxyBCb.kA9KIf.dS8AEf', // Main scrollable container
                'div[role="main"]',
                '.section-layout',
                'div.m6QErb'
            ];

            let scrollContainer = null;
            for (const selector of scrollableContainers) {
                const container = document.querySelector(selector);
                if (container && container.scrollHeight > container.clientHeight) {
                    scrollContainer = container;
                    console.log('Found scrollable container:', selector);
                    break;
                }
            }

            if (!scrollContainer) {
                return { error: 'Scrollable container not found' };
            }

            const reviews = [];
            const seenReviewIds = new Set();
            let scrollAttempts = 0;
            const maxScrolls = 20; // Limit scrolls for testing
            let lastReviewCount = 0;
            let noNewReviewsCount = 0;

            console.log('Starting to scroll and extract reviews...');

            while (scrollAttempts < maxScrolls) {
                // Extract reviews from current viewport
                const reviewElements = document.querySelectorAll('div.jftiEf, div.jJc9Ad, div[data-review-id]');

                reviewElements.forEach((el) => {
                    try {
                        // Get review ID to avoid duplicates
                        const reviewId = el.getAttribute('data-review-id') ||
                                       el.querySelector('[data-review-id]')?.getAttribute('data-review-id') ||
                                       `scroll_${reviews.length}`;

                        if (seenReviewIds.has(reviewId)) return;
                        seenReviewIds.add(reviewId);

                        const review = {
                            review_id: reviewId,
                            rating: null,
                            review_text: null,
                            published_at: null,
                            reviewer_name: null,
                            reviewer_photo_count: null,
                            reviewer_review_count: null,
                            is_local_guide: false,
                            review_images: []
                        };

                        // Extract rating
                        const ratingEl = el.querySelector('[role="img"][aria-label*="star"]');
                        if (ratingEl) {
                            const ariaLabel = ratingEl.getAttribute('aria-label');
                            const match = ariaLabel.match(/(\d+)\s*star/i);
                            if (match) review.rating = parseInt(match[1]);
                        }

                        // Extract review text
                        const textSelectors = [
                            'span.wiI7pd',
                            'div.MyEned',
                            'span[jsan]',
                            'div.MyEned span'
                        ];
                        for (const selector of textSelectors) {
                            const textEl = el.querySelector(selector);
                            if (textEl && textEl.textContent.trim()) {
                                review.review_text = textEl.textContent.trim();
                                break;
                            }
                        }

                        // Extract published time
                        const timeSelectors = [
                            'span.rsqaWe',
                            'span.DZSIDd span',
                            'span[class*="time"]'
                        ];
                        for (const selector of timeSelectors) {
                            const timeEl = el.querySelector(selector);
                            if (timeEl) {
                                review.published_at = timeEl.textContent.trim();
                                break;
                            }
                        }

                        // Extract reviewer name
                        const nameEl = el.querySelector('div.d4r55, button[aria-label]');
                        if (nameEl) {
                            review.reviewer_name = nameEl.textContent.trim();
                        }

                        // Extract reviewer stats (photos, reviews)
                        const statsText = el.textContent;
                        const photoMatch = statsText.match(/(\d+)\s*photo/i);
                        if (photoMatch) review.reviewer_photo_count = parseInt(photoMatch[1]);

                        const reviewMatch = statsText.match(/(\d+)\s*review/i);
                        if (reviewMatch) review.reviewer_review_count = parseInt(reviewMatch[1]);

                        // Check if Local Guide
                        if (statsText.toLowerCase().includes('local guide')) {
                            review.is_local_guide = true;
                        }

                        // Extract review images
                        const imageElements = el.querySelectorAll('button[aria-label*="photo"] img, button[jsaction*="photo"] img');
                        imageElements.forEach(img => {
                            const src = img.src || img.getAttribute('data-src');
                            if (src && !src.includes('avatar')) {
                                review.review_images.push(src);
                            }
                        });

                        // Only add if we have at least rating or text
                        if (review.rating || review.review_text) {
                            reviews.push(review);
                        }

                    } catch (err) {
                        console.error('Error extracting review:', err.message);
                    }
                });

                // Check if we got new reviews
                if (reviews.length === lastReviewCount) {
                    noNewReviewsCount++;
                    if (noNewReviewsCount >= 3) {
                        console.log('No new reviews found after 3 scrolls, stopping...');
                        break;
                    }
                } else {
                    noNewReviewsCount = 0;
                    lastReviewCount = reviews.length;
                }

                console.log(`Scroll ${scrollAttempts + 1}: Found ${reviews.length} total reviews`);

                // Scroll down
                const scrollBefore = scrollContainer.scrollTop;
                scrollContainer.scrollBy(0, scrollContainer.clientHeight * 0.8);
                await sleep(800); // Wait for new content to load

                // Check if we reached the bottom
                const scrollAfter = scrollContainer.scrollTop;
                if (scrollBefore === scrollAfter) {
                    console.log('Reached bottom of reviews');
                    break;
                }

                scrollAttempts++;
            }

            return {
                success: true,
                totalReviews: reviews.length,
                scrollAttempts: scrollAttempts,
                reviews: reviews,
                sampleReview: reviews[0] || null
            };
        });

        console.log('\n=== Test Results ===\n');

        if (result.error) {
            console.error('Error:', result.error);
        } else {
            console.log('Success:', result.success);
            console.log('Total reviews extracted:', result.totalReviews);
            console.log('Scroll attempts:', result.scrollAttempts);
            console.log('\nSample review:');
            console.log(JSON.stringify(result.sampleReview, null, 2));

            // Analyze data quality
            const reviewsWithText = result.reviews.filter(r => r.review_text).length;
            const reviewsWithRating = result.reviews.filter(r => r.rating).length;
            const reviewsWithImages = result.reviews.filter(r => r.review_images.length > 0).length;
            const reviewsWithReviewerStats = result.reviews.filter(r => r.reviewer_review_count).length;

            console.log('\n=== Data Quality Analysis ===');
            console.log(`Reviews with text: ${reviewsWithText} (${((reviewsWithText/result.totalReviews)*100).toFixed(1)}%)`);
            console.log(`Reviews with rating: ${reviewsWithRating} (${((reviewsWithRating/result.totalReviews)*100).toFixed(1)}%)`);
            console.log(`Reviews with images: ${reviewsWithImages} (${((reviewsWithImages/result.totalReviews)*100).toFixed(1)}%)`);
            console.log(`Reviews with reviewer stats: ${reviewsWithReviewerStats} (${((reviewsWithReviewerStats/result.totalReviews)*100).toFixed(1)}%)`);

            // Save full result
            const outputPath = '/Volumes/Data/time_scraper/output/test_reviews_scroll.json';
            fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
            console.log('\nFull results saved to:', outputPath);

            console.log('\n=== Conclusion ===');
            if (result.totalReviews > 10 && reviewsWithText > result.totalReviews * 0.8) {
                console.log('SUCCESS: Scrolling method is viable for review extraction!');
                console.log('We can extract: text, rating, reviewer info, images, timestamps');
            } else {
                console.log('PARTIAL: Method works but data quality needs improvement');
            }
        }

    } catch (err) {
        console.error('\n=== Test Failed ===');
        console.error('Error:', err.message);
        console.error(err.stack);
    }

    console.log('\nPress Enter to close browser...');
    await new Promise(resolve => {
        process.stdin.once('data', resolve);
    });

    await browser.close();
}

testReviewsScrolling().catch(console.error);
