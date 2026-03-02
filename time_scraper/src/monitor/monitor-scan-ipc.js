#!/usr/bin/env node

/**
 * Monitor Scan IPC Wrapper
 *
 * Bridges Monitor scanning modules with the TaskController IPC protocol.
 * Supports three scan types: scan (change detection), discover (POI discovery), import (baseline).
 *
 * IPC Protocol: stdout lines prefixed with "__IPC__" containing JSON:
 *   { type: 'progress|status|stats|log', taskType: 'monitor-*', ... }
 *
 * Signals: SIGUSR1 (pause/resume), SIGTERM (graceful stop)
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const MonitorDB = require('./db');
const ChangeScanner = require('./change-scanner');
const POIDiscovery = require('./poi-discovery');
const { importBaseline } = require('./baseline-importer');
const ReportGenerator = require('./report-generator');
const { exportSnapshot } = require('./snapshot-exporter');

// --- Parse command-line args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}
function hasArg(name) {
  return args.includes(name);
}

const scanType = getArg('--scan-type') || 'scan';
const limit = getArg('--limit') ? parseInt(getArg('--limit'), 10) : undefined;
const resume = hasArg('--resume');
const stateFile = getArg('--state-file');
const source = getArg('--source');
const format = getArg('--format') || 'auto';
const city = getArg('--city') || 'Singapore';
const categories = getArg('--categories');
const cellSize = getArg('--cell-size') ? parseInt(getArg('--cell-size'), 10) : 2000;
const headless = !hasArg('--no-headless');

// --- IPC helpers ---
function ipcSend(type, data) {
  const message = JSON.stringify({ type, taskType: `monitor-${scanType}`, timestamp: Date.now(), ...data });
  process.stdout.write(`__IPC__${message}\n`);
}

function ipcProgress(current, total, currentPlace) {
  ipcSend('progress', { current, total, currentPlace });
}

function ipcLog(level, message, data) {
  ipcSend('log', { level, message, data });
}

function ipcStatus(status, error) {
  ipcSend('status', { status, error });
}

function ipcStats(stats) {
  ipcSend('stats', stats);
}

// --- State file management ---
const state = {
  status: 'running',
  progress: { current: 0, total: 0 },
  stats: {},
  currentPlace: null,
  recentLogs: [],
  updatedAt: Date.now(),
  lastActivityAt: Date.now(),
  pid: process.pid
};

function writeState() {
  if (!stateFile) return;
  state.updatedAt = Date.now();
  state.lastActivityAt = Date.now();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    // Ignore write errors
  }
}

function addRecentLog(level, message) {
  state.recentLogs.push({ timestamp: Date.now(), level, message });
  if (state.recentLogs.length > 20) {
    state.recentLogs = state.recentLogs.slice(-20);
  }
}

// --- Signal handling ---
let paused = false;
let stopped = false;

process.on('SIGUSR1', () => {
  paused = !paused;
  state.status = paused ? 'paused' : 'running';
  ipcStatus(paused ? 'paused' : 'running');
  ipcLog('info', paused ? 'Scan paused' : 'Scan resumed');
  addRecentLog('info', paused ? 'Scan paused' : 'Scan resumed');
  writeState();
});

process.on('SIGTERM', () => {
  stopped = true;
  ipcLog('info', 'Received SIGTERM, stopping gracefully...');
  addRecentLog('info', 'Received SIGTERM, stopping gracefully');
  writeState();
});

// --- Pause check utility ---
async function waitWhilePaused() {
  while (paused && !stopped) {
    await new Promise(r => setTimeout(r, 500));
  }
  return stopped;
}

// --- Main execution ---
async function main() {
  const config = loadConfig();
  const db = new MonitorDB(config.paths.database);

  ipcLog('info', `Monitor scan starting: type=${scanType}`);
  addRecentLog('info', `Monitor scan starting: type=${scanType}`);
  writeState();

  try {
    if (scanType === 'scan') {
      await runChangeScan(db, config);
    } else if (scanType === 'discover') {
      await runDiscovery(db, config);
    } else if (scanType === 'import') {
      await runImport(db, config);
    } else {
      throw new Error(`Unknown scan type: ${scanType}`);
    }

    if (!stopped) {
      state.status = 'completed';
      ipcStatus('completed');
      ipcLog('info', 'Scan completed successfully');
    } else {
      state.status = 'stopped';
      ipcStatus('stopped');
      ipcLog('info', 'Scan stopped by user');
    }
  } catch (err) {
    state.status = 'failed';
    ipcStatus('failed', err.message);
    ipcLog('error', `Scan failed: ${err.message}`);
    addRecentLog('error', `Scan failed: ${err.message}`);
  } finally {
    writeState();
    db.close();
  }
}

// --- Change Scan ---
async function runChangeScan(db, config) {
  const allPlaceIds = db.getAllActivePlaceIds();
  const total = limit ? Math.min(limit, allPlaceIds.length) : allPlaceIds.length;

  state.progress.total = total;
  state.stats = { scanned: 0, changed: 0, failed: 0, newPois: 0 };
  ipcProgress(0, total, null);
  ipcStats(state.stats);
  writeState();

  if (total === 0) {
    ipcLog('info', 'No active POIs to scan');
    return;
  }

  // Use ChangeScanner but hook into its progress
  const scanner = new ChangeScanner(db, config);

  // Override the original progress output with IPC messages
  const origProcessBatch = scanner._processBatch.bind(scanner);
  let scannedSoFar = 0;

  // Monkey-patch the scan loop to add IPC + pause/stop support
  const origRun = scanner.run.bind(scanner);

  // We'll run the scanner directly but track progress via polling
  const progressPoll = setInterval(() => {
    const s = scanner.stats;
    const current = s.scanned + s.failed;
    if (current !== scannedSoFar) {
      scannedSoFar = current;
      state.progress.current = current;
      state.stats = { scanned: s.scanned, changed: s.changed, failed: s.failed, gone: s.gone || 0 };
      ipcProgress(current, total, null);
      ipcStats(state.stats);
      writeState();
    }
  }, 1000);

  try {
    const scanId = await origRun({ resume, limit });

    clearInterval(progressPoll);

    // Final stats
    const finalStats = scanner.stats;
    state.progress.current = finalStats.scanned + finalStats.failed;
    state.stats = { scanned: finalStats.scanned, changed: finalStats.changed, failed: finalStats.failed, gone: finalStats.gone || 0 };
    ipcProgress(state.progress.current, total, null);
    ipcStats(state.stats);

    // Generate report
    ipcLog('info', `Generating report for scan ${scanId}...`);
    addRecentLog('info', `Generating report for scan ${scanId}`);
    const reporter = new ReportGenerator(db, config);
    const { reportDir, summary } = reporter.generate(scanId);

    // Export snapshot
    exportSnapshot(db, config.paths.snapshots);

    ipcLog('info', `Report saved to ${reportDir}`);
    ipcLog('info', `Summary: scanned=${summary.totalScanned}, changed=${summary.totalChanged}, gone=${summary.gonePois}, failed=${summary.scanFailed}`);
    addRecentLog('info', `Scan ${scanId} complete: ${summary.totalChanged} changes detected`);
  } catch (err) {
    clearInterval(progressPoll);
    throw err;
  }

  writeState();
}

// --- POI Discovery ---
async function runDiscovery(db, config) {
  const catList = categories ? categories.split(',').map(c => c.trim()) : undefined;

  ipcLog('info', `Discovery starting: city=${city}, cellSize=${cellSize}`);
  addRecentLog('info', `Discovery starting: city=${city}`);

  state.stats = { totalFound: 0, newPois: 0 };
  ipcStats(state.stats);
  writeState();

  const discovery = new POIDiscovery(db, config);
  const result = await discovery.run({
    city,
    categories: catList,
    cellSize,
    limit
  });

  state.stats = { totalFound: result.totalFound, newPois: result.newCount };
  state.progress = { current: result.totalFound, total: result.totalFound };
  ipcProgress(result.totalFound, result.totalFound, null);
  ipcStats(state.stats);

  ipcLog('info', `Discovery complete: found=${result.totalFound}, new=${result.newCount}`);
  addRecentLog('info', `Discovery complete: ${result.newCount} new POIs`);
  writeState();
}

// --- Baseline Import ---
async function runImport(db, config) {
  if (!source) {
    throw new Error('--source is required for import scan type');
  }

  const sourcePath = path.resolve(source);
  ipcLog('info', `Import starting: source=${sourcePath}, format=${format}`);
  addRecentLog('info', `Import starting from ${path.basename(sourcePath)}`);

  state.stats = { imported: 0, skipped: 0, errors: 0 };
  ipcStats(state.stats);
  writeState();

  const result = await importBaseline(sourcePath, db, format);

  state.stats = {
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors,
    uniquePois: result.uniquePois
  };
  state.progress = { current: result.imported, total: result.imported };
  ipcProgress(result.imported, result.imported, null);
  ipcStats(state.stats);

  ipcLog('info', `Import complete: imported=${result.imported}, skipped=${result.skipped}, errors=${result.errors}`);
  addRecentLog('info', `Import complete: ${result.imported} POIs imported`);
  writeState();
}

main().catch(err => {
  console.error('[monitor-scan-ipc] Fatal error:', err);
  ipcStatus('failed', err.message);
  process.exit(1);
});
