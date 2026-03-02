const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'monitor-config.json');

const DEFAULTS = {
  concurrency: {
    browsers: 3,
    tabsPerBrowser: 5
  },
  thresholds: {
    ratingTolerance: 0.05,
    consecutiveFailuresForGone: 3,
    poiTimeoutMs: 10000,
    navigationTimeoutMs: 30000
  },
  scan: {
    batchSize: 100,
    checkpointInterval: 50,
    delayBetweenBatchesMs: 1000
  },
  resources: {
    blockImages: true,
    blockFonts: true,
    blockMapTiles: true
  },
  paths: {
    database: 'db/monitor.sqlite',
    output: 'output/',
    reports: 'output/reports/',
    snapshots: 'output/snapshots/',
    logs: 'logs/',
    checkpoint: 'output/scan.checkpoint.json'
  },
  browser: {
    headless: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function resolvePaths(config) {
  const resolved = { ...config };
  resolved.paths = {};
  for (const [key, val] of Object.entries(config.paths)) {
    resolved.paths[key] = path.resolve(PROJECT_ROOT, val);
  }
  return resolved;
}

function loadConfig() {
  let userConfig = {};
  if (fs.existsSync(CONFIG_PATH)) {
    userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  const merged = deepMerge(DEFAULTS, userConfig);
  const resolved = resolvePaths(merged);
  return Object.freeze(resolved);
}

module.exports = { loadConfig, PROJECT_ROOT };
