#!/usr/bin/env node
'use strict';

/**
 * Test using direct URL to reviews page
 * Google Maps supports URL parameters to open specific views
 */

const { chromium } = require('playwright');
const fs = require('fs');

async function testDirectReviewsURL() {
    console.log('=== Test: Direct URL to Reviews ===\n');

    const browser = await chromium.launch({
        headless: false,
        slowMo: 500
    });

    const context = await browser.newContext({
        locale: 'en-SG',
        timezoneId: 'Asia/Singapore'
    });

    const page = await context.newPage();

    const testPlaceId = 'ChIJo3EXjvAZ2jERRdFfHa-rqT8';

    // Try different URL formats that might show reviews
    const urlFormats = [
        // Format 1: Direct data parameter
        `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${testPlaceId}`,
        // Format 2: Place details with data parameter
        `https://www.google.com/maps/place/?q=place_id:${testPlaceId}&hl=en&reviews=true`,
        // Format 3: Using /@ coordinates (if we knew them)
        `https://www.google.com/maps/place/?q=place_id:${testPlaceId}&hl=en`,
    ];

    for (let i = 0; i < urlFormats.length; i++) {
        const url = urlFormats[i];
        console.log(`\nTrying URL format ${i + 1}:`, url);

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForSelector('h1', { timeout: 30000 });
            await page.waitForTimeout(4000);

            // Check what we got
            const pageState = await page.evaluate(() => {
                const stars = document.querySelectorAll('[role="img"][aria-label*="star"]');
                const tabs = Array.from(document.querySelectorAll('button[role="tab"]')).map(t => t.textContent.trim());

                // Look for review-like elements
                const reviewIndicators = [
                    document.querySelectorAll('div.jftiEf').length,
                    document.querySelectorAll('div.jJc9Ad').length,
                    document.querySelectorAll('[data-review-id]').length,
                    document.querySelectorAll('span.wiI7pd').length
                ];

                return {
                    stars: stars.length,
                    tabs: tabs,
                    reviewIndicators: reviewIndicators,
                    hasReviewElements: reviewIndicators.some(count => count > 1)
                };
            });

            console.log('  Stars found:', pageState.stars);
            console.log('  Tabs:', pageState.tabs.join(', '));
            console.log('  Review elements:', pageState.reviewIndicators);

            if (pageState.hasReviewElements) {
                console.log('\n  ✓ Found review elements! Extracting...');

                const reviews = await page.evaluate(async () => {
                    const sleep = ms => new Promise(r => setTimeout(r, ms));

                    const scrollContainer = document.querySelector('div.m6QErb.DxyBCb.kA9KIf.dS8AEf');
                    if (!scrollContainer) return [];

                    const reviews = [];
                    const seenIds = new Set();

                    for (let scroll = 0; scroll < 5; scroll++) {
                        const stars = document.querySelectorAll('[role="img"][aria-label*="star"]');

                        stars.forEach((star, index) => {
                            if (index === 0) return; // Skip overall rating

                            let container = star.parentElement;
                            for (let i = 0; i < 8 && container; i++) {
                                if (container.textContent.length > 100) break;
                                container = container.parentElement;
                            }

                            if (!container) return;

                            const id = container.getAttribute('data-review-id') ||
                                      container.getAttribute('jslog') ||
                                      `review_${reviews.length}`;

                            if (seenIds.has(id)) return;
                            seenIds.add(id);

                            reviews.push({
                                rating: star.getAttribute('aria-label'),
                                textPreview: container.textContent.substring(0, 200)
                            });
                        });

                        scrollContainer.scrollBy(0, 500);
                        await sleep(1000);
                    }

                    return reviews;
                });

                console.log(`  Extracted ${reviews.length} reviews`);

                if (reviews.length > 0) {
                    console.log('\n  Sample reviews:');
                    reviews.slice(0, 2).forEach((r, i) => {
                        console.log(`    ${i + 1}. ${r.rating}`);
                        console.log(`       ${r.textPreview.substring(0, 80)}...`);
                    });

                    fs.mkdirSync('/Volumes/Data/time_scraper/output', { recursive: true });
                    fs.writeFileSync(
                        '/Volumes/Data/time_scraper/output/direct_url_reviews.json',
                        JSON.stringify({ url, reviews }, null, 2)
                    );

                    console.log('\n  ✓ SUCCESS! Found working URL format');
                    console.log('  Results saved to: direct_url_reviews.json');

                    console.log('\nBrowser will close in 15 seconds...');
                    await page.waitForTimeout(15000);
                    await browser.close();
                    return;
                }
            }

        } catch (err) {
            console.log('  Error with this URL:', err.message);
        }
    }

    console.log('\nNo URL format successfully showed reviews.');
    console.log('Browser will close in 5 seconds...');
    await page.waitForTimeout(5000);
    await browser.close();
}

testDirectReviewsURL().catch(console.error);
