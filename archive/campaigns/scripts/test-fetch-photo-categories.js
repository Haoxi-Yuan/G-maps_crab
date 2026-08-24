#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test for src/photo-category-fetcher.js.
 *
 * Loads two test places (small + large), captures one session token
 * from auto-fired batchexecute, then drives the direct-POST fetcher to
 * enumerate every category. Reports per-category photo count and timing.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const stealth = require('../src/stealth');
const photo = require('../src/photo-category-fetcher');

const PLACES = [
  {
    name: 'Bukit Timah Wet Market & Food Centre (Interim)',
    url: 'https://www.google.com/maps/place/Bukit+Timah+Wet+Market+%26+Food+Centre+(Interim)/@1.3407156,103.775054,17z/data=!4m6!3m5!1s0x31da108a1e060fc1:0x69d17c2ce13247e5!8m2!3d1.3407156!4d103.775054!16s%2Fg%2F1tfqhx60?hl=en',
    ftid: '0x31da108a1e060fc1:0x69d17c2ce13247e5',
  },
  {
    name: 'Hua Kee Cantonese Chicken Rice',
    url: 'https://www.google.com/maps/place/Hua+Kee+Cantonese+Chicken+Rice+-+Toh+Yi+Drive/@1.3399916,103.7730156,17z/data=!3m1!4b1!4m6!3m5!1s0x31da11007b1f6c8b:0xac9b77502deefcd5!8m2!3d1.3399916!4d103.7730156!16s%2Fg%2F11ykbfch8w?hl=en',
    ftid: '0x31da11007b1f6c8b:0xac9b77502deefcd5',
  },
];

const OUT_DIR = path.join(__dirname, '..', 'discovery', 'test_fetch');

async function runPlace(browser, place) {
  const { context, page } = await stealth.createStealthContext(browser, {});

  // Keep the LARGEST preview/place response (Maps fires both a short
  // and a full one — only the full version has the category structure).
  let previewText = null;
  page.on('response', async (resp) => {
    if (!resp.url().includes('/maps/preview/place')) return;
    try {
      const t = await resp.text();
      if (!previewText || t.length > previewText.length) previewText = t;
    } catch (e) {}
  });

  const sess = photo.makeSessionCapturer(page);
  // Diagnostic: log every batchexecute POST body for debugging
  const batchPosts = [];
  page.on('request', (req) => {
    if (/batchexecute/.test(req.url())) {
      const pd = req.postData();
      if (pd) batchPosts.push({ url: req.url().slice(0, 80), body: pd.slice(0, 200) });
    }
  });

  const t0 = Date.now();

  // Two-step nav matching src/review-scraper.js — these specific URL
  // patterns are what trigger Google to return the full preview/place
  // payload (with embedded photoCategories). Direct goto to a long
  // /maps/place/<name>/@.../data=... URL only gets the lite version.
  const pid = place.ftid;
  await page.goto(
    `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${pid}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 },
  );
  await page.waitForTimeout(2000);
  await page.goto(
    `https://www.google.com/maps/place/?ftid=${pid}&hl=en`,
    { waitUntil: 'domcontentloaded', timeout: 45000 },
  );
  await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // Wait for both preview/place AND a batchexecute session token
  const sessionOk = await sess.wait(20000);
  sess.detach();
  console.log(`  preview/place captured: ${previewText ? previewText.length + ' bytes' : 'no'}`);
  console.log(`  batchexecute POSTs seen: ${batchPosts.length}`);
  console.log(`  session token captured: ${sessionOk ? sess.captured.sessionToken + ' / counter=' + sess.captured.counter : 'NO'}`);
  if (!previewText) {
    console.log('  ! preview/place not captured — abort');
    await context.close();
    return null;
  }

  const tLoad = Date.now() - t0;

  // Adaptive category extraction
  const placeMeta = photo.extractPlaceMeta(previewText);
  const cats = photo.extractPhotoCategoriesFromPreview(previewText);
  console.log(`\n=== ${place.name} ===`);
  console.log(`Load: ${tLoad}ms  |  ftid=${placeMeta.ftid}  kg=${placeMeta.kgId}`);
  console.log(`Detected ${cats.length} categories:`);
  for (const c of cats) console.log(`  ${c.key.padEnd(30)} → ${c.label}`);

  if (!sess.captured.sessionToken) {
    console.log('  ! no sessionToken, aborting fetch for this place');
    await context.close();
    return { place: place.name, categories: cats, error: 'no_session' };
  }

  const tFetch0 = Date.now();
  const result = await photo.fetchAllPhotoCategories(page, previewText, sess.captured, {
    onProgress: (info) => {
      if (info.stage === 'category_start') {
        console.log(`\n  → fetching "${info.label}" (${info.key})`);
      } else if (info.error || info.httpError) {
        console.log(`    ERR: ${info.error || 'HTTP ' + info.httpError}`);
      } else {
        process.stdout.write(`    page ${info.page}: +${info.added}  total=${info.total}${info.expected != null ? '/' + info.expected : ''}\n`);
      }
    },
  });
  const tFetch = Date.now() - tFetch0;
  console.log(`\nFetched all categories in ${tFetch}ms`);

  // Summary table
  console.log('\nSummary:');
  for (const c of result.categories) {
    console.log(`  ${c.label.padEnd(36)} ${c.photoCount} photos${c.totalCount != null ? ' (expected ~' + c.totalCount + ')' : ''}`);
  }

  fs.writeFileSync(
    path.join(OUT_DIR, place.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.json'),
    JSON.stringify({ place: place.name, placeMeta, timing: { loadMs: tLoad, fetchMs: tFetch }, ...result }, null, 2)
  );

  await context.close();
  return result;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: stealth.buildLaunchArgs() });
  try {
    for (const p of PLACES) {
      try { await runPlace(browser, p); }
      catch (e) { console.error(`FAILED ${p.name}: ${e.stack || e.message}`); }
    }
  } finally {
    await browser.close();
  }
  console.log(`\nDone. Output: ${OUT_DIR}`);
})();
