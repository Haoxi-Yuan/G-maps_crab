#!/usr/bin/env node
'use strict';

/**
 * POI Search Only - Standalone IPC Script
 *
 * Runs ONLY the POI search phase (sampling points × categories → place_ids).
 * Uses identical IPC protocol as gmaps_batch_scrape_ipc.js so TaskController
 * can manage it without any changes.
 *
 * Usage:
 *   node src/poi_search_ipc.js --ipc-mode --state-file <file> \
 *     --points <csv/json> --categories <json> --output <search_results.json> \
 *     [--search-zoom 1000m] [--headless] [--start N] [--limit N]
 */

const fs = require('fs');
const path = require('path');

// ============================================
// IPC Communication (same protocol as gmaps_batch_scrape_ipc.js)
// ============================================

let IPC_MODE = false;
let STATE_FILE = null;
let IS_PAUSED = false;
let SHOULD_STOP = false;

const TASK_STATS = {
  status: 'pending',
  progress: { current: 0, total: 0, percentage: 0 },
  stats: { success: 0, failed: 0, reviews: 0, images: 0 },
  currentPlace: null,
  startedAt: null,
  lastActivityAt: null,
  error: null
};

const RECENT_LOGS = [];
const MAX_RECENT_LOGS = 50;

function ipcSend(type, data) {
  if (!IPC_MODE) return;
  const message = { type, timestamp: Date.now(), ...data };
  try {
    console.log(`__IPC__${JSON.stringify(message)}`);
  } catch (err) {
    IPC_MODE = false;
  }
}

function ipcProgress(current, total, currentPlace = null) {
  TASK_STATS.progress = {
    current,
    total,
    percentage: total > 0 ? Math.round((current / total) * 100) : 0
  };
  TASK_STATS.currentPlace = currentPlace;
  TASK_STATS.lastActivityAt = Date.now();
  ipcSend('progress', { current, total, percentage: TASK_STATS.progress.percentage, currentPlace });
  writeStateFile();
}

function ipcLog(level, message, data = null) {
  ipcSend('log', { level, message, data });
  RECENT_LOGS.push({ timestamp: Date.now(), level, message, data });
  if (RECENT_LOGS.length > MAX_RECENT_LOGS) RECENT_LOGS.shift();
}

function ipcStatus(status, error = null) {
  TASK_STATS.status = status;
  TASK_STATS.error = error;
  ipcSend('status', { status, error });
  writeStateFile();
}

function ipcStats(stats) {
  Object.assign(TASK_STATS.stats, stats);
  TASK_STATS.lastActivityAt = Date.now();
  ipcSend('stats', TASK_STATS.stats);
  writeStateFile();
}

function writeStateFile() {
  if (!STATE_FILE) return;
  try {
    const state = { ...TASK_STATS, recentLogs: RECENT_LOGS, updatedAt: Date.now(), pid: process.pid };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) { /* ignore */ }
}

function setupSignalHandlers() {
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') IPC_MODE = false;
  });
  process.stderr.on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') IPC_MODE = false;
  });

  process.on('SIGTERM', () => { SHOULD_STOP = true; ipcStatus('stopping'); });
  process.on('SIGINT', () => { SHOULD_STOP = true; ipcStatus('stopping'); });

  if (process.platform !== 'win32') {
    process.on('SIGUSR1', () => {
      IS_PAUSED = !IS_PAUSED;
      ipcStatus(IS_PAUSED ? 'paused' : 'running');
    });
  }

  process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') { IPC_MODE = false; return; }
    try { console.error('[ERROR] Uncaught exception:', err.message); } catch (e) {}
    ipcStatus('failed', err.message);
    process.exit(1);
  });
}

// ============================================
// Argument Parsing
// ============================================

function parseArgs(argv) {
  const opts = {
    ipcMode: false,
    stateFile: null,
    pointsFile: null,
    categoriesFile: null,
    outputFile: null,
    searchZoom: '1000m',
    maxSearchScrolls: 15,
    searchDelay: 2000,
    headless: false,
    startIndex: 0,
    limit: null,
    lang: 'en',
    checkpoint: null
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--ipc-mode': opts.ipcMode = true; break;
      case '--state-file': opts.stateFile = argv[++i]; break;
      case '--points': opts.pointsFile = argv[++i]; break;
      case '--categories': opts.categoriesFile = argv[++i]; break;
      case '--output': opts.outputFile = argv[++i]; break;
      case '--search-zoom': opts.searchZoom = argv[++i]; break;
      case '--max-search-scrolls': opts.maxSearchScrolls = parseInt(argv[++i]); break;
      case '--search-delay': opts.searchDelay = parseInt(argv[++i]); break;
      case '--headless': opts.headless = true; break;
      case '--start': opts.startIndex = parseInt(argv[++i]); break;
      case '--limit': opts.limit = parseInt(argv[++i]); break;
      case '--lang': case '--hl': opts.lang = argv[++i]; break;
      case '--checkpoint': opts.checkpoint = argv[++i]; break;
    }
  }

  return opts;
}

// ============================================
// Main
// ============================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  IPC_MODE = opts.ipcMode;
  STATE_FILE = opts.stateFile;

  if (!opts.pointsFile) {
    console.error('Error: --points is required');
    process.exit(1);
  }
  if (!opts.outputFile) {
    console.error('Error: --output is required');
    process.exit(1);
  }
  if (!opts.categoriesFile) {
    opts.categoriesFile = 'config/categories.json';
  }

  setupSignalHandlers();
  ipcStatus('starting');
  TASK_STATS.startedAt = Date.now();

  const poiSearcher = require('./poi-searcher');

  // Load points
  let points;
  const ext = path.extname(opts.pointsFile).toLowerCase();
  if (ext === '.csv') {
    points = poiSearcher.loadPointsFromCSV(opts.pointsFile);
  } else if (ext === '.json') {
    points = poiSearcher.loadPointsFromJSON(opts.pointsFile);
  } else {
    throw new Error('Points file must be .csv or .json');
  }

  ipcLog('info', `Loaded ${points.length} sampling points from ${opts.pointsFile}`);

  // Apply start/limit for parallel splitting
  if (opts.startIndex > 0) {
    ipcLog('info', `Applying start offset: skipping first ${opts.startIndex} points`);
    points = points.slice(opts.startIndex);
  }
  if (opts.limit && opts.limit < points.length) {
    points = points.slice(0, opts.limit);
  }

  ipcLog('info', `Processing ${points.length} points`);

  const categories = poiSearcher.loadCategories(opts.categoriesFile);
  ipcLog('info', `Loaded ${categories.length} categories`);

  // Check if search was already completed
  if (fs.existsSync(opts.outputFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(opts.outputFile, 'utf8'));
      const progress = existing.progress || {};
      if (progress.searchCount > 0 && progress.searchCount >= progress.totalSearches) {
        const placeIds = existing.uniquePlaceIds || [];
        ipcLog('info', `Search already completed: ${placeIds.length} place_ids found in ${progress.searchCount} searches`);
        ipcProgress(progress.searchCount, progress.totalSearches, 'Completed');
        ipcStats({ success: placeIds.length, failed: 0, reviews: 0, images: 0 });
        ipcStatus('completed');
        return;
      }
    } catch (err) {
      ipcLog('warn', `Could not check existing search results: ${err.message}`);
    }
  }

  // Launch browser and run search
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: opts.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    ipcStatus('running');

    const searchOptions = {
      zoom: opts.searchZoom,
      lang: opts.lang,
      maxScrolls: opts.maxSearchScrolls,
      searchDelay: opts.searchDelay,
      extractPlaceId: true,
      incrementalSaveFile: opts.outputFile,
      saveInterval: 50
    };

    const searchResults = await poiSearcher.batchSearchPOIs(
      browser,
      points,
      categories,
      searchOptions,
      (current, total, currentPlace) => {
        ipcProgress(current, total, currentPlace);

        // Update stats with current place_id count
        // We read from the incremental save to get accurate count
        try {
          if (fs.existsSync(opts.outputFile)) {
            const data = JSON.parse(fs.readFileSync(opts.outputFile, 'utf8'));
            ipcStats({
              success: data.totalPlaceIds || 0,
              failed: 0,
              reviews: 0,
              images: 0
            });
          }
        } catch (e) { /* ignore */ }

        if (SHOULD_STOP) {
          throw new Error('Task stopped by user');
        }
      }
    );

    // Final save (atomic write)
    ipcLog('info', `Search completed! Found ${searchResults.totalPlaceIds} unique place_ids`);
    const tmpFile = opts.outputFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(searchResults, null, 2), 'utf8');
    fs.renameSync(tmpFile, opts.outputFile);

    ipcStats({
      success: searchResults.totalPlaceIds,
      failed: 0,
      reviews: 0,
      images: 0
    });
    ipcProgress(searchResults.totalSearches, searchResults.totalSearches, 'Completed');
    ipcStatus('completed');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  ipcLog('error', `Fatal error: ${err.message}`);
  ipcStatus('failed', err.message);
  process.exit(1);
});
