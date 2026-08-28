'use strict';

// Fast resume via the done-index sidecar, and the cheap prefix scan that bootstraps
// it. Correctness contract: the resume set is exactly the reviewers with a terminal
// (non-error) record; the sidecar may only ever LAG (re-fetch), never wrong-skip.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  appendDoneId,
  completedReviewerIds,
  doneSidecarPath,
  extractResumeSignal,
} = require('../src/reviewer-profile-scraper');

// Build representative output lines matching the real record prefix.
function terminalLine(id, status = 'complete', pad = 0) {
  const reviews = pad ? `,"reviews":[${'"r",'.repeat(pad).slice(0, -1)}]` : '';
  return JSON.stringify({ a: 1 }).slice(0, 0) // no-op to keep prettier calm
    + `{"extracted_at":"2026-08-24T10:00:00.000Z","reviewer_id":"${id}","reviewer":{"reviewer_id":"${id}","reviewer_name":"N"}`
    + `,"public_content":{"returned_review_count":200${reviews}},"_status":"${status}","_source":"x"}`;
}
function errorLine(id) {
  return `{"extracted_at":"2026-08-24T10:00:00.000Z","reviewer_id":"${id}","reviewer":null,"public_content":null,"_status":"error","_error":"boom"}`;
}

// Old semantics: full JSON.parse, done = ids with a non-error record.
function referenceDoneSet(lines) {
  const done = new Set();
  for (const line of lines) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.reviewer_id && r._status !== 'error') done.add(r.reviewer_id);
  }
  return done;
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-resume-')); }

function testExtractSignal() {
  const big = terminalLine('100000000000000000001', 'service_cap', 400); // ~oversized, id still in prefix
  assert.deepEqual(extractResumeSignal(big), { id: '100000000000000000001', terminal: true });
  assert.deepEqual(extractResumeSignal(errorLine('100000000000000000002')), { id: '100000000000000000002', terminal: false });
  // A reordered record (reviewer before reviewer_id) must NOT be mis-parsed by the
  // prefix regex — it returns null so the caller falls back to a full parse.
  const reordered = '{"reviewer":{"x":1},"reviewer_id":"100000000000000000003","_status":"complete"}';
  assert.equal(extractResumeSignal(reordered), null);
  console.log('extractResumeSignal: prefix parse, oversized record, reorder-safe fallback: passed');
}

async function testBuildAndParity() {
  const dir = tmpDir();
  const output = path.join(dir, 'out.ndjson');
  const lines = [
    terminalLine('100000000000000000001', 'complete'),
    errorLine('100000000000000000002'),
    terminalLine('100000000000000000003', 'service_cap', 300),
    // reordered terminal → exercises the JSON.parse fallback inside the build scan
    '{"extracted_at":"t","reviewer":{"x":1},"reviewer_id":"100000000000000000004","_status":"complete"}',
    terminalLine('100000000000000000002', 'complete'), // a later terminal for the earlier error id
  ];
  fs.writeFileSync(output, `${lines.join('\n')}\n`);

  // No sidecar yet -> full scan builds it.
  const built = await completedReviewerIds(output);
  const reference = referenceDoneSet(lines);
  assert.deepEqual([...built].sort(), [...reference].sort(), 'cheap-scan done-set must equal full-parse done-set');
  assert.ok(fs.existsSync(doneSidecarPath(output)), 'a sidecar must be written on bootstrap');
  // error-only id would be absent, but here 002 has a later terminal -> present.
  assert.ok(built.has('100000000000000000002'), 'an id with a later terminal record is done');
  assert.ok(built.has('100000000000000000004'), 'the reordered terminal is recovered via fallback');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('build + parity with full-parse semantics (incl. reorder fallback): passed');
}

async function testSidecarFastPathTrusted() {
  const dir = tmpDir();
  const output = path.join(dir, 'out.ndjson');
  // Output has two terminals...
  fs.writeFileSync(output, `${[terminalLine('1'.padEnd(21, '0')), terminalLine('2'.padEnd(21, '0'))].join('\n')}\n`);
  // ...but a pre-existing sidecar lists only one. The fast path must TRUST the
  // sidecar (return just that one) and not re-scan the output. A lagging sidecar
  // only causes re-fetch of the missing id — the safe direction.
  const sidecar = doneSidecarPath(output);
  fs.writeFileSync(sidecar, '100000000000000000000\n');
  const done = await completedReviewerIds(output);
  assert.deepEqual([...done], ['100000000000000000000'], 'fast path returns the sidecar verbatim');

  // rebuild=true ignores the stale sidecar and rescans the output (both ids).
  const rebuilt = await completedReviewerIds(output, { rebuild: true });
  assert.equal(rebuilt.size, 2, 'rebuild rescans the full output');
  assert.equal((fs.readFileSync(sidecar, 'utf8').trim().split('\n').length), 2, 'rebuild rewrites the sidecar');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('sidecar fast path is trusted; --rebuild rescans and rewrites: passed');
}

async function testLiveAppendConsistency() {
  const dir = tmpDir();
  const output = path.join(dir, 'out.ndjson');
  fs.writeFileSync(output, `${terminalLine('100000000000000000009')}\n`);
  const sidecar = doneSidecarPath(output);
  await completedReviewerIds(output); // builds sidecar with the one id
  // A live run appends a new terminal id to the sidecar as it writes.
  appendDoneId(sidecar, '100000000000000000010');
  const done = await completedReviewerIds(output);
  assert.ok(done.has('100000000000000000009') && done.has('100000000000000000010'), 'live-appended ids resume without a rescan');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('live appendDoneId is picked up on next resume: passed');
}

async function main() {
  testExtractSignal();
  await testBuildAndParity();
  await testSidecarFastPathTrusted();
  await testLiveAppendConsistency();
  console.log('Reviewer resume done-index tests: passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
