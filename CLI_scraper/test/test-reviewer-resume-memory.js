'use strict';

// Regression: the resume set must not retain its source records.
//
// extractResumeSignal returns an id captured from a slice of the output line.
// A V8 sliced string keeps its parent alive, so storing the id in the resume
// Set used to pin the whole record — up to ~120 KB for a service_cap profile.
// buildDoneIndexFromOutput therefore grew with (ids x record size): a 13.7 GB
// production shard reached 28 GB RSS without finishing, and OOMed under the
// default heap. Retention per id must stay proportional to the id, not the
// record.
//
// Measured on the fix: 81 bytes/id, versus 100153 bytes/id before it.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const RECORD_BYTES = 50000;
const IDS = 8000;
// Generous: ~250x the observed 81 bytes/id, but ~25x below one record. Any
// re-introduction of parent retention lands far above this.
const MAX_BYTES_PER_ID = 2000;

const probe = `
  const { extractResumeSignal } = require(${JSON.stringify(path.resolve(__dirname, '../src/reviewer-profile-scraper.js'))});
  const pad = 'x'.repeat(${RECORD_BYTES});
  const line = (i) =>
    '{"extracted_at":"2026-08-24T10:00:00.000Z","reviewer_id":"' + (100000000000000000000n + BigInt(i)) +
    '","reviewer":{"reviewer_name":"N"},"pad":"' + pad + '"}';
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const done = new Set();
  for (let i = 0; i < ${IDS}; i += 1) {
    const signal = extractResumeSignal(line(i));
    if (signal && signal.terminal) done.add(signal.id);
  }
  global.gc();
  const after = process.memoryUsage().heapUsed;
  if (done.size !== ${IDS}) { console.log('SIZE_MISMATCH ' + done.size); process.exit(2); }
  console.log(String((after - before) / done.size));
`;

function testResumeSetDoesNotRetainRecords() {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', probe], { encoding: 'utf8' });
  assert.equal(result.status, 0, `probe failed: ${result.stderr || result.stdout}`);
  const bytesPerId = Number(result.stdout.trim());
  assert.ok(Number.isFinite(bytesPerId), `probe printed no measurement: ${result.stdout}`);
  assert.ok(
    bytesPerId < MAX_BYTES_PER_ID,
    `resume set retains ${bytesPerId.toFixed(0)} bytes per id (limit ${MAX_BYTES_PER_ID}); `
    + `records are ${RECORD_BYTES} bytes, so the ids are pinning their source lines again`,
  );
  console.log(`resume set retention: ${bytesPerId.toFixed(0)} bytes/id with ${RECORD_BYTES}-byte records: passed`);
}

testResumeSetDoesNotRetainRecords();
console.log('Reviewer resume memory tests: passed');
