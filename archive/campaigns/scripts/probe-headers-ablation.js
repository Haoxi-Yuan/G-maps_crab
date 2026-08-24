#!/usr/bin/env node
/**
 * probe-headers-ablation.js
 *
 * Controlled experiment to verify the claim in the anti-scraping report:
 *   "Google's /maps/_/MapsWizUi/data/batchexecute gateway now enforces
 *    per-request signed headers (x-maps-bgbind = query context,
 *    x-maps-bgkey = signed token). A replay missing them returns a 200 with an
 *    empty body [null,null,null,null,null,true] that the pager misread as
 *    'blocked'. The fix captures the real request headers and replays them."
 *
 * The report's original 3-group test (content-type only / +referer / full
 * headers) only proves "some header is required" — it cannot isolate WHICH
 * header is load-bearing (sec-ch-ua? x-same-domain? origin? the bg tokens?).
 *
 * This probe does a leave-one-out ablation. It loads a place exactly like the
 * production scraper (src/review-scraper.js: stealth context + two-step load),
 * captures ONE genuine qv9Egd POST (url + body + full headers), then replays
 * the SAME url+body many times changing ONLY the header set, back-to-back, in
 * the same session/cookies. Differences are thus attributable to headers alone
 * — not IP, not cookies, not rate drift, not place exhaustion.
 *
 * Conditions:
 *   C0_full_pre   all captured headers          (positive control, before)
 *   C1_ct_only    content-type only             (negative control / report g1)
 *   C2_ct_referer content-type + referer        (report g2)
 *   C3_no_bgbind  full minus x-maps-bgbind
 *   C4_no_bgkey   full minus x-maps-bgkey
 *   C5_no_both_bg full minus BOTH x-maps-bg*    (DECISIVE: is it the token?)
 *   C6_no_samedom full minus x-same-domain
 *   C7_no_origin  full minus origin
 *   C8_no_secchua full minus all sec-ch-ua*
 *   C9_no_referer full minus referer
 *   C10_minimal   content-type + bg* + x-same-domain + origin (sufficient set?)
 *   C0_full_post  all captured headers          (positive control, after)
 *
 * Verdict logic (per place):
 *   - C0 full returns reviews AND C5 (drop both bg) returns empty
 *     AND C6..C9 still return reviews  => report confirmed: signed-token upgrade
 *   - If C8/C9 alone also empties      => fix still valid, report attribution off
 *
 * Plus: a durability pass paginates N pages with the full captured headers to
 * see whether the captured token expires mid-scrape.
 *
 * Run identically on a residential IP (local) and a datacenter IP (server). If
 * both show "empty without bg, full with bg", the result is IP-independent —
 * decisively separating header enforcement from IP reputation.
 *
 * Usage:
 *   node scripts/probe-headers-ablation.js [--place <ftid>]... [--out <file>]
 *        [--no-sandbox] [--headful] [--pages <n>] [--places-limit <n>]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const stealth = require('../src/stealth');

const REVIEW_RPC_ID = 'qv9Egd';
const RPC_SERVICE = '/MapsUgcPostService.ListUgcPosts';

// Proven high-review place_ids (ftid form) pulled from output/{paris,berlin}.
const DEFAULT_PLACES = [
  { name: 'Eiffel Tower',     pid: '0x47e66e2964e34e2d:0x8ddca9ee380ef7e0' },
  { name: 'Louvre Museum',    pid: '0x47e671d877937b0f:0xb975fcfa192f84d4' },
  { name: 'Brandenburg Gate', pid: '0x47a851c655f20989:0x26bbfb4e84674c63' },
];

// ----- batchexecute helpers (mirrors src/api-review-fetcher.js) -------------

function parseBatchexecuteResponse(text, rpcServicePath = RPC_SERVICE) {
  let pos = 0;
  while (pos < text.length) {
    const startIdx = text.indexOf('[["wrb.fr"', pos);
    if (startIdx < 0) return null;
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = startIdx; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) return null;
    let envelope;
    try { envelope = JSON.parse(text.slice(startIdx, end)); }
    catch { pos = startIdx + 1; continue; }
    for (const entry of envelope) {
      if (Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === rpcServicePath) {
        try { return JSON.parse(entry[2]); } catch { return null; }
      }
    }
    pos = end;
  }
  return null;
}

function buildPaginatedBody(originalBody, nextToken, pageSize) {
  const params = new URLSearchParams(originalBody);
  const freq = params.get('f.req');
  if (!freq) throw new Error('original body has no f.req');
  const outer = JSON.parse(freq);
  const inner = JSON.parse(outer[0][0][1]);
  inner[1] = [pageSize, nextToken || ''];
  outer[0][0][1] = JSON.stringify(inner);
  params.set('f.req', JSON.stringify(outer));
  return params.toString();
}

// Count reviews in a raw batchexecute response; classify the response.
function classify(status, text) {
  if (status !== 200) return { status, bytes: text.length, count: 0, klass: 'http_' + status };
  const inner = parseBatchexecuteResponse(text);
  const count = (inner && Array.isArray(inner[2])) ? inner[2].length : 0;
  let klass;
  if (count > 0) klass = 'FULL';
  else if (!inner) klass = 'EMPTY(no-wrb.fr)';
  else klass = 'EMPTY(null-array)';
  return { status, bytes: text.length, count, klass };
}

// ----- header variant builders ---------------------------------------------

function pick(full, keys) { const o = {}; for (const k of keys) if (full[k] !== undefined) o[k] = full[k]; return o; }
function omit(full, keys) { const o = { ...full }; for (const k of keys) delete o[k]; return o; }
function omitPrefix(full, p) { const o = { ...full }; for (const k of Object.keys(o)) if (k.startsWith(p)) delete o[k]; return o; }

function buildVariants(full) {
  return [
    { id: 'C0_full_pre',   desc: 'all captured headers (control, pre)',         headers: { ...full } },
    { id: 'C1_ct_only',    desc: 'content-type only',                           headers: pick(full, ['content-type']) },
    { id: 'C2_ct_referer', desc: 'content-type + referer',                      headers: pick(full, ['content-type', 'referer']) },
    { id: 'C3_no_bgbind',  desc: 'full minus x-maps-bgbind',                    headers: omit(full, ['x-maps-bgbind']) },
    { id: 'C4_no_bgkey',   desc: 'full minus x-maps-bgkey',                     headers: omit(full, ['x-maps-bgkey']) },
    { id: 'C5_no_both_bg', desc: 'full minus BOTH x-maps-bg* (decisive)',       headers: omit(full, ['x-maps-bgbind', 'x-maps-bgkey']) },
    { id: 'C6_no_samedom', desc: 'full minus x-same-domain',                    headers: omit(full, ['x-same-domain']) },
    { id: 'C7_no_origin',  desc: 'full minus origin',                           headers: omit(full, ['origin']) },
    { id: 'C8_no_secchua', desc: 'full minus all sec-ch-ua*',                   headers: omitPrefix(full, 'sec-ch-ua') },
    { id: 'C9_no_referer', desc: 'full minus referer',                          headers: omit(full, ['referer']) },
    { id: 'C10_minimal',   desc: 'content-type + bg* + x-same-domain + origin', headers: pick(full, ['content-type', 'x-maps-bgbind', 'x-maps-bgkey', 'x-same-domain', 'origin']) },
    { id: 'C0_full_post',  desc: 'all captured headers (control, post)',        headers: { ...full } },
  ];
}

// ----- playwright replay -----------------------------------------------------

async function replay(page, url, body, headers) {
  return await page.evaluate(async ({ url, body, headers }) => {
    try {
      const r = await fetch(url, { method: 'POST', credentials: 'include', headers, body });
      const text = await r.text();
      return { status: r.status, text };
    } catch (e) {
      return { status: -1, text: 'EXC:' + (e && e.message || 'unknown') };
    }
  }, { url, body, headers });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- per-place battery -----------------------------------------------------

async function runPlace(browser, place, opts) {
  const { pages, headful } = opts;
  const result = { place: place.name, pid: place.pid, captured: null, variants: [], durability: null, error: null };

  const { context, page } = await stealth.createStealthContext(browser, {});

  // Capture the first qv9Egd POST exactly like api-review-fetcher.js does.
  let cap = null;
  const handler = (req) => {
    const u = req.url();
    if (cap) return;
    if (!u.includes('rpcids=' + REVIEW_RPC_ID)) return;
    const raw = req.headers();
    const hdr = {};
    for (const [k, v] of Object.entries(raw || {})) {
      const lk = k.toLowerCase();
      if (lk.startsWith(':')) continue;
      if (['host', 'content-length', 'cookie', 'accept-encoding', 'connection'].includes(lk)) continue;
      hdr[k] = v;
    }
    if (!hdr['content-type']) hdr['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    cap = { url: u, body: req.postData() || '', headers: hdr };
  };
  page.on('request', handler);

  try {
    const isFtid = place.pid.startsWith('0x');
    await page.goto(`https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${place.pid}`,
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    // Best-effort consent dismissal (EU IPs).
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const b = btns.find(x => /accept all|reject all|alle akzeptieren|tout accepter/i.test(x.textContent || ''));
      if (b) b.click();
    }).catch(() => {});

    const placeUrl = isFtid
      ? `https://www.google.com/maps/place/?ftid=${place.pid}&hl=en`
      : `https://www.google.com/maps/place/?q=place_id:${place.pid}&hl=en`;
    await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Click Reviews tab to trigger the first ListUgcPosts POST.
    const clicked = await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll('button[role="tab"]'))
        .find(t => t.textContent.toLowerCase().includes('review'));
      if (t) { t.click(); return true; }
      return false;
    });
    if (!clicked) { result.error = 'reviews_tab_not_found'; return finish(); }

    for (let i = 0; i < 30 && !cap; i++) await page.waitForTimeout(500);
    if (!cap) { result.error = 'qv9Egd_not_captured'; return finish(); }

    const hdrNames = Object.keys(cap.headers).sort();
    const hasBgbind = 'x-maps-bgbind' in cap.headers;
    const hasBgkey = 'x-maps-bgkey' in cap.headers;
    result.captured = {
      headerNames: hdrNames,
      hasBgbind, hasBgkey,
      bgbindLen: cap.headers['x-maps-bgbind'] ? cap.headers['x-maps-bgbind'].length : 0,
      bgkeyLen: cap.headers['x-maps-bgkey'] ? cap.headers['x-maps-bgkey'].length : 0,
      bodyBytes: cap.body.length,
    };
    if (!hasBgbind || !hasBgkey) {
      console.log(`  [WARN] captured request missing bg headers (bgbind=${hasBgbind} bgkey=${hasBgkey}) — mechanism may have changed`);
    }

    // --- Ablation battery (same url+body, vary headers) ---
    const variants = buildVariants(cap.headers);
    for (const v of variants) {
      const r = await replay(page, cap.url, cap.body, v.headers);
      const c = classify(r.status, r.text);
      result.variants.push({ id: v.id, desc: v.desc, nHeaders: Object.keys(v.headers).length, ...c });
      console.log(`  ${v.id.padEnd(13)} hdrs=${String(Object.keys(v.headers).length).padStart(2)}  ${String(c.status).padStart(3)}  ${String(c.bytes).padStart(7)}B  reviews=${String(c.count).padStart(3)}  ${c.klass}`);
      await sleep(300);
    }

    // --- Durability pass: paginate with full headers ---
    if (pages > 0) {
      const dur = { requested: pages, pages: [], degradedAt: null };
      let token = '';
      let url = cap.url;
      for (let p = 0; p < pages; p++) {
        const body = buildPaginatedBody(cap.body, token, 10);
        const r = await replay(page, url, body, cap.headers);
        const c = classify(r.status, r.text);
        const inner = c.status === 200 ? parseBatchexecuteResponse(r.text) : null;
        token = (inner && inner[1]) ? inner[1] : '';
        dur.pages.push({ page: p, count: c.count, klass: c.klass, hasToken: !!token });
        if (c.count === 0 && dur.degradedAt === null) dur.degradedAt = p;
        if (!token) break;
        url = url.replace(/([?&]_reqid=)(\d+)/, (_, pre, n) => pre + (parseInt(n, 10) + 100000));
        await sleep(300);
      }
      const totalDur = dur.pages.reduce((s, x) => s + x.count, 0);
      result.durability = dur;
      console.log(`  durability: ${dur.pages.length} pages, ${totalDur} reviews, degradedAt=${dur.degradedAt}`);
    }
  } catch (e) {
    result.error = 'exception:' + (e && e.message || 'unknown').slice(0, 120);
  }
  return finish();

  async function finish() {
    page.off('request', handler);
    try { await context.close(); } catch (_) {}
    return result;
  }
}

// ----- main ------------------------------------------------------------------

function parseArgs(argv) {
  const a = { places: [], out: null, noSandbox: false, headful: false, pages: 25, placesLimit: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--place': a.places.push({ name: 'custom:' + argv[i + 1], pid: argv[++i] }); break;
      case '--out': a.out = argv[++i]; break;
      case '--no-sandbox': a.noSandbox = true; break;
      case '--headful': a.headful = true; break;
      case '--pages': a.pages = parseInt(argv[++i], 10); break;
      case '--places-limit': a.placesLimit = parseInt(argv[++i], 10); break;
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let places = args.places.length ? args.places : DEFAULT_PLACES;
  if (args.placesLimit) places = places.slice(0, args.placesLimit);

  const host = os.hostname();
  const out = args.out || `probe-ablation-${host}.json`;

  console.log(`=== batchexecute header ablation probe ===`);
  console.log(`host=${host}  platform=${os.platform()}  node=${process.version}`);
  console.log(`places=${places.length}  pages(durability)=${args.pages}  noSandbox=${args.noSandbox}`);
  console.log('');

  const browser = await chromium.launch({
    headless: !args.headful,
    args: stealth.buildLaunchArgs({ noSandbox: args.noSandbox }),
  });

  const results = [];
  try {
    for (const place of places) {
      console.log(`--- ${place.name} (${place.pid}) ---`);
      const r = await runPlace(browser, place, { pages: args.pages, headful: args.headful });
      results.push(r);
      console.log('');
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  const report = {
    host, platform: os.platform(), node: process.version,
    pagesRequested: args.pages,
    results,
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${out}`);

  // Compact verdict per place.
  console.log('\n=== VERDICT ===');
  for (const r of results) {
    if (r.error) { console.log(`${r.place}: ERROR ${r.error}`); continue; }
    const by = Object.fromEntries(r.variants.map(v => [v.id, v]));
    const full = by['C0_full_pre'], fullPost = by['C0_full_post'];
    const noBg = by['C5_no_both_bg'];
    const ctrlOk = full && fullPost && full.count > 0 && fullPost.count > 0;
    const bgLoadBearing = noBg && noBg.count === 0;
    const others = ['C6_no_samedom', 'C7_no_origin', 'C8_no_secchua', 'C9_no_referer']
      .map(id => by[id]).filter(Boolean);
    const othersStillFull = others.every(v => v.count > 0);
    let verdict;
    if (!ctrlOk) verdict = 'INCONCLUSIVE (positive control did not return reviews)';
    else if (bgLoadBearing && othersStillFull) verdict = 'CONFIRMED: x-maps-bg* signed token is the load-bearing header';
    else if (bgLoadBearing) verdict = 'bg headers load-bearing, but other headers ALSO matter (see C6-C9)';
    else verdict = 'NOT bg-only: dropping bg headers did NOT empty the response — attribution is wrong';
    console.log(`${r.place}: ${verdict} [C0pre=${full && full.count} C0post=${fullPost && fullPost.count} C5=${noBg && noBg.count}]`);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
