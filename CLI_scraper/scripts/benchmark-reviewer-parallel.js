#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const stealth = require('../src/stealth');
const { iterateNdjsonRecords } = require('../src/ndjson-reader');
const { parseReviewerMasResponse } = require('../src/reviewer-profile-parser');
const {
  SERVICE_MAX_REVIEWS,
  completenessFor,
  expansionPageSizes,
  fetchExpandedMas,
  fetchMasFromPage,
} = require('../src/reviewer-profile-scraper');
const { AdaptiveConcurrencyController } = require('../src/adaptive-concurrency');

function usage() {
  console.log(`
Benchmark reviewer concurrency and Chromium process topology under one public IP

Usage:
  node scripts/benchmark-reviewer-parallel.js --list <reviewers.ndjson> [options]

Options:
  --mode <staircase|adaptive>       Default: staircase
  --concurrency-sequence <csv>      Default: 1,2,4,6
  --browser-count <n>               Chromium processes sharing one gate (default: 1)
  --profiles-per-stage <n>          Default: 20
  --adaptive-epochs <n>             Default: 6
  --adaptive-start <n>              Default: 1
  --adaptive-max <n>                Default: 8
  --request-interval-ms <n>         Global smooth-start interval (default: 150)
  --initial-wait-ms <n>             MAS capture wait (default: 2500)
  --max-profile-reviews <n>         Default: 200
  --fetch-retries <n>               Default: 2
  --cooldown-ms <n>                 Between stages (default: 5000)
  --stop-on-unsafe                  Stop staircase on errors, throttles, or content drift
  --output <file>                   JSON result
  --self-test                       Test the adaptive controller without network
`);
}

function parseArgs(argv) {
  const options = {
    mode: 'staircase', concurrencySequence: [1, 2, 4, 6], profilesPerStage: 20,
    adaptiveEpochs: 6, adaptiveStart: 1, adaptiveMax: 8, requestIntervalMs: 150,
    initialWaitMs: 2500, maxProfileReviews: 200, fetchRetries: 2, cooldownMs: 5000,
    browserCount: 1,
  };
  const valueOptions = new Set([
    '--list', '--mode', '--concurrency-sequence', '--profiles-per-stage', '--adaptive-epochs',
    '--adaptive-start', '--adaptive-max', '--request-interval-ms', '--initial-wait-ms',
    '--max-profile-reviews', '--fetch-retries', '--cooldown-ms', '--browser-count', '--output',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (key === '--self-test') { options.selfTest = true; continue; }
    if (key === '--stop-on-unsafe') { options.stopOnUnsafe = true; continue; }
    if (!valueOptions.has(key)) throw new Error(`unknown option: ${key}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value`);
    const value = argv[++index];
    const property = {
      '--list': 'list', '--mode': 'mode', '--concurrency-sequence': 'concurrencySequence',
      '--profiles-per-stage': 'profilesPerStage', '--adaptive-epochs': 'adaptiveEpochs',
      '--adaptive-start': 'adaptiveStart', '--adaptive-max': 'adaptiveMax',
      '--request-interval-ms': 'requestIntervalMs', '--initial-wait-ms': 'initialWaitMs',
      '--max-profile-reviews': 'maxProfileReviews', '--fetch-retries': 'fetchRetries',
      '--cooldown-ms': 'cooldownMs', '--browser-count': 'browserCount', '--output': 'output',
    }[key];
    options[property] = value;
  }
  if (typeof options.concurrencySequence === 'string') {
    options.concurrencySequence = options.concurrencySequence.split(',').map(Number);
  }
  for (const key of ['profilesPerStage', 'adaptiveEpochs', 'adaptiveStart', 'adaptiveMax', 'requestIntervalMs', 'initialWaitMs', 'maxProfileReviews', 'fetchRetries', 'cooldownMs', 'browserCount']) {
    options[key] = Number(options[key]);
  }
  if (!['staircase', 'adaptive'].includes(options.mode)) throw new Error('--mode must be staircase or adaptive');
  if (!options.concurrencySequence.length || options.concurrencySequence.some((value) => !Number.isInteger(value) || value < 1)) throw new Error('--concurrency-sequence must contain positive integers');
  for (const key of ['profilesPerStage', 'adaptiveEpochs', 'adaptiveStart', 'adaptiveMax', 'browserCount']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  for (const key of ['requestIntervalMs', 'initialWaitMs', 'fetchRetries', 'cooldownMs']) {
    if (!Number.isInteger(options[key]) || options[key] < 0) throw new Error(`${key} must be a non-negative integer`);
  }
  if (!Number.isInteger(options.maxProfileReviews) || options.maxProfileReviews < 1 || options.maxProfileReviews > SERVICE_MAX_REVIEWS) throw new Error('--max-profile-reviews is outside the service range');
  return options;
}

class SmoothGate {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.nextAt = 0;
  }

  async acquire() {
    const now = Date.now();
    const scheduled = Math.max(now, this.nextAt);
    this.nextAt = scheduled + this.intervalMs;
    const wait = scheduled - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function logStage(stage) {
  const { reviewer_results: _reviewerResults, ...summary } = stage;
  console.log(JSON.stringify(summary));
}

function annotateContentConsistency(stage, baseline) {
  const current = new Map(stage.reviewer_results.map((item) => [
    item.reviewer_id,
    { status: item.status, returned_reviews: item.returned_reviews },
  ]));
  if (!baseline) {
    stage.content_consistency_rate = 1;
    stage.content_mismatch_count = 0;
    stage.content_mismatches = [];
    return current;
  }
  const mismatches = [];
  for (const [reviewerId, expected] of baseline) {
    const actual = current.get(reviewerId) || null;
    if (!actual || actual.status !== expected.status || actual.returned_reviews !== expected.returned_reviews) {
      mismatches.push({ reviewer_id: reviewerId, expected, actual });
    }
  }
  stage.content_mismatch_count = mismatches.length;
  stage.content_consistency_rate = Number(((baseline.size - mismatches.length) / baseline.size).toFixed(4));
  stage.content_mismatches = mismatches;
  return baseline;
}

function writeResult(outputFile, result) {
  if (!outputFile) return;
  const output = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  fs.renameSync(temporary, output);
}

function isThrottleError(message) {
  return /(?:HTTP (?:403|429)|captcha|unusual traffic|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET)/i.test(message);
}

async function loadSample(listFile, count) {
  const buckets = { low: [], medium: [], high: [] };
  for await (const logical of iterateNdjsonRecords(listFile)) {
    const item = logical.value || {};
    if (!item.reviewer_id || !item.reviewer_link) continue;
    const observed = Number(item.observed_public_review_count);
    const bucket = Number.isFinite(observed) && observed > 100 ? 'high'
      : Number.isFinite(observed) && observed > 10 ? 'medium' : 'low';
    if (buckets[bucket].length < count) buckets[bucket].push(item);
    if (Object.values(buckets).every((values) => values.length >= count)) break;
  }
  const sample = [];
  for (let index = 0; sample.length < count; index += 1) {
    let added = false;
    for (const bucket of ['low', 'medium', 'high']) {
      if (buckets[bucket][index]) { sample.push(buckets[bucket][index]); added = true; }
      if (sample.length >= count) break;
    }
    if (!added) break;
  }
  return sample;
}

async function fetchOne(browser, browserIndex, reviewer, options, gate) {
  const started = Date.now();
  let lastError = null;
  for (let attempt = 1; attempt <= options.fetchRetries + 1; attempt += 1) {
    let context;
    let page;
    try {
      await gate.acquire();
      ({ context, page } = await stealth.createStealthContext(browser, {
        geoConfig: { timezone: 'Asia/Singapore', locale: 'en-US', languages: ['en-US', 'en'] },
        blockImages: true,
        blockHeavyResources: false,
      }));
      const initial = await fetchMasFromPage(page, reviewer.reviewer_id, { initialWaitMs: options.initialWaitMs });
      let parsed = parseReviewerMasResponse(initial.masText, { reviewerId: reviewer.reviewer_id, reviewerName: reviewer.reviewer_name });
      const visible = parsed.public_content.public_review_count;
      const initialCount = parsed.public_content.returned_review_count;
      const desired = Math.max(1, Math.min(options.maxProfileReviews, Number.isFinite(visible) ? visible : options.maxProfileReviews, SERVICE_MAX_REVIEWS));
      const ladder = visible === 0 ? [] : expansionPageSizes(desired, initialCount);
      const attempts = [];
      let effectiveLimit = initialCount;
      for (const pageSize of ladder) {
        await gate.acquire();
        const expanded = await fetchExpandedMas(page, initial.masUrl, pageSize);
        const candidate = parseReviewerMasResponse(expanded.text, { reviewerId: reviewer.reviewer_id, reviewerName: reviewer.reviewer_name });
        const returned = candidate.public_content.returned_review_count;
        attempts.push({ requested: pageSize, returned });
        if (returned > parsed.public_content.returned_review_count) { parsed = candidate; effectiveLimit = pageSize; }
        if (returned >= Math.min(pageSize, Number.isFinite(visible) ? visible : pageSize)) break;
      }
      const completeness = completenessFor(parsed, options.maxProfileReviews, effectiveLimit, {
        exhaustedFallbacks: ladder.length > 0 && attempts.length === ladder.length && attempts.every((item) => item.returned === 0),
      });
      return {
        ok: completeness.stop_reason !== 'response_shortfall',
        browser_index: browserIndex,
        reviewer_id: reviewer.reviewer_id,
        duration_ms: Date.now() - started,
        attempts: attempt,
        returned_reviews: parsed.public_content.returned_review_count,
        visible_reviews: visible,
        status: completeness.stop_reason,
        error: completeness.stop_reason === 'response_shortfall' ? 'response_shortfall' : null,
      };
    } catch (error) {
      lastError = String(error.message || error).slice(0, 500);
      if (attempt > options.fetchRetries) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }
  return { ok: false, browser_index: browserIndex, reviewer_id: reviewer.reviewer_id, duration_ms: Date.now() - started, attempts: options.fetchRetries + 1, returned_reviews: 0, status: 'error', error: lastError };
}

function laneAllocation(concurrency, browserCount) {
  const active = Math.min(concurrency, browserCount);
  return Array.from({ length: active }, (_, browserIndex) => (
    Math.floor(concurrency / active) + (browserIndex < concurrency % active ? 1 : 0)
  ));
}

async function runStage(browsers, sample, concurrency, options) {
  const gate = new SmoothGate(options.requestIntervalMs);
  const results = new Array(sample.length);
  let next = 0;
  const started = Date.now();
  const lane = async (browserIndex) => {
    while (true) {
      const index = next++;
      if (index >= sample.length) return;
      const queueStartedOffsetMs = Date.now() - started;
      results[index] = await fetchOne(browsers[browserIndex], browserIndex, sample[index], options, gate);
      results[index].queue_started_offset_ms = queueStartedOffsetMs;
      results[index].queue_completed_offset_ms = Date.now() - started;
    }
  };
  const allocation = laneAllocation(Math.min(concurrency, sample.length), browsers.length);
  const lanes = allocation.flatMap((count, browserIndex) => (
    Array.from({ length: count }, () => lane(browserIndex))
  ));
  await Promise.all(lanes);
  const wallMs = Date.now() - started;
  const durations = results.map((item) => item.duration_ms);
  const errors = results.filter((item) => !item.ok);
  const throttles = errors.filter((item) => isThrottleError(item.error || ''));
  const completionOffsets = results.map((item) => item.queue_completed_offset_ms).sort((left, right) => left - right);
  const steadyLowIndex = Math.floor((completionOffsets.length - 1) * 0.1);
  const steadyHighIndex = Math.ceil((completionOffsets.length - 1) * 0.9);
  const steadyCompletions = steadyHighIndex - steadyLowIndex;
  const steadyWallMs = completionOffsets[steadyHighIndex] - completionOffsets[steadyLowIndex];
  return {
    concurrency,
    browser_count: browsers.length,
    active_browser_count: allocation.length,
    lanes_per_browser: allocation,
    sample_size: results.length,
    wall_ms: wallMs,
    profiles_per_minute: Number((results.length * 60000 / wallMs).toFixed(3)),
    steady_state_profiles_per_minute: steadyWallMs > 0
      ? Number((steadyCompletions * 60000 / steadyWallMs).toFixed(3)) : null,
    steady_state_window: { low_index: steadyLowIndex, high_index: steadyHighIndex, wall_ms: steadyWallMs },
    success_rate: Number(((results.length - errors.length) / results.length).toFixed(4)),
    error_rate: Number((errors.length / results.length).toFixed(4)),
    throttle_rate: Number((throttles.length / results.length).toFixed(4)),
    duration_p50_ms: percentile(durations, 0.5),
    duration_p95_ms: percentile(durations, 0.95),
    duration_max_ms: Math.max(...durations),
    returned_reviews: results.reduce((sum, item) => sum + item.returned_reviews, 0),
    statuses: results.reduce((counts, item) => { counts[item.status] = (counts[item.status] || 0) + 1; return counts; }, {}),
    errors: errors.map((item) => ({ reviewer_id: item.reviewer_id, error: item.error })),
    reviewer_results: results.map((item) => ({
      reviewer_id: item.reviewer_id,
      browser_index: item.browser_index,
      ok: item.ok,
      status: item.status,
      returned_reviews: item.returned_reviews,
      visible_reviews: item.visible_reviews ?? null,
      attempts: item.attempts,
      duration_ms: item.duration_ms,
      queue_started_offset_ms: item.queue_started_offset_ms,
      queue_completed_offset_ms: item.queue_completed_offset_ms,
      error: item.error,
    })),
  };
}

function selfTest() {
  const controller = new AdaptiveConcurrencyController({ start: 1, maximum: 8, plateauWindows: 2 });
  let decision = controller.observe({ profiles_per_minute: 10, error_rate: 0, throttle_rate: 0, duration_p95_ms: 1000 });
  if (decision.concurrency !== 2) throw new Error('controller did not increase');
  decision = controller.observe({ profiles_per_minute: 19, error_rate: 0, throttle_rate: 0, duration_p95_ms: 1050 });
  if (decision.concurrency !== 3) throw new Error('controller did not keep increasing');
  decision = controller.observe({ profiles_per_minute: 20, error_rate: 0.1, throttle_rate: 0.05, duration_p95_ms: 2000 });
  if (decision.action !== 'backoff' || decision.concurrency >= 3) throw new Error('controller did not back off');
  const allocation = laneAllocation(9, 2);
  if (allocation.length !== 2 || allocation[0] !== 5 || allocation[1] !== 4) throw new Error('browser lane allocation is not balanced');
  const sparse = laneAllocation(2, 3);
  if (sparse.length !== 2 || sparse.some((count) => count !== 1)) throw new Error('sparse browser allocation is invalid');
  const baselineStage = { reviewer_results: [
    { reviewer_id: 'a', status: 'complete', returned_reviews: 2 },
    { reviewer_id: 'b', status: 'service_cap', returned_reviews: 200 },
  ] };
  const baseline = annotateContentConsistency(baselineStage, null);
  const changedStage = { reviewer_results: [
    { reviewer_id: 'a', status: 'complete', returned_reviews: 2 },
    { reviewer_id: 'b', status: 'service_cap', returned_reviews: 150 },
  ] };
  annotateContentConsistency(changedStage, baseline);
  if (changedStage.content_mismatch_count !== 1 || changedStage.content_consistency_rate !== 0.5) throw new Error('content mismatch was not detected');
  console.log('Adaptive concurrency self-test: passed');
}

async function launchBrowsers(count) {
  const browsers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      browsers.push(await chromium.launch({ headless: true, args: stealth.buildLaunchArgs() }));
    }
    return browsers;
  } catch (error) {
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (options.selfTest) { selfTest(); return; }
  if (!options.list) throw new Error('--list is required');
  const listFile = path.resolve(options.list);
  const sample = await loadSample(listFile, options.profilesPerStage);
  if (sample.length < options.profilesPerStage) throw new Error(`only ${sample.length} sample reviewers found`);
  const browsers = await launchBrowsers(options.browserCount);
  const stages = [];
  const result = { generated_at: new Date().toISOString(), list: listFile, options, stages, termination: null };
  let controller = null;
  let baselineContent = null;
  try {
    if (options.mode === 'adaptive') {
      controller = new AdaptiveConcurrencyController({ start: options.adaptiveStart, maximum: options.adaptiveMax });
      for (let epoch = 0; epoch < options.adaptiveEpochs; epoch += 1) {
        const rotated = sample.slice(epoch % sample.length).concat(sample.slice(0, epoch % sample.length));
        const metrics = await runStage(browsers, rotated, controller.current, options);
        baselineContent = annotateContentConsistency(metrics, baselineContent);
        const decision = controller.observe(metrics);
        stages.push({ epoch: epoch + 1, ...metrics, decision });
        logStage(stages[stages.length - 1]);
        writeResult(options.output, result);
        if (options.cooldownMs > 0 && epoch + 1 < options.adaptiveEpochs) await new Promise((resolve) => setTimeout(resolve, options.cooldownMs));
      }
    } else {
      for (let stage = 0; stage < options.concurrencySequence.length; stage += 1) {
        const concurrency = options.concurrencySequence[stage];
        const offset = stage % sample.length;
        const rotated = sample.slice(offset).concat(sample.slice(0, offset));
        const metrics = await runStage(browsers, rotated, concurrency, options);
        baselineContent = annotateContentConsistency(metrics, baselineContent);
        stages.push({ stage: stage + 1, ...metrics });
        logStage(stages[stages.length - 1]);
        const unsafeReason = metrics.error_rate > 0.03 ? 'error_rate'
          : metrics.throttle_rate > 0.01 ? 'throttle_rate'
            : metrics.content_mismatch_count > 0 ? 'content_mismatch' : null;
        if (options.stopOnUnsafe && unsafeReason) {
          result.termination = { reason: unsafeReason, stage: stage + 1, concurrency };
          writeResult(options.output, result);
          break;
        }
        writeResult(options.output, result);
        if (options.cooldownMs > 0 && stage + 1 < options.concurrencySequence.length) await new Promise((resolve) => setTimeout(resolve, options.cooldownMs));
      }
    }
  } finally {
    await Promise.allSettled(browsers.map((browser) => browser.close()));
  }
  writeResult(options.output, result);
}

main().catch((error) => { console.error(`[PARALLEL BENCHMARK] ERROR: ${error.message}`); process.exitCode = 1; });
