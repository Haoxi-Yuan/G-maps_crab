#!/usr/bin/env node
'use strict';

/**
 * harvest-temporal-stack.js
 *
 * Given a Google Maps POI/SV URL, discover ALL historical Street View
 * captures at that physical location and emit a `timeline.json` listing
 * every (date, panoid) tuple. The downstream pipeline then bulk-fetches
 * each historical panoid's photometa + panorama + planes to produce one
 * point-cloud capture per year — the foundation for temporal SVI research.
 *
 * Mechanism: when you load an SV URL Google renders a horizontal "timeline
 * strip" along the bottom listing all captures at that point. Each strip
 * thumbnail is a <button> whose background-image URL embeds the historical
 * panoid (panoid=<id> query param). We harvest those URLs from the DOM.
 *
 * Companion to fetch-neighbor-photometas.js: that one walks SPACE (74 nbs of
 * one pano), this one walks TIME (8 captures of one location).
 *
 * Output:
 *   data/raw/google_maps/temporal/<focal_panoid>/<ts>/
 *     timeline.json       {focal: {panoid, lat, lng}, captures: [{date, panoid}]}
 *     dom_snapshot.html
 *     full_screenshot.png
 *
 * Usage:
 *   node src/js/harvest-temporal-stack.js \
 *     --url '<full Google Maps URL with panoid in data=...!1s<panoid>!2e0>' \
 *     [--quiet-seconds 8]
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const stealth = require('../../../../src/stealth');
const TEST_ROOT = path.resolve(__dirname, '..', '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function timestamp() {
  const d = new Date();
  const z = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_` +
         `${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}-${z(d.getMilliseconds(), 3)}`;
}

// Pull (date_label, panoid) pairs from the rendered timeline strip
// Returns [{date_label: 'Mar 2022', panoid: 'H5v7eyv_R26yT_4_iQ8nNQ'}]
async function extractTimeline(page) {
  return await page.evaluate(() => {
    const out = [];
    // Each timeline thumbnail is a <button> with class `aLPB6c kaqDpe` (Google
    // class hashes change occasionally — use jsaction or label-text fallback).
    // The background-image URL on the button (or its child) embeds the panoid.
    const buttons = Array.from(document.querySelectorAll('button'));
    const seen = new Set();
    for (const b of buttons) {
      // Find date label: a child <div> whose text matches "<MMM> <YYYY>"
      const txt = (b.textContent || '').trim();
      const m = txt.match(/^([A-Z][a-z]{2})\s+(20\d{2}|19\d{2})$/);
      if (!m) continue;
      const date_label = txt;
      // Try to find the panoid in any child's background-image (style attr) or src/href
      const all = [b, ...b.querySelectorAll('*')];
      let panoid = null;
      for (const el of all) {
        const style = el.getAttribute('style') || '';
        const m2 = style.match(/panoid=([A-Za-z0-9_-]{10,})/);
        if (m2) { panoid = m2[1]; break; }
      }
      if (!panoid) {
        const html = b.outerHTML;
        const m3 = html.match(/panoid=([A-Za-z0-9_-]{10,})/);
        if (m3) panoid = m3[1];
      }
      if (!panoid) continue;
      const key = `${date_label}|${panoid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date_label, panoid });
    }
    return out;
  });
}

// Parse the SV URL for the focal panoid and lat/lng
function parseFocalFromUrl(url) {
  const out = { panoid: null, lat: null, lng: null, date: null };
  // /@<lat>,<lng>,
  const m1 = url.match(/\/@(-?[\d.]+),(-?[\d.]+),/);
  if (m1) { out.lat = parseFloat(m1[1]); out.lng = parseFloat(m1[2]); }
  // !1s<panoid>!2e0
  const m2 = url.match(/!1s([A-Za-z0-9_-]{10,})!2e\d/);
  if (m2) out.panoid = m2[1];
  // !5s<YYYYMMDD>T000000
  const m3 = url.match(/!5s(\d{8})T/);
  if (m3) {
    const s = m3[1];
    out.date = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  }
  return out;
}

async function main() {
  const url = arg('url');
  if (!url) { console.error('Need --url <google maps URL with !1s<panoid>!2e0 in data=>'); process.exit(2); }
  const headless = arg('headless', '1') !== '0';
  const quietSeconds = parseInt(arg('quiet-seconds', '8'));
  const focal = parseFocalFromUrl(url);
  if (!focal.panoid) {
    console.error('Could not parse focal panoid from URL.');
    process.exit(2);
  }
  console.log(`Focal: panoid=${focal.panoid} lat=${focal.lat} lng=${focal.lng} date=${focal.date}`);

  const outDir = path.join(
    TEST_ROOT,
    'data',
    'raw',
    'google_maps',
    'temporal',
    focal.panoid,
    timestamp()
  );
  fs.mkdirSync(outDir, { recursive: true });

  const launchOpts = stealth.buildLaunchOptions({ headless, slowMo: 0 });
  const browser = await chromium.launch(launchOpts);
  const { context, page } = await stealth.createStealthContext(browser, {
    blockImages: false, blockHeavyResources: false, blockTracking: false,
  });

  let nReq = 0;
  context.on('request', () => nReq++);

  console.log(`Loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // Network idle: 4s quiet, max 30s
  let lastN = nReq, lastChange = Date.now(), start = Date.now();
  while (Date.now() - lastChange < 4000 && Date.now() - start < 30000) {
    await page.waitForTimeout(300);
    if (nReq !== lastN) { lastN = nReq; lastChange = Date.now(); }
  }
  console.log(`  network idle reached after ${((Date.now()-start)/1000).toFixed(1)}s; ${nReq} reqs total`);

  // Give the timeline strip time to render
  await page.waitForTimeout(quietSeconds * 1000);

  let captures = await extractTimeline(page);
  if (captures.length === 0) {
    // Timeline strip is hidden behind a "See more dates" button in the
    // titlecard. The button has jsaction="titlecard.timemachineClick"
    // (more stable than the obfuscated class hashes). Click it; if the
    // pano genuinely has only 1 capture the button won't exist and we
    // correctly report 0.
    console.log('  no timeline found yet — clicking "See more dates"...');
    try {
      const sel = 'button[jsaction*="timemachineClick" i]';
      if (await page.locator(sel).count() > 0) {
        await page.locator(sel).first().click({ timeout: 5000 });
        await page.waitForTimeout(3500);
      } else {
        console.log('  "See more dates" button not present (pano likely has only 1 capture)');
      }
    } catch (e) {
      console.log(`  click failed: ${e.message}`);
    }
    captures = await extractTimeline(page);
  }

  // Capture diagnostic artefacts
  await page.screenshot({ path: path.join(outDir, 'full_screenshot.png'), fullPage: false });
  fs.writeFileSync(path.join(outDir, 'dom_snapshot.html'), await page.content());

  // Build timeline.json
  const timeline = {
    source_url: url,
    focal: focal,
    capture_count: captures.length,
    captures: captures.map(c => ({
      date_label: c.date_label,
      panoid: c.panoid,
      is_focal: c.panoid === focal.panoid,
    })),
    harvested_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));

  console.log(`\n=== Timeline (${captures.length} captures) ===`);
  for (const c of captures) {
    const marker = c.panoid === focal.panoid ? '  ← focal' : '';
    console.log(`  ${c.date_label.padEnd(10)}  ${c.panoid}${marker}`);
  }
  console.log(`\nWrote ${outDir}/timeline.json`);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
