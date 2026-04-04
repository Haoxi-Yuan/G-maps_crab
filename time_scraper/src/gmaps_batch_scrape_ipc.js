#!/usr/bin/env node
'use strict';

/**
 * Google Maps Batch Scraper with IPC Support
 *
 * This version adds:
 * - --ipc-mode: Structured JSON output for frontend communication
 * - --state-file: Persistent state file for monitoring
 * - Signal handling: SIGTERM (stop), SIGUSR1 (pause/resume)
 *
 * Based on gmaps_batch_scrape_with_reviews.js
 */

const fs = require('fs');
const stealth = require('./stealth');
const path = require('path');
const ReviewImageDownloader = require('./review_image_downloader');
const { fetchAllReviews } = require('./api-review-fetcher');
const {
    createResponseHandler,
    applyTimestampsToReviews
} = require('./review_timestamp_parser');

// ============================================
// IPC Communication IPC通信模块
// ============================================

let IPC_MODE = false;
let STATE_FILE = null;
let IS_PAUSED = false;
let SHOULD_STOP = false;

// Task stats for IPC
const TASK_STATS = {
  status: 'pending',
  progress: { current: 0, total: 0, percentage: 0 },
  stats: { success: 0, failed: 0, reviews: 0, images: 0 },
  currentPlace: null,
  startedAt: null,
  lastActivityAt: null,
  error: null
};

// Recent logs ring buffer for state file (survives backend restarts)
const RECENT_LOGS = [];
const MAX_RECENT_LOGS = 50;

/**
 * Send IPC message to stdout (JSON format)
 */
function ipcSend(type, data) {
  if (!IPC_MODE) return;

  const message = {
    type,
    timestamp: Date.now(),
    ...data
  };

  // Write to stdout with special prefix for easy parsing
  try {
    console.log(`__IPC__${JSON.stringify(message)}`);
  } catch (err) {
    // stdout broken (parent died) - silently degrade to file-only mode
    IPC_MODE = false;
  }
}

/**
 * Send progress update
 */
function ipcProgress(current, total, currentPlace = null) {
  TASK_STATS.progress = {
    current,
    total,
    percentage: total > 0 ? Math.round((current / total) * 100) : 0
  };
  TASK_STATS.currentPlace = currentPlace;
  TASK_STATS.lastActivityAt = Date.now();

  ipcSend('progress', {
    current,
    total,
    percentage: TASK_STATS.progress.percentage,
    currentPlace
  });

  writeStateFile();
}

/**
 * Send log message
 */
function ipcLog(level, message, data = null) {
  ipcSend('log', { level, message, data });

  // Store in ring buffer for state file
  RECENT_LOGS.push({ timestamp: Date.now(), level, message, data });
  if (RECENT_LOGS.length > MAX_RECENT_LOGS) {
    RECENT_LOGS.shift();
  }

  // Flush state file on every log so progress is always visible externally
  TASK_STATS.lastActivityAt = Date.now();
  writeStateFile();
}

/**
 * Send status change
 */
function ipcStatus(status, error = null) {
  TASK_STATS.status = status;
  TASK_STATS.error = error;

  ipcSend('status', { status, error });
  writeStateFile();
}

/**
 * Send stats update
 */
function ipcStats(stats) {
  Object.assign(TASK_STATS.stats, stats);
  TASK_STATS.lastActivityAt = Date.now();
  ipcSend('stats', TASK_STATS.stats);
  writeStateFile();
}

/**
 * Write state to file for external monitoring
 */
function writeStateFile() {
  if (!STATE_FILE) return;

  try {
    const state = {
      ...TASK_STATS,
      recentLogs: RECENT_LOGS,
      updatedAt: Date.now(),
      pid: process.pid
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    // Silently fail - don't interrupt main process
  }
}

/**
 * Check if paused and wait
 */
async function checkPaused() {
  while (IS_PAUSED && !SHOULD_STOP) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return !SHOULD_STOP;
}

/**
 * Setup signal handlers
 */
function setupSignalHandlers() {
  // Handle stdout broken pipe (parent server died) - degrade to file-only mode
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
      IPC_MODE = false; // Stop writing to stdout, continue processing
    }
  });
  process.stderr.on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
      IPC_MODE = false;
    }
  });

  // SIGTERM - graceful stop
  process.on('SIGTERM', () => {
    SHOULD_STOP = true;
    ipcStatus('stopping');
  });

  // SIGINT - immediate stop
  process.on('SIGINT', () => {
    SHOULD_STOP = true;
    ipcStatus('stopping');
  });

  // SIGUSR1 - toggle pause (Unix only)
  if (process.platform !== 'win32') {
    process.on('SIGUSR1', () => {
      IS_PAUSED = !IS_PAUSED;
      const status = IS_PAUSED ? 'paused' : 'running';
      ipcStatus(status);
    });
  }

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    // Don't crash on broken pipe - just disable IPC
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
      IPC_MODE = false;
      return;
    }
    try { console.error('[ERROR] Uncaught exception:', err.message); } catch (e) {}
    ipcStatus('failed', err.message);
    process.exit(1);
  });
}

// ============================================
// Anti-Detection Configuration 反检测配置
// ============================================

const ANTI_DETECTION = {
  delayRange: { min: 1000, max: 10000 },
  scrollDelayRange: { min: 100, max: 500 },
  captchaSelectors: [
    'iframe[src*="recaptcha"]',
    '[id*="captcha"]',
    '[class*="captcha"]'
  ],
  geoLocations: {
    'US': { timezone: 'America/New_York', locale: 'en-US', languages: ['en-US', 'en'] },
    'SG': { timezone: 'Asia/Singapore', locale: 'en-SG', languages: ['en-SG', 'en'] },
    'UK': { timezone: 'Europe/London', locale: 'en-GB', languages: ['en-GB', 'en'] },
    'JP': { timezone: 'Asia/Tokyo', locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en'] },
    'DE': { timezone: 'Europe/Berlin', locale: 'de-DE', languages: ['de-DE', 'de', 'en'] },
    'ES': { timezone: 'Europe/Madrid', locale: 'es-ES', languages: ['es-ES', 'es', 'en'] },
    'FR': { timezone: 'Europe/Paris', locale: 'fr-FR', languages: ['fr-FR', 'fr', 'en'] },
    'CN': { timezone: 'Asia/Shanghai', locale: 'zh-CN', languages: ['zh-CN', 'zh', 'en'] },
  },
  softBlockIndicators: ['popular times', 'opening hours', 'reviews'],
  softBlockSelectors: [
    '[role="main"] a:has-text("Sign in")',
    '[role="main"] button:has-text("Sign in")',
    '.section-layout a:has-text("Sign in")',
    '.section-layout button:has-text("Sign in")',
    '[class*="place"] a:has-text("Sign in")',
    '[class*="place"] button:has-text("Sign in")',
    '[data-is-touch-wrapper="true"]:not([class*="header"]) a[href*="accounts.google.com"]',
    'div[role="dialog"] a:has-text("Sign in")',
    '[role="main"] a:has-text("登录")',
    '[role="main"] button:has-text("登录")'
  ]
};

// ============================================
// Utility Functions 工具函数
// ============================================

function randomDelay(min = ANTI_DETECTION.delayRange.min, max = ANTI_DETECTION.delayRange.max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function log(message, opts) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;

  if (!IPC_MODE) {
    console.log(logMessage);
  }

  // Also send as IPC log
  ipcLog('info', message);

  if (opts?.enableLogging && opts?.logFile) {
    try {
      fs.appendFileSync(opts.logFile, logMessage + '\n');
    } catch (err) {
      // Ignore
    }
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function renderProgress(current, total, startTimeMs) {
  // In IPC mode, send structured progress instead of console output
  if (IPC_MODE) {
    ipcProgress(current, total);
    return;
  }

  if (!process.stdout.isTTY || total <= 0) return;
  const width = 28;
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
  const elapsedSec = (Date.now() - startTimeMs) / 1000;
  const etaSec = current > 0 ? (elapsedSec / current) * (total - current) : 0;
  const percent = Math.round(ratio * 100);
  const line = `Progress [${bar}] ${current}/${total} ${percent}% ETA ${formatDuration(etaSec)}`;
  const pad = process.stdout.columns || line.length;
  process.stdout.write(`\r${line.padEnd(pad)}`);
  if (current >= total) {
    process.stdout.write('\n');
  }
}

function parseArgs(argv) {
  const projectRoot = path.resolve(__dirname, '..');
  const opts = {
    input: path.join(projectRoot, 'data/coordinates_singapore.json'),
    output: path.join(projectRoot, 'output/gmaps_batch.ndjson'),
    script: path.join(__dirname, 'google-maps-scraper-pipeline.js'),
    headless: false,
    slowMo: 80,
    delayMs: 1500,
    timeoutMs: 60000,
    hl: 'en',
    limit: null,
    startIndex: 0,
    startIndexSet: false,
    restartEvery: 25,
    restartBrowserEvery: 500,
    blockResources: true,
    resume: true,
    checkpointFile: path.join(projectRoot, 'output/gmaps_batch.checkpoint.json'),
    useProxy: false,
    proxyConfig: null,
    randomDelay: false,
    stealthMode: true,
    detectCaptcha: true,
    retryOnCaptcha: true,
    maxRetries: 3,
    captchaSolver: null,
    geoTarget: null,
    checkIpReputation: false,
    mouseSimulation: true,
    randomNavigation: true,
    detectSoftBlock: true,
    enableLogging: false,
    logFile: path.join(projectRoot, 'output/scraper.log'),
    extractReviews: true,
    maxReviews: 1000,
    maxScrolls: 1000,
    includeReviewImages: true,
    downloadImages: false,
    imageOutputDir: path.join(projectRoot, 'output/images'),
    prettyOutput: false,
    outputFormat: 'ndjson',
    searchMode: false,
    pointsFile: null,
    categoriesFile: null,
    searchZoom: '1000m',
    maxSearchScrolls: 15,
    searchDelay: 2000,
    saveSearchResults: true,
    searchResultsFile: null,
    // Review sort order: 'relevant' (default) or 'newest'
    reviewSort: 'relevant',
    // Output-as-truth: max retries for failed items (0 = no retry, 1 = retry once, etc.)
    maxErrorRetries: 1,
    // Timeout for review extraction page.evaluate() call (ms)
    reviewTimeoutMs: 300000,  // 5 minutes
    // Per-place timeout (ms) - wraps entire place processing including retries
    placeTimeoutMs: 0,   // 0 = adaptive (auto-calculated from review count), or fixed ms value
    // NEW: IPC mode parameters
    ipcMode: false,
    stateFile: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') opts.input = argv[++i];
    else if (arg === '--output') opts.output = argv[++i];
    else if (arg === '--script') opts.script = argv[++i];
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--slowmo') opts.slowMo = parseInt(argv[++i], 10);
    else if (arg === '--delay') opts.delayMs = parseInt(argv[++i], 10);
    else if (arg === '--timeout') opts.timeoutMs = parseInt(argv[++i], 10);
    else if (arg === '--hl') opts.hl = argv[++i];
    else if (arg === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (arg === '--start') {
      opts.startIndex = parseInt(argv[++i], 10);
      opts.startIndexSet = true;
    }
    else if (arg === '--restart-every') opts.restartEvery = parseInt(argv[++i], 10);
    else if (arg === '--restart-browser-every') opts.restartBrowserEvery = parseInt(argv[++i], 10);
    else if (arg === '--no-block-resources') opts.blockResources = false;
    else if (arg === '--no-resume') opts.resume = false;
    else if (arg === '--checkpoint') opts.checkpointFile = argv[++i];
    else if (arg === '--use-proxy') opts.useProxy = true;
    else if (arg === '--proxy-config') opts.proxyConfig = argv[++i];
    else if (arg === '--random-delay') opts.randomDelay = true;
    else if (arg === '--no-stealth') opts.stealthMode = false;
    else if (arg === '--no-captcha-detect') opts.detectCaptcha = false;
    else if (arg === '--max-retries') opts.maxRetries = parseInt(argv[++i], 10);
    else if (arg === '--max-error-retries') opts.maxErrorRetries = parseInt(argv[++i], 10);
    else if (arg === '--captcha-solver') opts.captchaSolver = argv[++i];
    else if (arg === '--geo-target') opts.geoTarget = argv[++i];
    else if (arg === '--check-ip') opts.checkIpReputation = true;
    else if (arg === '--no-mouse-sim') opts.mouseSimulation = false;
    else if (arg === '--no-random-nav') opts.randomNavigation = false;
    else if (arg === '--no-soft-block-detect') opts.detectSoftBlock = false;
    else if (arg === '--enable-logging') opts.enableLogging = true;
    else if (arg === '--log-file') opts.logFile = argv[++i];
    else if (arg === '--no-reviews') opts.extractReviews = false;
    else if (arg === '--max-reviews') opts.maxReviews = parseInt(argv[++i], 10);
    else if (arg === '--max-scrolls') opts.maxScrolls = parseInt(argv[++i], 10);
    else if (arg === '--no-review-images') opts.includeReviewImages = false;
    else if (arg === '--download-images') opts.downloadImages = true;
    else if (arg === '--image-output') opts.imageOutputDir = argv[++i];
    else if (arg === '--pretty') opts.prettyOutput = true;
    else if (arg === '--format') {
      const format = argv[++i];
      if (['ndjson', 'json', 'both'].includes(format)) {
        opts.outputFormat = format;
      } else {
        throw new Error('Invalid --format value. Must be: ndjson, json, or both');
      }
    }
    else if (arg === '--search-mode') opts.searchMode = true;
    else if (arg === '--points') opts.pointsFile = argv[++i];
    else if (arg === '--categories') opts.categoriesFile = argv[++i];
    else if (arg === '--search-zoom') opts.searchZoom = argv[++i];
    else if (arg === '--max-search-scrolls') opts.maxSearchScrolls = parseInt(argv[++i], 10);
    else if (arg === '--search-delay') opts.searchDelay = parseInt(argv[++i], 10);
    else if (arg === '--select-categories') opts.selectCategories = argv[++i];
    else if (arg === '--no-save-search-results') opts.saveSearchResults = false;
    else if (arg === '--search-results') opts.searchResultsFile = argv[++i];
    else if (arg === '--review-sort') {
      const sort = argv[++i];
      if (['relevant', 'newest', 'highest', 'lowest'].includes(sort)) {
        opts.reviewSort = sort;
      } else {
        throw new Error('Invalid --review-sort value. Must be: relevant, newest, highest, or lowest');
      }
    }
    else if (arg === '--review-timeout') opts.reviewTimeoutMs = parseInt(argv[++i], 10);
    else if (arg === '--place-timeout') opts.placeTimeoutMs = parseInt(argv[++i], 10);
    // NEW: IPC mode parameters
    else if (arg === '--ipc-mode') opts.ipcMode = true;
    else if (arg === '--state-file') opts.stateFile = argv[++i];
  }

  // Validate
  if (opts.searchMode) {
    if (!opts.pointsFile) {
      throw new Error('Search mode requires --points (sampling points file).');
    }
    if (!opts.categoriesFile) {
      throw new Error('Search mode requires --categories (POI categories file).');
    }
    if (!opts.searchResultsFile) {
      opts.searchResultsFile = opts.output.replace(/\.ndjson$/i, '.search_results.json');
    }
  } else {
    if (!opts.input) {
      throw new Error('Missing --input (place_id list file). Use --search-mode for POI search.');
    }
  }

  // Auto-generate state file if IPC mode enabled
  if (opts.ipcMode && !opts.stateFile) {
    opts.stateFile = opts.output.replace(/\.ndjson$/i, '.state.json');
  }

  return opts;
}

// Global map: placeId → direct Google Maps link (populated by loadPlaceIds)
const _placeIdToLink = new Map();

function loadPlaceIds(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      return data
        .map(item => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object') {
            const id = item.place_id || item.placeId || null;
            // Store direct link if available (used instead of place_id: query)
            if (id && (item.google_maps_link || item.link)) {
              _placeIdToLink.set(id, item.google_maps_link || item.link);
            }
            return id;
          }
          return null;
        })
        .filter(Boolean);
    }
    if (data && typeof data === 'object') {
      const id = data.place_id || data.placeId;
      return id ? [id] : [];
    }
    return [];
  }

  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const ids = [];
  for (const line of lines) {
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        const id = obj.place_id || obj.placeId;
        if (id) {
          ids.push(id);
          if (obj.google_maps_link || obj.link) {
            _placeIdToLink.set(id, obj.google_maps_link || obj.link);
          }
        }
      } catch (err) {
        // Skip
      }
    } else {
      ids.push(line);
    }
  }
  return ids;
}

function stripDownload(scriptSource) {
  return scriptSource.replace(
    /downloadJSON\(\s*cleanedData\s*,\s*filename\s*\);\s*/g,
    'window.__gmap_last = cleanedData;'
  );
}

function readCheckpoint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.lastIndex === 'number') return data;
    return null;
  } catch (err) {
    return null;
  }
}

function writeCheckpoint(filePath, data) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    // Ignore
  }
}

// ============================================
// Output-as-Truth System (输出即真相)
// ============================================

const crypto = require('crypto');

/**
 * Compute a hash of the config to detect changes
 */
function computeConfigHash(opts, inputFile) {
  const relevantConfig = {
    input: inputFile,
    start: opts.startIndex || 0,
    limit: opts.limit || null,
    searchMode: opts.searchMode || false,
    pointsFile: opts.pointsFile || null,
    categoriesFile: opts.categoriesFile || null
  };
  return crypto.createHash('md5').update(JSON.stringify(relevantConfig)).digest('hex').slice(0, 12);
}

/**
 * Scan output files (.ndjson + .errors.ndjson) to build doneSet
 * Also returns retry candidates (errors with retryable types)
 */
function scanOutputForDoneSet(outputPath, errorsPath, maxRetries = 1) {
  const doneSet = new Set();
  const errorCounts = new Map(); // placeId -> { count, lastError }
  const retryableErrors = new Set([
    'timeout', 'navigation', 'network', 'captcha', 'blocked',
    'PLACE TIMEOUT', 'Page crashed', 'browser disconnected'
  ]);

  // Scan success output
  if (fs.existsSync(outputPath)) {
    const content = fs.readFileSync(outputPath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        const placeId = (record._meta && record._meta.placeId) || record.placeId || record.business?.placeId;
        if (placeId) {
          doneSet.add(placeId);
        }
      } catch (err) {
        // Bad line at end - truncate file here if it's the last few lines
        if (i >= lines.length - 3) {
          ipcLog('warn', `Truncating malformed line ${i + 1} in output file`);
        }
      }
    }
  }

  // Scan errors output
  if (fs.existsSync(errorsPath)) {
    const content = fs.readFileSync(errorsPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const placeId = record.placeId;
        if (!placeId) continue;

        const errorType = record.error || '';
        const isRetryable = [...retryableErrors].some(e => errorType.includes(e));

        if (!errorCounts.has(placeId)) {
          errorCounts.set(placeId, { count: 0, lastError: errorType, retryable: isRetryable });
        }
        const entry = errorCounts.get(placeId);
        entry.count++;
        entry.lastError = errorType;
        entry.retryable = isRetryable;

        // If error count >= maxRetries or not retryable, mark as done
        if (entry.count >= maxRetries || !isRetryable) {
          doneSet.add(placeId);
        }
      } catch (err) {
        // Skip malformed error lines
      }
    }
  }

  // Build retry set: errors that haven't exceeded retry limit
  const retrySet = new Set();
  for (const [placeId, entry] of errorCounts) {
    if (entry.count < maxRetries && entry.retryable && !doneSet.has(placeId)) {
      retrySet.add(placeId);
    }
  }

  return { doneSet, retrySet, successCount: doneSet.size - errorCounts.size, errorCount: errorCounts.size };
}

/**
 * Load or create output.meta.json
 */
function loadMeta(metaPath) {
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function saveMeta(metaPath, meta) {
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    ipcLog('warn', `Failed to save meta file: ${err.message}`);
  }
}

/**
 * Backup old output files when config changes
 */
function backupOutputFiles(outputPath, errorsPath, metaPath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupSuffix = `.bak-${timestamp}`;

  const filesToBackup = [outputPath, errorsPath, metaPath];
  for (const file of filesToBackup) {
    if (fs.existsSync(file)) {
      const backupPath = file + backupSuffix;
      fs.renameSync(file, backupPath);
      ipcLog('info', `Backed up ${path.basename(file)} → ${path.basename(backupPath)}`);
    }
  }
}

/**
 * Initialize output-as-truth system
 * Returns: { doneSet, retrySet, meta, needsReset }
 */
function initOutputAsTruth(opts, inputFile, placeIds) {
  const outputPath = opts.output;
  const errorsPath = outputPath.replace(/\.ndjson$/i, '.errors.ndjson');
  const metaPath = outputPath.replace(/\.ndjson$/i, '.meta.json');

  const currentHash = computeConfigHash(opts, inputFile);
  const existingMeta = loadMeta(metaPath);

  let needsReset = false;

  // Check if config has changed
  if (existingMeta && existingMeta.configHash !== currentHash) {
    ipcLog('warn', `Config changed (hash ${existingMeta.configHash} → ${currentHash}), backing up old output`);
    backupOutputFiles(outputPath, errorsPath, metaPath);
    needsReset = true;
  }

  // Scan output files
  const { doneSet, retrySet, successCount, errorCount } = needsReset
    ? { doneSet: new Set(), retrySet: new Set(), successCount: 0, errorCount: 0 }
    : scanOutputForDoneSet(outputPath, errorsPath, opts.maxErrorRetries || 1);

  // Create/update meta
  const meta = {
    configHash: currentHash,
    inputFile: inputFile,
    totalInputItems: placeIds.length,
    chunkStart: opts.startIndex || 0,
    chunkLimit: opts.limit || null,
    createdAt: existingMeta?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // For POI search mode, save placeIds for reproducibility
    ...(opts.searchMode && opts.saveSearchPlaceIds !== false ? { placeIds: placeIds } : {})
  };
  saveMeta(metaPath, meta);

  ipcLog('info', `Output-as-truth initialized: ${doneSet.size} done, ${retrySet.size} retryable, hash=${currentHash}`);

  return { doneSet, retrySet, meta, outputPath, errorsPath, metaPath };
}

// Resource blocking and ProxyManager now provided by stealth module
// See: ./stealth/resource-blocker.js, ./stealth/proxy-rotator.js

// ============================================
// CAPTCHA Solver (stub)
// ============================================

class CaptchaSolver {
  constructor(apiKey, service = '2captcha') {
    this.apiKey = apiKey;
    this.service = service;
  }

  async solveCaptcha(page, siteKey) {
    if (!this.apiKey) return null;
    // Stub - actual implementation needed
    return null;
  }
}

// ============================================
// IP Reputation Checker (stub)
// ============================================

class IpReputationChecker {
  constructor() {
    this.checkedIps = new Map();
  }

  async checkReputation(proxyServer) {
    if (!proxyServer) {
      return { status: 'ok', message: 'Direct connection' };
    }

    const ipMatch = proxyServer.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!ipMatch) {
      return { status: 'unknown', message: 'Invalid proxy format' };
    }

    const ip = ipMatch[1];
    if (this.checkedIps.has(ip)) {
      return this.checkedIps.get(ip);
    }

    const result = { status: 'ok', message: 'IP reputation check passed', score: 85 };
    this.checkedIps.set(ip, result);
    return result;
  }
}

// ============================================
// Anti-Detection Functions
// ============================================

async function detectCaptcha(page) {
  for (const selector of ANTI_DETECTION.captchaSelectors) {
    try {
      const element = await page.locator(selector).first();
      if (await element.isVisible({ timeout: 1000 })) {
        return true;
      }
    } catch (e) {
      // Continue
    }
  }
  return false;
}

// applyStealth now provided by stealth module — see ./stealth/apply-stealth.js

async function simulateMouseMovement(page) {
  const viewport = page.viewportSize();
  if (!viewport) return;

  const startX = Math.floor(Math.random() * viewport.width);
  const startY = Math.floor(Math.random() * viewport.height);
  await page.mouse.move(startX, startY);

  const steps = Math.floor(Math.random() * 10) + 5;
  for (let i = 0; i < steps; i++) {
    const targetX = Math.floor(Math.random() * viewport.width);
    const targetY = Math.floor(Math.random() * viewport.height);
    const subSteps = Math.floor(Math.random() * 5) + 3;
    const currentX = startX + (targetX - startX) * (i / steps);
    const currentY = startY + (targetY - startY) * (i / steps);

    for (let j = 0; j < subSteps; j++) {
      const x = currentX + (targetX - currentX) * (j / subSteps);
      const y = currentY + (targetY - currentY) * (j / subSteps);
      await page.mouse.move(x, y);
      await page.waitForTimeout(randomDelay(10, 50));
    }
    await page.waitForTimeout(randomDelay(100, 300));
  }
}

async function humanScroll(page) {
  const scrollDistance = Math.floor(Math.random() * 300) + 200;
  const steps = Math.floor(Math.random() * 5) + 3;
  const stepDistance = scrollDistance / steps;

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepDistance);
    const delay = randomDelay(ANTI_DETECTION.scrollDelayRange.min, ANTI_DETECTION.scrollDelayRange.max);
    await page.waitForTimeout(delay);
  }
}

async function randomNavigation(page) {
  const patterns = [
    async () => {
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(randomDelay(1000, 3000));
    },
    async () => {
      await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(randomDelay(1000, 3000));
    }
  ];

  const pattern = randomChoice(patterns);
  await pattern();
}

async function detectSoftBlock(page, placeId) {
  try {
    for (const selector of ANTI_DETECTION.softBlockSelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 1000 })) {
          return { blocked: true, reason: 'sign_in_required' };
        }
      } catch (e) {
        // Continue
      }
    }

    const pageContent = await page.content();
    const signInKeywords = ['sign in to google', 'log in', 'login required'];
    for (const keyword of signInKeywords) {
      if (pageContent.toLowerCase().includes(keyword.toLowerCase())) {
        return { blocked: true, reason: 'sign_in_keyword' };
      }
    }

    let missingDataCount = 0;
    for (const indicator of ANTI_DETECTION.softBlockIndicators) {
      if (!pageContent.toLowerCase().includes(indicator.toLowerCase())) {
        missingDataCount++;
      }
    }

    if (missingDataCount >= 2) {
      return { blocked: true, reason: 'missing_data' };
    }

    return { blocked: false };
  } catch (err) {
    return { blocked: false };
  }
}

async function autoScrollAndOpen(page) {
  return page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

    const findScrollContainer = () =>
      document.querySelector('.e07Vkf.kA9KIf.dS8AEf') ||
      document.querySelector('[role="main"]') ||
      document.scrollingElement ||
      document.body;

    const hasPopular = () =>
      !!document.querySelector('[aria-label*="Popular times"], [aria-label*="popular times"], [aria-label*="% busy"]');

    const clickHours = () => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const btn = buttons.find(el => {
        const text = norm(el.textContent);
        const aria = norm(el.getAttribute('aria-label'));
        return /Hours|Open hours|Show open hours|24\s*hours/i.test(text) ||
          /Hours|Open hours|Show open hours|24\s*hours/i.test(aria) ||
          el.getAttribute('data-item-id') === 'oh';
      });
      if (btn) btn.click();
    };

    const scroller = findScrollContainer();
    if (!scroller) return { ok: false, reason: 'no_scroller' };

    clickHours();
    await sleep(600);

    for (let i = 0; i < 40; i++) {
      if (hasPopular()) {
        const el = document.querySelector('[aria-label*="Popular times"], [aria-label*="popular times"], [aria-label*="% busy"]');
        if (el) el.scrollIntoView({ block: 'center' });
        return { ok: true, popularFound: true };
      }
      scroller.scrollBy(0, Math.round(scroller.clientHeight * 0.85));
      await sleep(350);
    }

    return { ok: true, popularFound: false };
  });
}

// ============================================
// Main Function
// ============================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Initialize IPC mode
  IPC_MODE = opts.ipcMode;
  STATE_FILE = opts.stateFile;

  // Setup signal handlers
  setupSignalHandlers();

  // Send initial status
  ipcStatus('starting');
  TASK_STATS.startedAt = Date.now();

  let placeIds = [];

  // POI Search Mode
  if (opts.searchMode) {
    ipcLog('info', 'Starting POI search from sampling points');

    const poiSearcher = require('./poi-searcher');

    // Check if search phase was already completed (resume support)
    let searchAlreadyComplete = false;
    if (opts.searchResultsFile && fs.existsSync(opts.searchResultsFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(opts.searchResultsFile, 'utf8'));
        const progress = existing.progress || {};
        if (progress.searchCount > 0 && progress.searchCount >= progress.totalSearches) {
          // Search phase was fully completed in a previous run
          placeIds = existing.uniquePlaceIds || [];
          if (placeIds.length > 0) {
            ipcLog('info', `Search phase already completed: ${placeIds.length} place_ids loaded from ${opts.searchResultsFile}`);
            searchAlreadyComplete = true;
          }
        }
      } catch (err) {
        ipcLog('warn', `Could not check existing search results: ${err.message}`);
      }
    }

    if (!searchAlreadyComplete) {
      let points;
      const ext = path.extname(opts.pointsFile).toLowerCase();
      if (ext === '.csv') {
        points = poiSearcher.loadPointsFromCSV(opts.pointsFile);
      } else if (ext === '.json') {
        points = poiSearcher.loadPointsFromJSON(opts.pointsFile);
      } else {
        throw new Error('Points file must be .csv or .json');
      }

      ipcLog('info', `Loaded ${points.length} sampling points`);

      // Apply --start offset for parallel splitting
      if (opts.startIndex > 0) {
        ipcLog('info', `Applying start offset: skipping first ${opts.startIndex} points`);
        points = points.slice(opts.startIndex);
      }

      if (opts.limit && opts.limit < points.length) {
        points = points.slice(0, opts.limit);
      }

      let categories = poiSearcher.loadCategories(opts.categoriesFile);
      if (opts.selectCategories) {
        const selected = new Set(opts.selectCategories.split(',').map(s => s.trim().toLowerCase()));
        categories = categories.filter(c => selected.has(c.toLowerCase()));
        ipcLog('info', `Category filter applied: ${categories.length} selected from ${opts.selectCategories}`);
        if (categories.length === 0) {
          throw new Error('No matching categories found after filtering. Check --select-categories values.');
        }
      }
      ipcLog('info', `Using ${categories.length} categories`);

      const { chromium } = require('playwright');
      const searchBrowser = await chromium.launch({
        headless: opts.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      try {
        const searchOptions = {
          zoom: opts.searchZoom,
          lang: opts.hl,
          maxScrolls: opts.maxSearchScrolls,
          searchDelay: opts.searchDelay,
          extractPlaceId: true,
          incrementalSaveFile: opts.searchResultsFile,
          saveInterval: 50  // Save every 50 searches
        };

        // Progress callback for POI search phase
        const searchProgressCallback = (current, total, currentPlace) => {
          ipcProgress(current, total, currentPlace);
        };

        const searchResults = await poiSearcher.batchSearchPOIs(
          searchBrowser,
          points,
          categories,
          searchOptions,
          searchProgressCallback
        );

        ipcLog('info', `Search completed! Found ${searchResults.totalPlaceIds} unique place_ids`);

        if (opts.saveSearchResults) {
          const tmpFile = opts.searchResultsFile + '.tmp';
          fs.writeFileSync(tmpFile, JSON.stringify(searchResults, null, 2), 'utf8');
          fs.renameSync(tmpFile, opts.searchResultsFile);
        }

        placeIds = searchResults.uniquePlaceIds;

        if (placeIds.length === 0) {
          throw new Error('No place_id found from POI search.');
        }

      } finally {
        await searchBrowser.close();
      }
    }

    if (!opts.startIndexSet) {
      opts.limit = null;
    }

  } else {
    placeIds = loadPlaceIds(opts.input);
    if (placeIds.length === 0) {
      throw new Error('No place_id found in input.');
    }
  }

  const pipelinePath = path.resolve(opts.script);
  if (!fs.existsSync(pipelinePath)) {
    throw new Error(`Pipeline not found: ${pipelinePath}`);
  }
  const pipelineSrc = stripDownload(fs.readFileSync(pipelinePath, 'utf8'));

  const reviewsExtractorPath = path.join(__dirname, 'reviews_extractor_scroll.js');
  let reviewsExtractorSrc = null;
  if (fs.existsSync(reviewsExtractorPath)) {
    reviewsExtractorSrc = fs.readFileSync(reviewsExtractorPath, 'utf8');
  }

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });

  const outStream = fs.createWriteStream(opts.output, { flags: 'a' });
  const errStream = fs.createWriteStream(opts.output.replace(/\.ndjson$/i, '.errors.ndjson'), { flags: 'a' });
  const results = [];
  const needsCollection = opts.outputFormat === 'json' || opts.outputFormat === 'both' || opts.prettyOutput;

  // Initialize modules — using stealth module
  let proxyManager = new stealth.ProxyRotator([], { geoTarget: opts.geoTarget });
  if (opts.useProxy && opts.proxyConfig) {
    try {
      const proxyData = JSON.parse(fs.readFileSync(opts.proxyConfig, 'utf8'));
      const proxies = proxyData.proxies || [];
      proxyManager = new stealth.ProxyRotator(proxies, { geoTarget: opts.geoTarget });
    } catch (err) {
      // Ignore
    }
  }

  const captchaSolver = opts.captchaSolver ? new CaptchaSolver(opts.captchaSolver) : null;
  const ipChecker = opts.checkIpReputation ? new IpReputationChecker() : null;
  const imageDownloader = opts.downloadImages ? new ReviewImageDownloader(opts.imageOutputDir) : null;

  let geoConfig = ANTI_DETECTION.geoLocations['US'];
  if (opts.geoTarget && ANTI_DETECTION.geoLocations[opts.geoTarget]) {
    geoConfig = ANTI_DETECTION.geoLocations[opts.geoTarget];
  }

  // Launch browser with stealth args (85+ args from Scrapling)
  const { chromium } = require('playwright');
  let currentProxy = opts.useProxy ? proxyManager.getCurrentProxy() : null;

  let launchOptions = stealth.buildLaunchOptions({
    headless: opts.headless,
    slowMo: opts.slowMo,
    proxy: currentProxy ? stealth.ProxyRotator.toPlaywrightProxy(currentProxy) : undefined,
    blockWebRTC: true,
    canvasNoise: true,
    allowWebGL: true,
    noSandbox: true,
  });

  let browser = await chromium.launch(launchOptions);

  // Stealth context state
  let context = null;
  let page = null;
  let currentFingerprint = null;
  let pageCrashed = false;
  let browserDisconnected = false;

  const attachPageHandlers = () => {
    pageCrashed = false;
    page.on('crash', () => {
      pageCrashed = true;
    });
  };

  // Create stealth context using stealth module (replaces manual context + applyStealth + headers + resource blocking)
  const initContextPage = async () => {
    if (context) {
      await context.close().catch(() => {});
    }
    const result = await stealth.createStealthContext(browser, {
      geoConfig,
      proxy: currentProxy ? stealth.ProxyRotator.toPlaywrightProxy(currentProxy) : undefined,
      stealthMode: opts.stealthMode,
      blockImages: false,            // Default OFF to preserve review image links
      blockHeavyResources: opts.blockResources !== false,
      blockTracking: true,
      canvasNoise: true,
      webglSpoof: true,
    });
    context = result.context;
    page = result.page;
    currentFingerprint = result.fingerprint;
    page.setDefaultTimeout(opts.timeoutMs);
    page.setDefaultNavigationTimeout(opts.timeoutMs);
    attachPageHandlers();
  };

  const restartContext = async (reason) => {
    await initContextPage();
    if (opts.randomNavigation) {
      await randomNavigation(page);
    }
  };

  const restartBrowser = async (reason, nextLaunchOptions) => {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    browser = await chromium.launch(nextLaunchOptions || launchOptions);
    browserDisconnected = false;
    await initContextPage();
    if (opts.randomNavigation) {
      await randomNavigation(page);
    }
  };

  browser.on('disconnected', () => {
    browserDisconnected = true;
  });

  await initContextPage();

  if (ipChecker && currentProxy) {
    await ipChecker.checkReputation(currentProxy.server);
  }

  if (opts.randomNavigation) {
    await randomNavigation(page);
  }

  // ============================================
  // Output-as-Truth: Initialize from output files
  // ============================================
  const originalStart = Math.max(0, opts.startIndex || 0);
  const endIndex = opts.limit
    ? Math.min(placeIds.length, originalStart + opts.limit)
    : placeIds.length;

  if (originalStart >= placeIds.length) {
    throw new Error('Start index beyond input size.');
  }

  const chunkItems = placeIds.slice(originalStart, endIndex);
  const uniquePlaceIds = [];
  const seenPlaceIds = new Set();
  let duplicateCount = 0;
  let missingIdCount = 0;

  for (const item of chunkItems) {
    const pid = (item && typeof item === 'object')
      ? (item.place_id || item.placeId)
      : item;
    if (!pid) {
      missingIdCount++;
      continue;
    }
    if (seenPlaceIds.has(pid)) {
      duplicateCount++;
      continue;
    }
    seenPlaceIds.add(pid);
    uniquePlaceIds.push(pid);
  }

  const total = uniquePlaceIds.length;

  if (total === 0) {
    throw new Error('No unique records to process.');
  }

  if (duplicateCount > 0) {
    ipcLog('info', `Deduped ${duplicateCount} duplicate place_ids in chunk`);
  }
  if (missingIdCount > 0) {
    ipcLog('warn', `Skipped ${missingIdCount} items with missing place_id`);
  }

  // Initialize output-as-truth system: scan output files to build doneSet
  const inputFile = opts.searchMode ? opts.pointsFile : opts.input;
  const { doneSet, retrySet } = initOutputAsTruth(opts, inputFile, uniquePlaceIds);

  // Calculate initial progress from doneSet
  // Count how many items in our unique chunk are already done
  let alreadyDoneCount = 0;
  for (const pid of uniquePlaceIds) {
    if (doneSet.has(pid)) {
      alreadyDoneCount++;
    }
  }

  ipcLog('info', `Output-as-truth: ${alreadyDoneCount}/${total} already done, ${retrySet.size} retryable errors`);

  // Update task stats with total and initial progress
  TASK_STATS.progress.total = total;
  TASK_STATS.progress.current = alreadyDoneCount;
  ipcStatus('running');

  const startTimeMs = Date.now();

  let processed = alreadyDoneCount;  // Start from already-done count
  let successCount = alreadyDoneCount;  // Approximate (actual count from output scan)
  let failedCount = 0;
  let reviewCount = 0;
  let imageCount = 0;

  // Send initial progress
  ipcProgress(processed, total, null);
  ipcStats({ success: successCount, failed: failedCount, reviews: reviewCount, images: imageCount });
  renderProgress(processed, total, startTimeMs);

  // Main processing loop - iterate through ALL items in chunk, skip done ones
  for (let idx = 0; idx < uniquePlaceIds.length; idx++) {
    // Check for stop signal
    if (SHOULD_STOP) {
      ipcLog('info', 'Received stop signal, finishing...');
      break;
    }

    // Check for pause
    const shouldContinue = await checkPaused();
    if (!shouldContinue) break;

    const placeId = uniquePlaceIds[idx];

    // OUTPUT-AS-TRUTH: Skip if already in doneSet (processed in previous runs)
    if (doneSet.has(placeId) && !retrySet.has(placeId)) {
      // Already done - no need to process or update progress (already counted)
      continue;
    }

    // Mark as in-progress for retry items
    const isRetry = retrySet.has(placeId);
    if (isRetry) {
      ipcLog('info', `Retrying previously failed: ${placeId}`);
    }

    // runIndex: 1-based index within items we're actually processing this session
    const runIndex = processed - alreadyDoneCount + 1;

    // Support both ChIJ place_id and hex ftid formats
    const isFtid = placeId.startsWith('0x');
    const url = isFtid
      ? `https://www.google.com/maps/place/?ftid=${placeId}&hl=${encodeURIComponent(opts.hl)}`
      : `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=${encodeURIComponent(opts.hl)}`;

    // Update current place for IPC
    ipcProgress(processed, total, placeId);

    // Reuse context (don't create fresh per place — matches demo behavior)
    // Only restart on crash/disconnect
    if (browserDisconnected) {
      await restartBrowser('browser disconnected');
    } else if (pageCrashed || (page && page.isClosed())) {
      await initContextPage(); // No randomNavigation
    }

    let retryCount = 0;
    let success = false;
    let reviewTimestamps = null;
    let responseHandler = null;
    const placeStartTime = Date.now();

    while (retryCount <= opts.maxRetries && !success && !SHOULD_STOP) {
      try {
        ipcLog('info', `[${runIndex}/${total}] Processing ${placeId}`);

        // Lean two-step load: search preload + place URL + wait for h1
        const searchUrl = `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${placeId}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
        await page.waitForTimeout(2000);

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
        await page.waitForSelector('h1', { timeout: opts.timeoutMs });
        await page.waitForTimeout(2000);

        // Extract basic business data via pipeline
        const result = await page.evaluate(pipelineSrc);

        if (result && typeof result === 'object') {
          // Extract reviews — API method (primary) with DOM scroll fallback
          if (opts.extractReviews !== false) {
            try {
              // ========== PHASE 1: API extraction (primary) ==========
              ipcLog('info', `[Reviews] Phase 1: API extraction (maxReviews=${opts.maxReviews})`);

              const apiResult = await fetchAllReviews(page, {
                maxReviews: opts.maxReviews || 1000,
                pageSize: 20,
                delayMs: 200,
                onProgress: (count, total) => {
                  ipcLog('info', `[Reviews] API progress: ${count}/${total}`);
                },
              });

              let allReviews = [];
              const seenIds = new Set();

              if (!apiResult.error && apiResult.reviews.length > 0) {
                for (const r of apiResult.reviews) {
                  seenIds.add(r.review_id);
                  allReviews.push(r);
                }
                ipcLog('info', `[Reviews] API: ${allReviews.length} reviews (${apiResult.withText} text) in ${apiResult.elapsed}s`);
              } else if (apiResult.error) {
                ipcLog('warn', `[Reviews] API failed: ${apiResult.error}`);
              }

              // Set detected review count
              const detectedTotal = apiResult.detectedCount;
              if (detectedTotal && result.business) {
                result.business.reviewCount = detectedTotal;
              }

              // ========== PHASE 2: DOM scroll supplement (only if API clearly fell short) ==========
              const apiCoverage = detectedTotal ? (allReviews.length / detectedTotal) : 0;
              // Only supplement if: detected count known AND API got < 95%
              // If count unknown but API got reviews, assume API is sufficient (it reached its natural end)
              const needSupplement = detectedTotal && apiCoverage < 0.95;
              if (needSupplement && reviewsExtractorSrc) {
                const remaining = detectedTotal ? (detectedTotal - allReviews.length) : 'unknown';
                ipcLog('info', `[Reviews] Phase 2: DOM supplement (API got ${allReviews.length}${detectedTotal ? '/' + detectedTotal + ' = ' + Math.round(apiCoverage * 100) + '%' : ' (count unknown)'}, need ~${remaining} more)`);

                const consoleHandler = (msg) => {
                  if (msg.text().includes('[Reviews]')) ipcLog('info', `[Browser] ${msg.text()}`);
                };
                page.on('console', consoleHandler);
                await page.evaluate(reviewsExtractorSrc);

                try {
                  const scrollResult = await Promise.race([
                    page.evaluate(async (config) => {
                      if (typeof window.extractReviewsByScrolling === 'function') {
                        return await window.extractReviewsByScrolling(config);
                      }
                      return { reviews: [], error: 'function_not_found' };
                    }, {
                      maxReviews: opts.maxReviews || 1000,
                      maxScrolls: opts.maxScrolls || 1000,
                      includeImages: opts.includeReviewImages !== false,
                      scrollDelay: 500,
                      reviewSort: opts.reviewSort || 'relevant'
                    }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('DOM scroll timeout')), 3600000))
                  ]);

                  const domReviews = Array.isArray(scrollResult) ? scrollResult : (scrollResult?.reviews || []);

                  // Merge: add DOM reviews not already captured by API
                  let domNew = 0;
                  for (const r of domReviews) {
                    if (!seenIds.has(r.review_id)) {
                      seenIds.add(r.review_id);
                      allReviews.push(r);
                      domNew++;
                    }
                  }
                  ipcLog('info', `[Reviews] DOM supplement: ${domReviews.length} extracted, ${domNew} new unique (total: ${allReviews.length})`);
                } catch (domErr) {
                  ipcLog('warn', `[Reviews] DOM supplement failed: ${domErr.message}`);
                }
                try { page.off('console', consoleHandler); } catch (e) {}
              } else {
                if (detectedTotal) {
                  ipcLog('info', `[Reviews] API coverage ${Math.round(apiCoverage * 100)}% >= 95% — DOM supplement not needed`);
                } else {
                  ipcLog('info', `[Reviews] API got ${allReviews.length} reviews (count unknown, API reached natural end) — skipping DOM supplement`);
                }
              }

              // ========== PHASE 3: Finalize ==========
              if (allReviews.length > 0) {
                if (reviewTimestamps && reviewTimestamps.size > 0) {
                  applyTimestampsToReviews(allReviews, reviewTimestamps);
                }
                result.detailedReviews = allReviews;
                reviewCount += allReviews.length;

                if (imageDownloader && opts.includeReviewImages) {
                  try {
                    await imageDownloader.downloadAllReviewImages(placeId, allReviews, false);
                    const stats = imageDownloader.getStats();
                    imageCount += stats.success;
                  } catch (imgError) {
                    ipcLog('warn', `[Reviews] Image download error: ${imgError.message}`);
                  }
                }
              }

              ipcLog('info', `[Reviews] Final: ${allReviews.length} reviews${detectedTotal ? ` (${Math.round(allReviews.length/detectedTotal*100)}% of ${detectedTotal})` : ''}`);

              if (responseHandler) {
                try { page.off('response', responseHandler); } catch (e) {}
                responseHandler = null;
              }

            } catch (reviewError) {
              ipcLog('error', `[Reviews] Extraction failed: ${reviewError.message}`);
              if (responseHandler) {
                try { page.off('response', responseHandler); } catch (e) {}
                responseHandler = null;
              }
            }
          }

          result._meta = { placeId, sourceUrl: url };

          if (opts.outputFormat === 'ndjson' || opts.outputFormat === 'both') {
            outStream.write(JSON.stringify(result) + '\n');
          }

          if (needsCollection) {
            results.push(result);
          }

          ipcLog('success', `[${runIndex}/${total}] OK: ${placeId}`);
          successCount++;
          success = true;
        } else {
          if (opts.detectSoftBlock) {
            const softBlockResult = await detectSoftBlock(page, placeId);
            if (softBlockResult.blocked) {
              throw new Error(`Soft-block detected: ${softBlockResult.reason}`);
            }
          }
          throw new Error('null_result');
        }
      } catch (err) {
        // Clean up response handler on error
        if (responseHandler) {
          try { page.off('response', responseHandler); } catch (e) {}
          responseHandler = null;
        }

        const message = err && err.message ? err.message : String(err);
        const navigationIssue = /ERR_ABORTED|frame was detached|Target closed|Navigation failed/i.test(message);
        const isSoftBlockError = /Soft-block detected/i.test(message);

        if (browserDisconnected) {
          await restartBrowser('browser disconnected during navigation');
        } else if (pageCrashed || navigationIssue) {
          await restartContext(`navigation error: ${message}`);
        }

        if (retryCount < opts.maxRetries) {
          ipcLog('warn', `[${runIndex}/${total}] Retrying: ${message}`);

          if (isSoftBlockError && opts.detectSoftBlock) {
            try {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
              await page.waitForTimeout(randomDelay(1000, 2000));
            } catch (refreshErr) {
              // Ignore
            }
          } else {
            await page.waitForTimeout(randomDelay(2000, 5000));
          }

          retryCount++;
        } else {
          errStream.write(JSON.stringify({ placeId, url, error: message }) + '\n');
          ipcLog('error', `[${runIndex}/${total}] FAIL: ${placeId} - ${message}`);
          failedCount++;
          break;
        }
      }
    }

    // Final cleanup of response handler (safety net)
    if (responseHandler) {
      try { page.off('response', responseHandler); } catch (e) {}
      responseHandler = null;
    }

    // If place timed out, restart browser context to clean up any hung operations
    const placeTimedOut = opts.placeTimeoutMs > 0 && (Date.now() - placeStartTime) > opts.placeTimeoutMs;
    if (placeTimedOut && !success) {
      ipcLog('warn', 'Restarting browser context after place timeout');
      try { await restartContext('place timeout'); } catch (e) {}
    }

    if (opts.delayMs && runIndex < total) {
      const delay = opts.randomDelay ? randomDelay(opts.delayMs, opts.delayMs * 2) : opts.delayMs;
      await page.waitForTimeout(delay);
    }

    processed += 1;
    renderProgress(processed, total, startTimeMs);

    // Update stats
    ipcStats({ success: successCount, failed: failedCount, reviews: reviewCount, images: imageCount });

    // Write checkpoint as UI cache (not used for recovery - output files are the truth)
    if (opts.resume) {
      writeCheckpoint(opts.checkpointFile, {
        lastIndex: idx,
        placeId: placeId,
        lastStatus: success ? 'ok' : 'error',
        updatedAt: new Date().toISOString()
      });
    }

    // Add to doneSet for this session (output file is the persistent truth)
    doneSet.add(placeId);

    if (opts.restartBrowserEvery && processed % opts.restartBrowserEvery === 0 && runIndex < total) {
      await restartBrowser(`processed ${processed} items, periodic browser restart`);
    } else if (opts.restartEvery && processed % opts.restartEvery === 0 && runIndex < total) {
      await restartContext(`processed ${processed} items`);
    }
  }

  await browser.close();
  outStream.end();
  errStream.end();

  // Generate JSON output
  if (needsCollection && results.length > 0) {
    const jsonOutputPath = opts.output.replace(/\.ndjson$/i, '.json');
    const indent = opts.prettyOutput === false ? 0 : 2;

    if (opts.outputFormat === 'json' || opts.outputFormat === 'both') {
      fs.writeFileSync(jsonOutputPath, JSON.stringify(results, null, indent));
    } else if (opts.prettyOutput && opts.outputFormat === 'ndjson') {
      const prettyPath = opts.output.replace(/\.ndjson$/i, '.pretty.json');
      fs.writeFileSync(prettyPath, JSON.stringify(results, null, 2));
    }
  }

  // Final status
  const finalStatus = SHOULD_STOP ? 'stopped' : 'completed';
  ipcStatus(finalStatus);
  ipcLog('info', `Scraping ${finalStatus}. Success: ${successCount}, Failed: ${failedCount}`);
}

main().catch(err => {
  ipcStatus('failed', err.message);
  console.error(err.message);
  process.exit(1);
});
