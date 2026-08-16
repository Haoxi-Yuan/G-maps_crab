#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createPool, PostgresScheduler } = require('./scheduler/postgres-store');
const { HttpSchedulerClient } = require('./scheduler/http-client');

function parseArgs(argv) {
  const opts = {
    workflowId: null,
    outputDir: null,
    allowQuarantined: false,
    allowSuspectEmpty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workflow') opts.workflowId = argv[++i];
    else if (argv[i] === '--output') opts.outputDir = argv[++i];
    else if (argv[i] === '--allow-quarantined') opts.allowQuarantined = true;
    else if (argv[i] === '--allow-suspect-empty') opts.allowSuspectEmpty = true;
    else if (argv[i] === '--help') {
      console.log(`
Adaptive POI finalizer and Review input barrier

Usage:
  DATABASE_URL=... node src/adaptive-poi-finalize.js --workflow <id> --output <dir>
  SCHEDULER_URL=https://... SCHEDULER_API_TOKEN_FILE=... \
    node src/adaptive-poi-finalize.js --workflow <id> --output <dir>

The default is strict: any open/claimed, QUARANTINED, or suspect-empty tile
prevents the completion marker. A successful run exports globally deduplicated
places.ndjson plus place_boundaries.ndjson and writes _poi_batch_complete.json.
`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!opts.workflowId || !opts.outputDir) throw new Error('--workflow and --output are required');
  return opts;
}

async function writeQuery(pool, QueryStream, sql, params, outputFile, rowToLine) {
  const temp = `${outputFile}.tmp`;
  const stream = fs.createWriteStream(temp, { encoding: 'utf8' });
  const hash = crypto.createHash('sha256');
  let rows = 0;
  const client = await pool.connect();
  try {
    const query = client.query(new QueryStream(sql, params, { batchSize: 1000 }));
    for await (const row of query) {
      const line = rowToLine(row) + '\n';
      hash.update(line);
      rows++;
      if (!stream.write(line)) await new Promise((resolve) => stream.once('drain', resolve));
    }
    await new Promise((resolve, reject) => {
      stream.once('error', reject);
      stream.end(resolve);
    });
    fs.renameSync(temp, outputFile);
    return { rows, sha256: hash.digest('hex'), bytes: fs.statSync(outputFile).size };
  } catch (error) {
    stream.destroy();
    try { fs.unlinkSync(temp); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function assertFinalizable(state, opts) {
  if (state.waiting > 0 || state.claimed > 0) {
    throw new Error(`POI queue is not terminal: waiting=${state.waiting} claimed=${state.claimed}`);
  }
  if (state.quarantined > 0 && !opts.allowQuarantined) {
    throw new Error(`${state.quarantined} tile(s) are QUARANTINED; repair/requeue before finalizing`);
  }
  if (state.suspectEmpty > 0 && !opts.allowSuspectEmpty) {
    throw new Error(`${state.suspectEmpty} empty tile(s) remain suspect; audit/requeue before finalizing`);
  }
}

function writeMarker(outputDir, marker) {
  const markerTemp = path.join(outputDir, '_poi_batch_complete.json.tmp');
  const markerFile = path.join(outputDir, '_poi_batch_complete.json');
  fs.writeFileSync(markerTemp, JSON.stringify(marker, null, 2) + '\n');
  fs.renameSync(markerTemp, markerFile);
}

async function finalizeOverHttp(opts) {
  if (opts.allowQuarantined || opts.allowSuspectEmpty) {
    throw new Error('remote finalization is strict; repair exceptional tiles before exporting');
  }
  const scheduler = new HttpSchedulerClient(process.env.SCHEDULER_URL, {
    tokenFile: process.env.SCHEDULER_API_TOKEN_FILE,
  });
  const state = await scheduler.queueState(opts.workflowId);
  assertFinalizable(state, opts);
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const placesFile = path.join(opts.outputDir, 'places.ndjson');
  const membershipFile = path.join(opts.outputDir, 'place_boundaries.ndjson');
  const places = await scheduler.downloadExport(opts.workflowId, 'places.ndjson', placesFile);
  const memberships = await scheduler.downloadExport(
    opts.workflowId,
    'place_boundaries.ndjson',
    membershipFile,
  );
  const progress = await scheduler.progress(opts.workflowId);
  const marker = {
    workflowId: opts.workflowId,
    completedAt: new Date().toISOString(),
    queue: state,
    boundaries: progress.length,
    places,
    memberships,
    reviewInput: placesFile,
    schedulerTransport: 'https',
    qualityPolicy: { allowQuarantined: false, allowSuspectEmpty: false },
  };
  await scheduler.markWorkflowComplete(opts.workflowId, marker);
  writeMarker(opts.outputDir, marker);
  console.log(JSON.stringify(marker, null, 2));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.env.SCHEDULER_URL) {
    await finalizeOverHttp(opts);
    return;
  }
  const pool = createPool(process.env.DATABASE_URL, { applicationName: `gmaps-finalize:${opts.workflowId}`, max: 3 });
  const scheduler = new PostgresScheduler(pool);
  try {
    const state = await scheduler.queueState(opts.workflowId);
    assertFinalizable(state, opts);

    fs.mkdirSync(opts.outputDir, { recursive: true });
    const QueryStream = require('pg-query-stream');
    const placesFile = path.join(opts.outputDir, 'places.ndjson');
    const membershipFile = path.join(opts.outputDir, 'place_boundaries.ndjson');
    const places = await writeQuery(
      pool,
      QueryStream,
      `SELECT payload FROM gmaps_scheduler.places WHERE workflow_id = $1 ORDER BY place_id`,
      [opts.workflowId],
      placesFile,
      (row) => JSON.stringify(row.payload),
    );
    const memberships = await writeQuery(
      pool,
      QueryStream,
      `SELECT place_id, jsonb_agg(DISTINCT boundary_id ORDER BY boundary_id) AS boundary_ids
       FROM gmaps_scheduler.poi_observations
       WHERE workflow_id = $1
       GROUP BY place_id ORDER BY place_id`,
      [opts.workflowId],
      membershipFile,
      (row) => JSON.stringify({ placeId: row.place_id, boundaryIds: row.boundary_ids }),
    );

    const progress = await scheduler.progress(opts.workflowId);
    const marker = {
      workflowId: opts.workflowId,
      completedAt: new Date().toISOString(),
      queue: state,
      boundaries: progress.length,
      places,
      memberships,
      reviewInput: placesFile,
      qualityPolicy: {
        allowQuarantined: opts.allowQuarantined,
        allowSuspectEmpty: opts.allowSuspectEmpty,
      },
    };
    if (!opts.allowQuarantined && !opts.allowSuspectEmpty) {
      await scheduler.markWorkflowComplete(opts.workflowId, marker);
    } else {
      await pool.query(
        `UPDATE gmaps_scheduler.workflows
         SET status = 'COMPLETE', updated_at = clock_timestamp()
         WHERE workflow_id = $1`,
        [opts.workflowId],
      );
    }
    writeMarker(opts.outputDir, marker);
    console.log(JSON.stringify(marker, null, 2));
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

module.exports = { writeQuery, assertFinalizable, finalizeOverHttp };
