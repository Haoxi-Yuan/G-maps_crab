#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  capturePbTemplate,
  fetchPage,
  fetchCellPaginated,
  searchCell,
  createBBox,
} = require('../src/poi-searcher-api');
const { areaOutputDir, validateCategoryCoverage } = require('../src/multi-boundary-orchestrator');

const place = (ftid) => ({ ftid, lat: 1.3, lng: 103.8, mainCategory: 'Test' });

async function testEmptyResponseSlotIsTerminal() {
  const originalFetch = global.fetch;
  const data = new Array(65).fill(null);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://www.google.com/search?tbm=map',
    text: async () => `)]}'\n${JSON.stringify(data)}`,
  });
  const page = { evaluate: (fn, args) => fn(args), close: async () => {} };
  try {
    const result = await fetchPage(page, 'park', 1.3, 103.8, 100, '!10b', 0, { requestTimeoutMs: 100 });
    assert.deepEqual(result, { places: [] });
  } finally {
    global.fetch = originalFetch;
  }
}

async function testBlockedResponseIsRetryable() {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://www.google.com/sorry/index',
    text: async () => '<html>unusual traffic captcha</html>',
  });
  const page = { evaluate: (fn, args) => fn(args), close: async () => {} };
  try {
    const result = await fetchPage(page, 'park', 1.3, 103.8, 100, '!10b', 0, { requestTimeoutMs: 100 });
    assert.equal(result.error, 'blocked_response');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testResumeStillPaginatesDuplicates() {
  const first = Array.from({ length: 20 }, (_, i) => place(`dup-${i}`));
  const responses = [{ places: first }, { places: [place('new-on-page-2')] }];
  const page = {
    evaluate: async () => responses.shift(),
    waitForTimeout: async () => {},
    close: async () => {},
  };
  const ids = new Set(first.map((entry) => entry.ftid));
  const result = await fetchCellPaginated(
    page, 'park', 1.3, 103.8, 100, '!10b', ids,
    { requests: 0, errors: 0, totalIds: 0 },
    { maxPaginationPages: 2, requestDelayMs: 0 },
  );
  assert.deepEqual(result.newIds, ['new-on-page-2']);
  assert.equal(ids.has('new-on-page-2'), true);
  assert.equal(responses.length, 0);
}

async function testResumeStillSubdividesSaturatedCell() {
  const first = Array.from({ length: 20 }, (_, i) => place(`dup-${i}`));
  const responses = [{ places: first }, ...Array.from({ length: 4 }, () => ({ places: [] }))];
  let calls = 0;
  const page = {
    evaluate: async () => { calls++; return responses.shift(); },
    waitForTimeout: async () => {},
    close: async () => {},
  };
  await searchCell(
    page, 'park', createBBox(1.3, 103.8, 1), '!10b',
    new Set(first.map((entry) => entry.ftid)),
    { requests: 0, errors: 0, totalIds: 0 }, 0,
    { maxPaginationPages: 1, maxDepth: 1, minCellSizeKm: 0.1, requestDelayMs: 0 },
  );
  assert.equal(calls, 5, 'a saturated duplicate parent must still visit four child cells');
}

async function testFetchErrorsDoNotAdvanceCheckpoint() {
  let calls = 0;
  const page = {
    evaluate: async () => { calls++; return { error: 'blocked_response', places: [] }; },
    waitForTimeout: async () => {},
    close: async () => {},
  };
  await assert.rejects(
    fetchCellPaginated(
      page, 'park', 1.3, 103.8, 100, '!10b', new Set(),
      { requests: 0, errors: 0, totalIds: 0 },
      { maxRetries: 2, retryDelayMs: 0 },
    ),
    (error) => error.code === 'MAP_FETCH_FAILED',
  );
  assert.equal(calls, 3);
}

async function testCaptureHasOuterDeadline() {
  let closed = false;
  const page = {
    on: () => {},
    off: () => {},
    goto: () => new Promise(() => {}),
    waitForTimeout: async () => {},
    close: async () => { closed = true; },
  };
  await assert.rejects(
    capturePbTemplate(page, 'park', 1.3, 103.8, { captureTimeoutMs: 10 }),
    (error) => error.code === 'OPERATION_TIMEOUT',
  );
  assert.equal(closed, true);
}

function testMarkerAndCoverageInvariants() {
  const output = areaOutputDir({ dirSlug: 'batch__park', relDir: '_batches/batch/batch__park' });
  assert.match(output, /output\/_batches\/batch\/batch__park$/);
  validateCategoryCoverage({ results: [{ category: 'a' }, { category: 'b' }] }, ['a', 'b']);
  assert.throws(
    () => validateCategoryCoverage({ results: [{ category: 'a' }] }, ['a', 'b']),
    /Incomplete category coverage/,
  );
}

(async () => {
  await testEmptyResponseSlotIsTerminal();
  await testBlockedResponseIsRetryable();
  await testResumeStillPaginatesDuplicates();
  await testResumeStillSubdividesSaturatedCell();
  await testFetchErrorsDoNotAdvanceCheckpoint();
  await testCaptureHasOuterDeadline();
  testMarkerAndCoverageInvariants();
  console.log('POI resume and failure-boundary tests: passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
