#!/usr/bin/env node
'use strict';

/**
 * walk-streetview-3d.js
 *
 * Probe the 3D system behind Google Maps street view.
 *
 * Captures:
 *   1. WASM modules: full bytecode + import/export signatures (saved to wasm_modules/)
 *   2. WASM export call statistics per "epoch" (mouse-step granularity)
 *   3. WebGL call statistics per epoch (drawCalls, uniformMatrix4fv, etc.)
 *   4. Mouse trace: at each grid point, snapshot DOM overlay + element at point
 *      + delta of wasm/webgl stats during the hover
 *   5. photometa response body (raw + parsed JSON if possible)
 *   6. Tile inventory: every /v1/tile URL with parsed panoid/x/y/zoom
 *
 * Mouse trajectory profile:
 *   - "ground sweep": horizontal scan across visible road area (lower viewport)
 *   - "facade sweep": horizontal scan across visible building wall (upper viewport)
 *   - "vertical cross": top-to-bottom sweep crossing ground↔facade boundary
 *
 * Each mouse step:
 *   1. dump+reset wasm/webgl stats
 *   2. mouse.move(x, y) over N intermediate steps (so hover events fire)
 *   3. wait dwell milliseconds
 *   4. dump wasm/webgl stats (this is the "during" delta)
 *   5. snapshot: hit element, overlay near mouse (with CSS matrix3d), screenshot crop
 *
 * Usage:
 *   node TEST/src/js/capture/walk-streetview-3d.js --url '<sv url>' [--quiet-seconds 10] [--dwell-ms 700]
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const stealth = require('../../../../src/stealth');
const TEST_ROOT = path.resolve(__dirname, '..', '..', '..');

const PHOTOMETA_RE = /\/maps\/photometa\/v1/;
const SV_TILE_RE = /streetviewpixels-pa\.googleapis\.com\/v1\/tile/;

function parseArgs(argv) {
  const args = { quietSeconds: 10, dwellMs: 700, headless: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--quiet-seconds') args.quietSeconds = parseInt(argv[++i], 10);
    else if (a === '--dwell-ms') args.dwellMs = parseInt(argv[++i], 10);
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--headless') args.headless = true;
  }
  if (!args.url) { console.error('--url required'); process.exit(2); }
  return args;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    const route = seg[1] || 'unknown';
    const name = (seg[2] || '').slice(0, 30).replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/g, '');
    return name ? `${route}_${name}` : route;
  } catch { return 'unknown'; }
}

async function waitForRequestIdle(reqsRef, quietSeconds, maxSeconds) {
  const quietMs = quietSeconds * 1000;
  const maxMs = maxSeconds * 1000;
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

function parseTileUrl(u) {
  try {
    const url = new URL(u);
    const params = url.searchParams;
    return {
      panoid: params.get('panoid'),
      x: parseInt(params.get('x'), 10),
      y: parseInt(params.get('y'), 10),
      zoom: parseInt(params.get('zoom'), 10),
      cb_client: params.get('cb_client'),
      nbt: params.get('nbt'),
      fover: params.get('fover'),
    };
  } catch { return null; }
}

function buildMouseGrid(viewportWidth, viewportHeight) {
  // Three sweeps:
  //   1. ground sweep — y at 75%-90% of height, x across
  //   2. facade sweep — y at 25%-45% of height, x across
  //   3. vertical cross — center x, y from 20% to 90%
  const W = viewportWidth, H = viewportHeight;
  const trace = [];

  // Ground sweep
  const groundYs = [Math.round(H * 0.78), Math.round(H * 0.86)];
  const groundXs = [Math.round(W * 0.2), Math.round(W * 0.35), Math.round(W * 0.5), Math.round(W * 0.65), Math.round(W * 0.8)];
  for (const y of groundYs) for (const x of groundXs) trace.push({ phase: 'ground', x, y });

  // Facade sweep
  const facadeYs = [Math.round(H * 0.28), Math.round(H * 0.38)];
  const facadeXs = [Math.round(W * 0.15), Math.round(W * 0.3), Math.round(W * 0.45), Math.round(W * 0.6), Math.round(W * 0.75), Math.round(W * 0.9)];
  for (const y of facadeYs) for (const x of facadeXs) trace.push({ phase: 'facade', x, y });

  // Vertical cross at center
  const crossX = Math.round(W * 0.5);
  for (let frac = 0.22; frac <= 0.92; frac += 0.07) {
    trace.push({ phase: 'cross', x: crossX, y: Math.round(H * frac) });
  }

  return trace;
}

async function probe(args) {
  const slug = slugFromUrl(args.url);
  const outDir = args.output || path.join(
    TEST_ROOT,
    'data',
    'raw',
    'google_maps',
    'spatial',
    slug,
    timestamp()
  );
  const wasmDir = path.join(outDir, 'wasm_modules');
  fs.mkdirSync(wasmDir, { recursive: true });

  console.log(`[sv3d] URL:        ${args.url}`);
  console.log(`[sv3d] Output:     ${outDir}`);
  console.log(`[sv3d] Quiet sec:  ${args.quietSeconds}`);
  console.log(`[sv3d] Dwell ms:   ${args.dwellMs}`);

  const launchOpts = stealth.buildLaunchOptions({ headless: !!args.headless, slowMo: 0 });
  const browser = await chromium.launch(launchOpts);
  const { context, page } = await stealth.createStealthContext(browser, {
    blockImages: false,
    blockHeavyResources: false,
    blockTracking: false,
  });

  const allRequests = [];
  const wasmLoads = []; // {method, url, size, hash, importsCount, exportsCount}
  const wasmInstances = []; // {hash, exports: [names], imports: [{module,name,kind}]}
  const screenshotsDir = path.join(outDir, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // Bindings: page → node
  await context.exposeBinding('__saveWasm', async ({}, hash, b64, url, size, method) => {
    try {
      const fp = path.join(wasmDir, `${hash}.wasm`);
      if (!fs.existsSync(fp)) {
        fs.writeFileSync(fp, Buffer.from(b64, 'base64'));
      }
      wasmLoads.push({ method, url, size, hash });
      console.log(`[sv3d] WASM load: hash=${hash.slice(0, 12)} size=${size} method=${method} url=${(url || '').slice(0, 80)}`);
    } catch (e) {
      console.warn(`[sv3d] saveWasm error: ${e.message}`);
    }
  });
  await context.exposeBinding('__wasmInstance', async ({}, hash, exportsList, importsList) => {
    wasmInstances.push({ hash, exports: exportsList, imports: importsList });
    console.log(`[sv3d] WASM instance: hash=${hash.slice(0, 12)} exports=${exportsList.length} imports=${importsList.length}`);
  });

  // Inject hooks BEFORE any script
  await context.addInitScript(() => {
    // === History hooks ===
    try {
      const _push = history.pushState, _rep = history.replaceState;
      history.pushState = function (s, t, u) {
        try { console.log('[HIST]' + JSON.stringify({ k: 'push', u: String(u) })); } catch (e) {}
        return _push.apply(this, arguments);
      };
      history.replaceState = function (s, t, u) {
        try { console.log('[HIST]' + JSON.stringify({ k: 'rep', u: String(u) })); } catch (e) {}
        return _rep.apply(this, arguments);
      };
    } catch (e) {}

    // === WASM hooks ===
    async function hashBytes(buf) {
      const h = await crypto.subtle.digest('SHA-1', buf);
      return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function bytesToBase64(buf) {
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }

    async function reportInstance(hash, instance) {
      try {
        const exports = [];
        for (const k of Object.keys(instance.exports)) {
          const v = instance.exports[k];
          exports.push({ name: k, kind: typeof v === 'function' ? 'function' : (v && v.constructor && v.constructor.name) || typeof v });
        }
        // imports info isn't directly exposed; we'd need to read module sections. Pass empty for now.
        await window.__wasmInstance(hash, exports, []);
      } catch (e) {}
    }

    // Init wasm export-call stat collector
    window.__wasmStats = {};   // {hash:exportName: count}
    window.__webglStats = {};  // {method: count}

    function wrapInstance(realInstance, hash) {
      try {
        const realExports = realInstance.exports;
        const wrapped = {};
        for (const name of Object.keys(realExports)) {
          const v = realExports[name];
          if (typeof v === 'function') {
            const key = hash.slice(0, 12) + ':' + name;
            wrapped[name] = function () {
              window.__wasmStats[key] = (window.__wasmStats[key] || 0) + 1;
              return v.apply(this, arguments);
            };
          } else {
            wrapped[name] = v;
          }
        }
        // Best-effort replace via property descriptor
        try {
          Object.defineProperty(realInstance, 'exports', { value: wrapped, configurable: true });
        } catch (e) {
          // exports may be non-configurable; in that case caller will use original (we still get count nothing)
        }
      } catch (e) {}
    }

    if (typeof WebAssembly !== 'undefined') {
      const _compile = WebAssembly.compile;
      WebAssembly.compile = async function (bytes) {
        try {
          const buf = bytes instanceof ArrayBuffer ? bytes : (bytes.buffer || bytes);
          const hash = await hashBytes(buf);
          await window.__saveWasm(hash, bytesToBase64(buf), null, buf.byteLength, 'compile');
          return _compile.call(this, bytes);
        } catch (e) { return _compile.call(this, bytes); }
      };

      const _compileStreaming = WebAssembly.compileStreaming;
      if (_compileStreaming) {
        WebAssembly.compileStreaming = async function (source) {
          try {
            const resp = await source;
            const cloned = resp.clone();
            const buf = await cloned.arrayBuffer();
            const hash = await hashBytes(buf);
            await window.__saveWasm(hash, bytesToBase64(buf), resp.url || null, buf.byteLength, 'compileStreaming');
            return _compileStreaming.call(this, resp);
          } catch (e) { return _compileStreaming.call(this, source); }
        };
      }

      const _instantiate = WebAssembly.instantiate;
      WebAssembly.instantiate = async function (bytesOrModule, importObject) {
        try {
          if (bytesOrModule instanceof ArrayBuffer || ArrayBuffer.isView(bytesOrModule)) {
            const buf = bytesOrModule instanceof ArrayBuffer ? bytesOrModule : bytesOrModule.buffer;
            const hash = await hashBytes(buf);
            await window.__saveWasm(hash, bytesToBase64(buf), null, buf.byteLength, 'instantiate');
            const result = await _instantiate.call(this, bytesOrModule, importObject);
            wrapInstance(result.instance, hash);
            await reportInstance(hash, result.instance);
            return result;
          } else {
            // Module already
            return _instantiate.call(this, bytesOrModule, importObject);
          }
        } catch (e) { return _instantiate.call(this, bytesOrModule, importObject); }
      };

      const _instantiateStreaming = WebAssembly.instantiateStreaming;
      if (_instantiateStreaming) {
        WebAssembly.instantiateStreaming = async function (source, importObject) {
          try {
            const resp = await source;
            const cloned = resp.clone();
            const buf = await cloned.arrayBuffer();
            const hash = await hashBytes(buf);
            await window.__saveWasm(hash, bytesToBase64(buf), resp.url || null, buf.byteLength, 'instantiateStreaming');
            const result = await _instantiateStreaming.call(this, resp, importObject);
            wrapInstance(result.instance, hash);
            await reportInstance(hash, result.instance);
            return result;
          } catch (e) { return _instantiateStreaming.call(this, source, importObject); }
        };
      }
    }

    // === WebGL hooks ===
    function wrapGlContext(ctx) {
      const methods = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced',
        'bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'compressedTexImage2D',
        'uniformMatrix4fv', 'uniformMatrix3fv', 'useProgram', 'createProgram', 'createBuffer', 'createTexture'];
      for (const m of methods) {
        if (typeof ctx[m] !== 'function') continue;
        const orig = ctx[m];
        const key = (ctx.constructor.name || 'GL') + '.' + m;
        ctx[m] = function () {
          window.__webglStats[key] = (window.__webglStats[key] || 0) + 1;
          return orig.apply(this, arguments);
        };
      }
    }

    const _getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = _getContext.call(this, type, ...rest);
      if (ctx && /webgl/i.test(type)) {
        try { wrapGlContext(ctx); } catch (e) {}
      }
      return ctx;
    };

    // === DOM mutation tick (for idle detection) ===
    try {
      let mutCount = 0;
      let mutTimer = null;
      const obs = new MutationObserver((muts) => {
        mutCount += muts.length;
        if (mutTimer) return;
        mutTimer = setTimeout(() => {
          try { console.log('[DOM_TICK]' + mutCount); } catch (e) {}
          mutCount = 0;
          mutTimer = null;
        }, 1000);
      });
      const start = () => {
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
        else setTimeout(start, 50);
      };
      start();
    } catch (e) {}
  });

  // Network listeners
  page.on('request', r => allRequests.push({ t: Date.now(), url: r.url(), method: r.method(), type: r.resourceType() }));

  // Save photometa & tile responses
  const photometaResponses = [];
  page.on('response', async (resp) => {
    const u = resp.url();
    if (PHOTOMETA_RE.test(u)) {
      try {
        const body = await resp.body();
        const idx = photometaResponses.length;
        const fp = path.join(outDir, `photometa_${idx}.bin`);
        fs.writeFileSync(fp, body);
        photometaResponses.push({ url: u, status: resp.status(), file: fp, size: body.length });
        console.log(`[sv3d] photometa saved (${body.length} bytes) → photometa_${idx}.bin`);
      } catch (e) {
        console.warn(`[sv3d] photometa body fetch failed: ${e.message}`);
      }
    }
  });

  // Console log forwarding
  const histEvents = [];
  page.on('console', m => {
    const txt = m.text();
    if (txt.startsWith('[HIST]')) {
      try { histEvents.push({ t: Date.now(), ...JSON.parse(txt.slice(6)) }); } catch {}
    }
  });

  // === Navigate ===
  console.log('[sv3d] Navigating...');
  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.warn(`[sv3d] goto warning: ${e.message}`);
  }
  console.log('[sv3d] DOM ready, waiting for idle (≤60s)...');
  await waitForRequestIdle(allRequests, args.quietSeconds, 60);

  // Take a baseline screenshot
  try {
    await page.screenshot({ path: path.join(outDir, 'baseline.png'), fullPage: false });
  } catch (e) {}

  // Get viewport
  const viewport = await page.viewportSize();
  const W = viewport.width, H = viewport.height;
  console.log(`[sv3d] Viewport ${W}×${H}. Building mouse grid...`);
  const grid = buildMouseGrid(W, H);
  console.log(`[sv3d] Grid: ${grid.length} points (ground=${grid.filter(p => p.phase === 'ground').length}, facade=${grid.filter(p => p.phase === 'facade').length}, cross=${grid.filter(p => p.phase === 'cross').length})`);

  // Move mouse off-screen first (using corner)
  try { await page.mouse.move(1, 1); } catch {}
  await page.waitForTimeout(500);

  // Mouse trajectory loop
  const mouseTraceFh = fs.openSync(path.join(outDir, 'mouse_trace.ndjson'), 'w');
  for (let i = 0; i < grid.length; i++) {
    const p = grid[i];
    process.stdout.write(`[sv3d] step ${i + 1}/${grid.length} ${p.phase} (${p.x},${p.y}) ... `);

    // Reset stats
    await page.evaluate(() => { window.__wasmStats = {}; window.__webglStats = {}; });

    // Move mouse with intermediate steps so hover handlers fire
    try {
      await page.mouse.move(p.x, p.y, { steps: 20 });
    } catch (e) { console.log(`move err: ${e.message}`); }
    await page.waitForTimeout(args.dwellMs);

    // Snapshot stats and DOM
    const snap = await page.evaluate(({ x, y }) => {
      const wasmStatsCopy = { ...window.__wasmStats };
      const webglStatsCopy = { ...window.__webglStats };

      // Element at point
      let el = document.elementFromPoint(x, y);
      const hitChain = [];
      let cur = el;
      let depth = 0;
      while (cur && depth < 6) {
        const r = cur.getBoundingClientRect();
        const cs = getComputedStyle(cur);
        hitChain.push({
          tag: cur.tagName,
          cls: (cur.className && typeof cur.className === 'string' ? cur.className.slice(0, 60) : ''),
          id: cur.id || null,
          transform: cs.transform === 'none' ? null : cs.transform,
          width: Math.round(r.width), height: Math.round(r.height),
          ariaLabel: cur.getAttribute && cur.getAttribute('aria-label'),
          role: cur.getAttribute && cur.getAttribute('role'),
        });
        cur = cur.parentElement;
        depth++;
      }

      // Find any element near mouse with non-trivial 3D transform
      let overlay = null;
      const allCandidates = document.querySelectorAll('div, canvas, svg');
      for (const e of allCandidates) {
        const cs = getComputedStyle(e);
        if (!cs.transform || cs.transform === 'none') continue;
        if (!cs.transform.includes('matrix3d') && !cs.transform.includes('matrix(')) continue;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // proximity check: center of element within 200px of mouse
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (Math.abs(cx - x) < 200 && Math.abs(cy - y) < 200) {
          overlay = {
            tag: e.tagName,
            cls: (e.className && typeof e.className === 'string' ? e.className.slice(0, 80) : ''),
            transform: cs.transform,
            transformOrigin: cs.transformOrigin,
            opacity: cs.opacity,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            innerHTML_len: e.innerHTML ? e.innerHTML.length : 0,
          };
          break;
        }
      }

      return { wasmStatsCopy, webglStatsCopy, hitChain, overlay };
    }, { x: p.x, y: p.y });

    // Take a small screenshot crop around mouse
    const crop = {
      x: Math.max(0, p.x - 80), y: Math.max(0, p.y - 80),
      width: Math.min(160, W - Math.max(0, p.x - 80)),
      height: Math.min(160, H - Math.max(0, p.y - 80)),
    };
    const ssPath = path.join(screenshotsDir, `step${String(i).padStart(3, '0')}_${p.phase}.png`);
    try { await page.screenshot({ path: ssPath, clip: crop }); } catch {}

    const rec = { i, phase: p.phase, x: p.x, y: p.y, ...snap, screenshot: path.relative(outDir, ssPath) };
    fs.writeSync(mouseTraceFh, JSON.stringify(rec) + '\n');

    const wasmTotal = Object.values(snap.wasmStatsCopy).reduce((a, b) => a + b, 0);
    const webglTotal = Object.values(snap.webglStatsCopy).reduce((a, b) => a + b, 0);
    process.stdout.write(`wasm:${wasmTotal} gl:${webglTotal} overlay:${snap.overlay ? 'Y' : 'N'}\n`);
  }
  fs.closeSync(mouseTraceFh);

  // Tile inventory
  const tiles = [];
  for (const r of allRequests) {
    if (SV_TILE_RE.test(r.url)) {
      const parsed = parseTileUrl(r.url);
      tiles.push({ url: r.url, ...parsed });
    }
  }
  fs.writeFileSync(path.join(outDir, 'tile_inventory.json'), JSON.stringify(tiles, null, 2));

  // wasm_loads.json
  fs.writeFileSync(path.join(outDir, 'wasm_loads.json'), JSON.stringify({
    loads: wasmLoads,
    instances: wasmInstances,
  }, null, 2));

  // Try to parse photometa
  for (const pm of photometaResponses) {
    try {
      const txt = fs.readFileSync(pm.file, 'utf8');
      const cleaned = txt.replace(/^\)\]\}'\n?/, '');
      const parsed = JSON.parse(cleaned);
      const idx = photometaResponses.indexOf(pm);
      fs.writeFileSync(path.join(outDir, `photometa_${idx}_parsed.json`), JSON.stringify(parsed, null, 2));
      console.log(`[sv3d] photometa_${idx} parsed OK`);
    } catch (e) {
      console.warn(`[sv3d] photometa parse failed: ${e.message}`);
    }
  }

  // Summary
  const lines = [];
  lines.push(`# Street View 3D Probe — ${slug}`);
  lines.push('');
  lines.push(`- URL: \`${args.url}\``);
  lines.push(`- Viewport: ${W}×${H}`);
  lines.push(`- Mouse grid steps: ${grid.length}`);
  lines.push(`- Total network requests: ${allRequests.length}`);
  lines.push(`- WASM modules loaded: ${wasmLoads.length}`);
  lines.push(`- WASM instances: ${wasmInstances.length}`);
  lines.push(`- Photometa responses: ${photometaResponses.length}`);
  lines.push(`- Street view tiles loaded: ${tiles.length}`);
  lines.push('');

  lines.push('## WASM modules');
  for (const m of wasmLoads) {
    lines.push(`- \`${m.hash}\` (${m.size} bytes, via ${m.method})${m.url ? `\n  url: ${m.url}` : ''}`);
  }
  lines.push('');

  lines.push('## WASM instance exports');
  for (const inst of wasmInstances) {
    lines.push(`### \`${inst.hash.slice(0, 12)}\`  (${inst.exports.length} exports)`);
    const fnExports = inst.exports.filter(e => e.kind === 'function').map(e => e.name);
    lines.push('Functions: ' + fnExports.slice(0, 50).map(n => `\`${n}\``).join(', ') + (fnExports.length > 50 ? ` ... +${fnExports.length - 50} more` : ''));
    const otherExports = inst.exports.filter(e => e.kind !== 'function');
    if (otherExports.length) lines.push('Other: ' + otherExports.map(e => `${e.name} (${e.kind})`).join(', '));
    lines.push('');
  }

  lines.push('## Tile inventory');
  const panoidSet = new Set(tiles.map(t => t.panoid).filter(Boolean));
  lines.push(`- Distinct panoids: ${panoidSet.size} → ${[...panoidSet].slice(0, 5).join(', ')}`);
  const zoomSet = new Set(tiles.map(t => t.zoom));
  lines.push(`- Zoom levels: ${[...zoomSet].sort().join(', ')}`);
  const xys = {};
  for (const t of tiles) {
    if (t.panoid && Number.isFinite(t.zoom)) {
      const k = `${t.panoid.slice(0, 8)}@z${t.zoom}`;
      xys[k] = (xys[k] || 0) + 1;
    }
  }
  for (const [k, n] of Object.entries(xys)) lines.push(`  - ${k}: ${n} tiles`);
  lines.push('');

  // Mouse trace summary by phase
  lines.push('## Mouse trace highlights');
  const traceLines = fs.readFileSync(path.join(outDir, 'mouse_trace.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const byPhase = {};
  for (const t of traceLines) {
    if (!byPhase[t.phase]) byPhase[t.phase] = { steps: 0, totalWasm: 0, totalGL: 0, overlays: 0, samples: [] };
    byPhase[t.phase].steps++;
    byPhase[t.phase].totalWasm += Object.values(t.wasmStatsCopy || {}).reduce((a, b) => a + b, 0);
    byPhase[t.phase].totalGL += Object.values(t.webglStatsCopy || {}).reduce((a, b) => a + b, 0);
    if (t.overlay) {
      byPhase[t.phase].overlays++;
      if (byPhase[t.phase].samples.length < 3) byPhase[t.phase].samples.push(t);
    }
  }
  for (const [phase, info] of Object.entries(byPhase)) {
    lines.push(`### ${phase} (${info.steps} steps)`);
    lines.push(`- Total wasm calls: ${info.totalWasm}, total webgl calls: ${info.totalGL}, overlays detected: ${info.overlays}`);
    if (info.samples.length) {
      lines.push('Sample overlay transforms:');
      for (const s of info.samples) {
        lines.push(`  - step ${s.i} @(${s.x},${s.y}): \`${s.overlay.transform}\` rect=${s.overlay.rect.w}×${s.overlay.rect.h}`);
      }
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n'));
  console.log(`\n[sv3d] Done. Output: ${outDir}`);

  await context.close();
  await browser.close();
}

probe(parseArgs(process.argv)).catch(err => {
  console.error('[sv3d] FATAL:', err);
  process.exit(1);
});
