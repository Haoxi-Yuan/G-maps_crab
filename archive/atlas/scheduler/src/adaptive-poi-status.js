#!/usr/bin/env node
'use strict';

const { createSchedulerBackend } = require('./scheduler/backend');

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--workflow');
  const workflowId = index >= 0 ? args[index + 1] : null;
  if (!workflowId) throw new Error('--workflow is required');
  const backend = createSchedulerBackend({ applicationName: `gmaps-status:${workflowId}`, max: 2 });
  try {
    console.log(JSON.stringify(await backend.scheduler.workflowStatus(workflowId), null, 2));
  } finally {
    await backend.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
