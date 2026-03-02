#!/usr/bin/env node
'use strict';

/**
 * Test script for enhanced pipeline
 * Tests new features: About, Metadata, Main Category
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function testEnhancedPipeline() {
    console.log('=== Testing Enhanced Pipeline ===\n');

    const browser = await chromium.launch({
        headless: false,
        slowMo: 50
    });

    const context = await browser.newContext({
        locale: 'en-SG',
        timezoneId: 'Asia/Singapore'
    });

    const page = await context.newPage();

    // Load enhanced pipeline script
    const pipelinePath = '/Volumes/Data/scraper/google-maps-scraper-pipeline.js';
    const pipelineSrc = fs.readFileSync(pipelinePath, 'utf8')
        .replace(/downloadJSON\(\s*cleanedData\s*,\s*filename\s*\);\s*/g, 'window.__gmap_last = cleanedData;');

    // Test with a known place
    const testPlaceId = 'ChIJaS3Tr08W2jERiy489bOlKhQ'; // Ang Mo Supermarket
    const url = `https://www.google.com/maps/place/?q=place_id:${testPlaceId}&hl=en`;

    console.log('Testing with:', url);
    console.log();

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('h1', { timeout: 30000 });

        console.log('Page loaded, waiting for content...');
        await page.waitForTimeout(2000);

        console.log('Executing enhanced pipeline...\n');
        const result = await page.evaluate(pipelineSrc);

        if (result && typeof result === 'object') {
            console.log('\n=== Test Results ===\n');
            console.log('Name:', result.business?.name);
            console.log('Main Category:', result.business?.mainCategory);
            console.log('Categories:', result.business?.categories);
            console.log('Rating:', result.business?.rating);
            console.log('Reviews:', result.business?.reviewCount);
            console.log();
            console.log('About Categories:', Object.keys(result.about || {}).length);
            if (result.about && Object.keys(result.about).length > 0) {
                console.log('About Fields:');
                Object.keys(result.about).forEach(key => {
                    console.log(`  - ${key}: ${result.about[key].length} items`);
                });
            }
            console.log();
            console.log('Metadata Fields:', Object.keys(result.metadata || {}).length);
            if (result.metadata && Object.keys(result.metadata).length > 0) {
                console.log('Metadata:');
                Object.entries(result.metadata).forEach(([key, value]) => {
                    const displayValue = Array.isArray(value)
                        ? `[${value.length} items]`
                        : value;
                    console.log(`  - ${key}: ${displayValue}`);
                });
            }
            console.log();
            console.log('Popular Times Days:', result.popularTimes?.weeklyData?.length || 0);
            console.log('Opening Hours Days:', result.openingHours?.weeklyHours?.length || 0);

            // Save result
            const outputPath = '/Volumes/Data/time_scraper/output/test_enhanced.json';
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
            console.log('\nSaved to:', outputPath);

            console.log('\n=== Test PASSED ===');
        } else {
            console.error('\n=== Test FAILED ===');
            console.error('Result is null or invalid');
        }

    } catch (err) {
        console.error('\n=== Test FAILED ===');
        console.error('Error:', err.message);
        console.error(err.stack);
    }

    console.log('\nPress Enter to close browser...');
    await new Promise(resolve => {
        process.stdin.once('data', resolve);
    });

    await browser.close();
}

testEnhancedPipeline().catch(console.error);
