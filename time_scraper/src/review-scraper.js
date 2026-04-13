#!/usr/bin/env node
'use strict';

/**
 * Review Scraper
 *
 * Reads places from a places.ndjson file (produced by POI search),
 * fetches reviews via API for each place, and writes merged results
 * to an output ndjson file.
 *
 * Key design:
 *   - Fresh browser context per place (prevents memory buildup)
 *   - Stream write: each place written immediately after completion
 *   - Progress logging with review count visibility
 *   - Resume support: skips places that already have reviews in output
 *   - Log rotation: keeps last 1000 lines
 *
 * Usage:
 *   node src/review-scraper.js --input output/city/places.ndjson
 *   node src/review-scraper.js --input output/city/places.ndjson --output output/city/reviews.ndjson
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const stealth = require('./stealth');
const { fetchAllReviews } = require('./api-review-fetcher');

const CONFIG = {
  maxReviews: 50000,
  pageSize: 20,
  delayMs: 200,
  pageLoadTimeout: 30000,
  logMaxLines: 1000,
};

async function scrapeReviews(inputFile, outputFile, opts = {}) {
  const maxReviews = opts.maxReviews || CONFIG.maxReviews;
  const logFile = outputFile.replace(/\.ndjson$/, '.log');

  // Log rotation
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n');
    if (lines.length > CONFIG.logMaxLines) {
      fs.writeFileSync(logFile, lines.slice(-CONFIG.logMaxLines).join('\n'));
    }
  }

  // Logging: write to both console and log file
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const log = (msg) => {
    const line = msg;
    console.log(line);
    logStream.write(line + '\n');
  };

  // Read input places
  const lines = fs.readFileSync(inputFile, 'utf8').trim().split('\n');
  const places = lines.filter(l => l.trim()).map(l => JSON.parse(l));
  log(`[REVIEWS] Loaded ${places.length} places from ${inputFile}`);

  // Resume: check which places already have reviews
  const doneSet = new Set();
  if (fs.existsSync(outputFile)) {
    const existing = fs.readFileSync(outputFile, 'utf8').trim().split('\n');
    for (const line of existing) {
      if (!line) continue;
      try {
        const p = JSON.parse(line);
        const pid = p._meta?.placeId || p.business?.placeId;
        if (pid && p.detailedReviews && p.detailedReviews.length > 0) {
          doneSet.add(pid);
        }
      } catch (e) {}
    }
    if (doneSet.size > 0) {
      log(`[REVIEWS] Resuming: ${doneSet.size} places already done`);
    }
  }

  // Launch browser
  let browser = await chromium.launch({ headless: true, args: stealth.buildLaunchArgs() });

  let processed = 0;
  let totalReviews = 0;
  let totalErrors = 0;
  const startTime = Date.now();

  try {
    for (let i = 0; i < places.length; i++) {
      const place = places[i];
      const biz = place.business || {};
      const pid = biz.placeId || place._meta?.placeId;

      if (!pid) continue;
      if (doneSet.has(pid)) continue;

      const name = biz.name || '?';
      const expected = biz.reviewCount || 0;
      log(`\n[${i + 1}/${places.length}] ${name} (expected: ${expected})`);

      // Fresh context + page per place
      let context, page;
      try {
        const result = await stealth.createStealthContext(browser, {});
        context = result.context;
        page = result.page;
      } catch (e) {
        // Browser may have crashed, restart
        log(`  Browser error, restarting: ${e.message}`);
        try { await browser.close(); } catch (_) {}
        browser = await chromium.launch({ headless: true, args: stealth.buildLaunchArgs() });
        const result = await stealth.createStealthContext(browser, {});
        context = result.context;
        page = result.page;
      }

      try {
        const isFtid = pid.startsWith('0x');

        // Two-step load
        log('  Loading page...');
        await page.goto(`https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${pid}`, {
          waitUntil: 'domcontentloaded', timeout: CONFIG.pageLoadTimeout
        });
        await page.waitForTimeout(2000);

        const placeUrl = isFtid
          ? `https://www.google.com/maps/place/?ftid=${pid}&hl=en`
          : `https://www.google.com/maps/place/?q=place_id:${pid}&hl=en`;
        await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageLoadTimeout });
        await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // Fetch reviews with incremental flush to prevent data loss
        log('  Fetching reviews...');
        const partialFile = outputFile + '.partial.' + pid.replace(/[^a-z0-9]/gi, '_');
        let flushedCount = 0;

        const reviewResult = await fetchAllReviews(page, {
          maxReviews,
          pageSize: CONFIG.pageSize,
          delayMs: CONFIG.delayMs,
          flushEvery: 100,
          onProgress: (count, total, msg) => {
            if (msg) log(`    ${msg}`);
            else log(`    progress: ${count}/${total}`);
          },
          onFlush: (batch) => {
            // Write each batch of ~100 reviews to a partial file
            const lines = batch.map(r => JSON.stringify(r)).join('\n') + '\n';
            fs.appendFileSync(partialFile, lines);
            flushedCount += batch.length;
          },
        });

        // Clean up partial file (data is now in reviewResult.reviews)
        try { fs.unlinkSync(partialFile); } catch (e) {}

        const fetched = reviewResult.reviews.length;
        const coverage = expected > 0 ? Math.round(fetched / expected * 100) + '%' : '-';
        log(`  DONE: ${fetched}/${expected} (${coverage}) | ${reviewResult.withText || 0} text | ${reviewResult.elapsed || 0}s${reviewResult.error ? ' ERR:' + reviewResult.error : ''}`);

        // Write complete record
        const merged = { ...place, detailedReviews: reviewResult.reviews };
        fs.appendFileSync(outputFile, JSON.stringify(merged) + '\n');

        totalReviews += fetched;
        processed++;

      } catch (err) {
        log(`  ERROR: ${err.message}`);

        // Try to recover partial reviews from flush file
        let partialReviews = [];
        const partialFile = outputFile + '.partial.' + pid.replace(/[^a-z0-9]/gi, '_');
        if (fs.existsSync(partialFile)) {
          try {
            const partialLines = fs.readFileSync(partialFile, 'utf8').trim().split('\n');
            partialReviews = partialLines.filter(l => l).map(l => JSON.parse(l));
            log(`  Recovered ${partialReviews.length} reviews from partial file`);
            try { fs.unlinkSync(partialFile); } catch (e) {}
          } catch (e) {}
        }

        const merged = { ...place, detailedReviews: partialReviews, _error: err.message };
        fs.appendFileSync(outputFile, JSON.stringify(merged) + '\n');
        totalReviews += partialReviews.length;
        totalErrors++;
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
    logStream.end();
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}/${places.length} | Reviews: ${totalReviews} | Errors: ${totalErrors} | Time: ${elapsed}s`);
  console.log(`Output: ${outputFile}`);

  return { processed, totalReviews, totalErrors, elapsed };
}

// ============================================
// CLI
// ============================================

if (require.main === module) {
  const args = process.argv.slice(2);
  let inputFile = null;
  let outputFile = null;
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input': inputFile = args[++i]; break;
      case '--output': outputFile = args[++i]; break;
      case '--max-reviews': opts.maxReviews = parseInt(args[++i]); break;
      case '--help':
        console.log(`
Review Scraper

Usage:
  node src/review-scraper.js --input <places.ndjson> [--output <reviews.ndjson>]

Options:
  --input <file>       Input places file (from POI search)
  --output <file>      Output file (default: reviews.ndjson in same dir)
  --max-reviews <n>    Max reviews per place (default: 50000)
`);
        process.exit(0);
    }
  }

  if (!inputFile) {
    console.error('ERROR: --input is required');
    process.exit(1);
  }
  if (!outputFile) {
    outputFile = path.join(path.dirname(inputFile), 'reviews.ndjson');
  }

  scrapeReviews(inputFile, outputFile, opts).catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { scrapeReviews };
