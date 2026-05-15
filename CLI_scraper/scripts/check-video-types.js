#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
const stealth = require('../src/stealth');
const photo = require('../src/photo-category-fetcher');

(async () => {
  const browser = await chromium.launch({ headless: true, args: stealth.buildLaunchArgs() });
  const { context, page } = await stealth.createStealthContext(browser, {});
  let preview = null;
  page.on('response', async (r) => {
    if (!r.url().includes('/maps/preview/place')) return;
    try { const t = await r.text(); if (!preview || t.length > preview.length) preview = t; } catch (e) {}
  });
  const sess = photo.makeSessionCapturer(page);
  const ftid = '0x31da1804eaccbd7f:0x422fd9f92536878f';
  await page.goto(`https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${ftid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.goto(`https://www.google.com/maps/place/?ftid=${ftid}&hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('h1').catch(() => {});
  await page.waitForTimeout(2500);
  await sess.wait(15000);
  sess.detach();

  const meta = photo.extractPlaceMeta(preview);
  const cats = photo.extractPhotoCategoriesFromPreview(preview);
  const videos = cats.find((c) => c.label === 'Videos');
  const result = await photo.fetchPhotosForCategory(page, meta, videos, sess.captured, {});

  const types = {};
  for (const p of result.photos) types[p.mediaType] = (types[p.mediaType] || 0) + 1;
  console.log('mediaType counts in Videos category:', types);
  console.log('Total entries:', result.photos.length);
  console.log('\nSample first 3 entries:');
  for (const p of result.photos.slice(0, 3)) {
    console.log(`  id=${p.id} type=${p.mediaType} dims=${p.w}x${p.h}`);
    console.log(`    ${p.url.slice(0, 110)}...`);
  }
  const found = result.photos.find((p) => p.id === 'CIHM0ogKEICAgICTpuPH_AE');
  console.log('\nUser-supplied video ID CIHM0ogKEICAgICTpuPH_AE present:', found ? 'YES' : 'NO');
  if (found) console.log('  ', JSON.stringify(found, null, 2));

  await browser.close();
})();
