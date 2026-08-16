'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildSeedPlan, makeCategoryGroups } = require('../../src/adaptive-poi-seed');

test('category groups have stable content-derived identities', () => {
  const first = makeCategoryGroups(['Cafe', 'Park', 'Restaurant'], 2, 7);
  const second = makeCategoryGroups(['Cafe', 'Park', 'Restaurant'], 2, 7);
  assert.deepEqual(first, second);
  assert.equal(first[0].estimatedRequests, 14);
});

test('one huge boundary is spatially decomposed when category parallelism is insufficient', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmaps-seed-test-'));
  const boundaryFile = path.join(temp, 'country.geojson');
  const categoryFile = path.join(temp, 'categories.json');
  fs.writeFileSync(boundaryFile, JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: 'large_test_country',
      properties: { name: 'Large Test Country' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-10, 35], [30, 35], [30, 60], [-10, 60], [-10, 35]]],
      },
    }],
  }));
  fs.writeFileSync(categoryFile, JSON.stringify({ categories: ['Restaurant'] }));
  const plan = await buildSeedPlan({
    boundariesFile: boundaryFile,
    categoriesFile: categoryFile,
    categoryGroupSize: 1,
    maxPages: 7,
    expectedWorkers: 96,
    targetTasksPerWorker: 4,
    rootZoom: null,
    minRootZoom: 0,
    maxRootZoom: 16,
    maxRootTilesPerBoundary: 1024,
    maxAttempts: 4,
  });
  assert.equal(plan.boundaries.length, 1);
  assert.ok(plan.tasks.length >= 96, `expected substantial initial parallelism, got ${plan.tasks.length}`);
  assert.ok(plan.tasks.length <= 1024);
  assert.equal(new Set(plan.tasks.map((task) => task.taskKey)).size, plan.tasks.length);
});

test('many boundary/category combinations do not multiply tile-seam roots', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmaps-seed-small-test-'));
  const boundaryFile = path.join(temp, 'parks.geojson');
  const categoryFile = path.join(temp, 'categories.json');
  fs.writeFileSync(boundaryFile, JSON.stringify({
    type: 'FeatureCollection',
    features: Array.from({ length: 10 }, (_, index) => ({
      type: 'Feature',
      id: `park_${index}`,
      properties: { name: `Park ${index}` },
      // Straddles longitude 0, which is a Web Mercator seam at every zoom.
      geometry: {
        type: 'Polygon',
        coordinates: [[[-0.0001, 1], [0.0001, 1], [0.0001, 1.0002], [-0.0001, 1.0002], [-0.0001, 1]]],
      },
    })),
  }));
  fs.writeFileSync(categoryFile, JSON.stringify({ categories: Array.from({ length: 20 }, (_, index) => `Category ${index}`) }));
  const plan = await buildSeedPlan({
    boundariesFile: boundaryFile,
    categoriesFile: categoryFile,
    categoryGroupSize: 1,
    maxPages: 7,
    expectedWorkers: 8,
    targetTasksPerWorker: 4,
    rootZoom: null,
    minRootZoom: 0,
    maxRootZoom: 16,
    maxRootTilesPerBoundary: 1024,
    maxAttempts: 4,
  });
  assert.equal(plan.tasks.length, 10 * 20);
  assert.ok(plan.boundaries.every((boundary) => boundary.metadata.rootTiles === 1));
});
