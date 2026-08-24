#!/usr/bin/env node
'use strict';

/**
 * fetch-temporal-photometas.js
 *
 * Given a temporal-stack directory (containing timeline.json from harvest-
 * temporal-stack.js), bulk-fetch the photometa for every historical capture
 * via direct HTTP. Each capture lands in `captures/<YYYY-MM-DD>_<panoid>/`
 * and is ready for the existing parse-geometry → stitch_panoramas →
 * build_rgb_pointcloud pipeline.
 *
 * Replays the same pb template as fetch-neighbor-photometas.js, just with
 * different panoids — same maps_sv.tactile client signature, same auth flow.
 *
 * Output (per capture):
 *   captures/<YYYY-MM-DD>_<panoid>/photometa.bin   raw protobuf-style body
 *   captures/<YYYY-MM-DD>_<panoid>/parsed.json     JSON.parse'd response
 *   captures/<YYYY-MM-DD>_<panoid>/meta.json       {date, panoid, capture_year, capture_month}
 *
 * Usage:
 *   node src/js/fetch-temporal-photometas.js \
 *     --stack-dir data/raw/google_maps/temporal/<focal>/<ts>/ \
 *     [--throttle-ms 250]
 */

const fs = require('fs');
const path = require('path');

const PB_TEMPLATE =
  '!1m4!1smaps_sv.tactile' +
  '!11m2!2m1!1b1' +
  '!2m2!1sen!2ssg' +
  '!3m3!1m2!1e2!2s__PANOID__' +
  '!4m61!1e1!1e2!1e3!1e4!1e5!1e6!1e8!1e12!1e17!2m1!1e1!4m1!1i48!5m1!1e1!5m1!1e2!6m1!1e1!6m1!1e2' +
  '!9m36!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e3!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e1!2b0!3e3!1m3!1e4!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e3' +
  '!11m2!3m1!4b1';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.google.com/maps/',
  'Origin': 'https://www.google.com',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function buildUrl(panoid) {
  const pb = PB_TEMPLATE.replace('__PANOID__', panoid);
  return `https://www.google.com/maps/photometa/v1?authuser=0&hl=en&gl=sg&pb=${encodeURIComponent(pb)}`;
}

async function fetchOne(panoid) {
  const url = buildUrl(panoid);
  const resp = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  return { status: resp.status, text: await resp.text(), contentType: resp.headers.get('content-type') };
}

function parseResponseToJson(text) {
  return JSON.parse(text.replace(/^\)\]\}'\n?/, ''));
}

function dateLabelToYearMonth(label) {
  // "Mar 2009" → {year: 2009, month: 3}
  const months = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
  const m = label.match(/^([A-Z][a-z]{2})\s+(\d{4})$/);
  if (!m) return null;
  return { year: parseInt(m[2]), month: months[m[1]] };
}

function ymToShort(ym) {
  return `${ym.year}-${String(ym.month).padStart(2,'0')}-01`;
}

async function main() {
  const stackDir = arg('stack-dir');
  if (!stackDir) { console.error('Need --stack-dir'); process.exit(2); }
  const throttle = parseInt(arg('throttle-ms', '250'));

  const tlFp = path.join(stackDir, 'timeline.json');
  if (!fs.existsSync(tlFp)) { console.error(`Missing ${tlFp}`); process.exit(2); }
  const tl = JSON.parse(fs.readFileSync(tlFp, 'utf-8'));
  console.log(`Stack focal: ${tl.focal.panoid}  (${tl.focal.lat}, ${tl.focal.lng})`);
  console.log(`Captures to fetch: ${tl.captures.length}`);

  const captureDir = path.join(stackDir, 'captures');
  fs.mkdirSync(captureDir, { recursive: true });

  let ok = 0, skipped = 0, failed = 0;
  for (let i = 0; i < tl.captures.length; i++) {
    const c = tl.captures[i];
    const ym = dateLabelToYearMonth(c.date_label);
    if (!ym) { console.warn(`  bad date label "${c.date_label}" — skip`); failed++; continue; }
    const dateShort = ymToShort(ym);
    const dir = path.join(captureDir, `${dateShort}_${c.panoid}`);
    const binFp = path.join(dir, 'photometa.bin');
    const parsedFp = path.join(dir, 'parsed.json');
    const metaFp = path.join(dir, 'meta.json');
    if (fs.existsSync(parsedFp)) {
      console.log(`  [${i+1}/${tl.captures.length}] ${dateShort}  ${c.panoid.slice(0,12)}…  cached, skip`);
      skipped++;
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    try {
      const t0 = Date.now();
      const r = await fetchOne(c.panoid);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(binFp, r.text);
      const parsed = parseResponseToJson(r.text);
      fs.writeFileSync(parsedFp, JSON.stringify(parsed));
      const responsePanoid = (((((parsed||[])[1]||[])[0]||[])[1]||[])[1]) || null;
      const captureYM = (((((parsed||[])[1]||[])[0]||[])[6]||[])[7]) || null;
      const captureSource = (((((((parsed||[])[1]||[])[0]||[])[6]||[])[5]||[])[2])) || 'unknown';
      const meta = {
        timeline_date_label: c.date_label,
        date_short: dateShort,
        panoid_requested: c.panoid,
        panoid_returned: responsePanoid,
        is_focal: c.is_focal,
        capture_year_month: captureYM,
        capture_source: captureSource,
        fetched_at: new Date().toISOString(),
        bytes: r.text.length,
      };
      fs.writeFileSync(metaFp, JSON.stringify(meta, null, 2));
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${i+1}/${tl.captures.length}] ${dateShort}  ${c.panoid.slice(0,12)}…  ${r.text.length} bytes  ${dur}s  src=${captureSource}`);
      ok++;
    } catch (e) {
      console.warn(`  [${i+1}/${tl.captures.length}] ${dateShort}  ${c.panoid.slice(0,12)}…  FAILED: ${e.message}`);
      failed++;
    }
    if (i < tl.captures.length - 1) await new Promise(r => setTimeout(r, throttle));
  }

  console.log(`\nDone. ok=${ok}  cached=${skipped}  failed=${failed}`);
  console.log(`Captures in: ${captureDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
