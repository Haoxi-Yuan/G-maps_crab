#!/usr/bin/env node
'use strict';

/**
 * Multi-Boundary Orchestrator
 *
 * Takes ONE GeoJSON file holding MULTIPLE boundary Features (each Feature =
 * one independent area, Polygon or MultiPolygon) and runs the full pipeline
 * per area, sequentially:
 *
 *   split -> per-area stage 1 (boundary file + sampling points)
 *         -> per-area stage 2 (quadtree POI search, boundary pre-filter)
 *         -> per-area post-filter (drop out-of-boundary POIs)
 *
 * Each area gets its own directory pair, named like a normal city so every
 * existing tool (poi-search.sh, review-scrape.sh, status menu) sees it:
 *
 *   data/<batch>__<slug>/<batch>__<slug>_boundary.geojson|_points.json|...
 *   output/<batch>__<slug>/poi_search.json|places.ndjson|...
 *
 * Resume is two-level: areas with an _area_complete.json marker are skipped;
 * the in-progress area resumes via stage 2's own poi_search.json/places.ndjson
 * logic. Re-running the same command continues where it stopped.
 *
 * Usage:
 *   node src/multi-boundary-orchestrator.js --boundaries areas.geojson --name mybatch
 *   node src/multi-boundary-orchestrator.js --boundaries areas.geojson --name mybatch --dry-run
 *   node src/multi-boundary-orchestrator.js --help
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Mirror bin/gmaps-crab so `node src/multi-boundary-orchestrator.js` works
// without going through the launcher.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const local = path.join(ROOT, '.playwright-browsers');
  if (fs.existsSync(local)) process.env.PLAYWRIGHT_BROWSERS_PATH = local;
}

const { filterByBoundary } = require('./filter-by-boundary');
const PointsGenerator = require('./city-generator/points-generator');
const { getTurf } = require('./city-generator/turf-loader');

// Stage-2 defaults, same as poi-search.sh
const DEFAULTS = {
  categoriesFile: 'config/categories.json',
  cellSize: 1000,
  lloydIterations: 10,
  maxDepth: 8,
  minCellSizeKm: 0.06,
  subdivideThreshold: 18,
  requestDelayMs: 150,
  saveInterval: 20,
  maxBrowserRestarts: 20,
};

const COMPLETE_MARKER = '_area_complete.json';

// ============================================
// GeoJSON split
// ============================================

function sanitizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function featureAreaName(feature, index) {
  const props = feature.properties || {};
  const raw = props.name || props.NAME || props.Name || props.title || props.id;
  if (raw) {
    const slug = sanitizeName(raw);
    if (slug) return { name: String(raw), slug };
  }
  const fallback = `area_${String(index + 1).padStart(2, '0')}`;
  return { name: fallback, slug: fallback };
}

function isPolygonal(geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') return true;
  if (geom.type === 'GeometryCollection') {
    return (geom.geometries || []).some(isPolygonal);
  }
  return false;
}

/**
 * Split a multi-boundary GeoJSON into one area per Feature.
 * A Feature that is itself a MultiPolygon stays ONE area (an area may
 * legitimately be disjoint, e.g. a district with islands).
 */
function splitAreas(boundariesFile, batchName) {
  const data = JSON.parse(fs.readFileSync(boundariesFile, 'utf8'));
  let features;
  if (data.type === 'FeatureCollection') features = data.features || [];
  else if (data.type === 'Feature') features = [data];
  else features = [{ type: 'Feature', properties: {}, geometry: data }];

  const areas = [];
  const seenSlugs = new Set();
  let skippedNonPolygonal = 0;

  features.forEach((feature, i) => {
    if (!feature || !isPolygonal(feature.geometry)) {
      skippedNonPolygonal++;
      return;
    }
    let { name, slug } = featureAreaName(feature, i);
    if (seenSlugs.has(slug)) {
      let n = 2;
      while (seenSlugs.has(`${slug}_${n}`)) n++;
      slug = `${slug}_${n}`;
    }
    seenSlugs.add(slug);
    const dirSlug = `${sanitizeName(batchName)}__${slug}`;
    areas.push({ index: i, name, slug, dirSlug, feature });
  });

  if (skippedNonPolygonal > 0) {
    console.log(`[MULTI] Skipped ${skippedNonPolygonal} non-polygonal feature(s) in ${boundariesFile}`);
  }
  if (areas.length === 0) {
    throw new Error('No polygonal Features found in the boundaries file');
  }
  return areas;
}

// ============================================
// Per-area stage 1: boundary file + sampling points
// ============================================

async function prepareAreaStage1(area, opts) {
  const dataDir = path.join(ROOT, 'data', area.dirSlug);
  fs.mkdirSync(dataDir, { recursive: true });

  const boundaryPath = path.join(dataDir, `${area.dirSlug}_boundary.geojson`);
  const pointsPath = path.join(dataDir, `${area.dirSlug}_points.json`);

  // Optionally expand the raw boundary outward by opts.bufferMeters so the
  // per-area search + post-filter capture POIs just outside the park (entrances,
  // adjacent F&B, car parks). turf.buffer handles Polygon and MultiPolygon.
  let areaGeometry = area.feature.geometry;
  if (opts.bufferMeters && opts.bufferMeters > 0) {
    const turf = await getTurf();
    const buffered = turf.buffer(
      { type: 'Feature', properties: {}, geometry: area.feature.geometry },
      opts.bufferMeters / 1000,
      { units: 'kilometers' }
    );
    if (buffered && buffered.geometry) areaGeometry = buffered.geometry;
  }

  const boundaryGeojson = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        ...(area.feature.properties || {}),
        name: area.name,
        multi_boundary_batch: opts.batchName,
        multi_boundary_index: area.index,
        buffer_meters: opts.bufferMeters || 0,
      },
      geometry: areaGeometry,
    }],
  };
  fs.writeFileSync(boundaryPath, JSON.stringify(boundaryGeojson, null, 2));

  if (fs.existsSync(pointsPath) && !opts.fresh) {
    const existing = JSON.parse(fs.readFileSync(pointsPath, 'utf8'));
    console.log(`  stage 1: reusing ${existing.length} existing points (${path.relative(ROOT, pointsPath)})`);
    return { boundaryPath, pointsPath, numPoints: existing.length, reused: true };
  }

  const generator = new PointsGenerator(boundaryGeojson, {
    cellSize: opts.cellSize,
    minPoints: 10,
    lloydIterations: opts.lloydIterations,
  });
  await generator.init();
  const numPoints = opts.numPoints || generator.calculateNumPoints();
  const points = generator.generate(numPoints);

  fs.writeFileSync(pointsPath, JSON.stringify(points, null, 2));
  const csv = 'latitude,longitude\n' + points.map((p) => `${p.lat},${p.lng}`).join('\n');
  fs.writeFileSync(path.join(dataDir, `${area.dirSlug}_points.csv`), csv);

  const turf = await getTurf();
  const pointsFC = turf.featureCollection(points.map((p) => turf.point([p.lng, p.lat])));
  fs.writeFileSync(path.join(dataDir, `${area.dirSlug}_points.geojson`), JSON.stringify(pointsFC, null, 2));

  const areaM2 = turf.area(boundaryGeojson.features[0]);
  const summary = {
    city: area.dirSlug,
    area_name: area.name,
    batch: opts.batchName,
    timestamp: new Date().toISOString(),
    boundary: {
      area_km2: (areaM2 / 1e6).toFixed(2),
      bbox: turf.bbox(boundaryGeojson.features[0]),
    },
    points: {
      count: points.length,
      density_per_km2: (points.length / (areaM2 / 1e6)).toFixed(2),
    },
  };
  fs.writeFileSync(path.join(dataDir, `${area.dirSlug}_summary.json`), JSON.stringify(summary, null, 2));

  console.log(`  stage 1: ${points.length} points over ${summary.boundary.area_km2} km2`);
  return { boundaryPath, pointsPath, numPoints: points.length, reused: false };
}

// ============================================
// Per-area stage 2: POI search + post-filter
// ============================================

async function scrapeArea(area, stage1, categories, opts) {
  const outDir = path.join(ROOT, 'output', area.dirSlug);
  fs.mkdirSync(outDir, { recursive: true });

  const incrementalSaveFile = path.join(outDir, 'poi_search.json');
  const placesFile = path.join(outDir, 'places.ndjson');

  if (opts.fresh) {
    try { fs.unlinkSync(incrementalSaveFile); } catch (_) {}
    try { fs.unlinkSync(path.join(outDir, COMPLETE_MARKER)); } catch (_) {}
  }

  const api = require('./poi-searcher-api');
  const { chromium } = require('playwright');
  const points = api.loadPointsFromJSON(stage1.pointsPath);

  // Browser-relaunch retry loop, same rationale as poi-search.sh: chromium
  // occasionally dies during long scrapes; batchSearchPOIs resumes from
  // poi_search.json + places.ndjson after a relaunch.
  let browser = await chromium.launch({ headless: true, args: ['--disk-cache-size=1'] });
  let result = null;
  try {
    for (let attempt = 1; attempt <= opts.maxBrowserRestarts; attempt++) {
      try {
        result = await api.batchSearchPOIs(browser, points, categories, {
          maxDepth: opts.maxDepth,
          subdivideThreshold: opts.subdivideThreshold,
          requestDelayMs: opts.requestDelayMs,
          minCellSizeKm: opts.minCellSizeKm,
          saveInterval: opts.saveInterval,
          incrementalSaveFile,
          boundaryFile: stage1.boundaryPath,
          // Self-adapt mode: category-free discovery, sharing one yield-ranked
          // vocabulary file across all areas in the batch (discover-once).
          selfAdapt: opts.selfAdapt,
          saVocabFile: opts.saVocabFile,
          saMaxQueries: opts.saMaxQueries,
          saStopAfterDry: opts.saStopAfterDry,
          saMinYield: opts.saMinYield,
          saSeeds: opts.saSeeds,
        });
        break;
      } catch (e) {
        const msg = String(e && e.message || '');
        const isClosed = /Target page, context or browser has been closed|Browser has been closed|page has been closed|Execution context was destroyed/i.test(msg);
        try { await browser.close(); } catch (_) {}
        if (!isClosed || attempt >= opts.maxBrowserRestarts) throw e;
        console.warn(`  browser died, restarting (attempt ${attempt}/${opts.maxBrowserRestarts}): ${msg.substring(0, 120)}`);
        await new Promise((r) => setTimeout(r, 5000));
        browser = await chromium.launch({ headless: true, args: ['--disk-cache-size=1'] });
      }
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  let filterStats = null;
  if (fs.existsSync(placesFile)) {
    console.log(`  post-filter: dropping out-of-boundary places...`);
    filterStats = await filterByBoundary(placesFile, stage1.boundaryPath);
  }

  const marker = {
    area: area.slug,
    area_name: area.name,
    batch: opts.batchName,
    completedAt: new Date().toISOString(),
    totalPlaceIds: result ? result.totalPlaceIds : 0,
    filter: filterStats,
  };
  fs.writeFileSync(path.join(outDir, COMPLETE_MARKER), JSON.stringify(marker, null, 2));
  return marker;
}

// ============================================
// Main
// ============================================

async function main(opts) {
  const areas = splitAreas(opts.boundariesFile, opts.batchName);
  console.log(`[MULTI] ${areas.length} area(s) in ${opts.boundariesFile}:`);

  const selected = opts.areaFilter
    ? areas.filter((a) => opts.areaFilter.has(a.slug))
    : areas;
  if (opts.areaFilter) {
    const known = new Set(areas.map((a) => a.slug));
    for (const want of opts.areaFilter) {
      if (!known.has(want)) console.warn(`[MULTI] WARNING: --areas slug not found: ${want}`);
    }
  }

  for (const a of areas) {
    const mark = selected.includes(a) ? '*' : ' ';
    console.log(`  ${mark} [${a.index + 1}] ${a.slug}  (${a.name})  -> data|output/${a.dirSlug}/`);
  }

  if (opts.dryRun) {
    console.log('\n[MULTI] Dry run: preparing stage 1 for selected areas, no scraping.');
    for (const area of selected) {
      console.log(`\n[MULTI] --- ${area.slug} ---`);
      await prepareAreaStage1(area, opts);
    }
    console.log('\n[MULTI] Dry run complete. Re-run without --dry-run to scrape.');
    return;
  }

  const api = require('./poi-searcher-api');
  let categories = [];
  if (opts.selfAdapt) {
    // Category-free: batchSearchPOIs drives its own query set from Google's
    // labels. Vocabulary is shared across the batch (one file) for discover-once.
    if (!opts.saVocabFile) opts.saVocabFile = path.join(ROOT, 'output', `_selfadapt_vocab__${opts.batchName}.json`);
    console.log(`[MULTI] Self-adapt mode: seeds -> Google-label closure, shared vocab ${opts.saVocabFile}, budget ${opts.saMaxQueries}/area`);
  } else {
    categories = api.loadCategories(path.resolve(ROOT, opts.categoriesFile));
    if (opts.categoryFilter) {
      const wanted = new Set(opts.categoryFilter.map((s) => s.toLowerCase()));
      categories = categories.filter((c) => wanted.has(c.toLowerCase()));
      console.log(`[MULTI] Filtered to ${categories.length} categories: ${categories.join(', ')}`);
    }
    if (categories.length === 0) throw new Error('No categories to search');
  }

  const summary = [];
  let n = 0;
  for (const area of selected) {
    n++;
    const label = `[MULTI] [${n}/${selected.length}] ${area.slug}`;
    const markerPath = path.join(ROOT, 'output', area.dirSlug, COMPLETE_MARKER);

    if (fs.existsSync(markerPath) && !opts.fresh) {
      const prev = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      console.log(`\n${label}: already complete (${prev.completedAt}, ${prev.totalPlaceIds} POIs) — skipping`);
      summary.push({ area: area.slug, status: 'skipped', pois: prev.totalPlaceIds });
      continue;
    }

    console.log(`\n${label}: starting`);
    try {
      const stage1 = await prepareAreaStage1(area, opts);
      const marker = await scrapeArea(area, stage1, categories, opts);
      const kept = marker.filter ? marker.filter.kept : marker.totalPlaceIds;
      console.log(`${label}: done — ${kept} POIs kept`);
      summary.push({ area: area.slug, status: 'done', pois: kept });
    } catch (e) {
      // One area failing must not block the rest; it retries on the next run.
      console.error(`${label}: FAILED — ${e && e.message || e}`);
      summary.push({ area: area.slug, status: 'failed', error: String(e && e.message || e) });
    }
  }

  console.log('\n[MULTI] ============ Batch summary ============');
  for (const s of summary) {
    const extra = s.status === 'failed' ? `  (${s.error})` : `  ${s.pois} POIs`;
    console.log(`  ${s.status.padEnd(8)} ${s.area}${extra}`);
  }
  const failed = summary.filter((s) => s.status === 'failed');
  if (failed.length > 0) {
    console.log(`\n[MULTI] ${failed.length} area(s) failed — re-run the same command to retry them.`);
    process.exitCode = 1;
  } else {
    console.log('\n[MULTI] All areas complete. Next: ./review-scrape.sh — each area appears as its own city.');
  }
}

// ============================================
// CLI
// ============================================

function parseArgs(argv) {
  const opts = {
    boundariesFile: null,
    batchName: null,
    categoriesFile: DEFAULTS.categoriesFile,
    categoryFilter: null,
    areaFilter: null,
    cellSize: DEFAULTS.cellSize,
    numPoints: null,
    lloydIterations: DEFAULTS.lloydIterations,
    maxDepth: DEFAULTS.maxDepth,
    minCellSizeKm: DEFAULTS.minCellSizeKm,
    subdivideThreshold: DEFAULTS.subdivideThreshold,
    requestDelayMs: DEFAULTS.requestDelayMs,
    saveInterval: DEFAULTS.saveInterval,
    maxBrowserRestarts: DEFAULTS.maxBrowserRestarts,
    bufferMeters: 0,
    dryRun: false,
    fresh: false,
    selfAdapt: false,
    saVocabFile: null,
    saMaxQueries: 300,
    saStopAfterDry: 0,
    saMinYield: 1,
    saSeeds: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--boundaries': opts.boundariesFile = argv[++i]; break;
      case '--name': opts.batchName = argv[++i]; break;
      case '--categories': opts.categoriesFile = argv[++i]; break;
      case '--category-filter': opts.categoryFilter = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--areas': opts.areaFilter = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--cell-size': opts.cellSize = parseInt(argv[++i], 10); break;
      case '--points': opts.numPoints = parseInt(argv[++i], 10); break;
      case '--iterations': opts.lloydIterations = parseInt(argv[++i], 10); break;
      case '--max-depth': opts.maxDepth = parseInt(argv[++i], 10); break;
      case '--min-cell': opts.minCellSizeKm = parseFloat(argv[++i]); break;
      case '--threshold': opts.subdivideThreshold = parseInt(argv[++i], 10); break;
      case '--delay': opts.requestDelayMs = parseInt(argv[++i], 10); break;
      case '--save-interval': opts.saveInterval = parseInt(argv[++i], 10); break;
      case '--buffer': opts.bufferMeters = parseFloat(argv[++i]); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--fresh': opts.fresh = true; break;
      case '--self-adapt': opts.selfAdapt = true; break;
      case '--sa-vocab': opts.saVocabFile = argv[++i]; break;
      case '--sa-max-queries': opts.saMaxQueries = parseInt(argv[++i], 10); break;
      case '--sa-stop-after-dry': opts.saStopAfterDry = parseInt(argv[++i], 10); break;
      case '--sa-min-yield': opts.saMinYield = parseInt(argv[++i], 10); break;
      case '--sa-seeds': opts.saSeeds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--help':
        console.log(`
Multi-Boundary Orchestrator — scrape several disjoint boundaries in one run

Usage:
  node src/multi-boundary-orchestrator.js --boundaries <multi.geojson> --name <batch> [options]

Each Feature in the GeoJSON becomes one independent area, scraped sequentially
with its own sampling points, quadtree search, boundary filter, and output
directory (output/<batch>__<slug>/). Interrupted runs resume: completed areas
are skipped via their _area_complete.json marker, the current area resumes
from its own poi_search.json.

Options:
  --boundaries <file>      GeoJSON with multiple Polygon/MultiPolygon Features (required)
  --name <batch>           Batch name, prefixes every area directory (required)
  --categories <file>      Category taxonomy (default: config/categories.json)
  --category-filter a,b    Only search these categories
  --self-adapt             Category-free: discover types from Google's own labels
                           (generic seeds -> closure), no hand-curated taxonomy.
                           One yield-ranked vocab shared across the batch.
  --sa-max-queries N       Query budget per area in self-adapt mode (default 300)
  --sa-stop-after-dry K    Stop an area after K consecutive <min-yield queries (0=off)
  --sa-min-yield N         "Dry" query = fewer than N new POIs (default 1)
  --sa-seeds a,b,c         Override the generic bootstrap seeds
  --sa-vocab <file>        Shared vocab file (default output/_selfadapt_vocab__<batch>.json)
  --areas slug1,slug2      Only run these areas (slugs from feature names)
  --buffer <meters>        Expand each boundary outward by N m before search+filter (default 0)
  --cell-size <m>          Sampling density for stage 1 (default: 1000)
  --points <n>             Fixed number of sampling points per area (default: auto)
  --iterations <n>         Lloyd relaxation iterations (default: 10)
  --max-depth <n>          Quadtree max depth (default: 8)
  --min-cell <km>          Quadtree min cell size (default: 0.06)
  --threshold <n>          Subdivide threshold (default: 18)
  --delay <ms>             Request delay (default: 150)
  --save-interval <n>      Save progress every N requests (default: 20)
  --dry-run                Split + generate points only, no scraping
  --fresh                  Re-run areas even if marked complete
  --help                   Show this message
`);
        process.exit(0);
    }
  }
  if (!opts.boundariesFile || !opts.batchName) {
    console.error('ERROR: --boundaries and --name are required (see --help)');
    process.exit(1);
  }
  if (!fs.existsSync(opts.boundariesFile)) {
    console.error(`ERROR: boundaries file not found: ${opts.boundariesFile}`);
    process.exit(1);
  }
  if (!sanitizeName(opts.batchName)) {
    console.error('ERROR: --name must contain at least one alphanumeric character');
    process.exit(1);
  }
  return opts;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  main(opts).catch((err) => {
    console.error('Fatal:', err && err.stack || err);
    process.exit(1);
  });
}

module.exports = { splitAreas, prepareAreaStage1, sanitizeName };
