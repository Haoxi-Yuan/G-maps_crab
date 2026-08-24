#!/usr/bin/env node
'use strict';

/**
 * audit-ui-geometry.js
 *
 * Independent UI-geometry capture: open Google Maps Street View at a target
 * panoid and record EVERY non-trivial network request through a sequence of
 * scripted interaction phases. Goal is to detect whether the UI fetches
 * geometry/depth/mesh/vector-tile payloads beyond what the photometa pipeline
 * already covers.
 *
 * Strict scope:
 *   - photometa pipeline is left alone (this is purely an audit / discovery)
 *   - bodies for images/html/js/css are NOT saved
 *   - everything else (octet-stream, protobuf, application/*, etc.) is saved
 *     under bodies/<sha1> for offline classification
 *   - manifest.json carries every request (with phase, content-type, size,
 *     sha1) regardless of whether the body was saved
 *
 * Phases:
 *   A_initial         page load + idle (12 s by default)
 *   B_ground          mouse sweep across visual ground (lower viewport)
 *   C_facade          mouse sweep across visual facade (upper viewport)
 *   D_arrow_hover     best-effort hover over the click-to-go arrow (skip if not found)
 *   E_click_to_go     actual click on the arrow + idle (8 s)
 *   F_idle_after      passive idle baseline (6 s)
 *
 * Usage:
 *   node TEST/src/js/capture/audit-ui-geometry.js --panoid <PANOID>
 *   node TEST/src/js/capture/audit-ui-geometry.js --url '<sv-url>'
 *
 * Output:
 *   TEST/data/raw/google_maps/ui_geometry/<panoid>/<ts>/
 *     manifest.json
 *     phases.json
 *     requests.ndjson           (incremental log; manifest.json is the cooked summary)
 *     bodies/<sha1>.bin         (only for saved-body responses)
 *     screenshots/<phase>.png
 *     console.log
 *     run.log                   (orchestrator log, mirrors stdout)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const stealth = require('../../../../src/stealth');

const TEST_ROOT = path.resolve(__dirname, '..', '..', '..');

const SAVE_BODY_CAP_BYTES = 8 * 1024 * 1024; // 8 MB per body

// content-types we DO NOT save bodies for (everything else is saved)
const SKIP_BODY_CT = [
  /^image\//i,
  /^text\/html/i,
  /^text\/css/i,
  /^text\/plain/i,
  /^application\/javascript/i,
  /^application\/x-javascript/i,
  /^text\/javascript/i,
  /^font\//i,
  /^application\/font-/i,
];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function flag(name) {
  return process.argv.indexOf(`--${name}`) >= 0;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function buildSvUrl(panoid) {
  // Pano-only entry. Google rewrites this to the canonical /maps/@... pano URL.
  return `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(panoid)}`;
}

function shouldSaveBody(contentType) {
  if (!contentType) return true; // unknown CT — be greedy, classify offline
  return !SKIP_BODY_CT.some(re => re.test(contentType));
}

async function waitIdle(reqsRef, quietSec, maxSec) {
  const quietMs = quietSec * 1000;
  const maxMs = maxSec * 1000;
  const start = Date.now();
  let lastLen = reqsRef.length;
  let lastChange = Date.now();
  while (Date.now() - lastChange < quietMs) {
    if (Date.now() - start > maxMs) break;
    await new Promise(r => setTimeout(r, 300));
    if (reqsRef.length !== lastLen) {
      lastLen = reqsRef.length;
      lastChange = Date.now();
    }
  }
}

function buildSweep(W, H, kind) {
  const points = [];
  if (kind === 'ground') {
    const ys = [Math.round(H * 0.78), Math.round(H * 0.86)];
    const xs = [0.20, 0.35, 0.50, 0.65, 0.80].map(f => Math.round(W * f));
    for (const y of ys) for (const x of xs) points.push({ x, y });
  } else if (kind === 'facade') {
    const ys = [Math.round(H * 0.28), Math.round(H * 0.38)];
    const xs = [0.15, 0.30, 0.45, 0.60, 0.75, 0.90].map(f => Math.round(W * f));
    for (const y of ys) for (const x of xs) points.push({ x, y });
  }
  return points;
}

(async () => {
  const panoid = arg('panoid');
  const explicitUrl = arg('url');
  if (!panoid && !explicitUrl) {
    console.error('usage: --panoid <PANOID> [--url <override>]');
    process.exit(2);
  }
  const url = explicitUrl || buildSvUrl(panoid);
  const ts = timestamp();
  const outDir = arg('output') || path.join(
    TEST_ROOT, 'data', 'raw', 'google_maps', 'ui_geometry',
    panoid || 'custom', ts
  );
  const bodiesDir = path.join(outDir, 'bodies');
  const shotsDir = path.join(outDir, 'screenshots');
  fs.mkdirSync(bodiesDir, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });

  const runLogPath = path.join(outDir, 'run.log');
  const runLogFh = fs.openSync(runLogPath, 'w');
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.writeSync(runLogFh, line);
    process.stdout.write(line);
  };

  log(`panoid=${panoid || '(none)'}`);
  log(`url=${url}`);
  log(`outDir=${outDir}`);

  // Anonymous context — fresh state, no cookies, no persistent storage.
  const launchOpts = stealth.buildLaunchOptions({ headless: false, slowMo: 0 });
  const browser = await chromium.launch(launchOpts);
  const { context, page } = await stealth.createStealthContext(browser, {
    blockImages: false,
    blockHeavyResources: false,
    blockTracking: false,
  });

  const allRequests = []; // shared idle tracker
  const requestsByUrl = new Map(); // url+method -> request meta (so response can pair up)
  const seenBodyHashes = new Set();

  const requestsNdjsonPath = path.join(outDir, 'requests.ndjson');
  const requestsFh = fs.openSync(requestsNdjsonPath, 'w');
  const writeRecord = (rec) => {
    fs.writeSync(requestsFh, JSON.stringify(rec) + '\n');
  };

  // Phase tracker (mutable; the response handler stamps requests with the phase active at response time)
  const phaseRef = { current: 'pre' };
  const phaseEvents = []; // { phase, t_start, t_end }

  // Console capture
  const consoleLogPath = path.join(outDir, 'console.log');
  const consoleFh = fs.openSync(consoleLogPath, 'w');
  page.on('console', (m) => {
    const txt = `[${m.type()}] ${m.text()}\n`;
    fs.writeSync(consoleFh, txt);
  });

  page.on('request', (req) => {
    const t = Date.now();
    allRequests.push({ t, url: req.url(), method: req.method(), type: req.resourceType() });
    requestsByUrl.set(`${req.method()} ${req.url()}`, { phase_at_request: phaseRef.current, t_request: t });
  });

  page.on('response', async (resp) => {
    const req = resp.request();
    const reqKey = `${req.method()} ${req.url()}`;
    const reqMeta = requestsByUrl.get(reqKey) || { phase_at_request: phaseRef.current, t_request: Date.now() };
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    const status = resp.status();
    const u = resp.url();
    const t = Date.now();

    let body = null;
    let bodyErr = null;
    try {
      body = await resp.body();
    } catch (e) {
      bodyErr = e.message;
    }

    let sha1 = null;
    let bodySize = body ? body.length : null;
    let savedPath = null;
    let truncated = false;

    if (body) {
      sha1 = crypto.createHash('sha1').update(body).digest('hex');
      if (shouldSaveBody(ct) && status >= 200 && status < 400) {
        const writeBody = body.length <= SAVE_BODY_CAP_BYTES ? body : body.slice(0, SAVE_BODY_CAP_BYTES);
        truncated = body.length > SAVE_BODY_CAP_BYTES;
        const fp = path.join(bodiesDir, `${sha1}.bin`);
        if (!seenBodyHashes.has(sha1)) {
          try {
            fs.writeFileSync(fp, writeBody);
            seenBodyHashes.add(sha1);
          } catch (e) {
            log(`body write failed sha1=${sha1.slice(0, 12)} err=${e.message}`);
          }
        }
        savedPath = path.relative(outDir, fp);
      }
    }

    const rec = {
      t_request: reqMeta.t_request,
      t_response: t,
      phase_at_request: reqMeta.phase_at_request,
      phase_at_response: phaseRef.current,
      method: req.method(),
      url: u,
      status,
      content_type: ct || null,
      resource_type: req.resourceType(),
      body_size: bodySize,
      body_sha1: sha1,
      body_saved: savedPath,
      body_truncated: truncated,
      body_error: bodyErr,
    };
    writeRecord(rec);
  });

  const enterPhase = async (phase) => {
    if (phaseEvents.length) phaseEvents[phaseEvents.length - 1].t_end = Date.now();
    phaseRef.current = phase;
    phaseEvents.push({ phase, t_start: Date.now(), t_end: null });
    log(`>>> phase ${phase}`);
    try {
      await page.screenshot({ path: path.join(shotsDir, `${phase}.png`), fullPage: false });
    } catch (e) {
      // screenshot may fail before navigation; ignore
    }
  };

  // ===== Phase A: initial load =====
  await enterPhase('A_initial');
  log('navigating...');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    log(`goto warning: ${e.message}`);
  }
  log('waiting for network idle (12 s quiet, 60 s max)...');
  await waitIdle(allRequests, 12, 60);
  try {
    await page.screenshot({ path: path.join(shotsDir, `A_initial_settled.png`) });
  } catch {}

  const viewport = await page.viewportSize();
  if (!viewport) {
    log('viewport unavailable — aborting interaction phases');
    await context.close();
    await browser.close();
    fs.closeSync(requestsFh);
    fs.closeSync(consoleFh);
    fs.closeSync(runLogFh);
    process.exit(1);
  }
  const W = viewport.width, H = viewport.height;
  log(`viewport=${W}x${H}`);

  // Park mouse off-screen-ish (corner) before sweeps
  try { await page.mouse.move(2, 2); } catch {}
  await page.waitForTimeout(400);

  // ===== Phase B: ground sweep =====
  await enterPhase('B_ground');
  for (const p of buildSweep(W, H, 'ground')) {
    try {
      await page.mouse.move(p.x, p.y, { steps: 18 });
    } catch (e) {
      log(`mouse move err: ${e.message}`);
    }
    await page.waitForTimeout(800);
  }
  // Quiet tail to capture trailing async fetches
  await waitIdle(allRequests, 4, 12);

  // ===== Phase C: facade sweep =====
  await enterPhase('C_facade');
  for (const p of buildSweep(W, H, 'facade')) {
    try {
      await page.mouse.move(p.x, p.y, { steps: 18 });
    } catch (e) {
      log(`mouse move err: ${e.message}`);
    }
    await page.waitForTimeout(800);
  }
  await waitIdle(allRequests, 4, 12);

  // ===== Phase D: arrow hover (best-effort) =====
  await enterPhase('D_arrow_hover');
  const arrowInfo = await page.evaluate(() => {
    const probes = [
      '[role="button"][aria-label]',
      'button[aria-label]',
      'a[role="button"][aria-label]',
    ];
    const set = new Set();
    for (const sel of probes) {
      for (const el of document.querySelectorAll(sel)) set.add(el);
    }
    const moveRe = /(move forward|move backward|move to|next|previous|forward|backward|向前|向后|前进|后退)/i;
    const hits = [];
    for (const el of set) {
      const lab = el.getAttribute('aria-label') || '';
      if (!moveRe.test(lab)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      hits.push({
        label: lab,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
        tag: el.tagName,
      });
    }
    return hits;
  });
  log(`arrow probe: ${arrowInfo.length} candidate(s)`);
  let chosenArrow = null;
  if (arrowInfo.length) {
    // Prefer "Move forward" if present, else first.
    chosenArrow = arrowInfo.find(a => /forward|前进|向前/i.test(a.label)) || arrowInfo[0];
    log(`hovering arrow: "${chosenArrow.label}" @(${chosenArrow.x},${chosenArrow.y})`);
    try {
      await page.mouse.move(chosenArrow.x, chosenArrow.y, { steps: 25 });
      await page.waitForTimeout(2000);
    } catch (e) {
      log(`arrow hover err: ${e.message}`);
    }
    await waitIdle(allRequests, 3, 8);
  } else {
    log('no arrow found — skipping D');
  }

  // ===== Phase E: click-to-go =====
  await enterPhase('E_click_to_go');
  if (chosenArrow) {
    try {
      await page.mouse.click(chosenArrow.x, chosenArrow.y, { delay: 50 });
      log('arrow clicked, waiting for transition');
      await page.waitForTimeout(1500);
      await waitIdle(allRequests, 6, 15);
    } catch (e) {
      log(`click err: ${e.message}`);
    }
  } else {
    log('no arrow — skipping click');
  }

  // ===== Phase F: idle baseline =====
  await enterPhase('F_idle_after');
  // park mouse far away
  try { await page.mouse.move(2, 2); } catch {}
  await page.waitForTimeout(6000);

  // close out final phase
  if (phaseEvents.length) phaseEvents[phaseEvents.length - 1].t_end = Date.now();

  // ===== Cooked outputs =====
  fs.closeSync(requestsFh);
  fs.closeSync(consoleFh);

  // Read back ndjson and produce manifest.json
  const records = fs.readFileSync(requestsNdjsonPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const totalBytes = records.reduce((a, r) => a + (r.body_size || 0), 0);
  const savedBodies = records.filter(r => r.body_saved).length;

  const phaseHist = {};
  for (const ph of phaseEvents.map(p => p.phase)) phaseHist[ph] = phaseHist[ph] || { requests: 0, saved_bodies: 0, bytes: 0 };
  for (const r of records) {
    const ph = r.phase_at_request || 'pre';
    if (!phaseHist[ph]) phaseHist[ph] = { requests: 0, saved_bodies: 0, bytes: 0 };
    phaseHist[ph].requests++;
    if (r.body_saved) phaseHist[ph].saved_bodies++;
    phaseHist[ph].bytes += r.body_size || 0;
  }

  fs.writeFileSync(path.join(outDir, 'phases.json'), JSON.stringify({
    panoid: panoid || null,
    url,
    started_at: phaseEvents[0]?.t_start || null,
    finished_at: phaseEvents[phaseEvents.length - 1]?.t_end || null,
    phases: phaseEvents,
    arrow_candidates: arrowInfo,
    arrow_used: chosenArrow,
  }, null, 2));

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    panoid: panoid || null,
    url,
    timestamp: ts,
    viewport: { W, H },
    summary: {
      total_requests: records.length,
      saved_bodies: savedBodies,
      unique_body_hashes: seenBodyHashes.size,
      total_response_bytes: totalBytes,
      per_phase: phaseHist,
    },
    requests: records,
  }, null, 2));

  log(`done. records=${records.length} saved_bodies=${savedBodies} unique_hashes=${seenBodyHashes.size}`);
  fs.closeSync(runLogFh);

  await context.close();
  await browser.close();
})().catch(err => {
  console.error('[audit-ui-geometry] FATAL:', err);
  process.exit(1);
});
