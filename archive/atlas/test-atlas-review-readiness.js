#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { inspectPOIState, waitForPOI } = require('../scripts/hpc/atlas-review-batch-worker');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-review-ready-'));
  const outDir = path.join(root, 'area');
  const groupStatus = path.join(root, 'poi_group_1.status');
  fs.mkdirSync(outDir);
  return { root, outDir, groupStatus };
}

test('waits while neither an area marker nor group completion exists', () => {
  const { root, outDir, groupStatus } = fixture();
  try {
    const state = inspectPOIState(outDir, groupStatus);
    assert.equal(state.terminal, false);
    assert.equal(state.ready, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('starts from a completed area while the POI group is still running', () => {
  const { root, outDir, groupStatus } = fixture();
  try {
    fs.writeFileSync(path.join(outDir, '_area_complete.json'), '{}\n');
    fs.writeFileSync(path.join(outDir, 'places.ndjson'), '{"place_id":"p1"}\n');
    const state = inspectPOIState(outDir, groupStatus);
    assert.equal(state.ready, true);
    assert.equal(state.partial, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uses partial places only after the matching POI group finishes', () => {
  const { root, outDir, groupStatus } = fixture();
  try {
    fs.writeFileSync(path.join(outDir, 'places.ndjson'), '{"place_id":"p1"}\n');
    assert.equal(inspectPOIState(outDir, groupStatus).terminal, false);
    fs.writeFileSync(groupStatus, 'failures=1\n');
    const state = inspectPOIState(outDir, groupStatus);
    assert.equal(state.ready, true);
    assert.equal(state.partial, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('treats an empty completed POI area as having no review input', () => {
  const { root, outDir, groupStatus } = fixture();
  try {
    fs.writeFileSync(path.join(outDir, 'places.ndjson'), '');
    fs.writeFileSync(groupStatus, 'failures=0\n');
    const state = inspectPOIState(outDir, groupStatus);
    assert.equal(state.noInput, true);
    assert.equal(state.ready, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wait helper times out rather than skipping an active POI area', async () => {
  const { root, outDir, groupStatus } = fixture();
  try {
    const state = await waitForPOI(outDir, groupStatus, 0.01, 0.03, '[TEST]');
    assert.equal(state.timedOut, true);
    assert.equal(state.terminal, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
