#!/usr/bin/env node
'use strict';

const os = require('os');

const { chromium } = require('playwright');
const stealth = require('./stealth');
const { buildContainsCheck } = require('./filter-by-boundary');
const {
  capturePbTemplate,
  fetchPage,
  calculateAltitude,
  cellSizeToZoom,
  formatPlaceRecord,
  CONFIG,
} = require('./poi-searcher-api');
const {
  childTiles,
  makeTaskKey,
} = require('./scheduler/tile-id');
const { classifyTileOutcome } = require('./scheduler/outcome');
const { createPool, PostgresScheduler } = require('./scheduler/postgres-store');

const PAGE_SIZE = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function haversine(lat1, lng1, lat2, lng2) {
  const radius = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bboxSizeKm(bbox) {
  const northSouth = haversine(bbox.minLat, bbox.centerLng, bbox.maxLat, bbox.centerLng);
  const eastWest = haversine(bbox.centerLat, bbox.minLng, bbox.centerLat, bbox.maxLng);
  return Math.max(northSouth, eastWest) / 1000;
}

function parseArgs(argv) {
  const opts = {
    workflowId: null,
    workerId: `${os.hostname()}:${process.pid}`,
    maxPages: 7,
    maxPageRetries: 2,
    retryDelayMs: 5000,
    requestTimeoutMs: 45000,
    leaseSeconds: 300,
    heartbeatSeconds: 60,
    probeFreshSeconds: 300,
    probeQuery: 'restaurant',
    probeLat: 1.2834,
    probeLng: 103.8607,
    maxTileZoom: 20,
    idlePollMs: 5000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workflow') opts.workflowId = argv[++i];
    else if (arg === '--worker-id') opts.workerId = argv[++i];
    else if (arg === '--max-pages') opts.maxPages = Number(argv[++i]);
    else if (arg === '--max-page-retries') opts.maxPageRetries = Number(argv[++i]);
    else if (arg === '--retry-delay-ms') opts.retryDelayMs = Number(argv[++i]);
    else if (arg === '--request-timeout-ms') opts.requestTimeoutMs = Number(argv[++i]);
    else if (arg === '--lease-seconds') opts.leaseSeconds = Number(argv[++i]);
    else if (arg === '--heartbeat-seconds') opts.heartbeatSeconds = Number(argv[++i]);
    else if (arg === '--probe-fresh-seconds') opts.probeFreshSeconds = Number(argv[++i]);
    else if (arg === '--probe-query') opts.probeQuery = argv[++i];
    else if (arg === '--probe-lat') opts.probeLat = Number(argv[++i]);
    else if (arg === '--probe-lng') opts.probeLng = Number(argv[++i]);
    else if (arg === '--max-tile-zoom') opts.maxTileZoom = Number(argv[++i]);
    else if (arg === '--idle-poll-ms') opts.idlePollMs = Number(argv[++i]);
    else if (arg === '--help') {
      console.log(`
PostgreSQL adaptive POI worker

Usage:
  DATABASE_URL=postgres://... node src/adaptive-poi-worker.js --workflow <id> [options]

Important defaults:
  3 attempts per HTTP page (--max-page-retries 2), 45s fetch timeout,
  5m task lease, 5m known-nonempty probe freshness, Web Mercator zoom 20 floor.
`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.workflowId) throw new Error('--workflow is required');
  return opts;
}

async function createBrowserSession(opts) {
  const browser = await chromium.launch({
    headless: true,
    args: [...stealth.buildLaunchArgs(), '--disk-cache-size=1'],
  });
  try {
    const { context, page } = await stealth.createStealthContext(browser, { blockImages: true });
    const pbTemplate = await capturePbTemplate(page, opts.probeQuery, opts.probeLat, opts.probeLng);
    return { browser, context, page, pbTemplate };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeSession(session) {
  if (!session) return;
  try { await session.page.close(); } catch (_) {}
  try { await session.context.close(); } catch (_) {}
  try { await session.browser.close(); } catch (_) {}
}

async function fetchWithBudget({ scheduler, workflowId, page, args }) {
  await scheduler.waitForBudget(workflowId, 'poi_search');
  const result = await fetchPage(page, ...args);
  await scheduler.recordRequestOutcome(workflowId, 'poi_search', {
    success: !result.error,
    structureComplete: result.structureComplete === true,
    placeCount: result.places ? result.places.length : 0,
  });
  return result;
}

async function ensureHealthyProbe(scheduler, session, opts) {
  if (await scheduler.isProbeFresh(opts.workflowId, opts.workerId, 'poi_search', opts.probeFreshSeconds)) return true;
  const altitude = calculateAltitude(16, opts.probeLat);
  let result;
  try {
    result = await fetchWithBudget({
      scheduler,
      workflowId: opts.workflowId,
      page: session.page,
      args: [
        opts.probeQuery, opts.probeLat, opts.probeLng, altitude, session.pbTemplate, 0,
        { requestTimeoutMs: opts.requestTimeoutMs },
      ],
    });
  } catch (error) {
    await scheduler.recordProbe(opts.workflowId, opts.workerId, 'poi_search', false, String(error.message || error));
    return false;
  }
  const ok = !result.error && result.structureComplete === true && result.places.length > 0;
  await scheduler.recordProbe(
    opts.workflowId,
    opts.workerId,
    'poi_search',
    ok,
    ok ? null : String(result.error || 'known_nonempty_probe_returned_zero'),
  );
  return ok;
}

async function fetchQuery(task, query, scheduler, session, opts) {
  const bbox = task.bbox;
  const sizeKm = bboxSizeKm(bbox);
  const zoom = cellSizeToZoom(sizeKm);
  const altitude = calculateAltitude(zoom, bbox.centerLat);
  const seen = new Set();
  const places = [];
  let requests = 0;
  let responseStructureComplete = true;
  let capHit = false;

  for (let pageNumber = 0; pageNumber < opts.maxPages; pageNumber++) {
    const offset = pageNumber * PAGE_SIZE;
    let result = null;
    for (let attempt = 0; attempt <= opts.maxPageRetries; attempt++) {
      requests++;
      result = await fetchWithBudget({
        scheduler,
        workflowId: opts.workflowId,
        page: session.page,
        args: [
          query, bbox.centerLat, bbox.centerLng, altitude, session.pbTemplate, offset,
          { requestTimeoutMs: opts.requestTimeoutMs },
        ],
      });
      if (!result.error) break;
      responseStructureComplete = false;
      if (attempt < opts.maxPageRetries) await sleep(opts.retryDelayMs);
    }
    if (result.error) {
      return {
        paginationComplete: false,
        error: result.error,
        requests,
        responseStructureComplete: false,
        capHit: false,
        places,
      };
    }

    responseStructureComplete = responseStructureComplete && result.structureComplete === true;
    if (result.places.length === 0) break;
    let fresh = 0;
    for (const place of result.places) {
      if (!place.ftid || seen.has(place.ftid)) continue;
      seen.add(place.ftid);
      places.push(place);
      fresh++;
    }
    const full = result.places.length >= PAGE_SIZE;
    capHit = pageNumber === opts.maxPages - 1 && full;
    if (!full || fresh === 0) break;
  }

  return {
    paginationComplete: true,
    error: null,
    requests,
    responseStructureComplete,
    capHit,
    places,
  };
}

function tileFeature(turf, tile) {
  return turf.bboxPolygon([
    tile.bbox.minLng,
    tile.bbox.minLat,
    tile.bbox.maxLng,
    tile.bbox.maxLat,
  ]);
}

function buildChildren(task, opts) {
  const turf = require('@turf/turf');
  return childTiles({ x: task.tile_x, y: task.tile_y, zoom: task.tile_zoom })
    .filter((tile) => {
      try { return turf.booleanIntersects(task.boundary_geometry, tileFeature(turf, tile)); }
      catch (_) { return true; }
    })
    .map((tile) => ({
      ...tile,
      taskKey: makeTaskKey(task.boundary_id, task.category_group, tile.tileId),
      estimatedRequests: task.estimated_requests,
      maxAttempts: task.max_attempts,
      priority: task.priority,
    }));
}

async function processTask(task, scheduler, session, opts) {
  const contains = buildContainsCheck(task.boundary_geometry);
  const observations = [];
  let requests = 0;
  let paginationComplete = true;
  let responseStructureComplete = true;
  let capHit = false;
  let error = null;

  for (const query of task.queries) {
    const result = await fetchQuery(task, query, scheduler, session, opts);
    requests += result.requests;
    responseStructureComplete = responseStructureComplete && result.responseStructureComplete;
    capHit = capHit || result.capHit;
    for (const place of result.places) {
      const hasCoordinates = place.lat != null && place.lng != null;
      if (hasCoordinates && !contains(place.lat, place.lng)) continue;
      observations.push({
        placeId: place.ftid,
        query,
        payload: formatPlaceRecord(place, place.ftid),
      });
    }
    if (!result.paginationComplete) {
      paginationComplete = false;
      error = result.error;
      break;
    }
  }

  const canSplit = task.tile_zoom < opts.maxTileZoom;
  const shouldSplit = paginationComplete && capHit && canSplit;
  const probeFresh = await scheduler.isProbeFresh(
    opts.workflowId,
    opts.workerId,
    'poi_search',
    opts.probeFreshSeconds,
  );
  const teamHealth = await scheduler.teamProductionNormal(opts.workflowId, 'poi_search');
  const classification = classifyTileOutcome({
    paginationComplete,
    shouldSplit,
    placeCount: new Set(observations.map((item) => item.placeId)).size,
    sessionProbeFresh: probeFresh,
    responseStructureComplete,
    teamProductionNormal: teamHealth.normal,
  });
  const retryDelayMs = Math.min(15 * 60 * 1000, 30000 * 2 ** Math.max(0, task.attempt_count - 1));
  const children = classification.status === 'SPLIT' ? buildChildren(task, opts) : [];

  return {
    status: classification.status,
    observations,
    requestCount: requests,
    errorCode: error ? 'pagination_incomplete' : null,
    errorMessage: error ? String(error) : null,
    retryDelayMs,
    children,
    diagnostics: {
      reason: classification.reason,
      ...classification.diagnostics,
      teamHealth,
      capHit,
      saturatedAtMaxZoom: capHit && !canSplit,
      pageAttemptsPerOffset: opts.maxPageRetries + 1,
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pool = createPool(process.env.DATABASE_URL, {
    applicationName: `gmaps-worker:${opts.workflowId}:${opts.workerId}`,
    max: 4,
  });
  const scheduler = new PostgresScheduler(pool);
  let session = null;
  let stopping = false;
  let lastReap = 0;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });

  try {
    await scheduler.registerWorker(opts.workflowId, opts.workerId, 'poi_search', {
      pid: process.pid,
      hostname: os.hostname(),
      node: process.version,
    });
    session = await createBrowserSession(opts);

    while (!stopping) {
      if (Date.now() - lastReap > 60000) {
        await scheduler.reapExpiredLeases(opts.workflowId);
        lastReap = Date.now();
      }
      await ensureHealthyProbe(scheduler, session, opts);
      const task = await scheduler.claimTask(opts.workflowId, opts.workerId, {
        leaseSeconds: opts.leaseSeconds,
        starvationSeconds: 60,
        tailThreshold: 0.95,
      });
      if (!task) {
        const state = await scheduler.queueState(opts.workflowId);
        if (state.waiting === 0 && state.claimed === 0) {
          console.log(JSON.stringify({ event: 'queue_terminal', ...state }));
          break;
        }
        await sleep(opts.idlePollMs);
        continue;
      }

      console.log(JSON.stringify({
        event: 'task_claimed',
        taskKey: task.task_key,
        attempt: task.attempt_count,
        boundaryCompletion: task.completion_ratio,
      }));
      const heartbeat = setInterval(() => {
        Promise.all([
          scheduler.heartbeat(task, opts.leaseSeconds),
          scheduler.registerWorker(opts.workflowId, opts.workerId, 'poi_search', {
            pid: process.pid,
            hostname: os.hostname(),
            taskKey: task.task_key,
          }),
        ]).catch((error) => {
          console.error(`[WORKER] heartbeat failed ${task.task_key}: ${error.message}`);
        });
      }, opts.heartbeatSeconds * 1000);
      heartbeat.unref();

      try {
        const outcome = await processTask(task, scheduler, session, opts);
        const committed = await scheduler.commitOutcome(task, outcome);
        console.log(JSON.stringify({ event: 'task_committed', taskKey: task.task_key, ...committed }));
      } catch (error) {
        console.error(`[WORKER] ${task.task_key}: ${error.stack || error}`);
        try {
          const committed = await scheduler.commitOutcome(task, {
            status: 'RETRY',
            observations: [],
            requestCount: 0,
            errorCode: 'worker_exception',
            errorMessage: String(error.message || error).slice(0, 2000),
            retryDelayMs: Math.min(15 * 60 * 1000, 30000 * 2 ** Math.max(0, task.attempt_count - 1)),
            diagnostics: { workerException: true },
          });
          console.log(JSON.stringify({ event: 'task_exception_committed', taskKey: task.task_key, ...committed }));
        } catch (commitError) {
          console.error(`[WORKER] failed to release task lease ${task.task_key}: ${commitError.stack || commitError}`);
        }
        await closeSession(session);
        session = null;
        if (!stopping) session = await createBrowserSession(opts);
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    await closeSession(session);
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
  bboxSizeKm,
  fetchQuery,
  buildChildren,
  processTask,
};
