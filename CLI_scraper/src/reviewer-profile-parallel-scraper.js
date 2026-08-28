'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const stealth = require('./stealth');
const { iterateNdjsonRecords } = require('./ndjson-reader');
const { withDeadline } = require('./async-deadline');
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
  const createContext = options.createContext || stealth.createStealthContext;
  const contextDeadlineMs = options.contextDeadlineMs ?? 30000;
  const closeDeadlineMs = options.closeDeadlineMs ?? 15000;
  const flagForceRotation = () => { if (options.onForceRotation) options.onForceRotation(); };
  for (let fetchAttempt = 1; fetchAttempt <= options.maxFetchRetries + 1; fetchAttempt += 1) {
    let context;
    let page;
    try {
      await gate.acquire();
      // Every await below can hang under load; each is deadline-wrapped so the
      // lane always progresses. A hung context/close flags a forced rotation.
      ({ context, page } = await withDeadline(createContext(browser, {
        geoConfig: { timezone: 'Asia/Singapore', locale: 'en-US', languages: ['en-US', 'en'] },
        blockImages: true,
        blockHeavyResources: false,
      }), contextDeadlineMs, 'createStealthContext', flagForceRotation));
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
      // A hung close must not wedge the lane: bound it, and if it times out flag
      // the browser for a forced rotation (the force-kill reaps the leaked page).
      if (page) await withDeadline(page.close(), closeDeadlineMs, 'page.close', flagForceRotation).catch(() => {});
      if (context) await withDeadline(context.close(), closeDeadlineMs, 'context.close', flagForceRotation).catch(() => {});
    }
  }
  throw new Error('unreachable reviewer retry state');
}

async function launchBrowser(options) {
  const launchOptions = { headless: true, args: stealth.buildLaunchArgs() };
  if (options.browserExecutablePath) launchOptions.executablePath = options.browserExecutablePath;
  return chromium.launch(launchOptions);
}

// Reap stray chrome-headless-shell processes. Every Playwright launch writes its
// user-data-dir under TMPDIR (the run scripts set a run-scoped TMPDIR), and each
// child carries `--user-data-dir=<that dir>` in argv, so a pgrep on the scope dir
// matches exactly this run's browsers and nothing else on a shared host. On a dev
// box where TMPDIR is the shared OS default, the pgrep sweep is skipped and only
// explicitly tracked PIDs are killed.
function reapOrphanChromium(scopeDir, keepPids = new Set(), log = () => {}) {
  const killed = [];
  const kill = (pid) => {
    if (!pid || pid === process.pid || keepPids.has(pid)) return;
    try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch { /* already gone */ }
  };
  const osTmp = os.tmpdir();
  const runScoped = typeof scopeDir === 'string'
    && path.isAbsolute(scopeDir)
    && path.resolve(scopeDir) !== path.resolve(osTmp);
  if (runScoped) {
    try {
      const result = spawnSync('pgrep', ['-f', '--', scopeDir], { encoding: 'utf8' });
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.split('\n')) {
          const pid = Number(line.trim());
          if (Number.isInteger(pid)) kill(pid);
        }
      }
    } catch { /* pgrep unavailable; tracked-pid path below still runs */ }
  }
  if (killed.length) log(`[REVIEWERS PARALLEL] reaped ${killed.length} stray chromium under ${scopeDir}`);
  return killed;
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

  // Self-heal knobs. Defaults keep today's behavior; every unbounded await is
  // now deadline-guarded and a watchdog force-restarts a stalled browser.
  const taskDeadlineMs = options.taskDeadlineMs ?? 150000;
  const stallMs = options.stallMs ?? 210000;
  const watchdogIntervalMs = options.watchdogIntervalMs ?? 30000;
  const rotationCloseDeadlineMs = options.rotationCloseDeadlineMs ?? 20000;
  const launchDeadlineMs = options.launchDeadlineMs ?? 60000;
  const launchRetries = options.launchRetries ?? 3;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 45000;
  const contentShortfallThreshold = options.contentShortfallThreshold ?? 0.15;
  const userDataScopeDir = options.userDataScopeDir ?? process.env.TMPDIR ?? null;
  // Injectable seams (production defaults = real implementations).
  const browserFactory = options.browserFactory || (() => launchBrowser(options));
  const reapOrphans = options.reapOrphans || ((keep) => reapOrphanChromium(userDataScopeDir, keep, log));
  const onExit = options.onExit || ((code) => process.exit(code));

  if (!Number.isInteger(targetConcurrency) || targetConcurrency < 1) throw new Error('concurrency must be a positive integer');
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0) throw new Error('requestIntervalMs must be a non-negative integer');
  if (!Number.isInteger(windowSize) || windowSize < targetConcurrency) throw new Error('windowSize must be at least concurrency');
  if (!Number.isInteger(browserRestartEvery) || browserRestartEvery < windowSize) throw new Error('browserRestartEvery must be at least windowSize');
  if (!(stallMs > taskDeadlineMs)) throw new Error('stallMs must be greater than taskDeadlineMs');

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
  const browserPids = new Set();
  // Reap strays from a previously crashed run that shared this TMPDIR.
  reapOrphans(browserPids);
  const trackBrowser = (instance) => { const pid = instance?.process?.()?.pid; if (pid) browserPids.add(pid); return instance; };
  let browser = trackBrowser(await withDeadline(browserFactory(), launchDeadlineMs, 'launchBrowser'));
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
  let rotationLock = Promise.resolve();
  let rotationWaiters = [];
  let forceRotation = false;
  let lastProgressAt = Date.now();
  let watchdogEscalations = 0;
  let fatalExit = false;
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
    // Completeness health: among terminal, non-hidden profiles, the fraction
    // that returned fewer reviews than they should have. Catches silent content
    // drift (100% HTTP, fewer reviews) without any per-reviewer storage.
    const terminal = results.filter((result) => {
      const stop = result.record.completeness?.stop_reason;
      return stop === 'complete' || stop === 'service_cap' || stop === 'requested_limit';
    });
    const shortfalls = terminal.filter((result) => {
      const c = result.record.completeness || {};
      const expected = Math.min(
        Number.isFinite(c.visible_review_count) ? c.visible_review_count : Infinity,
        maxProfileReviews,
      );
      return Number.isFinite(c.returned_review_count) && c.returned_review_count < expected;
    }).length;
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
      shortfall_rate: terminal.length ? Number((shortfalls / terminal.length).toFixed(4)) : 0,
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

  // Force-kill the current browser: SIGKILL its process tree, then reap any
  // stray children scoped to this run's TMPDIR. Used when a graceful close hangs.
  const forceKillBrowser = () => {
    try { browser?.process()?.kill('SIGKILL'); } catch { /* already gone */ }
    reapOrphans(new Set());
  };

  const drainRotationWaiters = () => {
    const waiters = rotationWaiters;
    rotationWaiters = [];
    for (const resolve of waiters) resolve();
  };

  // Hardened rotation. Serialized by rotationLock so the watchdog and graceful
  // path can never double-launch. Every await is deadline-wrapped; a hung close
  // escalates to SIGKILL, a hung launch retries then exits for the supervisor.
  // Waiter release + flag reset live in `finally`, so a throw can never wedge
  // the pool forever (the original deadlock bug).
  const rotateBrowser = async ({ force = false } = {}) => {
    if (!rotationRequested && !force) return;
    if (!force && inFlight > 0) return;
    const previous = rotationLock;
    let release;
    rotationLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (!rotationRequested && !force) return;
      const reason = force ? 'forced' : (rotationReason || 'requested');
      const hardClose = force || forceRotation;
      if (hardClose) {
        forceKillBrowser();
      } else {
        await withDeadline(browser.close(), rotationCloseDeadlineMs, 'browser.close')
          .catch(() => forceKillBrowser());
      }
      forceRotation = false;
      if (!stopRequested) {
        let launched = null;
        for (let attempt = 1; attempt <= launchRetries && !launched; attempt += 1) {
          try {
            launched = await withDeadline(browserFactory(), launchDeadlineMs, 'launchBrowser');
          } catch (error) {
            log(`[REVIEWERS PARALLEL] launch attempt ${attempt}/${launchRetries} failed: ${error.message}`);
            reapOrphans(new Set());
            if (attempt < launchRetries) await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
        if (!launched) {
          fatalExit = true;
          log('[REVIEWERS PARALLEL] browser relaunch exhausted; exiting for supervisor respawn');
        } else {
          browser = trackBrowser(launched);
        }
      }
      processedSinceRestart = 0;
      browserRestarts += 1;
      log(`[REVIEWERS PARALLEL] rotated Chromium after ${processed} profiles (${reason})`);
    } finally {
      rotationRequested = false;
      rotationReason = null;
      drainRotationWaiters();
      release();
    }
    if (fatalExit) { statusSnapshot('watchdog_exit'); onExit(1); }
  };
  const maybeRotate = () => rotateBrowser({ force: false });

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
    lastProgressAt = Date.now();
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
      // Content shortfall: a fresh browser often clears renderer-degraded partial
      // responses. Rotate but do NOT touch concurrency (data quality != overload).
      else if (metrics.shortfall_rate > contentShortfallThreshold) requestRotation('content shortfall');
      lastWindowMetrics = metrics;
      statusSnapshot('reviewers', metrics);
      log(`[REVIEWERS PARALLEL] processed=${processed}/${runLimit} window=${metrics.profiles_per_minute}/min p95=${metrics.duration_p95_ms}ms errors=${Math.round(metrics.error_rate * metrics.size)} operational_errors=${Math.round(metrics.operational_error_rate * metrics.size)} throttles=${Math.round(metrics.throttle_rate * metrics.size)} concurrency=${currentConcurrency}`);
    }
    if (processedSinceRestart >= browserRestartEvery) requestRotation('periodic');
  };

  // Zero-progress watchdog + heartbeat. Refreshes updated_at every tick so
  // external monitors see liveness between the 200-profile windows; force-kills
  // and relaunches a stalled browser, and exits (for the supervisor) if the
  // recovery machinery itself is wedged. stallMs > taskDeadlineMs guarantees a
  // single hung task self-heals via its own deadline before the watchdog fires.
  const watchdog = setInterval(() => {
    writeStatus({
      heartbeat_at: new Date().toISOString(),
      in_flight: inFlight,
      processed,
      concurrency: currentConcurrency,
      rotation_requested: rotationRequested,
      seconds_since_progress: Number(((Date.now() - lastProgressAt) / 1000).toFixed(1)),
    });
    if (stopRequested) return;
    const stalled = Date.now() - lastProgressAt > stallMs;
    if (!stalled) return;
    if (watchdogEscalations >= 1) {
      log(`[REVIEWERS PARALLEL] watchdog: still stalled after force-rotation; exiting for supervisor respawn`);
      statusSnapshot('watchdog_exit');
      onExit(1);
      return;
    }
    watchdogEscalations += 1;
    lastProgressAt = Date.now();
    log(`[REVIEWERS PARALLEL] watchdog: no progress for ${(stallMs / 1000)}s (in_flight=${inFlight}); forcing browser restart`);
    rotateBrowser({ force: true }).catch((error) => log(`[REVIEWERS PARALLEL] watchdog force-rotate error: ${error.message}`));
  }, watchdogIntervalMs);
  if (typeof watchdog.unref === 'function') watchdog.unref();

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
          // Hard per-task deadline: guarantees inFlight always returns to 0 in
          // bounded time even if an unforeseen op hangs, which unblocks rotation.
          const result = await withDeadline(fetchReviewer(browser, task, {
            sourceReviewsFile: configuration.sourceReviewsFile,
            maxProfileReviews,
            maxFetchRetries,
            includeReviewMedia,
            initialWaitMs: options.initialWaitMs ?? 2500,
            navigationTimeoutMs,
            createContext: options.createContext,
            contextDeadlineMs: options.contextDeadlineMs,
            closeDeadlineMs: options.closeDeadlineMs,
            onForceRotation: () => { forceRotation = true; },
          }, gate), taskDeadlineMs, 'fetchReviewer', () => { forceRotation = true; });
          recordResult(task, result);
        } catch (error) {
          // A deadline (or any escaped throw) becomes a retryable fetch_error so
          // resume re-attempts it; recordResult still advances progress + inFlight.
          const record = errorRecord(task.reviewer, String(error.message || error).slice(0, 1000), {
            sourceReviewsFile: configuration.sourceReviewsFile,
            maxProfileReviews,
            fetchAttempt: 0,
          });
          recordResult(task, { record, durationMs: 0, attempts: 0, returnedReviews: 0, throttle: false });
        } finally {
          inFlight -= 1;
          await maybeRotate();
        }
      }
    };
    await Promise.all(Array.from({ length: targetConcurrency }, (_, laneIndex) => worker(laneIndex)));
    if (rotationRequested) await maybeRotate();
  } finally {
    clearInterval(watchdog);
    await withDeadline(browser.close(), rotationCloseDeadlineMs, 'browser.close').catch(() => forceKillBrowser());
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
  reapOrphanChromium,
  scrapeReviewerProfilesParallel,
};
