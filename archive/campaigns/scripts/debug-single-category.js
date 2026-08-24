#!/usr/bin/env node
'use strict';

/**
 * Run a single category fetch with verbose logging and save the raw
 * responses for the first few pages. Used to debug coverage gaps.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const stealth = require('../src/stealth');
const photo = require('../src/photo-category-fetcher');

// argv: [ftid] [label]
const FTID = process.argv[2] || '0x31da108a1e060fc1:0x69d17c2ce13247e5';
const TARGET_LABEL = process.argv[3] || 'Char kway teow';
const PLACE = {
  ftid: FTID,
  url: `https://www.google.com/maps/place/?ftid=${FTID}&hl=en`,
};
const OUT = path.join(__dirname, '..', 'discovery', 'debug_single');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: stealth.buildLaunchArgs() });
  const { context, page } = await stealth.createStealthContext(browser, {});

  let previewText = null;
  page.on('response', async (r) => {
    if (!r.url().includes('/maps/preview/place')) return;
    try {
      const t = await r.text();
      if (!previewText || t.length > previewText.length) previewText = t;
    } catch (e) {}
  });

  const sess = photo.makeSessionCapturer(page);

  await page.goto(
    `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${PLACE.ftid}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 },
  );
  await page.waitForTimeout(2000);
  await page.goto(PLACE.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('h1').catch(() => {});
  await page.waitForTimeout(2500);
  await sess.wait(15000);
  sess.detach();

  const meta = photo.extractPlaceMeta(previewText);
  const cats = photo.extractPhotoCategoriesFromPreview(previewText);
  const target = cats.find((c) => c.label === TARGET_LABEL);
  if (!target) {
    console.log(`Category "${TARGET_LABEL}" not found. Available:`);
    for (const c of cats) console.log('  ' + c.label);
    process.exit(1);
  }
  console.log(`Fetching "${target.label}" (key=${target.key})`);

  // Replicate the fetch loop with verbose output
  let cursor = null;
  const seen = new Set();
  let total = 0;
  let reqId = (sess.captured.reqIdSeed || 100000) + Math.floor(Math.random() * 1e5);

  for (let pageNum = 0; pageNum < 50; pageNum++) {
    const body = photo.buildListEntityPhotosBody({
      ftid: meta.ftid, kgId: meta.kgId,
      sessionToken: sess.captured.sessionToken, counter: sess.captured.counter,
      categoryKey: target.key, cursor, pageSize: 20,
    });
    reqId += 100000;
    const url = `/maps/_/MapsWizUi/data/batchexecute?rpcids=hspqX&hl=en&_reqid=${reqId}&rt=c`;
    const respText = await page.evaluate(async ({ u, b }) => {
      const r = await fetch(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: b,
        credentials: 'include',
      });
      return await r.text();
    }, { u: url, b: body });
    fs.writeFileSync(path.join(OUT, `page_${String(pageNum).padStart(2,'0')}.raw.txt`), respText);

    const parsed = photo.parseListEntityPhotosResponse(respText);
    let added = 0;
    for (const p of parsed.photos) {
      if (seen.has(p.id)) continue;
      seen.add(p.id); added++;
    }
    total = seen.size;
    console.log(`page ${pageNum}: bytes=${respText.length}  parsedPhotos=${parsed.photos.length}  newUnique=${added}  total=${total}  cursor=${parsed.nextCursor ? parsed.nextCursor.slice(0,30)+'... (len '+parsed.nextCursor.length+')' : 'NULL'}  reportedTotal=${parsed.totalCount}`);

    if (added === 0) { console.log('  → break: added=0'); break; }
    if (!parsed.nextCursor) { console.log('  → break: no nextCursor in response'); break; }
    cursor = parsed.nextCursor;
  }

  await context.close();
  await browser.close();
})().catch((e) => { console.error(e.stack); process.exit(1); });
