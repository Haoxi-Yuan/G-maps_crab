#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');

const { createPool, PostgresScheduler, runMigrations } = require('./scheduler/postgres-store');

const RPC_METHODS = new Set([
  'registerWorker',
  'recordProbe',
  'isProbeFresh',
  'acquireBudget',
  'recordRequestOutcome',
  'recordOperationLatency',
  'getTimingPolicy',
  'teamProductionNormal',
  'claimTask',
  'markTaskProgress',
  'heartbeat',
  'queueState',
  'workflowStatus',
  'markWorkflowComplete',
  'reapExpiredLeases',
  'commitOutcome',
  'progress',
]);

function readSecret(file, direct) {
  if (file) {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) !== 0) throw new Error(`scheduler token file must be mode 600: ${file}`);
    return fs.readFileSync(file, 'utf8').trim();
  }
  return direct || '';
}

async function readJson(req, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 }); }
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function authorized(req, token) {
  const value = req.headers.authorization || '';
  const supplied = value.startsWith('Bearer ') ? value.slice(7) : '';
  if (!supplied || supplied.length !== token.length) return false;
  return require('crypto').timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

async function requireStrictTerminal(scheduler, workflowId) {
  const state = await scheduler.queueState(workflowId);
  if (state.waiting || state.claimed || state.quarantined || state.suspectEmpty) {
    const error = new Error(`workflow is not strictly finalizable: ${JSON.stringify(state)}`);
    error.statusCode = 409;
    throw error;
  }
  return state;
}

async function writeResponseChunk(res, chunk) {
  if (res.destroyed) throw new Error('export client disconnected');
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('export client disconnected')); };
    const onError = (error) => { cleanup(); reject(error); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

async function streamWorkflowExport(scheduler, workflowId, dataset, res) {
  await requireStrictTerminal(scheduler, workflowId);
  const QueryStream = require('pg-query-stream');
  let sql;
  let rowToLine;
  if (dataset === 'places.ndjson') {
    sql = `SELECT payload FROM ${scheduler.table('places')} WHERE workflow_id = $1 ORDER BY place_id`;
    rowToLine = (row) => JSON.stringify(row.payload);
  } else if (dataset === 'place_boundaries.ndjson') {
    sql = `SELECT place_id, jsonb_agg(DISTINCT boundary_id ORDER BY boundary_id) AS boundary_ids
           FROM ${scheduler.table('poi_observations')}
           WHERE workflow_id = $1 GROUP BY place_id ORDER BY place_id`;
    rowToLine = (row) => JSON.stringify({ placeId: row.place_id, boundaryIds: row.boundary_ids });
  } else {
    const error = new Error('unknown export dataset');
    error.statusCode = 404;
    throw error;
  }
  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'content-disposition': `attachment; filename="${dataset}"`,
    'cache-control': 'no-store',
  });
  const client = await scheduler.pool.connect();
  try {
    const query = client.query(new QueryStream(sql, [workflowId], { batchSize: 1000 }));
    for await (const row of query) await writeResponseChunk(res, `${rowToLine(row)}\n`);
    res.end();
  } finally {
    client.release();
  }
}

function createSchedulerServer(scheduler, options = {}) {
  const token = options.token;
  if (!token || token.length < 32) throw new Error('scheduler API token must contain at least 32 characters');
  const handler = async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      sendJson(res, 200, { ok: true, service: 'gmaps-scheduler' });
      return;
    }
    const url = new URL(req.url, 'http://scheduler.local');
    const exportMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/export\/(places\.ndjson|place_boundaries\.ndjson)$/);
    if (req.method === 'GET' && exportMatch) {
      if (!authorized(req, token)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      try {
        await streamWorkflowExport(scheduler, decodeURIComponent(exportMatch[1]), exportMatch[2], res);
      } catch (error) {
        if (!res.headersSent) sendJson(res, error.statusCode || 500, { ok: false, error: String(error.message || error) });
        else res.destroy(error);
      }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/rpc') {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (!authorized(req, token)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    try {
      const body = await readJson(req, options.maxBodyBytes);
      if (!body || !RPC_METHODS.has(body.method) || !Array.isArray(body.args)) {
        throw Object.assign(new Error('invalid RPC method or arguments'), { statusCode: 400 });
      }
      const result = await scheduler[body.method](...body.args);
      sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        ok: false,
        error: String(error.message || error).slice(0, 2000),
      });
    }
  };
  if (options.tls) return https.createServer(options.tls, handler);
  return http.createServer(handler);
}

async function startLeaseReaper(scheduler, pool, signal) {
  while (!signal.aborted) {
    let delayMs = null;
    try {
      const result = await pool.query(
        `SELECT workflow_id FROM gmaps_scheduler.workflows WHERE status = 'ACTIVE' ORDER BY workflow_id`,
      );
      for (const row of result.rows) {
        const policy = await scheduler.getTimingPolicy(row.workflow_id, 'poi_search');
        delayMs = delayMs == null ? policy.reapIntervalMs : Math.min(delayMs, policy.reapIntervalMs);
        await scheduler.reapExpiredLeases(row.workflow_id);
      }
    } catch (error) {
      console.error(`[SCHEDULER] lease reaper: ${error.message}`);
    }
    await new Promise((resolve) => {
      const onAbort = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs == null ? 5000 : delayMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

async function main() {
  const host = process.env.SCHEDULER_HOST || '127.0.0.1';
  const port = Number(process.env.SCHEDULER_PORT || 8443);
  const token = readSecret(process.env.SCHEDULER_API_TOKEN_FILE, process.env.SCHEDULER_API_TOKEN);
  const certFile = process.env.SCHEDULER_TLS_CERT_FILE;
  const keyFile = process.env.SCHEDULER_TLS_KEY_FILE;
  const tls = certFile && keyFile ? {
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
  } : null;
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!tls && !local && process.env.SCHEDULER_ALLOW_INSECURE !== '1') {
    throw new Error('plain HTTP scheduler may only bind loopback; use TLS or a loopback reverse proxy');
  }

  const pool = createPool(process.env.DATABASE_URL, { applicationName: 'gmaps-scheduler-api', max: 20 });
  const scheduler = new PostgresScheduler(pool);
  await runMigrations(pool);
  const server = createSchedulerServer(scheduler, { token, tls });
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.listen(port, host, () => {
    console.log(JSON.stringify({ event: 'scheduler_listening', protocol: tls ? 'https' : 'http', host, port }));
  });
  const reaper = startLeaseReaper(scheduler, pool, controller.signal);
  await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
  await new Promise((resolve) => server.close(resolve));
  await reaper;
  await pool.end();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = {
  RPC_METHODS,
  createSchedulerServer,
  readJson,
  requireStrictTerminal,
  streamWorkflowExport,
};
