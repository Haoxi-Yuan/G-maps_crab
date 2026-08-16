#!/usr/bin/env node
'use strict';

const { createPool, PostgresScheduler } = require('./scheduler/postgres-store');

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--workflow');
  const workflowId = index >= 0 ? args[index + 1] : null;
  if (!workflowId) throw new Error('--workflow is required');
  const pool = createPool(process.env.DATABASE_URL, { applicationName: `gmaps-status:${workflowId}`, max: 2 });
  try {
    const scheduler = new PostgresScheduler(pool);
    const [queue, boundaries, budgets, workers] = await Promise.all([
      scheduler.queueState(workflowId),
      scheduler.progress(workflowId),
      pool.query(
        `SELECT endpoint, capacity, refill_per_second, tokens, updated_at
         FROM gmaps_scheduler.request_budgets WHERE workflow_id = $1 ORDER BY endpoint`,
        [workflowId],
      ),
      pool.query(
        `SELECT worker_id, endpoint, heartbeat_at, last_probe_ok_at, last_probe_error
         FROM gmaps_scheduler.worker_sessions WHERE workflow_id = $1 ORDER BY endpoint, worker_id`,
        [workflowId],
      ),
    ]);
    console.log(JSON.stringify({
      workflowId,
      capturedAt: new Date().toISOString(),
      queue,
      boundaries,
      budgets: budgets.rows,
      workers: workers.rows,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
