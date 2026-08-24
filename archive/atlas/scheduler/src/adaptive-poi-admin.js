#!/usr/bin/env node
'use strict';

const { createPool, PostgresScheduler } = require('./scheduler/postgres-store');

async function main() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const workflowId = get('--workflow');
  const boundaryId = get('--boundary');
  const requeueSuspect = args.includes('--requeue-suspect-empty');
  const requeueQuarantined = args.includes('--requeue-quarantined');
  const resetAttempts = args.includes('--reset-attempts');
  if (!workflowId) throw new Error('--workflow is required');
  if (requeueSuspect === requeueQuarantined) {
    throw new Error('choose exactly one of --requeue-suspect-empty or --requeue-quarantined');
  }
  const pool = createPool(process.env.DATABASE_URL, { applicationName: `gmaps-admin:${workflowId}` });
  try {
    const scheduler = new PostgresScheduler(pool);
    const result = await scheduler.requeueTerminal(
      workflowId,
      requeueSuspect ? 'DONE_EMPTY_SUSPECT' : 'QUARANTINED',
      { boundaryId, resetAttempts },
    );
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
