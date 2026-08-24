#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const api = require('../poi-searcher-api');

const root = path.resolve(__dirname, '../..');

function usage() {
  console.log(`
Cross-platform POI runner

Usage:
  node src/cli/run-poi.js --city <name> [options]
  node src/cli/run-poi.js --points <file> --output <file> [options]

Options:
  --city <name>             City name or data/<slug> directory name
  --points <file>           Existing JSON sampling-points file
  --output <file>           Checkpoint file (default: output/<slug>/poi_search.json)
  --boundary <file>         Boundary GeoJSON (auto-detected from the city directory)
  --categories <a,b>        Restrict the configured category list
  --cell-size <m>           Sampling cell size when city data must be generated
  --max-depth <n>           Quadtree maximum depth (default: 8)
  --min-cell <km>           Minimum cell size (default: 0.06)
  --threshold <n>           Subdivision threshold (default: 18)
  --delay <ms>              Delay between requests (default: 150)
  --save-interval <n>       Save every N requests (default: 20)
  --self-adapt              Discover categories from returned POIs
  --sa-max-queries <n>      Self-adapt query budget (default: 300)
  --sa-stop-after-dry <n>   Self-adapt convergence threshold (default: 0)
  --fresh                   Ignore the existing checkpoint
  --skip-filter             Do not run the final boundary filter
  --help                    Show this help
`);
}

function parseArgs(argv) {
  const options = {
    cellSize: 1000,
    maxDepth: 8,
    minCell: 0.06,
    threshold: 18,
    delay: 150,
    saveInterval: 20,
    selfAdapt: false,
    saMaxQueries: 300,
    saStopAfterDry: 0,
    fresh: false,
    skipFilter: false,
  };
  const values = new Set([
    '--city', '--points', '--output', '--boundary', '--categories', '--cell-size',
    '--max-depth', '--min-cell', '--threshold', '--delay', '--save-interval',
    '--sa-max-queries', '--sa-stop-after-dry',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (key === '--self-adapt') { options.selfAdapt = true; continue; }
    if (key === '--fresh') { options.fresh = true; continue; }
    if (key === '--skip-filter') { options.skipFilter = true; continue; }
    if (!values.has(key)) throw new Error(`unknown option: ${key}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value`);
    const value = argv[++index];
    const property = {
      '--city': 'city', '--points': 'points', '--output': 'output', '--boundary': 'boundary',
      '--categories': 'categories', '--cell-size': 'cellSize', '--max-depth': 'maxDepth',
      '--min-cell': 'minCell', '--threshold': 'threshold', '--delay': 'delay',
      '--save-interval': 'saveInterval', '--sa-max-queries': 'saMaxQueries',
      '--sa-stop-after-dry': 'saStopAfterDry',
    }[key];
    options[property] = value;
  }

  for (const key of ['cellSize', 'maxDepth', 'minCell', 'threshold', 'delay', 'saveInterval', 'saMaxQueries', 'saStopAfterDry']) {
    options[key] = Number(options[key]);
    if (!Number.isFinite(options[key])) throw new Error(`invalid numeric value for ${key}`);
  }
  return options;
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function findFirst(directory, suffix) {
  if (!fs.existsSync(directory)) return null;
  const name = fs.readdirSync(directory).sort().find((entry) => entry.endsWith(suffix));
  return name ? path.join(directory, name) : null;
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${path.basename(script)} exited with status ${result.status}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.city && !options.points) throw new Error('--city or --points is required');

  const citySlug = slugify(options.city || path.basename(path.dirname(options.points)) || 'custom');
  if (!citySlug) throw new Error('the city name does not produce a usable directory slug; pass --points and --output explicitly');
  const cityDirectory = path.join(root, 'data', citySlug);
  fs.mkdirSync(cityDirectory, { recursive: true });

  let pointsFile = options.points ? path.resolve(root, options.points) : findFirst(cityDirectory, '_points.json');
  if (!pointsFile && options.city) {
    runNode(path.join(root, 'src/city-generator/index.js'), [
      '--city', options.city,
      '--output', cityDirectory,
      '--cell-size', String(options.cellSize),
    ]);
    pointsFile = findFirst(cityDirectory, '_points.json');
  }
  if (!pointsFile || !fs.existsSync(pointsFile)) throw new Error('sampling-points file was not found or generated');

  const outputFile = options.output
    ? path.resolve(root, options.output)
    : path.join(root, 'output', citySlug, 'poi_search.json');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  if (options.fresh && fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

  const boundaryFile = options.boundary
    ? path.resolve(root, options.boundary)
    : findFirst(cityDirectory, '_boundary.geojson');
  const points = api.loadPointsFromJSON(pointsFile);
  let categories = api.loadCategories(path.join(root, 'config/categories.json'));
  if (options.categories) {
    const selected = new Set(options.categories.split(',').map((item) => item.trim().toLowerCase()));
    categories = categories.filter((category) => selected.has(category.toLowerCase()));
  }

  console.log(`[POI] city=${options.city || citySlug} points=${points.length} categories=${categories.length}`);
  let browser = await chromium.launch({ headless: true, args: ['--disk-cache-size=1'] });
  let result;
  const maxRestarts = 20;
  try {
    for (let attempt = 1; attempt <= maxRestarts; attempt += 1) {
      try {
        result = await api.batchSearchPOIs(browser, points, categories, {
          maxDepth: options.maxDepth,
          subdivideThreshold: options.threshold,
          requestDelayMs: options.delay,
          minCellSizeKm: options.minCell,
          saveInterval: options.saveInterval,
          incrementalSaveFile: outputFile,
          liveStatusFile: outputFile.replace(/\.json$/i, '.live.json'),
          boundaryFile,
          selfAdapt: options.selfAdapt,
          saMaxQueries: options.saMaxQueries,
          saStopAfterDry: options.saStopAfterDry,
          saVocabFile: options.selfAdapt ? path.join(path.dirname(outputFile), '_selfadapt_vocab.json') : null,
        });
        break;
      } catch (error) {
        const message = String(error && error.message || '');
        const closed = /Target page, context or browser has been closed|Browser has been closed|page has been closed|Execution context was destroyed/i.test(message);
        try { await browser.close(); } catch (_) { /* already closed */ }
        if (!closed || attempt >= maxRestarts) throw error;
        console.warn(`[POI] browser restart ${attempt}/${maxRestarts}: ${message.slice(0, 160)}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        browser = await chromium.launch({ headless: true, args: ['--disk-cache-size=1'] });
      }
    }
  } finally {
    try { await browser.close(); } catch (_) { /* already closed */ }
  }

  if (!result) throw new Error('POI search ended without a result');
  console.log(`[POI] complete: ${result.totalPlaceIds} unique POIs`);

  const placesFile = path.join(path.dirname(outputFile), 'places.ndjson');
  if (!options.skipFilter && boundaryFile && fs.existsSync(placesFile)) {
    runNode(path.join(root, 'src/filter-by-boundary.js'), ['--input', placesFile, '--boundary', boundaryFile]);
  }
}

main().catch((error) => {
  console.error(`[POI] ERROR: ${error.message}`);
  process.exitCode = 1;
});
