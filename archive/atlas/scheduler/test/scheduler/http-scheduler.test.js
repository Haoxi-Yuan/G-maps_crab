'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSchedulerServer } = require('../../src/scheduler-api');
const { HttpSchedulerClient } = require('../../src/scheduler/http-client');

const token = 'test-token-with-at-least-thirty-two-characters';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP scheduler exposes only authenticated RPC methods', async (t) => {
  const calls = [];
  const scheduler = {
    async queueState(workflowId) {
      calls.push(['queueState', workflowId]);
      return { waiting: 3, claimed: 1 };
    },
    async getTimingPolicy() {
      return { meanMs: 250, requestTimeoutMs: 5000, idlePollMs: 500 };
    },
  };
  const server = createSchedulerServer(scheduler, { token });
  let baseUrl;
  try {
    baseUrl = await listen(server);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('sandbox does not permit a loopback listener');
      return;
    }
    throw error;
  }
  try {
    const client = new HttpSchedulerClient(baseUrl, { token });
    assert.deepEqual(await client.queueState('workflow-a'), { waiting: 3, claimed: 1 });
    assert.deepEqual(calls, [['queueState', 'workflow-a']]);

    const denied = new HttpSchedulerClient(baseUrl, { token: `${token}-wrong` });
    await assert.rejects(denied.queueState('workflow-a'), /unauthorized/);

    const response = await fetch(`${baseUrl}/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'constructor', args: [] }),
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
