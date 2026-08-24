'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createPool,
  runMigrations,
  PostgresScheduler,
} = require('../../src/scheduler/postgres-store');
const { childTiles, makeTaskKey, makeTileId, tileBounds } = require('../../src/scheduler/tile-id');
const { createSchedulerServer } = require('../../src/scheduler-api');
const { HttpSchedulerClient } = require('../../src/scheduler/http-client');

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL queue claims with SKIP LOCKED and commits split atomically', { skip: !databaseUrl }, async () => {
  const pool = createPool(databaseUrl, { applicationName: 'gmaps-scheduler-test', max: 4 });
  const workflowId = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    await runMigrations(pool);
    const scheduler = new PostgresScheduler(pool);
    const tile = { x: 1, y: 1, zoom: 2 };
    const tileId = makeTileId(tile.x, tile.y, tile.zoom);
    const group = 'cg_0001_test';
    const seed = {
      workflowId,
      boundaries: [{
        boundaryId: 'country', name: 'Country', rootZoom: 2, weight: 1,
        geometry: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -80], [180, -80], [180, 80], [-180, 80], [-180, -80]]] } },
      }],
      categoryGroups: [{ categoryGroup: group, queries: ['Restaurant'], estimatedRequests: 7 }],
      tasks: [{
        boundaryId: 'country', categoryGroup: group, tileId,
        taskKey: makeTaskKey('country', group, tileId),
        ...tile, bbox: tileBounds(tile.x, tile.y, tile.zoom), maxAttempts: 4, estimatedRequests: 7,
      }],
      budgets: [{ endpoint: 'poi_search', capacity: 2, refillPerSecond: 1 }],
    };
    assert.equal((await scheduler.seedWorkflow(seed)).insertedTasks, 1);
    assert.equal((await scheduler.seedWorkflow(seed)).insertedTasks, 0, 'deterministic key must make reseed idempotent');

    assert.equal((await scheduler.getTimingPolicy(workflowId, 'poi_search')).meanMs, 1500);
    await scheduler.recordRequestOutcome(workflowId, 'poi_search', {
      success: true, structureComplete: true, placeCount: 2, elapsedMs: 400,
    });
    assert.equal((await scheduler.getTimingPolicy(workflowId, 'poi_search')).meanMs, 400);
    await scheduler.recordRequestOutcome(workflowId, 'poi_search', {
      success: false, structureComplete: false, placeCount: 0, elapsedMs: 60000,
    });
    assert.equal(
      (await scheduler.getTimingPolicy(workflowId, 'poi_search')).meanMs,
      400,
      'a timeout must not inflate future thresholds',
    );

    await scheduler.registerWorker(workflowId, 'worker-a', 'poi_search');
    const claimed = await scheduler.claimTask(workflowId, 'worker-a', { leaseSeconds: 60 });
    assert.equal(claimed.tile_id, tileId);
    assert.equal(await scheduler.markTaskProgress(claimed, 'test_request_complete'), true);
    assert.equal(await scheduler.heartbeat(claimed, 60, 1000), true);
    const children = childTiles(tile).map((child) => ({
      ...child,
      taskKey: makeTaskKey('country', group, child.tileId),
      estimatedRequests: 7,
      maxAttempts: 4,
    }));
    const committed = await scheduler.commitOutcome(claimed, {
      status: 'SPLIT',
      requestCount: 7,
      children,
      observations: [{
        placeId: 'place-1',
        query: 'Restaurant',
        payload: { _meta: { placeId: 'place-1' }, business: { placeId: 'place-1' } },
      }],
    });
    assert.equal(committed.insertedChildren, 4);
    assert.deepEqual(
      await scheduler.commitOutcome(claimed, {
        status: 'SPLIT', requestCount: 7, children, observations: [],
      }),
      committed,
      'a repeated HTTP commit must return the durable first result',
    );
    const progress = await scheduler.progress(workflowId);
    assert.equal(Number(progress[0].open_tasks), 4);
    assert.equal(Number(progress[0].split_tasks), 1);

    // Force the second child insert to violate the zoom constraint. The first
    // child insert and the observation UPSERT must roll back with it, leaving
    // the claimed parent intact and no orphan child/result rows.
    await scheduler.registerWorker(workflowId, 'worker-b', 'poi_search');
    const childClaim = await scheduler.claimTask(workflowId, 'worker-b', { leaseSeconds: 60 });
    await pool.query(
      `UPDATE gmaps_scheduler.tasks SET last_progress_at = clock_timestamp() - interval '2 minutes'
       WHERE workflow_id = $1 AND boundary_id = $2 AND category_group = $3 AND tile_id = $4`,
      [workflowId, childClaim.boundary_id, childClaim.category_group, childClaim.tile_id],
    );
    assert.equal(
      await scheduler.heartbeat(childClaim, 60, 1000),
      false,
      'heartbeats without recent completed-request progress must not renew a lease',
    );
    assert.equal(await scheduler.markTaskProgress(childClaim, 'test_resume'), true);
    const grandchildren = childTiles({
      x: childClaim.tile_x,
      y: childClaim.tile_y,
      zoom: childClaim.tile_zoom,
    }).map((child) => ({
      ...child,
      taskKey: makeTaskKey('country', group, child.tileId),
      estimatedRequests: 7,
      maxAttempts: 4,
    }));
    grandchildren[1].zoom = 23;
    await assert.rejects(
      scheduler.commitOutcome(childClaim, {
        status: 'SPLIT',
        requestCount: 7,
        children: grandchildren,
        observations: [{
          placeId: 'must-roll-back',
          query: 'Restaurant',
          payload: { _meta: { placeId: 'must-roll-back' } },
        }],
      }),
      /tasks_tile_zoom_check/,
    );
    const rollbackTask = await pool.query(
      `SELECT status FROM gmaps_scheduler.tasks
       WHERE workflow_id = $1 AND boundary_id = 'country' AND category_group = $2 AND tile_id = $3`,
      [workflowId, group, childClaim.tile_id],
    );
    assert.equal(rollbackTask.rows[0].status, 'CLAIMED');
    const rollbackPlace = await pool.query(
      `SELECT count(*)::integer AS n FROM gmaps_scheduler.places
       WHERE workflow_id = $1 AND place_id = 'must-roll-back'`,
      [workflowId],
    );
    assert.equal(rollbackPlace.rows[0].n, 0);
    await scheduler.commitOutcome(childClaim, {
      status: 'RETRY', observations: [], requestCount: 0, retryDelayMs: 0,
      errorCode: 'test_release', errorMessage: 'release after rollback test',
    });

    // A task that consumes its final claim is quarantined instead of silently
    // disappearing. The operator command can deterministically put it back in
    // RETRY and repair the per-boundary counters in the same transaction.
    const exhausted = await scheduler.claimTask(workflowId, 'worker-c', { leaseSeconds: 60 });
    await pool.query(
      `UPDATE gmaps_scheduler.tasks SET max_attempts = attempt_count
       WHERE workflow_id = $1 AND boundary_id = $2 AND category_group = $3 AND tile_id = $4`,
      [workflowId, exhausted.boundary_id, exhausted.category_group, exhausted.tile_id],
    );
    const quarantine = await scheduler.commitOutcome(exhausted, {
      status: 'RETRY', observations: [], requestCount: 3, retryDelayMs: 0,
      errorCode: 'pagination_incomplete', errorMessage: 'three page attempts failed',
    });
    assert.equal(quarantine.status, 'QUARANTINED');
    assert.equal((await scheduler.queueState(workflowId)).quarantined, 1);
    const requeued = await scheduler.requeueTerminal(workflowId, 'QUARANTINED', {
      boundaryId: 'country',
      resetAttempts: true,
    });
    assert.equal(requeued.requeued, 1);
    assert.equal((await scheduler.queueState(workflowId)).quarantined, 0);
    const reset = await pool.query(
      `SELECT status, attempt_count FROM gmaps_scheduler.tasks
       WHERE workflow_id = $1 AND boundary_id = $2 AND category_group = $3 AND tile_id = $4`,
      [workflowId, exhausted.boundary_id, exhausted.category_group, exhausted.tile_id],
    );
    assert.deepEqual(reset.rows[0], { status: 'RETRY', attempt_count: 0 });

    const budget1 = await scheduler.acquireBudget(workflowId, 'poi_search');
    const budget2 = await scheduler.acquireBudget(workflowId, 'poi_search');
    const budget3 = await scheduler.acquireBudget(workflowId, 'poi_search');
    assert.equal(budget1.granted, true);
    assert.equal(budget2.granted, true);
    assert.equal(budget3.granted, false);

    // Finish every remaining task, then exercise the exact Atlas topology:
    // authenticated HTTP queue read, streaming export, and strict completion.
    while (true) {
      const remaining = await scheduler.claimTask(workflowId, 'worker-final', { leaseSeconds: 60 });
      if (!remaining) break;
      await scheduler.commitOutcome(remaining, {
        status: 'DONE', observations: [], requestCount: 1,
      });
    }
    assert.deepEqual(
      Object.fromEntries(Object.entries(await scheduler.queueState(workflowId)).filter(([key]) => (
        ['waiting', 'claimed', 'quarantined', 'suspectEmpty'].includes(key)
      ))),
      { waiting: 0, claimed: 0, quarantined: 0, suspectEmpty: 0 },
    );

    const token = 'postgres-integration-token-with-32-characters';
    const server = createSchedulerServer(scheduler, { token });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const client = new HttpSchedulerClient(`http://127.0.0.1:${server.address().port}`, { token });
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gmaps-http-export-'));
    try {
      const places = await client.downloadExport(workflowId, 'places.ndjson', path.join(output, 'places.ndjson'));
      const memberships = await client.downloadExport(
        workflowId,
        'place_boundaries.ndjson',
        path.join(output, 'place_boundaries.ndjson'),
      );
      assert.equal(places.rows, 1);
      assert.equal(memberships.rows, 1);
      assert.equal((await client.markWorkflowComplete(workflowId, { places, memberships })).status, 'COMPLETE');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(output, { recursive: true, force: true });
    }
  } finally {
    await pool.query('DELETE FROM gmaps_scheduler.workflows WHERE workflow_id = $1', [workflowId]).catch(() => {});
    await pool.end();
  }
});
