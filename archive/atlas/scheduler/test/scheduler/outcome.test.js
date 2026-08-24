'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyTileOutcome,
  completionRatio,
  isTailBoundary,
} = require('../../src/scheduler/outcome');

test('incomplete pagination is never accepted as done', () => {
  const result = classifyTileOutcome({
    paginationComplete: false,
    shouldSplit: false,
    placeCount: 10,
    sessionProbeFresh: true,
    responseStructureComplete: true,
    teamProductionNormal: true,
  });
  assert.equal(result.status, 'RETRY');
});

test('a saturated complete tile splits before terminal classification', () => {
  const result = classifyTileOutcome({
    paginationComplete: true,
    shouldSplit: true,
    placeCount: 140,
    sessionProbeFresh: true,
    responseStructureComplete: true,
    teamProductionNormal: true,
  });
  assert.equal(result.status, 'SPLIT');
});

test('empty is confirmed only when all three independent signals pass', () => {
  const base = {
    paginationComplete: true,
    shouldSplit: false,
    placeCount: 0,
    sessionProbeFresh: true,
    responseStructureComplete: true,
    teamProductionNormal: true,
  };
  assert.equal(classifyTileOutcome(base).status, 'DONE_EMPTY_CONFIRMED');
  for (const key of ['sessionProbeFresh', 'responseStructureComplete', 'teamProductionNormal']) {
    assert.equal(classifyTileOutcome({ ...base, [key]: false }).status, 'DONE_EMPTY_SUSPECT');
  }
});

test('95% boundary tail calculation uses request-independent task completion', () => {
  assert.equal(completionRatio({ openTasks: 5, terminalTasks: 95 }), 0.95);
  assert.equal(isTailBoundary({ openTasks: 5, terminalTasks: 95 }), true);
  assert.equal(isTailBoundary({ openTasks: 6, terminalTasks: 94 }), false);
  assert.equal(isTailBoundary({ openTasks: 0, terminalTasks: 100 }), false);
});
