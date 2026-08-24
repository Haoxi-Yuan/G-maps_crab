'use strict';

const TERMINAL_STATUSES = new Set([
  'DONE',
  'DONE_EMPTY_CONFIRMED',
  'DONE_EMPTY_SUSPECT',
  'QUARANTINED',
]);

function classifyTileOutcome({
  paginationComplete,
  shouldSplit,
  placeCount,
  sessionProbeFresh,
  responseStructureComplete,
  teamProductionNormal,
}) {
  if (!paginationComplete) {
    return {
      status: 'RETRY',
      reason: 'pagination_incomplete',
    };
  }
  if (shouldSplit) {
    return {
      status: 'SPLIT',
      reason: 'pagination_cap_reached',
    };
  }
  if (placeCount > 0) {
    return {
      status: 'DONE',
      reason: 'complete_nonempty',
    };
  }

  const diagnostics = {
    sessionProbeFresh: Boolean(sessionProbeFresh),
    responseStructureComplete: Boolean(responseStructureComplete),
    teamProductionNormal: Boolean(teamProductionNormal),
  };
  const confirmed = Object.values(diagnostics).every(Boolean);
  return {
    status: confirmed ? 'DONE_EMPTY_CONFIRMED' : 'DONE_EMPTY_SUSPECT',
    reason: confirmed ? 'three_signal_empty_confirmation' : 'empty_confirmation_incomplete',
    diagnostics,
  };
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function completionRatio(runtime) {
  const open = Number(runtime.open_tasks ?? runtime.openTasks ?? 0);
  const terminal = Number(runtime.terminal_tasks ?? runtime.terminalTasks ?? 0);
  const denominator = open + terminal;
  return denominator === 0 ? 1 : terminal / denominator;
}

function isTailBoundary(runtime, threshold = 0.95) {
  return Number(runtime.open_tasks ?? runtime.openTasks ?? 0) > 0 && completionRatio(runtime) >= threshold;
}

module.exports = {
  TERMINAL_STATUSES,
  classifyTileOutcome,
  isTerminalStatus,
  completionRatio,
  isTailBoundary,
};
