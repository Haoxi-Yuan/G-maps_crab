'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchCellPaginated,
  searchCell,
  createBBox,
} = require('../../src/poi-searcher-api');

const pbTemplate = '!1d100!2d103.8!3d1.3!8i0!10b';

test('three failed page attempts make pagination incomplete', async () => {
  let attempts = 0;
  const page = {
    evaluate: async () => { attempts++; return { error: 'request_timeout', structureComplete: false, places: [] }; },
    waitForTimeout: async () => {},
  };
  const stats = { requests: 0, errors: 0, totalIds: 0 };
  const result = await fetchCellPaginated(
    page, 'Restaurant', 1.3, 103.8, 100, pbTemplate, new Set(), stats,
    { maxRetries: 2, retryDelayMs: 0 },
  );
  assert.equal(attempts, 3);
  assert.equal(result.paginationComplete, false);
  assert.equal(result.fetchError, 'request_timeout');
  assert.equal(stats.errors, 1);
});

test('legacy recursive search throws instead of completing an incomplete tile', async () => {
  const page = {
    evaluate: async () => ({ error: 'request_timeout', structureComplete: false, places: [] }),
    waitForTimeout: async () => {},
  };
  const bbox = createBBox(1.3, 103.8, 1);
  await assert.rejects(
    searchCell(
      page, 'Restaurant', bbox, pbTemplate, new Set(),
      { requests: 0, errors: 0, totalIds: 0 }, 0,
      { maxRetries: 2, retryDelayMs: 0 },
    ),
    (error) => error && error.code === 'PAGINATION_INCOMPLETE',
  );
});

test('a structurally complete empty response remains a valid empty page', async () => {
  const page = {
    evaluate: async () => ({ places: [], structureComplete: true, httpStatus: 200 }),
    waitForTimeout: async () => {},
  };
  const result = await fetchCellPaginated(
    page, 'Restaurant', 1.3, 103.8, 100, pbTemplate, new Set(),
    { requests: 0, errors: 0, totalIds: 0 },
    { maxRetries: 2, retryDelayMs: 0 },
  );
  assert.equal(result.paginationComplete, true);
  assert.equal(result.responseStructureComplete, true);
  assert.equal(result.newIds.length, 0);
});
