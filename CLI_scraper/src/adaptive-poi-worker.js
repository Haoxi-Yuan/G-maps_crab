#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');

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
const { HttpSchedulerClient } = require('./scheduler/http-client');
const { acquireLaunchSlot } = require('./scheduler/node-launch-gate');

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
    retryDelayMs: null,
    requestTimeoutMs: null,
    leaseSeconds: null,
    heartbeatSeconds: null,
    probeFreshSeconds: null,
    probeQuery: 'restaurant',
    probeLat: 1.2834,
    probeLng: 103.8607,
    maxTileZoom: 20,
    idlePollMs: null,
    launchSlots: Number(process.env.GMAPS_BROWSER_LAUNCH_SLOTS || 2),
    maxBrowserLaunchAttempts: 4,
    launchGate: process.env.GMAPS_NODE_LAUNCH_GATE
      || path.join('/tmp', `${process.env.USER || 'gmaps'}-browser-launch-gate`),
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
    else if (arg === '--launch-slots') opts.launchSlots = Number(argv[++i]);
    else if (arg === '--max-browser-launch-attempts') opts.maxBrowserLaunchAttempts = Number(argv[++i]);
    else if (arg === '--launch-gate') opts.launchGate = argv[++i];
    else if (arg === '--help') {
      console.log(`
PostgreSQL adaptive POI worker

Usage:
  SCHEDULER_URL=https://... SCHEDULER_API_TOKEN_FILE=... \
    node src/adaptive-poi-worker.js --workflow <id> [options]

Important defaults:
  3 attempts per HTTP page (--max-page-retries 2), Web Mercator zoom 20 floor.
  Request, retry, heartbeat, lease and stall thresholds are short capped values
  derived from the successful-response EWMA. Explicit time flags override them.
`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.workflowId) throw new Error('--workflow is required');
  return opts;
}

async function createBrowserSession(scheduler, opts) {
  const launchPolicy = await scheduler.getTimingPolicy(opts.workflowId, 'browser_launch');
  const launchTimeoutMs = opts.requestTimeoutMs || launchPolicy.requestTimeoutMs;
  const gate = await acquireLaunchSlot(opts.launchGate, {
    slots: opts.launchSlots,
    timeoutMs: launchTimeoutMs,
    staleMs: launchTimeoutMs * 2,
    pollMs: Math.max(100, Math.min(1000, Math.round(launchPolicy.meanMs / 10))),
  });
  let browser;
  try {
    const launchStarted = Date.now();
    browser = await chromium.launch({
      headless: true,
      timeout: launchTimeoutMs,
      args: [...stealth.buildLaunchArgs(), '--disk-cache-size=1'],
    });
    await scheduler.recordOperationLatency(opts.workflowId, 'browser_launch', Date.now() - launchStarted);
    const { context, page } = await stealth.createStealthContext(browser, { blockImages: true });
    const navigationPolicy = await scheduler.getTimingPolicy(opts.workflowId, 'page_navigation');
    const navigationTimeoutMs = opts.requestTimeoutMs || navigationPolicy.requestTimeoutMs;
    const navigationStarted = Date.now();
    const pbTemplate = await capturePbTemplate(page, opts.probeQuery, opts.probeLat, opts.probeLng, {
      navigationTimeoutMs,
      postNavigationWaitMs: Math.max(1000, Math.min(5000, navigationPolicy.meanMs)),
    });
    await scheduler.recordOperationLatency(opts.workflowId, 'page_navigation', Date.now() - navigationStarted);
    return {
      browser,
      context,
      page,
      pbTemplate,
      closeTimeoutMs: Math.max(500, Math.min(5000, navigationPolicy.heartbeatMs)),
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    throw error;
  } finally {
    // Keep the slot through the first Maps navigation as well as process
    // creation. This prevents a node-wide cold-start and socket stampede.
    gate.release();
  }
}

async function closeSession(session) {
  if (!session) return;
  const bounded = async (promise) => {
    let timer;
    try {
      await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, session.closeTimeoutMs || 1000);
          timer.unref();
        }),
      ]);
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  };
  try { await bounded(session.page.close()); } catch (_) {}
  try { await bounded(session.context.close()); } catch (_) {}
  try { await bounded(session.browser.close()); } catch (_) {}
}

async function fetchWithBudget({ scheduler, workflowId, page, args, task, opts }) {
  const timing = await scheduler.waitForBudget(workflowId, 'poi_search');
  const fetchArgs = [...args];
  fetchArgs.push({ requestTimeoutMs: opts.requestTimeoutMs || timing.requestTimeoutMs });
  const started = Date.now();
  const result = await fetchPage(page, ...fetchArgs);
  const nextTiming = await scheduler.recordRequestOutcome(workflowId, 'poi_search', {
    success: !result.error,
    structureComplete: result.structureComplete === true,
    placeCount: result.places ? result.places.length : 0,
    elapsedMs: Date.now() - started,
  });
  if (task) {
    const accepted = await scheduler.markTaskProgress(task, 'request_complete');
    if (!accepted) throw new Error(`task lease lost while recording progress: ${task.task_key}`);
    if (opts.onProgress) opts.onProgress('request_complete');
  }
  return { ...result, timingPolicy: nextTiming || timing };
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
      ],
      opts,
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
        ],
        task,
        opts,
      });
      if (!result.error) break;
      responseStructureComplete = false;
      if (attempt < opts.maxPageRetries) {
        const retryTiming = await scheduler.getTimingPolicy(opts.workflowId, 'poi_search', {
          attempt: attempt + 1,
        });
        await sleep(opts.retryDelayMs || retryTiming.retryDelayMs);
      }
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
  const retryTiming = await scheduler.getTimingPolicy(opts.workflowId, 'poi_search', {
    attempt: task.attempt_count,
  });
  const retryDelayMs = opts.retryDelayMs || retryTiming.retryDelayMs;
  const children = classification.status === 'SPLIT' ? buildChildren(task, opts) : [];

  return {
    status: classification.status,
    observations,
    requestCount: requests,
    errorCode: error ? 'pagination_incomplete' : null,
    errorMessage: error ? String(error) : null,
    retryDelayMs,
    children,
    restartSession: Boolean(error && /browser_closed|page has been closed|context.*closed/i.test(String(error))),
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

function createSchedulerBackend(opts) {
  if (process.env.SCHEDULER_URL) {
    const scheduler = new HttpSchedulerClient(process.env.SCHEDULER_URL, {
      tokenFile: process.env.SCHEDULER_API_TOKEN_FILE,
    });
    return { scheduler, remote: true, close: () => scheduler.end() };
  }
  const pool = createPool(process.env.DATABASE_URL, {
    applicationName: `gmaps-worker:${opts.workflowId}:${opts.workerId}`,
    max: 4,
  });
  return {
    scheduler: new PostgresScheduler(pool),
    remote: false,
    close: () => pool.end(),
  };
}

async function openBrowserWithRetry(scheduler, opts, shouldStop) {
  let attempt = 1;
  let lastError;
  while (!shouldStop() && attempt <= opts.maxBrowserLaunchAttempts) {
    try {
      return await createBrowserSession(scheduler, opts);
    } catch (error) {
      lastError = error;
      const timing = await scheduler.getTimingPolicy(opts.workflowId, 'browser_launch', { attempt });
      const retryDelayMs = opts.retryDelayMs || timing.retryDelayMs;
      console.error(`[WORKER] browser startup attempt ${attempt} failed: ${error.message}; retry in ${retryDelayMs}ms`);
      if (attempt >= opts.maxBrowserLaunchAttempts) break;
      await sleep(retryDelayMs);
      attempt++;
    }
  }
  if (lastError && !shouldStop()) {
    throw new Error(`browser failed to start after ${opts.maxBrowserLaunchAttempts} attempts: ${lastError.message}`);
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const backend = createSchedulerBackend(opts);
  const { scheduler } = backend;
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
      schedulerTransport: backend.remote ? 'https' : 'postgres',
    });
    session = await openBrowserWithRetry(scheduler, opts, () => stopping);

    while (!stopping) {
      const loopTiming = await scheduler.getTimingPolicy(opts.workflowId, 'poi_search');
      if (!backend.remote && Date.now() - lastReap > loopTiming.reapIntervalMs) {
        await scheduler.reapExpiredLeases(opts.workflowId);
        lastReap = Date.now();
      }
      const probeOk = await ensureHealthyProbe(scheduler, session, opts);
      if (!probeOk && session.page.isClosed()) {
        await closeSession(session);
        session = await openBrowserWithRetry(scheduler, opts, () => stopping);
        continue;
      }
      const task = await scheduler.claimTask(opts.workflowId, opts.workerId, {
        leaseSeconds: opts.leaseSeconds,
        tailThreshold: 0.95,
      });
      if (!task) {
        const state = await scheduler.queueState(opts.workflowId);
        if (state.waiting === 0 && state.claimed === 0) {
          console.log(JSON.stringify({ event: 'queue_terminal', ...state }));
          break;
        }
        await sleep(opts.idlePollMs || loopTiming.idlePollMs);
        continue;
      }

      console.log(JSON.stringify({
        event: 'task_claimed',
        taskKey: task.task_key,
        attempt: task.attempt_count,
        boundaryCompletion: task.completion_ratio,
        timing: task.timing_policy,
      }));
      const taskTiming = task.timing_policy || loopTiming;
      const leaseSeconds = opts.leaseSeconds || task.lease_seconds || Math.ceil(taskTiming.leaseMs / 1000);
      const heartbeatMs = opts.heartbeatSeconds
        ? opts.heartbeatSeconds * 1000
        : taskTiming.heartbeatMs;
      const progressTimeoutMs = taskTiming.progressTimeoutMs;
      const taskSession = session;
      const progressState = {
        lastAt: Date.now(),
        lastHeartbeatOkAt: Date.now(),
        error: null,
        checking: false,
      };
      const taskOpts = {
        ...opts,
        onProgress(kind) {
          progressState.lastAt = Date.now();
          console.log(JSON.stringify({ event: 'task_progress', taskKey: task.task_key, kind }));
        },
      };
      const heartbeat = setInterval(async () => {
        if (progressState.checking || progressState.error) return;
        progressState.checking = true;
        try {
          const idleMs = Date.now() - progressState.lastAt;
          if (idleMs > progressTimeoutMs) {
            progressState.error = new Error(`task made no completed-request progress for ${idleMs}ms`);
            console.error(`[WORKER] watchdog ${task.task_key}: ${progressState.error.message}`);
            await closeSession(taskSession);
            return;
          }
          const alive = await scheduler.heartbeat(task, leaseSeconds, progressTimeoutMs);
          if (!alive) {
            progressState.error = new Error('task lease was not renewed because durable progress is stale or lease was lost');
            console.error(`[WORKER] heartbeat ${task.task_key}: ${progressState.error.message}`);
            await closeSession(taskSession);
            return;
          }
          progressState.lastHeartbeatOkAt = Date.now();
          await scheduler.registerWorker(opts.workflowId, opts.workerId, 'poi_search', {
            pid: process.pid,
            hostname: os.hostname(),
            taskKey: task.task_key,
            lastProgressAt: new Date(progressState.lastAt).toISOString(),
          });
        } catch (error) {
          console.error(`[WORKER] heartbeat failed ${task.task_key}: ${error.message}`);
          if (Date.now() - progressState.lastHeartbeatOkAt > progressTimeoutMs) {
            progressState.error = new Error(`scheduler heartbeat unavailable for ${progressTimeoutMs}ms`);
            await closeSession(taskSession);
          }
        } finally {
          progressState.checking = false;
        }
      }, heartbeatMs);
      heartbeat.unref();

      try {
        const outcome = await processTask(task, scheduler, session, taskOpts);
        if (progressState.error) throw progressState.error;
        const committed = await scheduler.commitOutcome(task, outcome);
        console.log(JSON.stringify({ event: 'task_committed', taskKey: task.task_key, ...committed }));
        if (outcome.restartSession && !stopping) {
          await closeSession(session);
          session = await openBrowserWithRetry(scheduler, opts, () => stopping);
        }
      } catch (error) {
        console.error(`[WORKER] ${task.task_key}: ${error.stack || error}`);
        try {
          const committed = await scheduler.commitOutcome(task, {
            status: 'RETRY',
            observations: [],
            requestCount: 0,
            errorCode: 'worker_exception',
            errorMessage: String(error.message || error).slice(0, 2000),
            retryDelayMs: opts.retryDelayMs || taskTiming.retryDelayMs,
            diagnostics: {
              workerException: true,
              progressWatchdog: Boolean(progressState.error),
              timing: taskTiming,
            },
          });
          console.log(JSON.stringify({ event: 'task_exception_committed', taskKey: task.task_key, ...committed }));
        } catch (commitError) {
          console.error(`[WORKER] failed to release task lease ${task.task_key}: ${commitError.stack || commitError}`);
        }
        await closeSession(session);
        session = null;
        if (!stopping) session = await openBrowserWithRetry(scheduler, opts, () => stopping);
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    await closeSession(session);
    await backend.close();
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
  createSchedulerBackend,
  openBrowserWithRetry,
};
