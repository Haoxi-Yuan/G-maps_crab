'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  defaultMeanMs,
  timingPolicy,
  updateEwma,
} = require('./adaptive-timing');

const DEFAULT_SCHEMA = 'gmaps_scheduler';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPool(connectionString, options = {}) {
  if (!connectionString && !process.env.PGHOST) {
    throw new Error('DATABASE_URL or standard PGHOST/PGUSER/PGDATABASE variables are required');
  }
  const { Pool } = require('pg');
  return new Pool({
    connectionString,
    max: options.max ?? 4,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10000,
    application_name: options.applicationName || 'gmaps-adaptive-scheduler',
    ssl: options.ssl,
  });
}

async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function runMigrations(pool, migrationFile = path.resolve(__dirname, '../../scripts/sql/001_adaptive_scheduler.sql')) {
  const sql = fs.readFileSync(migrationFile, 'utf8');
  await pool.query(sql);
}

class PostgresScheduler {
  constructor(pool, options = {}) {
    if (!pool) throw new Error('pool is required');
    this.pool = pool;
    this.schema = options.schema || DEFAULT_SCHEMA;
  }

  table(name) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name) || !/^[a-z_][a-z0-9_]*$/i.test(this.schema)) {
      throw new Error('unsafe SQL identifier');
    }
    return `${this.schema}.${name}`;
  }

  async meanResponseMs(workflowId, operation, client = this.pool) {
    const result = await client.query(
      `SELECT ewma_ms, sample_count, last_sample_ms, updated_at
       FROM ${this.table('operation_latency')}
       WHERE workflow_id = $1 AND operation = $2`,
      [workflowId, operation],
    );
    if (result.rowCount === 0) {
      return {
        meanMs: defaultMeanMs(operation),
        sampleCount: 0,
        lastSampleMs: null,
        updatedAt: null,
      };
    }
    const row = result.rows[0];
    return {
      meanMs: Number(row.ewma_ms),
      sampleCount: Number(row.sample_count),
      lastSampleMs: Number(row.last_sample_ms),
      updatedAt: row.updated_at,
    };
  }

  async getTimingPolicy(workflowId, operation, options = {}, client = this.pool) {
    const latency = await this.meanResponseMs(workflowId, operation, client);
    return {
      ...timingPolicy(operation, latency.meanMs, options),
      sampleCount: latency.sampleCount,
      lastSampleMs: latency.lastSampleMs,
      modelUpdatedAt: latency.updatedAt,
    };
  }

  async recordOperationLatency(workflowId, operation, elapsedMs) {
    if (!Number.isFinite(Number(elapsedMs)) || Number(elapsedMs) <= 0) return null;
    return inTransaction(this.pool, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(length($1)::text || ':' || $1 || ':' || $2, 0))`,
        [workflowId, operation],
      );
      const currentResult = await client.query(
        `SELECT ewma_ms, sample_count
         FROM ${this.table('operation_latency')}
         WHERE workflow_id = $1 AND operation = $2
         FOR UPDATE`,
        [workflowId, operation],
      );
      const currentMean = currentResult.rowCount
        ? Number(currentResult.rows[0].ewma_ms)
        : defaultMeanMs(operation);
      const sampleCount = currentResult.rowCount
        ? Number(currentResult.rows[0].sample_count)
        : 0;
      const nextMean = updateEwma(currentMean, sampleCount, Number(elapsedMs));
      await client.query(
        `INSERT INTO ${this.table('operation_latency')}
           (workflow_id, operation, ewma_ms, sample_count, last_sample_ms)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT (workflow_id, operation) DO UPDATE SET
           ewma_ms = EXCLUDED.ewma_ms,
           sample_count = ${this.table('operation_latency')}.sample_count + 1,
           last_sample_ms = EXCLUDED.last_sample_ms,
           updated_at = clock_timestamp()`,
        [workflowId, operation, nextMean, Math.min(600000, Math.round(Number(elapsedMs)))],
      );
      return {
        ...timingPolicy(operation, nextMean),
        sampleCount: sampleCount + 1,
      };
    });
  }

  async seedWorkflow({ workflowId, config = {}, boundaries, categoryGroups, tasks, budgets = [] }) {
    if (!workflowId) throw new Error('workflowId is required');
    if (!Array.isArray(boundaries) || boundaries.length === 0) throw new Error('at least one boundary is required');
    if (!Array.isArray(categoryGroups) || categoryGroups.length === 0) throw new Error('at least one category group is required');
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('at least one task is required');

    return inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO ${this.table('workflows')} (workflow_id, config)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (workflow_id) DO UPDATE
           SET config = EXCLUDED.config, updated_at = clock_timestamp()`,
        [workflowId, JSON.stringify(config)],
      );

      for (const boundary of boundaries) {
        await client.query(
          `INSERT INTO ${this.table('boundaries')}
             (workflow_id, boundary_id, boundary_name, geometry, root_zoom, weight, metadata)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)
           ON CONFLICT (workflow_id, boundary_id) DO UPDATE SET
             boundary_name = EXCLUDED.boundary_name,
             geometry = EXCLUDED.geometry,
             root_zoom = EXCLUDED.root_zoom,
             weight = EXCLUDED.weight,
             metadata = EXCLUDED.metadata`,
          [
            workflowId,
            boundary.boundaryId,
            boundary.name,
            JSON.stringify(boundary.geometry),
            boundary.rootZoom,
            boundary.weight || 1,
            JSON.stringify(boundary.metadata || {}),
          ],
        );
        await client.query(
          `INSERT INTO ${this.table('boundary_runtime')} (workflow_id, boundary_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [workflowId, boundary.boundaryId],
        );
      }

      for (const group of categoryGroups) {
        await client.query(
          `INSERT INTO ${this.table('category_groups')}
             (workflow_id, category_group, queries, estimated_requests)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (workflow_id, category_group) DO UPDATE SET
             queries = EXCLUDED.queries,
             estimated_requests = EXCLUDED.estimated_requests`,
          [workflowId, group.categoryGroup, JSON.stringify(group.queries), group.estimatedRequests || 7],
        );
      }

      for (const budget of budgets) {
        await client.query(
          `INSERT INTO ${this.table('request_budgets')}
             (workflow_id, endpoint, capacity, refill_per_second, tokens)
           VALUES ($1, $2, $3, $4, $3)
           ON CONFLICT (workflow_id, endpoint) DO UPDATE SET
             capacity = EXCLUDED.capacity,
             refill_per_second = EXCLUDED.refill_per_second,
             tokens = LEAST(${this.table('request_budgets')}.tokens, EXCLUDED.capacity),
             updated_at = clock_timestamp()`,
          [workflowId, budget.endpoint, budget.capacity, budget.refillPerSecond],
        );
      }

      const insertedByBoundary = new Map();
      const chunkSize = 1000;
      for (let offset = 0; offset < tasks.length; offset += chunkSize) {
        const chunk = tasks.slice(offset, offset + chunkSize);
        const result = await client.query(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
               boundary_id text, category_group text, tile_id text, task_key text,
               parent_tile_id text, tile_zoom integer, tile_x integer, tile_y integer,
               bbox jsonb, priority integer, estimated_requests integer, max_attempts integer
             )
           ), inserted AS (
             INSERT INTO ${this.table('tasks')} (
               workflow_id, boundary_id, category_group, tile_id, task_key,
               parent_tile_id, tile_zoom, tile_x, tile_y, bbox, priority,
               estimated_requests, max_attempts
             )
             SELECT $1, boundary_id, category_group, tile_id, task_key,
               parent_tile_id, tile_zoom, tile_x, tile_y, bbox, priority,
               estimated_requests, max_attempts
             FROM input
             ON CONFLICT (workflow_id, boundary_id, category_group, tile_id) DO NOTHING
             RETURNING boundary_id
           )
           SELECT boundary_id, count(*)::bigint AS inserted
           FROM inserted GROUP BY boundary_id`,
          [workflowId, JSON.stringify(chunk.map((task) => ({
            boundary_id: task.boundaryId,
            category_group: task.categoryGroup,
            tile_id: task.tileId,
            task_key: task.taskKey,
            parent_tile_id: task.parentTileId || null,
            tile_zoom: task.zoom,
            tile_x: task.x,
            tile_y: task.y,
            bbox: task.bbox,
            priority: task.priority || 0,
            estimated_requests: task.estimatedRequests || 7,
            max_attempts: task.maxAttempts || 4,
          })))],
        );
        for (const row of result.rows) {
          insertedByBoundary.set(row.boundary_id, (insertedByBoundary.get(row.boundary_id) || 0) + Number(row.inserted));
        }
      }

      for (const [boundaryId, inserted] of insertedByBoundary) {
        await client.query(
          `UPDATE ${this.table('boundary_runtime')}
           SET open_tasks = open_tasks + $3, updated_at = clock_timestamp()
           WHERE workflow_id = $1 AND boundary_id = $2`,
          [workflowId, boundaryId, inserted],
        );
      }

      return {
        insertedTasks: [...insertedByBoundary.values()].reduce((sum, count) => sum + count, 0),
        insertedByBoundary: Object.fromEntries(insertedByBoundary),
      };
    });
  }

  async reapExpiredLeases(workflowId) {
    return inTransaction(this.pool, async (client) => {
      const latency = await this.meanResponseMs(workflowId, 'poi_search', client);
      const expired = await client.query(
        `SELECT workflow_id, boundary_id, category_group, tile_id, estimated_requests,
                attempt_count, max_attempts, lease_owner
         FROM ${this.table('tasks')}
         WHERE workflow_id = $1 AND status = 'CLAIMED' AND lease_expires_at < clock_timestamp()
         FOR UPDATE SKIP LOCKED`,
        [workflowId],
      );
      const summary = { retry: 0, quarantined: 0 };
      for (const task of expired.rows) {
        const quarantine = task.attempt_count >= task.max_attempts;
        const status = quarantine ? 'QUARANTINED' : 'RETRY';
        const retryDelayMs = timingPolicy('poi_search', latency.meanMs, {
          attempt: Number(task.attempt_count),
        }).retryDelayMs;
        await client.query(
          `UPDATE ${this.table('tasks')}
           SET status = $5, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
               error_code = 'lease_expired', error_message = 'worker lease expired',
               next_attempt_at = CASE WHEN $5 = 'RETRY'
                 THEN clock_timestamp() + make_interval(secs => $6::double precision / 1000.0)
                 ELSE next_attempt_at END,
               completed_at = CASE WHEN $5 = 'QUARANTINED' THEN clock_timestamp() ELSE NULL END,
               updated_at = clock_timestamp()
           WHERE workflow_id = $1 AND boundary_id = $2 AND category_group = $3 AND tile_id = $4`,
          [workflowId, task.boundary_id, task.category_group, task.tile_id, status, retryDelayMs],
        );
        await client.query(
          `UPDATE ${this.table('boundary_runtime')}
           SET reserved_requests = GREATEST(0, reserved_requests - $3),
               open_tasks = open_tasks - CASE WHEN $4 THEN 1 ELSE 0 END,
               terminal_tasks = terminal_tasks + CASE WHEN $4 THEN 1 ELSE 0 END,
               quarantined_tasks = quarantined_tasks + CASE WHEN $4 THEN 1 ELSE 0 END,
               updated_at = clock_timestamp()
           WHERE workflow_id = $1 AND boundary_id = $2`,
          [workflowId, task.boundary_id, task.estimated_requests, quarantine],
        );
        await client.query(
          `INSERT INTO ${this.table('task_events')}
             (workflow_id, boundary_id, category_group, tile_id, worker_id, from_status, to_status, detail)
           VALUES ($1, $2, $3, $4, $5, 'CLAIMED', $6, '{"reason":"lease_expired"}'::jsonb)`,
          [workflowId, task.boundary_id, task.category_group, task.tile_id, task.lease_owner, status],
        );
        if (quarantine) summary.quarantined++; else summary.retry++;
      }
      return summary;
    });
  }

  async claimTask(workflowId, workerId, options = {}) {
    const tailThreshold = options.tailThreshold ?? 0.95;
    const token = crypto.randomUUID();

    return inTransaction(this.pool, async (client) => {
      const latency = await this.meanResponseMs(workflowId, 'poi_search', client);
      const basePolicy = timingPolicy('poi_search', latency.meanMs);
      const starvationSeconds = options.starvationSeconds
        || Math.ceil(basePolicy.fleetStallMs / 1000);
      const boundaryResult = await client.query(
        `SELECT br.*, b.geometry, b.root_zoom, b.boundary_name, b.weight,
                CASE WHEN br.open_tasks + br.terminal_tasks = 0 THEN 1
                     ELSE br.terminal_tasks::double precision / (br.open_tasks + br.terminal_tasks) END AS completion_ratio
         FROM ${this.table('boundary_runtime')} br
         JOIN ${this.table('boundaries')} b USING (workflow_id, boundary_id)
         WHERE br.workflow_id = $1 AND br.open_tasks > 0
           AND EXISTS (
             SELECT 1 FROM ${this.table('tasks')} t
             WHERE t.workflow_id = br.workflow_id AND t.boundary_id = br.boundary_id
               AND t.status IN ('PENDING', 'RETRY')
               AND t.next_attempt_at <= clock_timestamp()
               AND t.attempt_count < t.max_attempts
           )
         ORDER BY
           CASE WHEN br.last_claimed_at IS NULL
                  OR br.last_claimed_at < clock_timestamp() - make_interval(secs => $2)
                THEN 0 ELSE 1 END,
           CASE WHEN (CASE WHEN br.open_tasks + br.terminal_tasks = 0 THEN 1
                           ELSE br.terminal_tasks::double precision / (br.open_tasks + br.terminal_tasks) END) >= $3
                THEN 0 ELSE 1 END,
           (br.request_count + br.reserved_requests) / b.weight ASC,
           br.last_claimed_at NULLS FIRST,
           br.boundary_id
         FOR UPDATE OF br SKIP LOCKED
         LIMIT 1`,
        [workflowId, starvationSeconds, tailThreshold],
      );
      if (boundaryResult.rowCount === 0) return null;
      const boundary = boundaryResult.rows[0];

      const taskResult = await client.query(
        `SELECT t.*, cg.queries
         FROM ${this.table('tasks')} t
         JOIN ${this.table('category_groups')} cg
           ON cg.workflow_id = t.workflow_id AND cg.category_group = t.category_group
         WHERE t.workflow_id = $1 AND t.boundary_id = $2
           AND t.status IN ('PENDING', 'RETRY')
           AND t.next_attempt_at <= clock_timestamp()
           AND t.attempt_count < t.max_attempts
         ORDER BY t.priority DESC, t.estimated_requests ASC, t.attempt_count ASC, t.tile_id, t.category_group
         FOR UPDATE OF t SKIP LOCKED
         LIMIT 1`,
        [workflowId, boundary.boundary_id],
      );
      if (taskResult.rowCount === 0) return null;
      const task = taskResult.rows[0];
      const taskPolicy = timingPolicy('poi_search', latency.meanMs, {
        estimatedRequests: Number(task.estimated_requests),
        attempt: Number(task.attempt_count) + 1,
      });
      const leaseSeconds = options.leaseSeconds
        || Math.ceil(taskPolicy.leaseMs / 1000);

      await client.query(
        `UPDATE ${this.table('tasks')}
         SET status = 'CLAIMED', attempt_count = attempt_count + 1,
             lease_owner = $5, lease_token = $6,
             lease_expires_at = clock_timestamp() + make_interval(secs => $7),
             last_progress_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE workflow_id = $1 AND boundary_id = $2 AND category_group = $3 AND tile_id = $4`,
        [workflowId, task.boundary_id, task.category_group, task.tile_id, workerId, token, leaseSeconds],
      );
      await client.query(
        `UPDATE ${this.table('boundary_runtime')}
         SET reserved_requests = reserved_requests + $3,
             last_claimed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE workflow_id = $1 AND boundary_id = $2`,
        [workflowId, task.boundary_id, task.estimated_requests],
      );
      await client.query(
        `INSERT INTO ${this.table('task_events')}
           (workflow_id, boundary_id, category_group, tile_id, worker_id, from_status, to_status, detail)
         VALUES ($1, $2, $3, $4, $5, $6, 'CLAIMED', jsonb_build_object('lease_seconds', $7::integer))`,
        [workflowId, task.boundary_id, task.category_group, task.tile_id, workerId, task.status, leaseSeconds],
      );

      return {
        ...task,
        attempt_count: Number(task.attempt_count) + 1,
        lease_owner: workerId,
        lease_token: token,
        lease_seconds: leaseSeconds,
        boundary_name: boundary.boundary_name,
        boundary_geometry: boundary.geometry,
        root_zoom: boundary.root_zoom,
        completion_ratio: Number(boundary.completion_ratio),
        timing_policy: taskPolicy,
      };
    });
  }

  async markTaskProgress(task, kind = 'request_complete') {
    const result = await this.pool.query(
      `WITH updated_task AS (
         UPDATE ${this.table('tasks')}
         SET last_progress_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE workflow_id = $1 AND boundary_id = $2 AND category_group = $3 AND tile_id = $4
           AND status = 'CLAIMED' AND lease_token = $5
         RETURNING lease_owner
       )
       UPDATE ${this.table('worker_sessions')} w
       SET heartbeat_at = clock_timestamp(), last_progress_at = clock_timestamp(),
           last_progress_kind = $6
       FROM updated_task t
       WHERE w.workflow_id = $1 AND w.worker_id = t.lease_owner AND w.endpoint = 'poi_search'
       RETURNING w.worker_id`,
      [task.workflow_id, task.boundary_id, task.category_group, task.tile_id, task.lease_token, kind],
    );
    return result.rowCount === 1;
  }

  async heartbeat(task, extendSeconds = null, progressTimeoutMs = null) {
    const policy = (extendSeconds && progressTimeoutMs)
      ? null
      : await this.getTimingPolicy(task.workflow_id, 'poi_search', {
        estimatedRequests: Number(task.estimated_requests || 1),
        attempt: Number(task.attempt_count || 1),
      });
    const effectiveExtendSeconds = extendSeconds || Math.ceil(policy.leaseMs / 1000);
    const effectiveProgressTimeoutMs = progressTimeoutMs || policy.progressTimeoutMs;
    const result = await this.pool.query(
      `UPDATE ${this.table('tasks')}
       SET lease_expires_at = clock_timestamp() + make_interval(secs => $6),
           updated_at = clock_timestamp()
       WHERE workflow_id = $1 AND boundary_id = $2 AND category_group = $3 AND tile_id = $4
         AND status = 'CLAIMED' AND lease_token = $5
         AND last_progress_at >= clock_timestamp() - make_interval(secs => $7::double precision / 1000.0)
       RETURNING tile_id`,
      [
        task.workflow_id, task.boundary_id, task.category_group, task.tile_id,
        task.lease_token, effectiveExtendSeconds, effectiveProgressTimeoutMs,
      ],
    );
    return result.rowCount === 1;
  }

  async registerWorker(workflowId, workerId, endpoint, metadata = {}) {
    await this.pool.query(
      `INSERT INTO ${this.table('worker_sessions')}
         (workflow_id, worker_id, endpoint, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (workflow_id, worker_id, endpoint) DO UPDATE SET
         heartbeat_at = clock_timestamp(), metadata = EXCLUDED.metadata`,
      [workflowId, workerId, endpoint, JSON.stringify(metadata)],
    );
  }

  async recordProbe(workflowId, workerId, endpoint, ok, error = null) {
    await this.pool.query(
      `INSERT INTO ${this.table('worker_sessions')}
         (workflow_id, worker_id, endpoint, last_probe_at, last_probe_ok_at, last_probe_error)
       VALUES ($1, $2, $3, clock_timestamp(), CASE WHEN $4 THEN clock_timestamp() END, $5)
       ON CONFLICT (workflow_id, worker_id, endpoint) DO UPDATE SET
         heartbeat_at = clock_timestamp(), last_probe_at = clock_timestamp(),
         last_probe_ok_at = CASE WHEN $4 THEN clock_timestamp() ELSE ${this.table('worker_sessions')}.last_probe_ok_at END,
         last_probe_error = $5`,
      [workflowId, workerId, endpoint, ok, error],
    );
  }

  async isProbeFresh(workflowId, workerId, endpoint, freshnessSeconds = null) {
    const effectiveFreshnessSeconds = freshnessSeconds
      || Math.ceil((await this.getTimingPolicy(workflowId, endpoint)).probeFreshMs / 1000);
    const result = await this.pool.query(
      `SELECT last_probe_ok_at IS NOT NULL
              AND last_probe_ok_at >= clock_timestamp() - make_interval(secs => $4) AS fresh
       FROM ${this.table('worker_sessions')}
       WHERE workflow_id = $1 AND worker_id = $2 AND endpoint = $3`,
      [workflowId, workerId, endpoint, effectiveFreshnessSeconds],
    );
    return result.rowCount === 1 && result.rows[0].fresh === true;
  }

  async acquireBudget(workflowId, endpoint, cost = 1) {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT capacity, refill_per_second, tokens,
                GREATEST(0, extract(epoch FROM clock_timestamp() - updated_at)) AS elapsed
         FROM ${this.table('request_budgets')}
         WHERE workflow_id = $1 AND endpoint = $2
         FOR UPDATE`,
        [workflowId, endpoint],
      );
      if (result.rowCount === 0) throw new Error(`request budget not configured: ${workflowId}/${endpoint}`);
      const row = result.rows[0];
      const capacity = Number(row.capacity);
      const refill = Number(row.refill_per_second);
      const tokens = Math.min(capacity, Number(row.tokens) + Number(row.elapsed) * refill);
      if (tokens >= cost) {
        await client.query(
          `UPDATE ${this.table('request_budgets')}
           SET tokens = $3, updated_at = clock_timestamp()
           WHERE workflow_id = $1 AND endpoint = $2`,
          [workflowId, endpoint, tokens - cost],
        );
        return { granted: true, waitMs: 0 };
      }
      await client.query(
        `UPDATE ${this.table('request_budgets')}
         SET tokens = $3, updated_at = clock_timestamp()
         WHERE workflow_id = $1 AND endpoint = $2`,
        [workflowId, endpoint, tokens],
      );
      return { granted: false, waitMs: Math.max(25, Math.ceil((cost - tokens) / refill * 1000)) };
    });
  }

  async waitForBudget(workflowId, endpoint, cost = 1, signal = null) {
    const policy = await this.getTimingPolicy(workflowId, endpoint);
    while (true) {
      if (signal && signal.aborted) throw new Error('budget wait aborted');
      const result = await this.acquireBudget(workflowId, endpoint, cost);
      if (result.granted) return policy;
      await sleep(Math.min(policy.idlePollMs, result.waitMs + Math.floor(Math.random() * 50)));
    }
  }

  async recordRequestOutcome(workflowId, endpoint, outcome) {
    const elapsedMs = Number(outcome.elapsedMs || 0);
    const latencySample = Boolean(outcome.success) && elapsedMs > 0;
    await this.pool.query(
      `INSERT INTO ${this.table('health_buckets')} (
         workflow_id, endpoint, bucket_start, request_count, success_count,
         structurally_complete_count, nonempty_count, place_count,
         latency_sum_ms, latency_samples
       ) VALUES (
         $1, $2, date_trunc('minute', clock_timestamp()), 1,
         CASE WHEN $3 THEN 1 ELSE 0 END,
         CASE WHEN $4 THEN 1 ELSE 0 END,
         CASE WHEN $5 > 0 THEN 1 ELSE 0 END,
         $5, CASE WHEN $6 THEN $7 ELSE 0 END, CASE WHEN $6 THEN 1 ELSE 0 END
       )
       ON CONFLICT (workflow_id, endpoint, bucket_start) DO UPDATE SET
         request_count = ${this.table('health_buckets')}.request_count + 1,
         success_count = ${this.table('health_buckets')}.success_count + CASE WHEN $3 THEN 1 ELSE 0 END,
         structurally_complete_count = ${this.table('health_buckets')}.structurally_complete_count + CASE WHEN $4 THEN 1 ELSE 0 END,
         nonempty_count = ${this.table('health_buckets')}.nonempty_count + CASE WHEN $5 > 0 THEN 1 ELSE 0 END,
         place_count = ${this.table('health_buckets')}.place_count + $5,
         latency_sum_ms = ${this.table('health_buckets')}.latency_sum_ms + CASE WHEN $6 THEN $7 ELSE 0 END,
         latency_samples = ${this.table('health_buckets')}.latency_samples + CASE WHEN $6 THEN 1 ELSE 0 END`,
      [
        workflowId, endpoint, Boolean(outcome.success), Boolean(outcome.structureComplete),
        Number(outcome.placeCount || 0), latencySample, Math.round(elapsedMs),
      ],
    );
    if (latencySample) return this.recordOperationLatency(workflowId, endpoint, elapsedMs);
    return this.getTimingPolicy(workflowId, endpoint);
  }

  async teamProductionNormal(workflowId, endpoint, options = {}) {
    const timing = await this.getTimingPolicy(workflowId, endpoint);
    const windowMs = options.windowMs
      || Math.max(30000, Math.min(120000, timing.fleetStallMs * 2));
    const activeWorkerMs = options.activeWorkerMs
      || Math.max(15000, Math.min(90000, timing.progressTimeoutMs * 2));
    const windowMinutes = windowMs / 60000;
    const minSamples = options.minSamples || 20;
    const minSuccessRate = options.minSuccessRate ?? 0.9;
    const minStructureRate = options.minStructureRate ?? 0.9;
    const minPlacesPerRequest = options.minPlacesPerRequest ?? 0.05;
    const minRequestsPerActiveWorkerMinute = options.minRequestsPerActiveWorkerMinute ?? 0.1;
    const result = await this.pool.query(
      `SELECT
         COALESCE(sum(h.request_count), 0)::bigint AS requests,
         COALESCE(sum(h.success_count), 0)::bigint AS successes,
         COALESCE(sum(h.structurally_complete_count), 0)::bigint AS structured,
         COALESCE(sum(h.place_count), 0)::bigint AS places,
         (SELECT count(*) FROM ${this.table('worker_sessions')} w
          WHERE w.workflow_id = $1 AND w.endpoint = $2
            AND w.heartbeat_at >= clock_timestamp() - make_interval(secs => $4::double precision / 1000.0))::bigint AS active_workers
       FROM ${this.table('health_buckets')} h
       WHERE h.workflow_id = $1 AND h.endpoint = $2
         AND h.bucket_start >= date_trunc('minute', clock_timestamp()) - make_interval(secs => $3::double precision / 1000.0)`,
      [workflowId, endpoint, windowMs, activeWorkerMs],
    );
    const row = result.rows[0];
    const requests = Number(row.requests);
    const successes = Number(row.successes);
    const structured = Number(row.structured);
    const places = Number(row.places);
    const activeWorkers = Number(row.active_workers);
    const successRate = requests ? successes / requests : 0;
    const structureRate = requests ? structured / requests : 0;
    const placesPerRequest = requests ? places / requests : 0;
    const requestsPerMinute = requests / windowMinutes;
    const minimumThroughput = Math.max(1, activeWorkers * minRequestsPerActiveWorkerMinute);
    const normal = requests >= minSamples
      && successRate >= minSuccessRate
      && structureRate >= minStructureRate
      && placesPerRequest >= minPlacesPerRequest
      && requestsPerMinute >= minimumThroughput;
    return {
      normal,
      requests,
      successes,
      structured,
      places,
      activeWorkers,
      successRate,
      structureRate,
      placesPerRequest,
      requestsPerMinute,
      minimumThroughput,
      timing,
    };
  }

  async commitOutcome(task, outcome) {
    return inTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM ${this.table('tasks')}
         WHERE workflow_id = $1 AND boundary_id = $2 AND category_group = $3 AND tile_id = $4
         FOR UPDATE`,
        [task.workflow_id, task.boundary_id, task.category_group, task.tile_id],
      );
      if (locked.rowCount !== 1) throw new Error(`unknown task: ${task.task_key}`);
      const current = locked.rows[0];
      if (current.status !== 'CLAIMED' || current.lease_token !== task.lease_token) {
        if (current.last_commit_token === task.lease_token && current.last_commit_result) {
          return current.last_commit_result;
        }
        throw new Error(`task lease lost: ${task.task_key}`);
      }
      const observations = Array.isArray(outcome.observations) ? outcome.observations : [];

      if (observations.length > 0) {
        const json = JSON.stringify(observations.map((item) => ({
          place_id: item.placeId,
          query_text: item.query,
          payload: item.payload,
        })));
        await client.query(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($2::jsonb)
               AS x(place_id text, query_text text, payload jsonb)
           )
           INSERT INTO ${this.table('places')} (workflow_id, place_id, payload)
           SELECT $1, place_id, payload FROM input
           ON CONFLICT (workflow_id, place_id) DO UPDATE SET
             payload = EXCLUDED.payload, last_seen_at = clock_timestamp()`,
          [task.workflow_id, json],
        );
        await client.query(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($5::jsonb)
               AS x(place_id text, query_text text, payload jsonb)
           )
           INSERT INTO ${this.table('poi_observations')}
             (workflow_id, boundary_id, category_group, tile_id, place_id, query_text)
           SELECT $1, $2, $3, $4, place_id, query_text FROM input
           ON CONFLICT DO NOTHING`,
          [task.workflow_id, task.boundary_id, task.category_group, task.tile_id, json],
        );
      }

      let status = outcome.status;
      if (status === 'RETRY' && current.attempt_count >= current.max_attempts) status = 'QUARANTINED';
      const requestCount = Number(outcome.requestCount || 0);
      const placeCount = new Set(observations.map((item) => item.placeId)).size;
      let insertedChildren = 0;

      if (status === 'SPLIT') {
        const children = Array.isArray(outcome.children) ? outcome.children : [];
        if (children.length === 0) throw new Error(`SPLIT outcome has no intersecting children: ${task.task_key}`);
        for (const child of children) {
          const inserted = await client.query(
            `INSERT INTO ${this.table('tasks')} (
               workflow_id, boundary_id, category_group, tile_id, task_key, parent_tile_id,
               tile_zoom, tile_x, tile_y, bbox, priority, estimated_requests, max_attempts
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
             ON CONFLICT (workflow_id, boundary_id, category_group, tile_id) DO NOTHING
             RETURNING tile_id`,
            [
              task.workflow_id, task.boundary_id, task.category_group, child.tileId,
              child.taskKey, task.tile_id, child.zoom, child.x, child.y,
              JSON.stringify(child.bbox), child.priority || current.priority,
              child.estimatedRequests || current.estimated_requests,
              child.maxAttempts || current.max_attempts,
            ],
          );
          insertedChildren += inserted.rowCount;
        }
      }

      const retryDelayMs = Math.max(0, Number(outcome.retryDelayMs || 0));
      const commitResult = { status, insertedChildren, placeCount, requestCount };
      await client.query(
        `UPDATE ${this.table('tasks')}
         SET status = $6,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             request_count = request_count + $7,
             result_place_count = result_place_count + $8,
             error_code = $9, error_message = $10,
             empty_diagnostics = $11::jsonb,
             last_commit_token = $5,
             last_commit_result = $13::jsonb,
             next_attempt_at = CASE WHEN $6 = 'RETRY'
               THEN clock_timestamp() + make_interval(secs => $12::double precision / 1000.0)
               ELSE next_attempt_at END,
             completed_at = CASE WHEN $6 IN (
               'DONE', 'DONE_EMPTY_CONFIRMED', 'DONE_EMPTY_SUSPECT', 'SPLIT', 'QUARANTINED'
             ) THEN clock_timestamp() ELSE NULL END,
             updated_at = clock_timestamp()
         WHERE workflow_id = $1 AND boundary_id = $2 AND category_group = $3 AND tile_id = $4
           AND lease_token = $5`,
        [
          task.workflow_id, task.boundary_id, task.category_group, task.tile_id, task.lease_token,
          status, requestCount, placeCount, outcome.errorCode || null, outcome.errorMessage || null,
          outcome.diagnostics ? JSON.stringify(outcome.diagnostics) : null, retryDelayMs,
          JSON.stringify(commitResult),
        ],
      );

      const terminal = ['DONE', 'DONE_EMPTY_CONFIRMED', 'DONE_EMPTY_SUSPECT', 'QUARANTINED'].includes(status);
      await client.query(
        `UPDATE ${this.table('boundary_runtime')}
         SET reserved_requests = GREATEST(0, reserved_requests - $3),
             request_count = request_count + $4,
             open_tasks = open_tasks
               - CASE WHEN $5 OR $6 THEN 1 ELSE 0 END
               + CASE WHEN $6 THEN $7 ELSE 0 END,
             terminal_tasks = terminal_tasks + CASE WHEN $5 THEN 1 ELSE 0 END,
             split_tasks = split_tasks + CASE WHEN $6 THEN 1 ELSE 0 END,
             quarantined_tasks = quarantined_tasks + CASE WHEN $8 THEN 1 ELSE 0 END,
             suspect_empty_tasks = suspect_empty_tasks + CASE WHEN $9 THEN 1 ELSE 0 END,
             updated_at = clock_timestamp()
         WHERE workflow_id = $1 AND boundary_id = $2`,
        [
          task.workflow_id, task.boundary_id, current.estimated_requests, requestCount,
          terminal, status === 'SPLIT', insertedChildren, status === 'QUARANTINED',
          status === 'DONE_EMPTY_SUSPECT',
        ],
      );
      await client.query(
        `INSERT INTO ${this.table('task_events')}
           (workflow_id, boundary_id, category_group, tile_id, worker_id, from_status, to_status, detail)
         VALUES ($1, $2, $3, $4, $5, 'CLAIMED', $6,
           jsonb_build_object(
             'requests', $7::integer,
             'places', $8::integer,
             'inserted_children', $9::integer,
             'attempt', $10::integer
           ))`,
        [
          task.workflow_id, task.boundary_id, task.category_group, task.tile_id,
          task.lease_owner, status, requestCount, placeCount, insertedChildren, current.attempt_count,
        ],
      );
      return commitResult;
    });
  }

  async progress(workflowId) {
    const result = await this.pool.query(
      `SELECT b.boundary_id, b.boundary_name, br.*,
              CASE WHEN br.open_tasks + br.terminal_tasks = 0 THEN 1
                   ELSE br.terminal_tasks::double precision / (br.open_tasks + br.terminal_tasks) END AS completion_ratio
       FROM ${this.table('boundaries')} b
       JOIN ${this.table('boundary_runtime')} br USING (workflow_id, boundary_id)
       WHERE b.workflow_id = $1
       ORDER BY completion_ratio DESC, b.boundary_id`,
      [workflowId],
    );
    return result.rows;
  }

  async queueState(workflowId) {
    const result = await this.pool.query(
      `SELECT
         count(*) FILTER (WHERE status IN ('PENDING', 'RETRY'))::bigint AS waiting,
         count(*) FILTER (WHERE status = 'CLAIMED')::bigint AS claimed,
         count(*) FILTER (WHERE status = 'QUARANTINED')::bigint AS quarantined,
         count(*) FILTER (WHERE status = 'DONE_EMPTY_SUSPECT')::bigint AS suspect_empty,
         count(*) FILTER (WHERE status IN ('DONE', 'DONE_EMPTY_CONFIRMED', 'DONE_EMPTY_SUSPECT'))::bigint AS done,
         count(*) FILTER (WHERE status = 'SPLIT')::bigint AS split,
         min(next_attempt_at) FILTER (WHERE status = 'RETRY') AS next_retry_at
       FROM ${this.table('tasks')}
       WHERE workflow_id = $1`,
      [workflowId],
    );
    const row = result.rows[0];
    return {
      waiting: Number(row.waiting),
      claimed: Number(row.claimed),
      quarantined: Number(row.quarantined),
      suspectEmpty: Number(row.suspect_empty),
      done: Number(row.done),
      split: Number(row.split),
      nextRetryAt: row.next_retry_at,
    };
  }

  async workflowStatus(workflowId) {
    const [queue, boundaries, budgets, workers, latency] = await Promise.all([
      this.queueState(workflowId),
      this.progress(workflowId),
      this.pool.query(
        `SELECT endpoint, capacity, refill_per_second, tokens, updated_at
         FROM ${this.table('request_budgets')} WHERE workflow_id = $1 ORDER BY endpoint`,
        [workflowId],
      ),
      this.pool.query(
        `SELECT worker_id, endpoint, heartbeat_at, last_progress_at, last_progress_kind,
                last_probe_ok_at, last_probe_error, metadata
         FROM ${this.table('worker_sessions')} WHERE workflow_id = $1 ORDER BY endpoint, worker_id`,
        [workflowId],
      ),
      this.pool.query(
        `SELECT operation, ewma_ms, sample_count, last_sample_ms, updated_at
         FROM ${this.table('operation_latency')} WHERE workflow_id = $1 ORDER BY operation`,
        [workflowId],
      ),
    ]);
    return {
      workflowId,
      capturedAt: new Date().toISOString(),
      queue,
      boundaries,
      budgets: budgets.rows,
      workers: workers.rows,
      latency: latency.rows,
    };
  }

  async markWorkflowComplete(workflowId, manifest = {}) {
    return inTransaction(this.pool, async (client) => {
      const workflow = await client.query(
        `SELECT workflow_id FROM ${this.table('workflows')}
         WHERE workflow_id = $1 FOR UPDATE`,
        [workflowId],
      );
      if (workflow.rowCount !== 1) throw new Error(`unknown workflow: ${workflowId}`);
      const result = await client.query(
        `SELECT
           count(*) FILTER (WHERE status IN ('PENDING', 'RETRY'))::bigint AS waiting,
           count(*) FILTER (WHERE status = 'CLAIMED')::bigint AS claimed,
           count(*) FILTER (WHERE status = 'QUARANTINED')::bigint AS quarantined,
           count(*) FILTER (WHERE status = 'DONE_EMPTY_SUSPECT')::bigint AS suspect_empty
         FROM ${this.table('tasks')} WHERE workflow_id = $1`,
        [workflowId],
      );
      const state = Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
      if (state.waiting || state.claimed || state.quarantined || state.suspect_empty) {
        const error = new Error(`workflow is not strictly finalizable: ${JSON.stringify(state)}`);
        error.statusCode = 409;
        throw error;
      }
      await client.query(
        `UPDATE ${this.table('workflows')}
         SET status = 'COMPLETE', config = config || jsonb_build_object('final_manifest', $2::jsonb),
             updated_at = clock_timestamp()
         WHERE workflow_id = $1`,
        [workflowId, JSON.stringify(manifest)],
      );
      return { workflowId, status: 'COMPLETE', state };
    });
  }

  async requeueTerminal(workflowId, status, options = {}) {
    if (!['DONE_EMPTY_SUSPECT', 'QUARANTINED'].includes(status)) {
      throw new Error(`only suspect-empty or quarantined tasks can be requeued, got ${status}`);
    }
    return inTransaction(this.pool, async (client) => {
      const selectParams = [workflowId, status];
      let boundaryClause = '';
      if (options.boundaryId) {
        selectParams.push(options.boundaryId);
        boundaryClause = `AND boundary_id = $${selectParams.length}`;
      }
      const selected = await client.query(
        `SELECT boundary_id, category_group, tile_id
         FROM ${this.table('tasks')}
         WHERE workflow_id = $1 AND status = $2 ${boundaryClause}
         FOR UPDATE`,
        selectParams,
      );
      const counts = new Map();
      for (const row of selected.rows) counts.set(row.boundary_id, (counts.get(row.boundary_id) || 0) + 1);
      const updateParams = [workflowId, status, Boolean(options.resetAttempts)];
      let updateBoundaryClause = '';
      if (options.boundaryId) {
        updateParams.push(options.boundaryId);
        updateBoundaryClause = 'AND boundary_id = $4';
      }
      await client.query(
        `UPDATE ${this.table('tasks')}
         SET status = 'RETRY', next_attempt_at = clock_timestamp(), completed_at = NULL,
             attempt_count = CASE WHEN $3 THEN 0 ELSE attempt_count END,
             error_code = NULL, error_message = NULL, updated_at = clock_timestamp()
         WHERE workflow_id = $1 AND status = $2 ${updateBoundaryClause}`,
        updateParams,
      );
      for (const [boundaryId, count] of counts) {
        await client.query(
          `UPDATE ${this.table('boundary_runtime')}
           SET open_tasks = open_tasks + $3,
               terminal_tasks = terminal_tasks - $3,
               quarantined_tasks = quarantined_tasks - CASE WHEN $4 = 'QUARANTINED' THEN $3 ELSE 0 END,
               suspect_empty_tasks = suspect_empty_tasks - CASE WHEN $4 = 'DONE_EMPTY_SUSPECT' THEN $3 ELSE 0 END,
               updated_at = clock_timestamp()
           WHERE workflow_id = $1 AND boundary_id = $2`,
          [workflowId, boundaryId, count, status],
        );
      }
      for (const row of selected.rows) {
        await client.query(
          `INSERT INTO ${this.table('task_events')}
             (workflow_id, boundary_id, category_group, tile_id, from_status, to_status, detail)
           VALUES ($1, $2, $3, $4, $5, 'RETRY', '{"reason":"operator_requeue"}'::jsonb)`,
          [workflowId, row.boundary_id, row.category_group, row.tile_id, status],
        );
      }
      return { requeued: selected.rowCount, byBoundary: Object.fromEntries(counts) };
    });
  }
}

module.exports = {
  DEFAULT_SCHEMA,
  createPool,
  inTransaction,
  runMigrations,
  PostgresScheduler,
};
