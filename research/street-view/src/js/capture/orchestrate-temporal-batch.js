#!/usr/bin/env node
'use strict';

/**
 * Orchestrate historical Street View photometa harvesting for a spatial run.
 *
 * This coordinator intentionally reuses the existing single-purpose tools:
 *
 *   - harvest-temporal-stack.js: opens a Google Maps Street View URL and writes
 *     timeline.json under data/raw/google_maps/temporal/<panoid>/<timestamp>/
 *   - fetch-temporal-photometas.js: downloads photometa for every historical
 *     capture listed in timeline.json.
 *
 * The orchestrator reads a spatial run's neighbor list, builds canonical
 * Google Maps Street View URLs, runs panos serially with randomized sleeps, and
 * writes a resumable master manifest.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_ROOT = path.resolve(__dirname, '..', '..', '..');
const HARVEST_JS = path.join(__dirname, 'harvest-temporal-stack.js');
const FETCH_JS = path.join(__dirname, 'fetch-temporal-photometas.js');

function parseArgs(argv) {
  const args = {
    testRoot: TEST_ROOT,
    runDir: null,
    site: null,
    runId: null,
    workspaceId: null,
    batchId: timestamp(),
    maxPanos: 0,
    startAt: 0,
    quietSeconds: 8,
    fetchThrottleMs: 250,
    minSleepMs: 3000,
    maxSleepMs: 5000,
    retry: 1,
    headless: true,
    dryRun: false,
    verifyOne: false,
    force: false,
    reuseZero: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test-root') args.testRoot = path.resolve(argv[++i]);
    else if (a === '--run-dir') args.runDir = path.resolve(argv[++i]);
    else if (a === '--site') args.site = argv[++i];
    else if (a === '--run-id') args.runId = argv[++i];
    else if (a === '--workspace-id') args.workspaceId = argv[++i];
    else if (a === '--batch-id') args.batchId = argv[++i];
    else if (a === '--max-panos') args.maxPanos = parseInt(argv[++i], 10);
    else if (a === '--start-at') args.startAt = parseInt(argv[++i], 10);
    else if (a === '--quiet-seconds') args.quietSeconds = parseInt(argv[++i], 10);
    else if (a === '--fetch-throttle-ms') args.fetchThrottleMs = parseInt(argv[++i], 10);
    else if (a === '--min-sleep-ms') args.minSleepMs = parseInt(argv[++i], 10);
    else if (a === '--max-sleep-ms') args.maxSleepMs = parseInt(argv[++i], 10);
    else if (a === '--retry') args.retry = parseInt(argv[++i], 10);
    else if (a === '--headless') args.headless = argv[++i] !== '0';
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verify-one') args.verifyOne = true;
    else if (a === '--force') args.force = true;
    else if (a === '--reuse-zero') args.reuseZero = true;
    else if (a === '--rerun-zero') args.reuseZero = false;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.runDir && !args.site) {
    console.error('Pass --run-dir or --site [--run-id].');
    process.exit(2);
  }
  if (args.verifyOne) args.maxPanos = 1;
  if (args.maxSleepMs < args.minSleepMs) args.maxSleepMs = args.minSleepMs;
  return args;
}

function timestamp() {
  const d = new Date();
  const z = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_` +
         `${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}-${z(d.getMilliseconds(), 3)}`;
}

function latestDir(parent) {
  const dirs = fs.existsSync(parent)
    ? fs.readdirSync(parent).map(n => path.join(parent, n)).filter(p => fs.statSync(p).isDirectory()).sort()
    : [];
  return dirs.length ? dirs[dirs.length - 1] : null;
}

function resolveRunDir(args) {
  if (args.runDir) {
    if (!fs.existsSync(args.runDir)) throw new Error(`run-dir not found: ${args.runDir}`);
    return {
      runDir: args.runDir,
      site: args.site || path.basename(path.dirname(args.runDir)),
      runId: path.basename(args.runDir),
    };
  }
  const siteDir = path.join(args.testRoot, 'data', 'raw', 'google_maps', 'spatial', args.site);
  const runDir = args.runId ? path.join(siteDir, args.runId) : latestDir(siteDir);
  if (!runDir || !fs.existsSync(runDir)) throw new Error(`spatial run not found under ${siteDir}`);
  return { runDir, site: args.site, runId: path.basename(runDir) };
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\)\]\}'\n?/, ''));
}

function readTargets(args, runDir, site) {
  const neighborsFp = path.join(runDir, 'neighbors.json');
  if (fs.existsSync(neighborsFp)) {
    const rows = readJson(neighborsFp);
    return rows.map((r, idx) => ({
      panoid: r.panoid,
      lat: Number(r.lat),
      lng: Number(r.lng),
      source: 'neighbors.json',
      index_in_source: idx,
    })).filter(r => r.panoid && Number.isFinite(r.lat) && Number.isFinite(r.lng));
  }

  const workspace = args.workspaceId || site;
  const parsedCandidates = [
    path.join(runDir, 'photometa_0_parsed.json'),
    path.join(args.testRoot, 'data', 'intermediate', workspace, '00_parsed_photometa', 'photometa_0_parsed.json'),
  ];
  const parsedFp = parsedCandidates.find(fp => fs.existsSync(fp));
  if (!parsedFp) throw new Error(`Missing neighbors.json and focal parsed photometa for ${runDir}`);

  const parsed = readJson(parsedFp);
  const rows = ((((((parsed || [])[1] || [])[0] || [])[5] || [])[0] || [])[3] || [])[0] || [];
  return rows.map((e, idx) => {
    const loc = e?.[2]?.[0] || [];
    return {
      panoid: e?.[0]?.[1],
      lat: Number(loc[2]),
      lng: Number(loc[3]),
      source: path.relative(args.testRoot, parsedFp),
      index_in_source: idx,
    };
  }).filter(r => r.panoid && Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

function dedupeTargets(targets) {
  const seen = new Map();
  for (const t of targets) {
    if (!seen.has(t.panoid)) seen.set(t.panoid, t);
  }
  return Array.from(seen.values());
}

function buildStreetViewUrl(t) {
  const panoid = encodeURIComponent(t.panoid);
  return `https://www.google.com/maps/@${t.lat},${t.lng},3a,75y,0h,90t/data=!3m6!1e1!3m4!1s${panoid}!2e0!7i16384!8i8192`;
}

function listStackDirs(args, panoid) {
  const root = path.join(args.testRoot, 'data', 'raw', 'google_maps', 'temporal', panoid);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map(n => path.join(root, n))
    .filter(p => fs.statSync(p).isDirectory())
    .sort();
}

function readTimeline(stackDir) {
  const fp = path.join(stackDir, 'timeline.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const timeline = readJson(fp);
    return { fp, stackDir, timeline };
  } catch (_) {
    return null;
  }
}

function reusableStack(args, panoid) {
  const stacks = listStackDirs(args, panoid).map(readTimeline).filter(Boolean).reverse();
  for (const s of stacks) {
    const count = Number(s.timeline.capture_count ?? (s.timeline.captures || []).length ?? 0);
    const url = s.timeline.source_url || '';
    const urlLooksCanonical = url.includes(',3a,75y,') && url.includes('!1s') && url.includes('!2e0');
    if (urlLooksCanonical && (count > 0 || args.reuseZero)) return { ...s, captureCount: count };
  }
  return null;
}

function newestStackAfter(args, panoid, beforeSet) {
  const stacks = listStackDirs(args, panoid).filter(p => !beforeSet.has(p));
  return stacks.length ? stacks[stacks.length - 1] : null;
}

function runCommand(cmd, cmdArgs, cwd) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function randomSleepMs(args) {
  const span = Math.max(0, args.maxSleepMs - args.minSleepMs);
  return args.minSleepMs + Math.floor(Math.random() * (span + 1));
}

function countFetchedPhotometas(stackDir) {
  const captureRoot = path.join(stackDir, 'captures');
  if (!fs.existsSync(captureRoot)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(captureRoot)) {
    if (fs.existsSync(path.join(captureRoot, name, 'parsed.json'))) n++;
  }
  return n;
}

function saveManifest(fp, manifest) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(manifest, null, 2));
}

function main() {
  const args = parseArgs(process.argv);
  const { runDir, site, runId } = resolveRunDir(args);
  let targets = dedupeTargets(readTargets(args, runDir, site));
  if (args.startAt > 0) targets = targets.slice(args.startAt);
  if (args.maxPanos > 0) targets = targets.slice(0, args.maxPanos);

  const batchRoot = path.join(args.testRoot, 'data', 'raw', 'google_maps', 'temporal_batches', site, args.batchId);
  const manifestFp = path.join(batchRoot, 'manifest.json');
  const manifest = {
    site,
    run_id: runId,
    run_dir: path.relative(args.testRoot, runDir),
    batch_id: args.batchId,
    strategy: {
      url_template: 'https://www.google.com/maps/@<lat>,<lng>,3a,75y,0h,90t/data=!3m6!1e1!3m4!1s<panoid>!2e0!7i16384!8i8192',
      serial: true,
      downloads: ['timeline', 'photometa'],
      min_sleep_ms: args.minSleepMs,
      max_sleep_ms: args.maxSleepMs,
      retry: args.retry,
    },
    target_count: targets.length,
    started_at: new Date().toISOString(),
    rows: [],
  };

  console.log(`Spatial run: ${path.relative(args.testRoot, runDir)}`);
  console.log(`Targets: ${targets.length}`);
  console.log(`Batch manifest: ${path.relative(args.testRoot, manifestFp)}`);

  if (args.dryRun) {
    for (const [i, t] of targets.entries()) {
      console.log(`[${i}] ${t.panoid} ${t.lat},${t.lng}`);
      console.log(`    ${buildStreetViewUrl(t)}`);
    }
    return;
  }

  saveManifest(manifestFp, manifest);
  for (const [i, target] of targets.entries()) {
    const url = buildStreetViewUrl(target);
    const row = {
      index: i,
      panoid: target.panoid,
      lat: target.lat,
      lng: target.lng,
      source: target.source,
      url,
      status: 'started',
      attempts: [],
      started_at: new Date().toISOString(),
    };
    console.log(`\n[${i + 1}/${targets.length}] ${target.panoid}`);

    const reusable = args.force ? null : reusableStack(args, target.panoid);
    if (reusable) {
      row.status = 'skipped_existing';
      row.stack_dir = path.relative(args.testRoot, reusable.stackDir);
      row.capture_count = reusable.captureCount;
      row.photometa_count = countFetchedPhotometas(reusable.stackDir);
      row.finished_at = new Date().toISOString();
      manifest.rows.push(row);
      saveManifest(manifestFp, manifest);
      console.log(`  skip existing ${row.stack_dir} captures=${row.capture_count} photometas=${row.photometa_count}`);
      continue;
    }

    let stackDir = null;
    let timeline = null;
    const before = new Set(listStackDirs(args, target.panoid));
    for (let attempt = 0; attempt <= args.retry; attempt++) {
      const harvestArgs = [
        HARVEST_JS,
        '--url', url,
        '--quiet-seconds', String(args.quietSeconds),
        '--headless', args.headless ? '1' : '0',
      ];
      const res = runCommand('node', harvestArgs, args.testRoot);
      const candidateStack = newestStackAfter(args, target.panoid, before);
      const parsed = candidateStack ? readTimeline(candidateStack) : null;
      const captureCount = parsed ? Number(parsed.timeline.capture_count ?? (parsed.timeline.captures || []).length ?? 0) : 0;
      row.attempts.push({
        attempt,
        harvest_exit_code: res.code,
        stack_dir: candidateStack ? path.relative(args.testRoot, candidateStack) : null,
        capture_count: captureCount,
        stdout_tail: res.stdout.slice(-1200),
        stderr_tail: res.stderr.slice(-1200),
      });
      if (res.code === 0 && parsed) {
        stackDir = candidateStack;
        timeline = parsed.timeline;
        break;
      }
      if (attempt < args.retry) sleep(1500);
    }

    if (!stackDir || !timeline) {
      row.status = 'harvest_failed';
      row.finished_at = new Date().toISOString();
      manifest.rows.push(row);
      saveManifest(manifestFp, manifest);
      console.log('  harvest failed');
    } else {
      row.stack_dir = path.relative(args.testRoot, stackDir);
      row.capture_count = Number(timeline.capture_count ?? (timeline.captures || []).length ?? 0);
      console.log(`  timeline ${row.capture_count} captures -> ${row.stack_dir}`);

      if (row.capture_count > 0) {
        const fetchRes = runCommand('node', [
          FETCH_JS,
          '--stack-dir', stackDir,
          '--throttle-ms', String(args.fetchThrottleMs),
        ], args.testRoot);
        row.fetch_exit_code = fetchRes.code;
        row.fetch_stdout_tail = fetchRes.stdout.slice(-1200);
        row.fetch_stderr_tail = fetchRes.stderr.slice(-1200);
        row.photometa_count = countFetchedPhotometas(stackDir);
        row.status = fetchRes.code === 0 ? 'ok' : 'fetch_failed';
        console.log(`  photometa parsed=${row.photometa_count} exit=${fetchRes.code}`);
      } else {
        row.photometa_count = 0;
        row.status = 'no_timeline_captures';
        console.log('  no timeline captures; no photometa fetch');
      }
      row.finished_at = new Date().toISOString();
      manifest.rows.push(row);
      saveManifest(manifestFp, manifest);
    }

    if (i < targets.length - 1) {
      const delay = randomSleepMs(args);
      console.log(`  sleep ${delay}ms`);
      sleep(delay);
    }
  }

  manifest.finished_at = new Date().toISOString();
  manifest.summary = {
    ok: manifest.rows.filter(r => r.status === 'ok').length,
    skipped_existing: manifest.rows.filter(r => r.status === 'skipped_existing').length,
    no_timeline_captures: manifest.rows.filter(r => r.status === 'no_timeline_captures').length,
    failed: manifest.rows.filter(r => ['harvest_failed', 'fetch_failed'].includes(r.status)).length,
    timeline_captures: manifest.rows.reduce((s, r) => s + (r.capture_count || 0), 0),
    photometa_count: manifest.rows.reduce((s, r) => s + (r.photometa_count || 0), 0),
  };
  saveManifest(manifestFp, manifest);
  console.log('\nDone.');
  console.log(JSON.stringify(manifest.summary, null, 2));
  console.log(`Manifest: ${manifestFp}`);
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
