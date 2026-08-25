'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const stealth = require('./stealth');
const { iterateNdjsonRecords } = require('./ndjson-reader');
const {
  parseReviewerMasResponse,
  setReviewerMasMediaEnabled,
} = require('./reviewer-profile-parser');
const {
  SERVICE_MAX_REVIEWS,
  completedReviewerIds,
  completenessFor,
  expansionPageSizes,
  fetchExpandedMas,
  fetchMasFromPage,
} = require('./reviewer-profile-scraper');

class SmoothGate {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.nextAt = 0;
  }

  async acquire() {
    const now = Date.now();
    const scheduled = Math.max(now, this.nextAt);
    this.nextAt = scheduled + this.intervalMs;
    if (scheduled > now) await new Promise((resolve) => setTimeout(resolve, scheduled - now));
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function isThrottleError(message) {
  return /(?:HTTP (?:403|429)|captcha|unusual traffic|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET)/i.test(message);
}

function makeAtomicStatusWriter(file) {
  let current = {};
  return (patchValue) => {
    if (!file) return;
    current = { ...current, ...patchValue, updated_at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(current, null, 2));
    fs.renameSync(temporary, file);
  };
}

async function* pendingReviewers(shards, doneByShard) {
  const iterators = shards.map((shard) => iterateNdjsonRecords(shard.listFile)[Symbol.asyncIterator]());
  const active = new Set(iterators.map((_, index) => index));
  while (active.size > 0) {
    for (const shardIndex of [...active]) {
      const iterator = iterators[shardIndex];
      let selected = null;
      while (selected == null) {
        const logical = await iterator.next();
        if (logical.done) {
          active.delete(shardIndex);
          break;
        }
        const reviewer = logical.value?.value || {};
        if (!reviewer.reviewer_id || !reviewer.reviewer_link) continue;
        if (doneByShard[shardIndex].has(reviewer.reviewer_id)) continue;
        selected = { shardIndex, reviewer };
      }
      if (selected) yield selected;
    }
  }
}

function profileRecord(sourceReviewer, parsed, initialFetch, completeness, metadata) {
  return {
    extracted_at: new Date().toISOString(),
    reviewer_id: parsed.reviewer.reviewer_id || sourceReviewer.reviewer_id,
    reviewer: parsed.reviewer,
    public_content: parsed.public_content,
    activity: parsed.activity,
    completeness,
    source_summary: sourceReviewer,
    _status: {
      complete: 'complete',
      private_or_hidden: 'private_or_hidden',
      requested_limit: 'requested_limit',
      service_cap: 'service_cap',
      response_shortfall: 'error',
    }[completeness.stop_reason],
    _source: 'google_maps_reviewer_mas',
    _meta: {
      source_reviews_file: metadata.sourceReviewsFile,
      profile_url: initialFetch.profileUrl,
      requested_review_limit: metadata.maxProfileReviews,
      service_review_cap: SERVICE_MAX_REVIEWS,
      effective_review_limit: metadata.effectiveReviewLimit,
      attempted_review_limits: metadata.attemptedReviewLimits,
      review_media_requested: metadata.includeReviewMedia,
      fetch_attempts: metadata.fetchAttempt,
    },
  };
}

function errorRecord(sourceReviewer, message, metadata) {
  return {
    extracted_at: new Date().toISOString(),
    reviewer_id: sourceReviewer.reviewer_id,
    reviewer: null,
    public_content: null,
    activity: null,
    completeness: { is_complete: false, stop_reason: 'fetch_error', visible_review_count: null, returned_review_count: 0 },
    source_summary: sourceReviewer,
    _status: 'error',
    _source: 'google_maps_reviewer_mas',
    _error: message,
    _meta: {
      source_reviews_file: metadata.sourceReviewsFile,
      requested_review_limit: metadata.maxProfileReviews,
      service_review_cap: SERVICE_MAX_REVIEWS,
      fetch_attempts: metadata.fetchAttempt,
    },
  };
}

async function fetchReviewer(browser, task, options, gate) {
  const started = Date.now();
  let lastError = null;
  for (let fetchAttempt = 1; fetchAttempt <= options.maxFetchRetries + 1; fetchAttempt += 1) {
    let context;
    let page;
    try {
      await gate.acquire();
      ({ context, page } = await stealth.createStealthContext(browser, {
        geoConfig: { timezone: 'Asia/Singapore', locale: 'en-US', languages: ['en-US', 'en'] },
        blockImages: true,
        blockHeavyResources: false,
      }));
      const sourceReviewer = task.reviewer;
      const initialFetch = await fetchMasFromPage(page, sourceReviewer.reviewer_id, options);
      let parsed = parseReviewerMasResponse(initialFetch.masText, {
        reviewerId: sourceReviewer.reviewer_id,
        reviewerName: sourceReviewer.reviewer_name,
      });
      const visible = parsed.public_content.public_review_count;
      const desired = Math.max(1, Math.min(
        options.maxProfileReviews,
        Number.isFinite(visible) ? visible : options.maxProfileReviews,
        SERVICE_MAX_REVIEWS,
      ));
      const initialReviewCount = parsed.public_content.returned_review_count;
      const ladder = visible === 0 ? [] : expansionPageSizes(desired, initialReviewCount);
      const attemptedReviewLimits = [];
      let effectiveReviewLimit = initialReviewCount;
      let remainingLadder = ladder.length;
      const expandUrl = options.includeReviewMedia
        ? initialFetch.masUrl
        : setReviewerMasMediaEnabled(initialFetch.masUrl, false);

      for (const pageSize of ladder) {
        remainingLadder -= 1;
        await gate.acquire();
        const expanded = await fetchExpandedMas(page, expandUrl, pageSize);
        const candidate = parseReviewerMasResponse(expanded.text, {
          reviewerId: sourceReviewer.reviewer_id,
          reviewerName: sourceReviewer.reviewer_name,
        });
        const returned = candidate.public_content.returned_review_count;
        attemptedReviewLimits.push({ requested: pageSize, returned });
        if (returned > parsed.public_content.returned_review_count || (desired < initialReviewCount && returned > 0)) {
          parsed = candidate;
          effectiveReviewLimit = pageSize;
        }
        if (returned >= Math.min(pageSize, Number.isFinite(visible) ? visible : pageSize)) break;
      }

      const completeness = completenessFor(parsed, options.maxProfileReviews, effectiveReviewLimit, {
        exhaustedFallbacks: ladder.length > 0 && remainingLadder === 0
          && attemptedReviewLimits.every((attempt) => attempt.returned === 0),
      });
      const record = profileRecord(sourceReviewer, parsed, initialFetch, completeness, {
        sourceReviewsFile: options.sourceReviewsFile,
        maxProfileReviews: options.maxProfileReviews,
        effectiveReviewLimit,
        attemptedReviewLimits,
        includeReviewMedia: options.includeReviewMedia,
        fetchAttempt,
      });
      return {
        record,
        durationMs: Date.now() - started,
        attempts: fetchAttempt,
        returnedReviews: parsed.public_content.returned_review_count,
        throttle: false,
      };
    } catch (error) {
      lastError = String(error.message || error).slice(0, 1000);
      if (fetchAttempt <= options.maxFetchRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, fetchAttempt * 1000)));
        continue;
      }
      return {
        record: errorRecord(task.reviewer, lastError, {
          sourceReviewsFile: options.sourceReviewsFile,
          maxProfileReviews: options.maxProfileReviews,
          fetchAttempt,
        }),
        durationMs: Date.now() - started,
        attempts: fetchAttempt,
        returnedReviews: 0,
        throttle: isThrottleError(lastError),
      };
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }
  throw new Error('unreachable reviewer retry state');
}

async function launchBrowser(options) {
  const launchOptions = { headless: true, args: stealth.buildLaunchArgs() };
  if (options.browserExecutablePath) launchOptions.executablePath = options.browserExecutablePath;
  return chromium.launch(launchOptions);
}

async function scrapeReviewerProfilesParallel(configuration, options = {}) {
  const shards = configuration.shards.map((shard) => ({
    listFile: path.resolve(shard.listFile),
    outputFile: path.resolve(shard.outputFile),
  }));
  const totalReviewers = configuration.totalReviewers;
  const targetConcurrency = options.concurrency ?? 27;
  const requestIntervalMs = options.requestIntervalMs ?? 150;
  const windowSize = options.windowSize ?? 200;
  const browserRestartEvery = options.browserRestartEvery ?? 2800;
  const maxReviewers = options.maxReviewers ?? Infinity;
  const maxProfileReviews = options.maxProfileReviews ?? SERVICE_MAX_REVIEWS;
  const maxFetchRetries = options.maxFetchRetries ?? 2;
  const includeReviewMedia = options.includeReviewMedia !== false;
  const log = options.log || console.log;
  const writeStatus = makeAtomicStatusWriter(options.liveStatusFile ? path.resolve(options.liveStatusFile) : null);

  if (!Number.isInteger(targetConcurrency) || targetConcurrency < 1) throw new Error('concurrency must be a positive integer');
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0) throw new Error('requestIntervalMs must be a non-negative integer');
  if (!Number.isInteger(windowSize) || windowSize < targetConcurrency) throw new Error('windowSize must be at least concurrency');
  if (!Number.isInteger(browserRestartEvery) || browserRestartEvery < windowSize) throw new Error('browserRestartEvery must be at least windowSize');

  for (const shard of shards) {
    if (!fs.existsSync(shard.listFile)) throw new Error(`reviewer list not found: ${shard.listFile}`);
    fs.mkdirSync(path.dirname(shard.outputFile), { recursive: true });
  }

  log(`[REVIEWERS PARALLEL] scanning ${shards.length} outputs for resumable completion markers`);
  const doneByShard = await Promise.all(shards.map((shard) => completedReviewerIds(shard.outputFile)));
  const completedBeforeStart = doneByShard.reduce((sum, done) => sum + done.size, 0);
  const pendingAtStart = Math.max(0, totalReviewers - completedBeforeStart);
  const runLimit = Math.min(pendingAtStart, maxReviewers);
  log(`[REVIEWERS PARALLEL] total=${totalReviewers} complete=${completedBeforeStart} pending=${pendingAtStart} run_limit=${runLimit}`);

  if (runLimit === 0) {
    writeStatus({ phase: 'complete', total_reviewers: totalReviewers, completed_before_start: completedBeforeStart, processed: 0, errors: 0 });
    return { totalReviewers, completedBeforeStart, processed: 0, errors: 0, elapsedSeconds: 0 };
  }

  let stopRequested = false;
  const requestStop = (signal) => {
    stopRequested = true;
    const waiters = rotationWaiters;
    rotationWaiters = [];
    for (const resolve of waiters) resolve();
    log(`[REVIEWERS PARALLEL] ${signal} received; draining in-flight profiles`);
  };
  const onSigint = () => requestStop('SIGINT');
  const onSigterm = () => requestStop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const iterator = pendingReviewers(shards, doneByShard)[Symbol.asyncIterator]();
  const gate = new SmoothGate(requestIntervalMs);
  const started = Date.now();
  let browser = await launchBrowser(options);
  let processed = 0;
  let terminalProfiles = 0;
  let errors = 0;
  let throttles = 0;
  let completeProfiles = 0;
  let cappedProfiles = 0;
  let hiddenProfiles = 0;
  let returnedReviews = 0;
  let currentConcurrency = targetConcurrency;
  let processedSinceRestart = 0;
  let browserRestarts = 0;
  let exhausted = false;
  let assigned = 0;
  let inFlight = 0;
  let iteratorLock = Promise.resolve();
  let rotationRequested = false;
  let rotationReason = null;
  let rotationPromise = null;
  let rotationWaiters = [];
  let windowStarted = Date.now();
  let windowResults = [];
  let lastWindowMetrics = null;

  const statusSnapshot = (phase, windowMetrics = null) => {
    const elapsedSeconds = (Date.now() - started) / 1000;
    writeStatus({
      phase,
      total_reviewers: totalReviewers,
      completed_before_start: completedBeforeStart,
      pending_at_start: pendingAtStart,
      run_limit: Number.isFinite(maxReviewers) ? runLimit : null,
      processed,
      terminal_profiles: terminalProfiles,
      errors,
      throttles,
      complete_profiles: completeProfiles,
      capped_profiles: cappedProfiles,
      hidden_profiles: hiddenProfiles,
      returned_reviews: returnedReviews,
      concurrency: currentConcurrency,
      target_concurrency: targetConcurrency,
      request_interval_ms: requestIntervalMs,
      browser_restarts: browserRestarts,
      elapsed_seconds: Number(elapsedSeconds.toFixed(3)),
      profiles_per_minute: elapsedSeconds > 0 ? Number((processed * 60 / elapsedSeconds).toFixed(3)) : 0,
      completed_total_estimate: completedBeforeStart + terminalProfiles,
      remaining_estimate: Math.max(0, totalReviewers - completedBeforeStart - terminalProfiles),
      window: windowMetrics,
    });
  };

  statusSnapshot('starting');

  const metricsFor = (results, wallMs, partial = false) => {
    if (!results.length) return null;
    const durations = results.map((result) => result.durationMs);
    const windowErrors = results.filter((result) => result.record._status === 'error').length;
    const windowOperationalErrors = results.filter((result) => (
      result.record.completeness?.stop_reason === 'fetch_error'
    )).length;
    const windowThrottles = results.filter((result) => result.throttle).length;
    return {
      size: results.length,
      partial,
      wall_ms: wallMs,
      profiles_per_minute: Number((results.length * 60000 / wallMs).toFixed(3)),
      duration_p50_ms: percentile(durations, 0.5),
      duration_p95_ms: percentile(durations, 0.95),
      duration_max_ms: Math.max(...durations),
      error_rate: Number((windowErrors / results.length).toFixed(4)),
      operational_error_rate: Number((windowOperationalErrors / results.length).toFixed(4)),
      throttle_rate: Number((windowThrottles / results.length).toFixed(4)),
      returned_reviews: results.reduce((sum, result) => sum + result.returnedReviews, 0),
    };
  };

  const requestRotation = (reason) => {
    rotationRequested = true;
    rotationReason ||= reason;
  };

  const waitForRotation = async () => {
    if (!rotationRequested) return;
    await new Promise((resolve) => rotationWaiters.push(resolve));
  };

  const maybeRotate = async () => {
    if (!rotationRequested || inFlight > 0) return;
    if (rotationPromise) { await rotationPromise; return; }
    rotationPromise = (async () => {
      const reason = rotationReason || 'requested';
      await browser.close().catch(() => {});
      if (!stopRequested) browser = await launchBrowser(options);
      processedSinceRestart = 0;
      browserRestarts += 1;
      rotationRequested = false;
      rotationReason = null;
      const waiters = rotationWaiters;
      rotationWaiters = [];
      for (const resolve of waiters) resolve();
      log(`[REVIEWERS PARALLEL] rotated Chromium after ${processed} profiles (${reason})`);
    })();
    try { await rotationPromise; } finally { rotationPromise = null; }
  };

  const takeTask = async () => {
    while (rotationRequested && !stopRequested) await waitForRotation();
    if (stopRequested || exhausted || assigned >= runLimit) return null;
    let release;
    const previous = iteratorLock;
    iteratorLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (stopRequested || exhausted || assigned >= runLimit) return null;
      const next = await iterator.next();
      if (next.done) { exhausted = true; return null; }
      assigned += 1;
      return next.value;
    } finally {
      release();
    }
  };

  const recordResult = (task, result) => {
    fs.appendFileSync(shards[task.shardIndex].outputFile, `${JSON.stringify(result.record)}\n`);
    processed += 1;
    processedSinceRestart += 1;
    returnedReviews += result.returnedReviews;
    if (result.record._status === 'error') errors += 1;
    else terminalProfiles += 1;
    if (result.throttle) throttles += 1;
    const reason = result.record.completeness.stop_reason;
    if (reason === 'complete') completeProfiles += 1;
    else if (reason === 'service_cap') cappedProfiles += 1;
    else if (reason === 'private_or_hidden') hiddenProfiles += 1;
    windowResults.push(result);

    if (windowResults.length >= windowSize) {
      const metrics = metricsFor(windowResults, Date.now() - windowStarted);
      windowResults = [];
      windowStarted = Date.now();
      // Content shortfalls are data-quality errors, not evidence that the IP or
      // browser is overloaded. Back off only for failed fetches or throttling.
      if (metrics.operational_error_rate > 0.03 || metrics.throttle_rate > 0.01) {
        currentConcurrency = Math.max(4, Math.floor(currentConcurrency * 0.7));
        metrics.control = 'backoff';
      } else if (currentConcurrency < targetConcurrency) {
        currentConcurrency += 1;
        metrics.control = 'recover';
      } else {
        metrics.control = 'hold';
      }
      if (!browser.isConnected() || metrics.throttle_rate > 0.01) requestRotation('unhealthy window');
      lastWindowMetrics = metrics;
      statusSnapshot('reviewers', metrics);
      log(`[REVIEWERS PARALLEL] processed=${processed}/${runLimit} window=${metrics.profiles_per_minute}/min p95=${metrics.duration_p95_ms}ms errors=${Math.round(metrics.error_rate * metrics.size)} operational_errors=${Math.round(metrics.operational_error_rate * metrics.size)} throttles=${Math.round(metrics.throttle_rate * metrics.size)} concurrency=${currentConcurrency}`);
    }
    if (processedSinceRestart >= browserRestartEvery) requestRotation('periodic');
  };

  try {
    const worker = async (laneIndex) => {
      while (!stopRequested && processed < runLimit && !exhausted) {
        while (laneIndex >= currentConcurrency && !stopRequested && !exhausted && processed < runLimit) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const task = await takeTask();
        if (!task) return;
        inFlight += 1;
        try {
          const result = await fetchReviewer(browser, task, {
            sourceReviewsFile: configuration.sourceReviewsFile,
            maxProfileReviews,
            maxFetchRetries,
            includeReviewMedia,
            initialWaitMs: options.initialWaitMs ?? 2500,
          }, gate);
          recordResult(task, result);
        } finally {
          inFlight -= 1;
          await maybeRotate();
        }
      }
    };
    await Promise.all(Array.from({ length: targetConcurrency }, (_, laneIndex) => worker(laneIndex)));
    if (rotationRequested) await maybeRotate();
  } finally {
    await browser.close().catch(() => {});
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }

  const elapsedSeconds = (Date.now() - started) / 1000;
  if (windowResults.length > 0) {
    lastWindowMetrics = metricsFor(windowResults, Date.now() - windowStarted, true);
  }
  const phase = stopRequested ? 'stopped' : processed >= runLimit && Number.isFinite(maxReviewers) ? 'limit_reached' : 'complete';
  statusSnapshot(phase, lastWindowMetrics);
  log(`[REVIEWERS PARALLEL] ${phase}: processed=${processed} terminal=${terminalProfiles} errors=${errors} elapsed=${elapsedSeconds.toFixed(1)}s rate=${(processed * 60 / elapsedSeconds).toFixed(3)}/min`);
  return {
    totalReviewers,
    completedBeforeStart,
    processed,
    terminalProfiles,
    errors,
    throttles,
    elapsedSeconds,
    profilesPerMinute: processed * 60 / elapsedSeconds,
  };
}

module.exports = {
  SmoothGate,
  isThrottleError,
  pendingReviewers,
  scrapeReviewerProfilesParallel,
};
