#!/usr/bin/env node
'use strict';

/**
 * Quick adaptive-fetch sanity test on one place. Prints the full tag tree
 * (label + key + photoCount + totalCount + first photo URL).
 *
 * Usage: node scripts/test-one-place.js <ftid>
 */

const { chromium } = require('playwright');
const stealth = require('../src/stealth');
const photo = require('../src/photo-category-fetcher');

const ftid = process.argv[2] || '0x31da22b906ff05d1:0xaffda4da354a96fa'; // East Coast Park

(async () => {
  const browser = await chromium.launch({ headless: true, args: stealth.buildLaunchArgs() });
  const { context, page } = await stealth.createStealthContext(browser, {});

  let previewText = null;
  page.on('response', async (resp) => {
    if (!resp.url().includes('/maps/preview/place')) return;
    try {
      const t = await resp.text();
      if (!previewText || t.length > previewText.length) previewText = t;
    } catch (e) {}
  });

  const sess = photo.makeSessionCapturer(page);
  const t0 = Date.now();

  await page.goto(`https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${ftid}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await page.goto(`https://www.google.com/maps/place/?ftid=${ftid}&hl=en`, {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await page.waitForSelector('h1').catch(() => {});
  await page.waitForTimeout(2500);
  await sess.wait(15000);
  sess.detach();

  const tLoad = Date.now() - t0;
  const meta = photo.extractPlaceMeta(previewText);

  console.log(`\n=== ${meta.name || ftid} ===`);
  console.log(`ftid:    ${meta.ftid}`);
  console.log(`kg:      ${meta.kgId}`);
  console.log(`coords:  ${meta.lat}, ${meta.lng}`);
  console.log(`session: ${sess.captured.sessionToken ? 'yes' : 'NO'}`);
  console.log(`load:    ${tLoad}ms`);

  const cats = photo.extractPhotoCategoriesFromPreview(previewText);
  console.log(`\nDetected ${cats.length} adaptive categories from preview/place:`);
  for (const c of cats) {
    console.log(`  ${c.key.padEnd(34)} → ${c.label}`);
  }

  if (!sess.captured.sessionToken) {
    console.log('\n(no session token, cannot enumerate photos)');
    await browser.close();
    return;
  }

  const tFetch0 = Date.now();
  const result = await photo.fetchAllPhotoCategories(page, previewText, sess.captured, {
    onProgress: () => {}, // silent — print summary at end
  });
  const tFetch = Date.now() - tFetch0;

  console.log(`\nFetched all categories in ${Math.round(tFetch / 1000)}s\n`);
  console.log('Tag tree:');
  console.log('─'.repeat(80));
  for (const c of result.categories) {
    const first = c.photos[0];
    console.log(`  ${c.label.padEnd(36)} key=${c.key.padEnd(22)} ${c.photoCount} photos${c.totalCount != null ? ' (Google says ~' + c.totalCount + ')' : ''}`);
    if (first) {
      console.log(`    first photo: ${first.id}  ${first.w}x${first.h}`);
      console.log(`    ${first.url.slice(0, 110)}...`);
    }
  }
  console.log('─'.repeat(80));
  console.log(`Total: ${result.categories.length} tags, ${result.categories.reduce((n, c) => n + c.photoCount, 0)} photos`);

  await context.close();
  await browser.close();
})().catch((e) => { console.error(e.stack); process.exit(1); });
