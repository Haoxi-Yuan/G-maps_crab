#!/usr/bin/env node
'use strict';

/**
 * fetch-neighbor-photometas.js
 *
 * Given a reference photometa (with its 74 neighbor panoids), pull the
 * photometa for every neighbor via direct HTTP — no browser needed. Replays
 * the pb URL template, substituting the panoid string in the
 * !3m3!1m2!1e2!2s<panoid> position.
 *
 * Falls back to Playwright with a captured cookie jar if a 4xx response is
 * received (handles cases where Google requires a session cookie).
 *
 * Usage:
 *   node TEST/fetch-neighbor-photometas.js \
 *     --run-dir <path to streetview_3d/<ts>_.../> \
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

function parseArgs(argv) {
  const args = { throttleMs: 250 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-dir') args.runDir = argv[++i];
    else if (a === '--throttle-ms') args.throttleMs = parseInt(argv[++i], 10);
  }
  if (!args.runDir) {
    console.error('--run-dir <streetview_3d/<ts>_.../> required');
    process.exit(2);
  }
  return args;
}

function buildUrl(panoid) {
  const pb = PB_TEMPLATE.replace('__PANOID__', panoid);
  return `https://www.google.com/maps/photometa/v1?authuser=0&hl=en&gl=sg&pb=${encodeURIComponent(pb)}`;
}

async function fetchOne(panoid) {
  const url = buildUrl(panoid);
  const resp = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  const status = resp.status;
  const text = await resp.text();
  return { status, text, contentType: resp.headers.get('content-type') };
}

function parseResponseToJson(text) {
  // Photometa responses are prefixed with )]}'\n
  const cleaned = text.replace(/^\)\]\}'\n?/, '');
  return JSON.parse(cleaned);
}

function getPanoid(parsed) {
  try { return parsed[1][0][1][1]; } catch { return null; }
}

function getNumPlanes(parsed) {
  try {
    const node = parsed[1][0][5][0][5];
    if (!node) return 0;
    const blob1 = Buffer.from(node[1][2], 'base64');
    return blob1.readUInt16LE(1);
  } catch { return 0; }
}

async function main() {
  const args = parseArgs(process.argv);
  const runDir = path.resolve(args.runDir);
  if (!fs.existsSync(runDir)) {
    console.error(`run-dir not found: ${runDir}`);
    process.exit(2);
  }

  const refFp = path.join(runDir, 'photometa_0_parsed.json');
  if (!fs.existsSync(refFp)) {
    console.error(`Need photometa_0_parsed.json in ${runDir}. Run sv3d probe first.`);
    process.exit(2);
  }

  const ref = JSON.parse(fs.readFileSync(refFp, 'utf8'));
  let neighbors;
  try {
    neighbors = ref[1][0][5][0][3][0].map(e => ({
      panoid: e[0][1],
      lat: e[2][0][2],
      lng: e[2][0][3],
    }));
  } catch (e) {
    console.error('Cannot extract neighbor list from photometa_0_parsed.json:', e.message);
    process.exit(2);
  }
  console.log(`Found ${neighbors.length} neighbors in reference photometa.`);

  const outDir = path.join(runDir, 'neighbor_photometas');
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  let okCount = 0, failCount = 0;

  for (let i = 0; i < neighbors.length; i++) {
    const nb = neighbors[i];
    const binFp = path.join(outDir, `${nb.panoid}.bin`);
    const jsonFp = path.join(outDir, `${nb.panoid}.parsed.json`);

    // Skip if already cached
    if (fs.existsSync(binFp) && fs.existsSync(jsonFp)) {
      const parsed = JSON.parse(fs.readFileSync(jsonFp, 'utf8'));
      const np = getNumPlanes(parsed);
      results.push({ panoid: nb.panoid, status: 'cached', numPlanes: np, lat: nb.lat, lng: nb.lng });
      console.log(`  [${i + 1}/${neighbors.length}] ${nb.panoid.slice(0, 12)}…  cached  (${np} planes)`);
      okCount++;
      continue;
    }

    try {
      const { status, text, contentType } = await fetchOne(nb.panoid);
      if (status === 200 && text.length > 100) {
        fs.writeFileSync(binFp, text);
        const parsed = parseResponseToJson(text);
        fs.writeFileSync(jsonFp, JSON.stringify(parsed, null, 2));
        const np = getNumPlanes(parsed);
        const returnedPid = getPanoid(parsed);
        const ok = returnedPid === nb.panoid;
        results.push({
          panoid: nb.panoid, status: ok ? 'ok' : 'mismatch',
          numPlanes: np, returnedPanoid: returnedPid,
          lat: nb.lat, lng: nb.lng,
          bytes: text.length,
        });
        okCount++;
        console.log(`  [${i + 1}/${neighbors.length}] ${nb.panoid.slice(0, 12)}…  ${text.length}B  (${np} planes)`);
      } else {
        results.push({ panoid: nb.panoid, status: 'http_error', code: status, lat: nb.lat, lng: nb.lng });
        failCount++;
        console.log(`  [${i + 1}/${neighbors.length}] ${nb.panoid.slice(0, 12)}…  FAILED HTTP ${status} (CT=${contentType})`);
      }
    } catch (e) {
      results.push({ panoid: nb.panoid, status: 'exception', error: e.message, lat: nb.lat, lng: nb.lng });
      failCount++;
      console.log(`  [${i + 1}/${neighbors.length}] ${nb.panoid.slice(0, 12)}…  EXCEPTION ${e.message}`);
    }

    // Throttle
    if (i < neighbors.length - 1) {
      await new Promise(r => setTimeout(r, args.throttleMs));
    }
  }

  const summary = {
    total: neighbors.length, ok: okCount, fail: failCount,
    finishedAt: new Date().toISOString(),
    results,
  };
  fs.writeFileSync(path.join(outDir, 'fetch_summary.json'), JSON.stringify(summary, null, 2));

  const planeCounts = results.filter(r => r.numPlanes !== undefined).map(r => r.numPlanes);
  const highDetail = planeCounts.filter(n => n > 2).length;
  const lowDetail = planeCounts.filter(n => n <= 2).length;

  console.log();
  console.log(`=== Done ===`);
  console.log(`OK: ${okCount}, fail: ${failCount}`);
  console.log(`High-detail (>2 planes): ${highDetail}`);
  console.log(`Low-detail (≤2 planes):  ${lowDetail}`);
  console.log(`Output: ${outDir}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
