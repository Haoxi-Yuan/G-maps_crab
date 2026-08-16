'use strict';

const { HttpSchedulerClient } = require('./http-client');
const { createPool, PostgresScheduler } = require('./postgres-store');

function createSchedulerBackend(options = {}) {
  if (process.env.SCHEDULER_URL) {
    const scheduler = new HttpSchedulerClient(process.env.SCHEDULER_URL, {
      tokenFile: process.env.SCHEDULER_API_TOKEN_FILE,
    });
    return { scheduler, transport: 'https', close: () => scheduler.end() };
  }
  const pool = createPool(process.env.DATABASE_URL, {
    applicationName: options.applicationName,
    max: options.max || 3,
  });
  return {
    scheduler: new PostgresScheduler(pool),
    transport: 'postgres',
    close: () => pool.end(),
  };
}

module.exports = { createSchedulerBackend };
