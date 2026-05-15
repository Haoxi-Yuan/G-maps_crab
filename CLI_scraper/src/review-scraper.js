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
const { makeSessionCapturer, fetchAllPhotoCategories } = require('./photo-category-fetcher');

const CONFIG = {
  maxReviews: 50000,
  pageSize: 20,
  delayMs: 200,
  pageLoadTimeout: 30000,
  logMaxLines: 1000,
};

// ============================================
// Supplement missing fields from preview/place
// ============================================

/**
 * Extract place data from the preview/place response text.
 * This response contains the same data structure as tbm=map's data[64].
 */
function extractSupplementFromPreview(previewText) {
  const result = { _supplemented: [] };
  if (!previewText) return result;

  try {
    const cleaned = previewText.replace(/^\)\]\}'\n/, '');
    const data = JSON.parse(cleaned);

    // preview/place response structure differs from tbm=map
    // The place data is typically at data[6] or we search for it
    let p = null;

    // Try common paths
    const candidates = [data[6], data[2], data[0]];
    for (const c of candidates) {
      if (c && Array.isArray(c) && c[11] && typeof c[11] === 'string') {
        p = c; break;
      }
    }

    // Fallback: search for the array containing name (field [11])
    if (!p) {
      const str = JSON.stringify(data);
      // Find via ftid pattern
      const ftidMatch = str.match(/"(0x[0-9a-f]+:0x[0-9a-f]+)"/);
      if (ftidMatch) {
        function findPlace(obj, depth) {
          if (depth > 5 || !obj) return null;
          if (Array.isArray(obj) && obj[10] === ftidMatch[1] && obj[11]) return obj;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const r = findPlace(item, depth + 1);
              if (r) return r;
            }
          }
          return null;
        }
        p = findPlace(data, 0);
      }
    }

    if (!p) return result;

    // Extract fields using same paths as poi-searcher-api.js
    const biz = {};

    if (p[11]) biz.name = p[11];
    if (p[2]) biz.address = p[2];
    if (p[18]) biz.fullAddress = p[18];
    if (p[9] && p[9][2] != null) biz.coordinates = { lat: p[9][2], lng: p[9][3] };
    if (p[9] && p[9][2] != null) { biz.latitude = p[9][2]; biz.longitude = p[9][3]; }
    if (p[4] && p[4][7] != null) biz.rating = p[4][7];
    if (p[4] && p[4][8] != null) biz.reviewCount = p[4][8];
    if (p[4] && p[4][2]) biz.priceRange = p[4][2];
    if (p[13]) { biz.categories = p[13]; biz.mainCategory = p[13][0]; }
    if (p[7] && p[7][1]) biz.website = p[7][1];
    if (p[178] && p[178][0] && p[178][0][0]) biz.phone = p[178][0][0];
    if (p[78]) biz.chijId = p[78];
    if (p[89]) biz.googleId = p[89];
    if (p[14]) biz.neighborhood = p[14];
    if (p[30]) biz.timezone = p[30];

    // Photos
    try {
      const extractPhotoUrls = (arr) => {
        const urls = [];
        const s = JSON.stringify(arr);
        const matches = s.match(/https:\/\/lh[0-9]\.googleusercontent\.com\/[^"]+/g);
        if (matches) for (const url of matches) {
          if (!url.includes('/s44-') && !url.includes('-k-no-ns-nd')) urls.push(url);
        }
        return [...new Set(urls)];
      };
      const photos = [...new Set([
        ...(p[37] ? extractPhotoUrls(p[37]) : []),
        ...(p[105] ? extractPhotoUrls(p[105]) : []),
      ])];
      if (photos.length > 0) biz.photos = photos;
    } catch (e) {}

    // Owner info
    if (p[57] && p[57][1]) biz.ownerInfo = { name: p[57][1], id: p[57][2] || null };

    // Category IDs
    if (p[76] && Array.isArray(p[76])) {
      biz.categoryIds = p[76].map(c => Array.isArray(c) ? { id: c[0], label: c[1] } : null).filter(Boolean);
    }

    // Identity badges
    try {
      if (p[196] && Array.isArray(p[196][1])) {
        const badges = p[196][1].map(b => Array.isArray(b) && b[1] ? b[1][0] : null).filter(Boolean);
        if (badges.length > 0) biz.identityBadges = badges;
      }
    } catch (e) {}

    // Description
    try {
      if (p[32] && Array.isArray(p[32])) {
        biz.description = (p[32][1] && p[32][1][1]) || (p[32][0] && p[32][0][1]) || null;
      }
    } catch (e) {}

    // Opening hours from [203]
    try {
      const rawHours = p[203];
      if (rawHours && Array.isArray(rawHours[0])) {
        const currentStatus = (rawHours[1] && rawHours[1][4] && rawHours[1][4][0]) || null;
        const weeklyHours = [];
        for (const day of rawHours[0]) {
          if (!Array.isArray(day)) continue;
          const dayName = day[0];
          const hours = day[3] ? day[3].map(h => h[0]).join(', ') : 'Closed';
          const openHour = day[3] && day[3][0] && day[3][0][1] && day[3][0][1][0] ? day[3][0][1][0][0] : null;
          const closeHour = day[3] && day[3][0] && day[3][0][1] && day[3][0][1][1] ? day[3][0][1][1][0] : null;
          weeklyHours.push({ day: dayName, hours, openHour, closeHour });
        }
        if (weeklyHours.length > 0) result.openingHours = { currentStatus, weeklyHours };
      }
    } catch (e) {}

    // About from [100]
    try {
      const rawAbout = p[100];
      if (rawAbout && Array.isArray(rawAbout)) {
        const about = {};
        for (const section of rawAbout) {
          if (!Array.isArray(section)) continue;
          for (const sub of section) {
            if (!Array.isArray(sub)) continue;
            if (typeof sub[0] === 'string' && typeof sub[1] === 'string' && Array.isArray(sub[2])) {
              const items = sub[2].map(a => Array.isArray(a) && a[1] ? a[1] : null).filter(Boolean);
              if (items.length > 0) about[sub[1]] = items;
            } else if (typeof sub[0] === 'string' && sub[0].startsWith('/geo/') && sub[1]) {
              if (!about['Highlights']) about['Highlights'] = [];
              about['Highlights'].push(sub[1]);
            }
          }
        }
        if (Object.keys(about).length > 0) result.about = about;
      }
    } catch (e) {}

    // Popular times (hourly data from text)
    try {
      const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const hourPattern = /\[(\d+),(\d+),"([^"]*)","([^"]*)","([^"]*)"/g;
      const allHours = [];
      let hm;
      while ((hm = hourPattern.exec(previewText)) !== null) {
        allHours.push({ hour: parseInt(hm[1]), popularity: parseInt(hm[2]), timeLabel: hm[5] });
      }
      if (allHours.length >= 18) {
        const popularTimes = { weeklyData: [] };
        let dayHours = [];
        let prevHour = -1;
        for (const h of allHours) {
          if (h.hour <= prevHour && dayHours.length >= 10) {
            popularTimes.weeklyData.push({ day: dayNames[popularTimes.weeklyData.length % 7], hourlyData: dayHours });
            dayHours = [];
          }
          dayHours.push(h);
          prevHour = h.hour;
        }
        if (dayHours.length >= 10) {
          popularTimes.weeklyData.push({ day: dayNames[popularTimes.weeklyData.length % 7], hourlyData: dayHours });
        }
        if (popularTimes.weeklyData.length > 0) result.popularTimes = popularTimes;
      }
    } catch (e) {}

    result.business = biz;
  } catch (e) {}

  return result;
}

/**
 * Merge place data with supplement: only fill in null/missing fields.
 */
function supplementPlace(place, supplement, reviews) {
  // Shallow merge — place object is read fresh per iteration and discarded after write
  const merged = {};
  for (const key of Object.keys(place)) merged[key] = place[key];
  if (place.business) merged.business = { ...place.business };
  if (place._meta) merged._meta = { ...place._meta };
  merged.detailedReviews = reviews;

  const filled = [];

  // Supplement business fields
  if (supplement.business) {
    if (!merged.business) merged.business = {};
    for (const [key, val] of Object.entries(supplement.business)) {
      if (val != null && (merged.business[key] == null || merged.business[key] === '')) {
        merged.business[key] = val;
        filled.push('business.' + key);
      }
    }
  }

  // Supplement top-level fields
  for (const key of ['openingHours', 'popularTimes', 'about']) {
    if (supplement[key] && !merged[key]) {
      merged[key] = supplement[key];
      filled.push(key);
    }
  }

  // Supplement metadata.description
  if (supplement.business && supplement.business.description && (!merged.metadata || !merged.metadata.description)) {
    if (!merged.metadata) merged.metadata = {};
    merged.metadata.description = supplement.business.description;
    filled.push('metadata.description');
  }

  // Supplement _meta fields
  if (supplement.business) {
    if (!merged._meta) merged._meta = {};
    for (const key of ['chijId', 'googleId', 'neighborhood', 'timezone']) {
      if (supplement.business[key] && !merged._meta[key]) {
        merged._meta[key] = supplement.business[key];
        filled.push('_meta.' + key);
      }
    }
  }

  supplement._supplemented = filled;
  return merged;
}

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

  // Read input: index placeId + byte offset per line using streaming (no full-file load)
  const placeIndex = []; // [{pid, name, expected, byteStart, byteEnd}]

  {
    const readline = require('readline');
    const inputStream = fs.createReadStream(inputFile, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });
    let bytePos = 0;

    await new Promise((resolve) => {
      rl.on('line', (line) => {
        const byteStart = bytePos;
        const lineBytes = Buffer.byteLength(line, 'utf8');
        bytePos += lineBytes + 1; // +1 for \n

        if (!line.trim()) return;
        try {
          const p = JSON.parse(line);
          const biz = p.business || {};
          const pid = biz.placeId || (p._meta && p._meta.placeId);
          if (pid) placeIndex.push({ pid, name: biz.name || '?', expected: biz.reviewCount || 0, byteStart, byteEnd: byteStart + lineBytes });
        } catch (e) {}
      });
      rl.on('close', resolve);
    });
  }
  log(`[REVIEWS] Indexed ${placeIndex.length} places from ${inputFile}`);

  // Helper: read a single place from file by byte offset (no full-file read)
  function readPlace(byteStart, byteEnd) {
    const fd = fs.openSync(inputFile, 'r');
    const len = byteEnd - byteStart;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, byteStart);
    fs.closeSync(fd);
    return JSON.parse(buf.toString('utf8'));
  }

  // Resume: scan the existing output for already-done pids.
  //
  // We deliberately do NOT use readline here — readline materialises each
  // line as a full JS string before emitting `line`, and a single place with
  // 50k+ reviews can be a 100+ MB line that blows V8's 4 GB JS heap during
  // UTF-8 → UTF-16 decode. Instead we stream Buffer chunks, slice at `\n`
  // byte boundaries, and for each line:
  //   * decode only the first 8 KB to regex out placeId (it lives right at
  //     the start of business.placeId, always inside the first 1-2 KB)
  //   * scan for "detailedReviews" and "_placeholder":true as raw byte
  //     needles across the whole line's Buffer list — no JS string ever
  //     materialises for the bulk of the line.
  // Memory is bounded by max(one line) as Buffer (off-heap), not by JS heap.
  const doneSet = new Set();
  if (fs.existsSync(outputFile)) {
    const NEWLINE = 0x0A;
    const DETAILED_MARK = Buffer.from('"detailedReviews"');
    const PLACEHOLDER_MARK = Buffer.from('"_placeholder":true');
    const PID_RE = /"placeId"\s*:\s*"([^"]+)"/;

    let lineBufs = [];

    function finishLine() {
      if (lineBufs.length === 0) return;
      // Extract placeId from the first 8 KB.
      let head = Buffer.alloc(0);
      let taken = 0;
      for (const b of lineBufs) {
        if (taken >= 8192) break;
        const slice = b.subarray(0, Math.min(8192 - taken, b.length));
        head = taken === 0 ? slice : Buffer.concat([head, slice]);
        taken += slice.length;
      }
      const m = head.toString('utf8').match(PID_RE);
      if (!m) { lineBufs = []; return; }

      // Byte-level scan for flag markers across all buffers, with a small
      // prevTail carry so marker bytes spanning two chunks still match.
      const markerMax = Math.max(DETAILED_MARK.length, PLACEHOLDER_MARK.length);
      let hasDetailed = false;
      let isPlaceholder = false;
      let prevTail = Buffer.alloc(0);
      for (const b of lineBufs) {
        const scan = prevTail.length > 0 ? Buffer.concat([prevTail, b]) : b;
        if (!hasDetailed && scan.indexOf(DETAILED_MARK) >= 0) hasDetailed = true;
        if (!isPlaceholder && scan.indexOf(PLACEHOLDER_MARK) >= 0) isPlaceholder = true;
        if (hasDetailed && isPlaceholder) break;
        prevTail = scan.subarray(Math.max(0, scan.length - (markerMax - 1)));
      }

      if (hasDetailed && !isPlaceholder) doneSet.add(m[1]);
      lineBufs = [];
    }

    const resumeStream = fs.createReadStream(outputFile);
    for await (const chunk of resumeStream) {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === NEWLINE) {
          if (i > start) lineBufs.push(chunk.subarray(start, i));
          finishLine();
          start = i + 1;
        }
      }
      if (start < chunk.length) lineBufs.push(chunk.subarray(start));
    }
    finishLine();

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
    for (let i = 0; i < placeIndex.length; i++) {
      const { pid, name, expected, byteStart, byteEnd } = placeIndex[i];

      if (doneSet.has(pid)) continue;

      log(`\n[${i + 1}/${placeIndex.length}] ${name} (expected: ${expected})`);

      // Read full place data on demand (not kept in memory)
      let place;
      try { place = readPlace(byteStart, byteEnd); } catch (e) { log('  SKIP: read error ' + e.message); continue; }
      if (!place) { log('  SKIP: could not read place data'); continue; }
      const biz = place.business || {};

      // Restart browser periodically to prevent memory buildup (Chromium leaks ~2MB/context)
      if (processed > 0 && processed % 200 === 0) {
        log(`  [MEMORY] Restarting browser after ${processed} places...`);
        try { await browser.close(); } catch (_) {}
        browser = await chromium.launch({ headless: true, args: stealth.buildLaunchArgs() });
      }

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

        // Capture preview/place — keep the LARGEST response (Maps fires
        // both a lite version during search redirect and a full version
        // on the place page; only the full one has photoCategories).
        let previewData = null;
        const previewHandler = async (resp) => {
          if (resp.url().includes('/maps/preview/place')) {
            try {
              const t = await resp.text();
              if (!previewData || t.length > previewData.length) previewData = t;
            } catch(e) {}
          }
        };
        page.on('response', previewHandler);

        // Capture a session token from the first auto-fired batchexecute.
        // Needed to replicate ListEntityPhotos POSTs after reviews finish.
        const photoSession = makeSessionCapturer(page);

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

        page.off('response', previewHandler);
        photoSession.detach();

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

        // Supplement missing fields from preview/place response
        const supplement = extractSupplementFromPreview(previewData);
        const merged = supplementPlace(place, supplement, reviewResult.reviews);
        if (supplement._supplemented.length > 0) {
          log(`  Supplemented: ${supplement._supplemented.join(', ')}`);
        }

        // Enumerate Google's adaptive photo categories (Menu / Food & drink /
        // dish-specific tags / Latest / Videos / ...). Direct batchexecute
        // POST against /MapsPhotoService.ListEntityPhotos — no UI nav.
        // Takes ~2-30s/place depending on how many categories Google created.
        if (photoSession.captured.sessionToken && previewData) {
          try {
            const photoStart = Date.now();
            const photoResult = await fetchAllPhotoCategories(
              page, previewData, photoSession.captured,
              { perCategoryOpts: { pageSize: 20, maxPhotos: 5000, maxPages: 200 } },
            );
            const totalPhotos = (photoResult.categories || [])
              .reduce((n, c) => n + (c.photoCount || 0), 0);
            merged.photoCategories = photoResult.categories;
            log(`  Photo categories: ${photoResult.categories.length} tags, ${totalPhotos} photos, ${Math.round((Date.now() - photoStart) / 1000)}s`);
          } catch (e) {
            log(`  Photo category fetch failed: ${e.message}`);
            merged.photoCategories = [];
          }
        } else {
          merged.photoCategories = [];
          if (!photoSession.captured.sessionToken) log('  (no session token, skipping photo categories)');
        }

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

        const merged = { ...place, detailedReviews: partialReviews, photoCategories: [], _error: err.message };
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
  console.log(`Processed: ${processed}/${placeIndex.length} | Reviews: ${totalReviews} | Errors: ${totalErrors} | Time: ${elapsed}s`);
  console.log(`Output: ${outputFile}`);

  // No auto-merge step here. Build the final dataset (SQLite DB, combined
  // ndjson, etc.) from this append-only reviews.ndjson + places.ndjson at
  // consumption time. The previous in-place `finalizeReviews` function had
  // a byte-range rewrite bug that destroyed ~36% of sf_v4's 3.3 GB output
  // in 2026-04; removed entirely to prevent repeat incidents.

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
