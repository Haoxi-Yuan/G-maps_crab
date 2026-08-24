'use strict';

const DEFAULT_MEAN_MS = Object.freeze({
  poi_search: 1500,
  page_navigation: 3000,
  browser_launch: 8000,
  reviews: 2500,
  images: 5000,
  scheduler_api: 300,
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

function defaultMeanMs(operation) {
  return DEFAULT_MEAN_MS[operation] || DEFAULT_MEAN_MS.poi_search;
}

// All time thresholds derive from the successful-response EWMA. The caps are
// deliberately short: failures never teach the model to wait longer, and one
  // pathological response cannot inflate a workflow for hours.
function timingPolicy(operation, meanMs, options = {}) {
  const mean = clamp(
    Number.isFinite(Number(meanMs)) ? Number(meanMs) : defaultMeanMs(operation),
    100,
    15000,
  );
  const estimatedRequests = clamp(options.estimatedRequests || 1, 1, 1000);
  const attempt = clamp(options.attempt || 1, 1, 10);
  const requestTimeoutMs = operation === 'browser_launch'
    ? clamp(Math.round(mean * 3), 15000, 45000)
    : clamp(Math.round(mean * 4), 5000, 30000);
  const progressTimeoutMs = clamp(Math.round(mean * 8), 15000, 90000);
  const leaseMs = clamp(
    Math.round(progressTimeoutMs + estimatedRequests * mean * 2),
    30000,
    180000,
  );
  return {
    operation,
    meanMs: Math.round(mean),
    requestTimeoutMs,
    progressTimeoutMs,
    leaseMs,
    heartbeatMs: clamp(Math.round(mean * 2), 2000, 15000),
    retryDelayMs: clamp(Math.round(mean * (2 ** (attempt - 1))), 500, 30000),
    idlePollMs: clamp(Math.round(mean), 500, 5000),
    reapIntervalMs: clamp(Math.round(mean * 4), 5000, 30000),
    probeFreshMs: clamp(Math.round(mean * 30), 30000, 120000),
    fleetStallMs: clamp(Math.round(mean * 12), 30000, 120000),
  };
}

function updateEwma(currentMeanMs, sampleCount, elapsedMs) {
  const current = clamp(currentMeanMs, 100, 15000);
  // Only successful completed operations reach this function. Winsorize each
  // sample to 2x the current mean so a slow-but-successful outlier cannot make
  // future workers tolerate multi-minute hangs.
  const sample = clamp(elapsedMs, 50, Math.max(1000, current * 2));
  if (Number(sampleCount) === 0) return Math.round(sample);
  const alpha = Number(sampleCount) < 10 ? 0.25 : 0.1;
  return Math.round(current * (1 - alpha) + sample * alpha);
}

module.exports = {
  DEFAULT_MEAN_MS,
  clamp,
  defaultMeanMs,
  timingPolicy,
  updateEwma,
};
