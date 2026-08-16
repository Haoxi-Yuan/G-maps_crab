'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { acquireLaunchSlot } = require('../../src/scheduler/node-launch-gate');

test('node launch gate enforces its slot limit and releases deterministically', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmaps-launch-gate-'));
  const first = await acquireLaunchSlot(root, { slots: 1, timeoutMs: 1000, pollMs: 50 });
  await assert.rejects(
    acquireLaunchSlot(root, { slots: 1, timeoutMs: 150, pollMs: 50 }),
    /timed out/,
  );
  first.release();
  const second = await acquireLaunchSlot(root, { slots: 1, timeoutMs: 1000, pollMs: 50 });
  second.release();
});
