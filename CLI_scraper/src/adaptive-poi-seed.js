#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  chooseRootZoom,
  coveringTiles,
  makeTaskKey,
} = require('./scheduler/tile-id');
const {
  createPool,
  PostgresScheduler,
  runMigrations,
} = require('./scheduler/postgres-store');

function sanitize(value) {
  return String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'boundary';
}

function geometryHash(geometry) {
  return crypto.createHash('sha256').update(JSON.stringify(geometry)).digest('hex').slice(0, 12);
}

function polygonFeatures(data) {
  let features;
  if (data.type === 'FeatureCollection') features = data.features || [];
  else if (data.type === 'Feature') features = [data];
  else features = [{ type: 'Feature', properties: {}, geometry: data }];
  return features.filter((feature) => feature && feature.geometry
    && ['Polygon', 'MultiPolygon'].includes(feature.geometry.type));
}

function loadQueries(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let queries;
  if (Array.isArray(data)) queries = data;
  else if (Array.isArray(data.categories)) queries = data.categories;
  else if (data.tier1_broad) {
    queries = [
      ...Object.keys(data.tier1_broad),
      ...Object.values(data.tier2_specific || {}).flat(),
    ];
  } else throw new Error(`no categories found in ${file}`);
  return [...new Set(queries.map((query) => String(query).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

function makeCategoryGroups(queries, size, maxPages) {
  const groups = [];
  for (let offset = 0; offset < queries.length; offset += size) {
    const items = queries.slice(offset, offset + size);
    const hash = crypto.createHash('sha256').update(items.join('\0')).digest('hex').slice(0, 10);
    groups.push({
      categoryGroup: `cg_${String(groups.length + 1).padStart(4, '0')}_${hash}`,
      queries: items,
      estimatedRequests: Math.max(1, items.length * maxPages),
    });
  }
  return groups;
}

function boundaryIdFor(feature, index, seen) {
  const props = feature.properties || {};
  const explicit = feature.id ?? props.boundary_id ?? props.boundaryId ?? props.id;
  const name = props.name || props.NAME || props.Name || props.title || explicit || `boundary_${index + 1}`;
  const base = sanitize(explicit || name);
  const hash = geometryHash(feature.geometry);
  let id = explicit ? base : `${base}_${hash}`;
  if (seen.has(id)) id = `${id}_${hash}`;
  seen.add(id);
  return { boundaryId: id, name: String(name) };
}

function tilePolygon(turf, tile) {
  const box = tile.bbox;
  return turf.bboxPolygon([box.minLng, box.minLat, box.maxLng, box.maxLat]);
}

function parseArgs(argv) {
  const opts = {
    workflowId: null,
    boundariesFile: null,
    categoriesFile: 'config/categories.json',
    categoryGroupSize: 1,
    expectedWorkers: 96,
    targetTasksPerWorker: 4,
    rootZoom: null,
    minRootZoom: 0,
    maxRootZoom: 16,
    maxRootTilesPerBoundary: 1024,
    maxPages: 7,
    maxAttempts: 4,
    poiRps: 4,
    poiBurst: 8,
    dryRun: false,
    migrate: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workflow') opts.workflowId = argv[++i];
    else if (arg === '--boundaries') opts.boundariesFile = argv[++i];
    else if (arg === '--categories') opts.categoriesFile = argv[++i];
    else if (arg === '--category-group-size') opts.categoryGroupSize = Number(argv[++i]);
    else if (arg === '--workers') opts.expectedWorkers = Number(argv[++i]);
    else if (arg === '--target-tasks-per-worker') opts.targetTasksPerWorker = Number(argv[++i]);
    else if (arg === '--root-zoom') opts.rootZoom = Number(argv[++i]);
    else if (arg === '--min-root-zoom') opts.minRootZoom = Number(argv[++i]);
    else if (arg === '--max-root-zoom') opts.maxRootZoom = Number(argv[++i]);
    else if (arg === '--max-root-tiles') opts.maxRootTilesPerBoundary = Number(argv[++i]);
    else if (arg === '--max-pages') opts.maxPages = Number(argv[++i]);
    else if (arg === '--max-attempts') opts.maxAttempts = Number(argv[++i]);
    else if (arg === '--poi-rps') opts.poiRps = Number(argv[++i]);
    else if (arg === '--poi-burst') opts.poiBurst = Number(argv[++i]);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--no-migrate') opts.migrate = false;
    else if (arg === '--help') {
      console.log(`
PostgreSQL adaptive POI task seeder

Usage:
  DATABASE_URL=postgres://... node src/adaptive-poi-seed.js \\
    --workflow <id> --boundaries <file.geojson> [options]

Options:
  --categories <file>             Category file (default config/categories.json)
  --category-group-size <n>       Queries per atomic task (default 1)
  --workers <n>                   Expected concurrent workers (default 96)
  --target-tasks-per-worker <n>   Initial queue depth target (default 4)
  --root-zoom <n>                 Fixed root Web Mercator zoom; auto by default
  --min-root-zoom <n>             Auto zoom lower bound (default 0)
  --max-root-zoom <n>             Auto zoom upper bound (default 16)
  --max-root-tiles <n>            Per-boundary root tile safety cap (default 1024)
  --max-pages <n>                 Pagination cap used for cost estimates (default 7)
  --max-attempts <n>              Tile claims before QUARANTINED (default 4)
  --poi-rps <n>                   Global POI token refill rate (default 4/s)
  --poi-burst <n>                 Global POI burst capacity (default 8)
  --dry-run                       Build and print plan without database writes
  --no-migrate                    Do not apply scripts/sql/001_adaptive_scheduler.sql
`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.workflowId || !opts.boundariesFile) throw new Error('--workflow and --boundaries are required');
  for (const [name, value] of Object.entries({
    categoryGroupSize: opts.categoryGroupSize,
    expectedWorkers: opts.expectedWorkers,
    targetTasksPerWorker: opts.targetTasksPerWorker,
    maxPages: opts.maxPages,
    maxAttempts: opts.maxAttempts,
  })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  return opts;
}

async function buildSeedPlan(opts) {
  const turf = require('@turf/turf');
  const source = JSON.parse(fs.readFileSync(opts.boundariesFile, 'utf8'));
  const features = polygonFeatures(source);
  if (!features.length) throw new Error('no Polygon/MultiPolygon features found');
  const queries = loadQueries(opts.categoriesFile);
  const categoryGroups = makeCategoryGroups(queries, opts.categoryGroupSize, opts.maxPages);
  const desiredInitialTasks = opts.expectedWorkers * opts.targetTasksPerWorker;
  const rootsPerBoundaryTarget = Math.max(
    1,
    Math.ceil(desiredInitialTasks / (features.length * categoryGroups.length)),
  );

  const boundaries = [];
  const tasks = [];
  const seenBoundaryIds = new Set();
  for (let index = 0; index < features.length; index++) {
    const feature = features[index];
    const identity = boundaryIdFor(feature, index, seenBoundaryIds);
    const areaKm2 = Math.max(0.000001, turf.area(feature) / 1e6);
    const center = turf.centroid(feature).geometry.coordinates;
    let rootZoom = opts.rootZoom == null
      ? chooseRootZoom({
        areaKm2,
        centroidLat: center[1],
        targetTasks: rootsPerBoundaryTarget,
        minZoom: opts.minRootZoom,
        maxZoom: opts.maxRootZoom,
      })
      : opts.rootZoom;

    const intersects = (tile) => {
      try { return turf.booleanIntersects(feature, tilePolygon(turf, tile)); }
      catch (_) { return true; } // false positives cost requests; false negatives lose coverage
    };
    let roots = coveringTiles(feature, rootZoom, intersects);
    // The area-based zoom is only an estimate. A tiny polygon crossing a tile
    // seam can otherwise turn one desired root into two or four tasks for every
    // category. Walk up to the closest common ancestors until the actual cover
    // fits the per-boundary queue target; runtime cap hits split back down.
    const rootTileTarget = Math.max(1, Math.min(
      opts.maxRootTilesPerBoundary,
      rootsPerBoundaryTarget,
    ));
    while (roots.length > rootTileTarget && rootZoom > opts.minRootZoom) {
      rootZoom--;
      roots = coveringTiles(feature, rootZoom, intersects);
    }
    if (roots.length === 0) throw new Error(`no root tiles intersect ${identity.boundaryId}`);

    boundaries.push({
      ...identity,
      geometry: feature,
      rootZoom,
      weight: 1,
      metadata: {
        sourceFile: path.resolve(opts.boundariesFile),
        sourceFeatureIndex: index,
        geometrySha256: geometryHash(feature.geometry),
        areaKm2,
        rootTiles: roots.length,
        rootTileTarget,
      },
    });
    for (const group of categoryGroups) {
      for (const tile of roots) {
        tasks.push({
          boundaryId: identity.boundaryId,
          categoryGroup: group.categoryGroup,
          tileId: tile.tileId,
          taskKey: makeTaskKey(identity.boundaryId, group.categoryGroup, tile.tileId),
          x: tile.x,
          y: tile.y,
          zoom: tile.zoom,
          bbox: tile.bbox,
          estimatedRequests: group.estimatedRequests,
          maxAttempts: opts.maxAttempts,
        });
      }
    }
  }

  return { boundaries, categoryGroups, tasks, queries };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = await buildSeedPlan(opts);
  const summary = {
    workflowId: opts.workflowId,
    boundaries: plan.boundaries.length,
    categoryGroups: plan.categoryGroups.length,
    queries: plan.queries.length,
    rootTasks: plan.tasks.length,
    expectedWorkers: opts.expectedWorkers,
    generatedBy: `${os.hostname()}:${process.pid}`,
  };
  console.log(JSON.stringify(summary, null, 2));
  for (const boundary of plan.boundaries) {
    console.log(`${boundary.boundaryId}: area=${boundary.metadata.areaKm2.toFixed(3)}km2 zoom=${boundary.rootZoom} roots=${boundary.metadata.rootTiles}`);
  }
  if (opts.dryRun) return;

  const pool = createPool(process.env.DATABASE_URL, { applicationName: `gmaps-seed:${opts.workflowId}` });
  try {
    if (opts.migrate) await runMigrations(pool);
    const scheduler = new PostgresScheduler(pool);
    const result = await scheduler.seedWorkflow({
      workflowId: opts.workflowId,
      config: {
        schedulerVersion: 1,
        identity: ['boundary_id', 'category_group', 'tile_id'],
        tileScheme: 'web-mercator-quadkey',
        maxPages: opts.maxPages,
        maxAttempts: opts.maxAttempts,
        sourceFile: path.resolve(opts.boundariesFile),
      },
      boundaries: plan.boundaries,
      categoryGroups: plan.categoryGroups,
      tasks: plan.tasks,
      budgets: [
        { endpoint: 'poi_search', capacity: opts.poiBurst, refillPerSecond: opts.poiRps },
        { endpoint: 'reviews', capacity: 2, refillPerSecond: 1 },
        { endpoint: 'images', capacity: 4, refillPerSecond: 2 },
      ],
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = {
  sanitize,
  geometryHash,
  polygonFeatures,
  loadQueries,
  makeCategoryGroups,
  boundaryIdFor,
  buildSeedPlan,
};
