'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { timingPolicy, updateEwma } = require('../../src/scheduler/adaptive-timing');

test('all time thresholds scale from the successful-response mean', () => {
  const fast = timingPolicy('poi_search', 500, { estimatedRequests: 7, attempt: 2 });
  const slow = timingPolicy('poi_search', 2000, { estimatedRequests: 7, attempt: 2 });
  assert.ok(slow.requestTimeoutMs > fast.requestTimeoutMs);
  assert.ok(slow.progressTimeoutMs > fast.progressTimeoutMs);
  assert.ok(slow.leaseMs > fast.leaseMs);
  assert.ok(slow.retryDelayMs > fast.retryDelayMs);
  assert.ok(slow.heartbeatMs > fast.heartbeatMs);
});

test('adaptive timeouts have short hard caps', () => {
  const request = timingPolicy('poi_search', 60000, { estimatedRequests: 1000, attempt: 10 });
  const launch = timingPolicy('browser_launch', 60000);
  assert.equal(request.requestTimeoutMs, 30000);
  assert.equal(request.progressTimeoutMs, 90000);
  assert.equal(request.leaseMs, 180000);
  assert.equal(request.retryDelayMs, 30000);
  assert.equal(launch.requestTimeoutMs, 45000);
});

test('EWMA clips a successful outlier and converges toward normal samples', () => {
  assert.equal(updateEwma(1000, 0, 750), 750);
  assert.equal(updateEwma(1000, 2, 60000), 1250);
  assert.equal(updateEwma(2000, 20, 1000), 1900);
});
