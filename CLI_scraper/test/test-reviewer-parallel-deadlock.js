'use strict';

// Deadlock / self-heal guarantees for the reviewer parallel scraper, exercised
// with injected fakes (no Chromium). Proves the core invariant: inFlight always
// returns to 0 and rotation never blocks forever.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scrapeReviewerProfilesParallel } = require('../src/reviewer-profile-parallel-scraper');

const HANG = () => new Promise(() => {}); // never resolves

function makeRun(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-deadlock-'));
  const listFile = path.join(dir, 'list.ndjson');
  const outputFile = path.join(dir, 'out.ndjson');
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      reviewer_id: `${100000000000000000000 + i}`,
      reviewer_link: `https://www.google.com/maps/contrib/${100000000000000000000 + i}/reviews`,
      reviewer_name: `R${i}`,
    }));
  }
  fs.writeFileSync(listFile, `${lines.join('\n')}\n`);
  return { dir, listFile, outputFile };
}

function fakeBrowser({ closeHangs = false, onKill } = {}) {
  return {
    isConnected: () => true,
    process: () => ({ pid: 900000 + Math.floor(os.uptime() * 1000) % 1000, kill: () => { if (onKill) onKill(); } }),
    close: () => (closeHangs ? HANG() : Promise.resolve()),
  };
}

const baseOptions = (run, extra) => ({
  concurrency: 1,
  windowSize: 1,
  browserRestartEvery: 1,
  requestIntervalMs: 0,
  maxFetchRetries: 0,
  log: () => {},
  reapOrphans: () => {},
  onExit: () => {},
  ...extra,
});

function readOutput(outputFile) {
  return fs.readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// (a) createContext hangs longer than the per-task deadline → the OUTER task
// deadline fires, the task is recorded as a retryable fetch_error, inFlight
// returns to 0, and the whole run resolves instead of hanging forever.
async function testTaskDeadlineReleasesInFlight() {
  const run = makeRun(1);
  const result = await scrapeReviewerProfilesParallel(
    { shards: [{ listFile: run.listFile, outputFile: run.outputFile }], totalReviewers: 1, sourceReviewsFile: 'x' },
    baseOptions(run, {
      maxReviewers: 1,
      taskDeadlineMs: 80,
      stallMs: 5000,
      watchdogIntervalMs: 10000,
      contextDeadlineMs: 600, // > taskDeadlineMs so the OUTER task deadline fires first; finite so the timer clears after the run
      browserFactory: () => fakeBrowser(),
      createContext: () => HANG(),
    }),
  );
  assert.equal(result.processed, 1, 'the hung task must still count as processed');
  const records = readOutput(run.outputFile);
  assert.equal(records.length, 1);
  assert.equal(records[0]._status, 'error', 'a deadlined task is a retryable error');
  assert.equal(records[0].completeness.stop_reason, 'fetch_error');
  fs.rmSync(run.dir, { recursive: true, force: true });
  console.log('(a) per-task deadline releases inFlight and records fetch_error: passed');
}

// (b) rotation's browser.close hangs → force-kill (SIGKILL) + reap + relaunch.
async function testHungCloseForceKills() {
  const run = makeRun(1);
  let killed = 0;
  let reaps = 0;
  let launches = 0;
  await scrapeReviewerProfilesParallel(
    { shards: [{ listFile: run.listFile, outputFile: run.outputFile }], totalReviewers: 1, sourceReviewsFile: 'x' },
    baseOptions(run, {
      maxReviewers: 1,
      taskDeadlineMs: 200,
      stallMs: 5000,
      watchdogIntervalMs: 10000,
      contextDeadlineMs: 20, // small → fetchReviewer self-completes as error fast → triggers periodic rotation
      rotationCloseDeadlineMs: 30,
      launchDeadlineMs: 1000,
      reapOrphans: () => { reaps += 1; },
      browserFactory: () => { launches += 1; return fakeBrowser({ closeHangs: true, onKill: () => { killed += 1; } }); },
      createContext: () => HANG(),
    }),
  );
  assert.ok(killed >= 1, 'a hung rotation close must SIGKILL the browser process');
  assert.ok(reaps >= 1, 'force-kill must reap stray chromium');
  assert.ok(launches >= 2, 'rotation must relaunch a fresh browser after the kill');
  fs.rmSync(run.dir, { recursive: true, force: true });
  console.log('(b) hung rotation close triggers force-kill + reap + relaunch: passed');
}

// (c) relaunch keeps failing → after launchRetries the run escalates to onExit(1)
// for the external supervisor to respawn.
async function testLaunchExhaustionExits() {
  const run = makeRun(1);
  let exitCode = null;
  let launches = 0;
  await scrapeReviewerProfilesParallel(
    { shards: [{ listFile: run.listFile, outputFile: run.outputFile }], totalReviewers: 1, sourceReviewsFile: 'x' },
    baseOptions(run, {
      maxReviewers: 1,
      taskDeadlineMs: 200,
      stallMs: 5000,
      watchdogIntervalMs: 10000,
      contextDeadlineMs: 20,
      launchRetries: 2,
      launchDeadlineMs: 500,
      onExit: (code) => { exitCode = code; },
      browserFactory: () => {
        launches += 1;
        if (launches === 1) return fakeBrowser(); // initial launch succeeds
        throw new Error('relaunch failure'); // every rotation relaunch fails
      },
      createContext: () => HANG(),
    }),
  );
  assert.equal(exitCode, 1, 'exhausted relaunch must call onExit(1)');
  assert.ok(launches >= 3, 'must attempt launchRetries relaunches before giving up');
  fs.rmSync(run.dir, { recursive: true, force: true });
  console.log('(c) exhausted relaunch escalates to onExit(1): passed');
}

// (d) the watchdog writes a heartbeat between windows so external monitors see
// liveness even when no window has closed.
async function testWatchdogHeartbeat() {
  const run = makeRun(1);
  const statusFile = path.join(run.dir, 'live.json');
  await scrapeReviewerProfilesParallel(
    { shards: [{ listFile: run.listFile, outputFile: run.outputFile }], totalReviewers: 1, sourceReviewsFile: 'x' },
    baseOptions(run, {
      maxReviewers: 1,
      taskDeadlineMs: 120,
      stallMs: 5000,
      watchdogIntervalMs: 15,
      contextDeadlineMs: 600,
      liveStatusFile: statusFile,
      browserFactory: () => fakeBrowser(),
      createContext: () => HANG(),
    }),
  );
  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  assert.ok(status.heartbeat_at, 'watchdog must write a heartbeat_at timestamp');
  assert.ok('seconds_since_progress' in status, 'heartbeat must expose progress age');
  fs.rmSync(run.dir, { recursive: true, force: true });
  console.log('(d) watchdog heartbeat refreshes liveness between windows: passed');
}

async function main() {
  await testTaskDeadlineReleasesInFlight();
  await testHungCloseForceKills();
  await testLaunchExhaustionExits();
  await testWatchdogHeartbeat();
  console.log('Reviewer parallel deadlock/self-heal tests: passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
