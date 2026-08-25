'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { completedReviewerIds } = require('../src/reviewer-profile-scraper');
const { pendingReviewers, SmoothGate } = require('../src/reviewer-profile-parallel-scraper');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-parallel-test-'));
  try {
    const list0 = path.join(directory, 'list0.ndjson');
    const list1 = path.join(directory, 'list1.ndjson');
    const output0 = path.join(directory, 'output0.ndjson');
    const output1 = path.join(directory, 'output1.ndjson');
    fs.writeFileSync(list0, [
      { reviewer_id: '10000001', reviewer_link: 'https://www.google.com/maps/contrib/10000001/reviews' },
      { reviewer_id: '10000002', reviewer_link: 'https://www.google.com/maps/contrib/10000002/reviews' },
    ].map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(list1, [
      { reviewer_id: '20000001', reviewer_link: 'https://www.google.com/maps/contrib/20000001/reviews' },
      { reviewer_id: '20000002', reviewer_link: 'https://www.google.com/maps/contrib/20000002/reviews' },
    ].map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(output0, `${JSON.stringify({ reviewer_id: '10000001', _status: 'complete' })}\n`);
    fs.writeFileSync(output1, `${JSON.stringify({ reviewer_id: '20000001', _status: 'error' })}\n`);

    const done = await Promise.all([completedReviewerIds(output0), completedReviewerIds(output1)]);
    const found = [];
    for await (const item of pendingReviewers([
      { listFile: list0 }, { listFile: list1 },
    ], done)) found.push([item.shardIndex, item.reviewer.reviewer_id]);
    assert.deepStrictEqual(found, [
      [0, '10000002'],
      [1, '20000001'],
      [1, '20000002'],
    ]);

    const gate = new SmoothGate(0);
    await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()]);
    console.log('Reviewer parallel queue/resume tests: passed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
