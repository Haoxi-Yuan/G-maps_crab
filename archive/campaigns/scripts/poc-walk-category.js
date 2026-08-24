#!/usr/bin/env node
'use strict';

/**
 * POC v2: enter the photo "all-tags detail" view by real-mouse-clicking a
 * category chip on the overview, then explore how to enumerate photos per
 * tag in that view.
 *
 * Hand-crafted viewer URLs were rejected by Google (redirected to a
 * stripped /data=!3m1!4b1 fallback), so we let Maps' own SPA handle the
 * navigation. The chip is found via DOM scan (same heuristic the working
 * scripts/discover-photo-categories.js uses), clicked with page.mouse so
 * jsaction's mousedown/mouseup handlers fire properly.
 *
 * Once landed we capture:
 *   - final page.url() (the URL pattern we ended up at)
 *   - DOM of the photo detail view (tab bar + photo grid)
 *   - all /maps/ XHRs fired during the click + 5s settle
 *   - whether scrolling inside the grid triggers more requests
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const stealth = require('../src/stealth');

const PLACE_URL =
  'https://www.google.com/maps/place/Bukit+Timah+Wet+Market+%26+Food+Centre+(Interim)/@1.3407156,103.775054,17z/data=!4m6!3m5!1s0x31da108a1e060fc1:0x69d17c2ce13247e5!8m2!3d1.3407156!4d103.775054!16s%2Fg%2F1tfqhx60?hl=en';

const TARGET_LABEL = 'Cendol'; // any dish-level tag — adaptive code will iterate all

const OUT_DIR = path.join(__dirname, '..', 'discovery', 'poc_v2');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: stealth.buildLaunchArgs() });
  const { context, page } = await stealth.createStealthContext(browser, {});

  // -----------------------------------------------------------------
  // Capture all network: URL + status + length always, body for /maps/.
  // Also pair each response with its REQUEST postData (we need the body
  // format to replicate batchexecute calls directly via fetch).
  // -----------------------------------------------------------------
  const fired = [];
  const reqByUrl = new Map(); // url+ts → postData (for matching to response)
  page.on('request', (req) => {
    const u = req.url();
    if (!/batchexecute/.test(u)) return;
    const postData = req.postData();
    if (postData) reqByUrl.set(u + '|' + Date.now(), postData);
  });
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/\/maps\//.test(u)) return;
    let body = null, length = 0;
    try { body = await resp.text(); length = body.length; } catch (e) {}
    let postData = null;
    if (/batchexecute/.test(u)) {
      try { postData = resp.request().postData(); } catch (e) {}
    }
    fired.push({ url: u, status: resp.status(), length, body, postData, ts: Date.now() });
  });

  // -----------------------------------------------------------------
  // Load overview
  // -----------------------------------------------------------------
  await page.goto('https://www.google.com/maps?hl=en', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.goto(PLACE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('h1', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  // Scroll to reveal the Photos & videos section
  for (const top of [200, 600, 1200, 1800, 2400]) {
    await page.evaluate((t) => {
      const h1 = document.querySelector('h1');
      if (!h1) return;
      let el = h1.parentElement;
      while (el) {
        const ov = getComputedStyle(el).overflowY;
        if (ov === 'auto' || ov === 'scroll') { el.scrollTop = t; break; }
        el = el.parentElement;
      }
    }, top);
    await page.waitForTimeout(500);
  }
  console.log('Overview loaded. URL before click:');
  console.log('  ' + page.url());

  // -----------------------------------------------------------------
  // Find the Cendol chip and real-mouse-click it
  // -----------------------------------------------------------------
  const firedBefore = fired.length;
  const urlBefore = page.url();

  const chipRect = await page.evaluate((label) => {
    const candidates = Array.from(document.querySelectorAll(
      'button, a, [role="button"], [role="link"], [jsaction]'
    ));
    for (const el of candidates) {
      const aria = el.getAttribute('aria-label') || '';
      const txt = (el.innerText || '').trim();
      if (aria === label || txt === label) {
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      }
    }
    return null;
  }, TARGET_LABEL);

  if (!chipRect) {
    console.log(`Chip "${TARGET_LABEL}" not found in DOM!`);
    await browser.close();
    return;
  }
  console.log(`Cendol chip at (${chipRect.x.toFixed(0)},${chipRect.y.toFixed(0)})  ${chipRect.w}x${chipRect.h}`);

  await page.waitForTimeout(400);
  // Re-query rect post-scroll
  const chipRect2 = await page.evaluate((label) => {
    const candidates = Array.from(document.querySelectorAll(
      'button, a, [role="button"], [role="link"], [jsaction]'
    ));
    for (const el of candidates) {
      const aria = el.getAttribute('aria-label') || '';
      const txt = (el.innerText || '').trim();
      if (aria === label || txt === label) {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  }, TARGET_LABEL);
  const pt = chipRect2 || chipRect;
  await page.mouse.click(pt.x, pt.y);

  await page.waitForTimeout(5000);
  const urlAfter = page.url();
  console.log('URL after click:');
  console.log('  ' + urlAfter);
  console.log(`URL ${urlBefore === urlAfter ? 'UNCHANGED' : 'CHANGED'}`);

  // -----------------------------------------------------------------
  // Scroll the detail-view grid to trigger any lazy-load
  // -----------------------------------------------------------------
  for (let s = 0; s < 6; s++) {
    await page.evaluate(() => {
      // Try any candidate scrollable element
      const all = document.querySelectorAll('[role="dialog"], [role="region"], [role="main"], div');
      for (const el of all) {
        try {
          const ov = getComputedStyle(el).overflowY;
          if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight + 100) {
            el.scrollTop = el.scrollHeight;
          }
        } catch (e) {}
      }
    }).catch(() => {});
    await page.waitForTimeout(900);
  }

  // -----------------------------------------------------------------
  // Snapshot the post-click DOM and the photo grid
  // -----------------------------------------------------------------
  const domSummary = await page.evaluate(() => {
    // Capture tab-bar candidates: button/role-tab with text
    const tabs = [];
    for (const el of document.querySelectorAll('button[role="tab"], [role="tab"], button, [jsaction]')) {
      const t = (el.innerText || '').trim();
      const a = el.getAttribute('aria-label') || '';
      if (!t && !a) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 20) continue;
      // Filter to short tag-like labels (avoid huge buttons with lots of text)
      const text = t || a;
      if (text.length > 80) continue;
      tabs.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        ariaSelected: el.getAttribute('aria-selected') || null,
        ariaLabel: a,
        text: text.slice(0, 80),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }
    // Collect all photo-like images (lh3.googleusercontent.com srcs or background-image)
    const imgs = [];
    for (const el of document.querySelectorAll('img, [style*="googleusercontent"]')) {
      let src = el.getAttribute('src') || '';
      if (!src) {
        const bg = el.getAttribute('style') || '';
        const m = bg.match(/url\(["']?(https:\/\/[^"')]+)/);
        if (m) src = m[1];
      }
      if (!/googleusercontent\.com/.test(src)) continue;
      if (/\/a-?\//.test(src)) continue; // skip avatars
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      imgs.push({
        src,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }
    return { tabs, imgs };
  });
  console.log(`\nDOM after click: ${domSummary.tabs.length} tab-like elements, ${domSummary.imgs.length} non-avatar images`);

  fs.writeFileSync(path.join(OUT_DIR, 'urls.txt'), `BEFORE:\n${urlBefore}\n\nAFTER:\n${urlAfter}\n`);
  fs.writeFileSync(path.join(OUT_DIR, 'dom_after_click.json'), JSON.stringify(domSummary, null, 2));

  const firedAfter = fired.slice(firedBefore);
  fs.writeFileSync(
    path.join(OUT_DIR, 'requests_after_click.ndjson'),
    firedAfter
      .map((r) => JSON.stringify({
        url: r.url, status: r.status, length: r.length,
        postData: r.postData || null,
        preview: r.body ? r.body.slice(0, 600) : null,
      }))
      .join('\n')
  );
  // Dump all distinct batchexecute postData bodies — small, high-signal
  const batchexecutePosts = firedAfter
    .filter((r) => /batchexecute/.test(r.url) && r.postData)
    .map((r, i) => ({ idx: i, url: r.url, postData: r.postData, length: r.length }));
  fs.writeFileSync(
    path.join(OUT_DIR, 'batchexecute_posts.json'),
    JSON.stringify(batchexecutePosts, null, 2)
  );
  // Save full bodies for the bigger ones (likely the photo list)
  firedAfter.forEach((r, i) => {
    if (r.length > 5000) {
      fs.writeFileSync(path.join(OUT_DIR, `resp_${String(i).padStart(2, '0')}__${r.length}b.raw.txt`), r.body || '');
    }
  });
  fs.writeFileSync(
    path.join(OUT_DIR, 'page_after_click.html'),
    await page.content().catch(() => '')
  );

  console.log(`\nSaved → ${OUT_DIR}`);
  console.log('Fired during/after click:', firedAfter.length, 'maps/* requests');
  console.log('Largest responses:');
  firedAfter
    .slice()
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)
    .forEach((r) => console.log(`  ${r.length} bytes  ${r.url.slice(0, 130)}`));

  await context.close();
  await browser.close();
})().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
