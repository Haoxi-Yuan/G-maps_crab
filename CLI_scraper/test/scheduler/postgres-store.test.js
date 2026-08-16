'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPool,
  runMigrations,
  PostgresScheduler,
} = require('../../src/scheduler/postgres-store');
const { childTiles, makeTaskKey, makeTileId, tileBounds } = require('../../src/scheduler/tile-id');

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

    const claimed = await scheduler.claimTask(workflowId, 'worker-a', { leaseSeconds: 60 });
    assert.equal(claimed.tile_id, tileId);
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
    const progress = await scheduler.progress(workflowId);
    assert.equal(Number(progress[0].open_tasks), 4);
    assert.equal(Number(progress[0].split_tasks), 1);

    // Force the second child insert to violate the zoom constraint. The first
    // child insert and the observation UPSERT must roll back with it, leaving
    // the claimed parent intact and no orphan child/result rows.
    const childClaim = await scheduler.claimTask(workflowId, 'worker-b', { leaseSeconds: 60 });
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
  } finally {
    await pool.query('DELETE FROM gmaps_scheduler.workflows WHERE workflow_id = $1', [workflowId]).catch(() => {});
    await pool.end();
  }
});
