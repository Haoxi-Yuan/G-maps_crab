#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { splitAreas, sanitizeName } = require('../../src/multi-boundary-orchestrator');

function parseArgs(argv) {
  const opts = {
    boundaries: null,
    name: null,
    shard: null,
    maxReviews: 50000,
    poiGroupStatus: null,
    pollSeconds: 15,
    maxWaitSeconds: 86400,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--boundaries') opts.boundaries = argv[++i];
    else if (argv[i] === '--name') opts.name = argv[++i];
    else if (argv[i] === '--max-reviews') opts.maxReviews = Number(argv[++i]);
    else if (argv[i] === '--poi-group-status') opts.poiGroupStatus = argv[++i];
    else if (argv[i] === '--poll-seconds') opts.pollSeconds = Number(argv[++i]);
    else if (argv[i] === '--max-wait-seconds') opts.maxWaitSeconds = Number(argv[++i]);
    else if (argv[i] === '--shard') {
      const match = String(argv[++i]).match(/^(\d+)\/(\d+)$/);
      if (!match) throw new Error('--shard must be i/N');
      opts.shard = { i: Number(match[1]), n: Number(match[2]) };
    }
  }
  if (!opts.boundaries || !opts.name || !opts.shard) {
    throw new Error('--boundaries, --name, and --shard are required');
  }
  if (!Number.isFinite(opts.pollSeconds) || opts.pollSeconds <= 0) {
    throw new Error('--poll-seconds must be greater than zero');
  }
  if (!Number.isFinite(opts.maxWaitSeconds) || opts.maxWaitSeconds <= 0) {
    throw new Error('--max-wait-seconds must be greater than zero');
  }
  return opts;
}

function inspectPOIState(outDir, poiGroupStatus) {
  const marker = path.join(outDir, '_area_complete.json');
  const places = path.join(outDir, 'places.ndjson');
  const markerReady = fs.existsSync(marker);
  const groupFinished = Boolean(poiGroupStatus && fs.existsSync(poiGroupStatus));
  const placesExists = fs.existsSync(places);
  const placesSize = placesExists ? fs.statSync(places).size : 0;
  const terminal = markerReady || groupFinished;
  return {
    marker,
    places,
    markerReady,
    groupFinished,
    placesExists,
    placesSize,
    terminal,
    ready: terminal && placesSize > 0,
    noInput: terminal && placesSize === 0,
    partial: !markerReady && groupFinished && placesSize > 0,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPOI(outDir, poiGroupStatus, pollSeconds, maxWaitSeconds, label) {
  const started = Date.now();
  let nextLog = 0;
  while (true) {
    const state = inspectPOIState(outDir, poiGroupStatus);
    if (state.terminal) return { ...state, timedOut: false };
    const elapsedSeconds = (Date.now() - started) / 1000;
    if (elapsedSeconds >= maxWaitSeconds) return { ...state, timedOut: true };
    if (elapsedSeconds >= nextLog) {
      console.log(`${label}: waiting for POI output (${Math.floor(elapsedSeconds)}s)`);
      nextLog = elapsedSeconds + 60;
    }
    await sleep(pollSeconds * 1000);
  }
}

function runReview(root, outDir, maxReviews) {
  const input = path.join(outDir, 'places.ndjson');
  const output = path.join(outDir, 'reviews.ndjson');
  const live = path.join(outDir, 'reviews.live.json');
  const log = path.join(outDir, 'reviews.log');
  const fd = fs.openSync(log, 'a');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(root, 'src/review-scraper.js'),
      '--input', input,
      '--output', output,
      '--live-status', live,
      '--max-reviews', String(maxReviews),
    ], { cwd: root, stdio: ['ignore', fd, fd] });
    child.once('close', (code, signal) => {
      fs.closeSync(fd);
      resolve({ code: code == null ? 1 : code, signal });
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, '../..');
  const areas = splitAreas(opts.boundaries, opts.name);
  const selected = areas.filter((_, index) => index % opts.shard.n === opts.shard.i - 1);
  let completed = 0;
  let failed = 0;
  let noInput = 0;
  let partial = 0;

  console.log(`[REVIEW-BATCH] shard ${opts.shard.i}/${opts.shard.n}: ${selected.length} areas`);
  for (const [index, area] of selected.entries()) {
    const outDir = path.join(root, 'output', area.relDir || area.dirSlug);
    const label = `[REVIEW-BATCH] [${index + 1}/${selected.length}] ${area.slug}`;
    const poi = await waitForPOI(
      outDir,
      opts.poiGroupStatus,
      opts.pollSeconds,
      opts.maxWaitSeconds,
      label,
    );
    if (poi.timedOut) {
      failed++;
      console.error(`${label}: timed out waiting for POI output`);
      continue;
    }
    if (poi.noInput) {
      noInput++;
      console.log(`${label}: POI finished with no review input`);
      continue;
    }
    if (poi.partial) {
      partial++;
      console.warn(`${label}: POI group finished without area marker; using partial places.ndjson`);
    }
    console.log(`${label}: starting`);
    const result = await runReview(root, outDir, opts.maxReviews);
    if (result.code === 0) {
      completed++;
      console.log(`${label}: complete`);
    } else {
      failed++;
      console.error(`${label}: failed code=${result.code} signal=${result.signal || '-'}`);
    }
  }

  console.log(JSON.stringify({
    batch: sanitizeName(opts.name), shard: opts.shard,
    selected: selected.length, completed, failed, noInput, partial,
  }));
  if (failed) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = { inspectPOIState, parseArgs, waitForPOI };
