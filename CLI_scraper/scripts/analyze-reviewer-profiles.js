#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { iterateNdjsonRecords } = require('../src/ndjson-reader');

const root = path.resolve(__dirname, '..');
const contract = require('../contracts/reviewer-profiles-ndjson-keys.v1.json');

function usage() {
  console.log(`
Analyze reviewer-profile NDJSON quality

Usage:
  node scripts/analyze-reviewer-profiles.js --input <reviewers.ndjson> [options]

Options:
  --live-status <file>  Read elapsed_seconds from the scraper status file
  --elapsed-seconds <n> Explicit elapsed wall time
  --output <file>       Write the JSON report
  --help                Show this help
`);
}

function parseArgs(argv) {
  const options = {};
  const values = new Set(['--input', '--live-status', '--elapsed-seconds', '--output']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (!values.has(key)) throw new Error(`unknown option: ${key}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value`);
    options[{ '--input': 'input', '--live-status': 'liveStatus', '--elapsed-seconds': 'elapsedSeconds', '--output': 'output' }[key]] = argv[++index];
  }
  if (options.elapsedSeconds != null) options.elapsedSeconds = Number(options.elapsedSeconds);
  return options;
}

function present(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function makeCoverage(fields) {
  return Object.fromEntries(fields.map((field) => [field, { present: 0, total: 0, rate: null }]));
}

function observeCoverage(coverage, object) {
  for (const [field, stats] of Object.entries(coverage)) {
    stats.total += 1;
    if (present(object?.[field])) stats.present += 1;
  }
}

function finalizeCoverage(coverage) {
  for (const stats of Object.values(coverage)) {
    stats.rate = stats.total ? Number((stats.present / stats.total).toFixed(4)) : null;
  }
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function quantiles(values) {
  if (!values.length) return { n: 0, min: null, p25: null, median: null, p75: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: sorted[sorted.length - 1],
  };
}

async function analyze(inputFile, options = {}) {
  const recordCoverage = makeCoverage(contract.topLevelFields);
  const reviewerCoverage = makeCoverage(contract.reviewerFields);
  const activityCoverage = makeCoverage(contract.activityFields);
  const reviewCoverage = makeCoverage(contract.reviewFields);
  const detailCoverage = makeCoverage(contract.normalizedReviewDetailFields);
  const businessCoverage = makeCoverage(contract.businessFields);
  const statuses = {};
  const stopReasons = {};
  const latestRecords = new Map();
  let attemptRecords = 0;
  let attemptErrors = 0;

  for await (const logical of iterateNdjsonRecords(inputFile)) {
    const record = logical.value || {};
    attemptRecords += 1;
    if (record._status === 'error') attemptErrors += 1;
    latestRecords.set(record.reviewer_id || `__missing_${attemptRecords}`, record);
  }

  let records = 0;
  let validProfiles = 0;
  let returnedReviews = 0;
  let reviewsWithId = 0;
  let reviewsWithRating = 0;
  let reviewsWithBusinessName = 0;
  let reviewsWithCoordinates = 0;
  let visibleReviews = 0;
  let fullHistoryProfiles = 0;
  const reviewsPerDaySamples = [];
  const windowSpanSamples = [];

  for (const record of latestRecords.values()) {
    records += 1;
    statuses[record._status || 'missing'] = (statuses[record._status || 'missing'] || 0) + 1;
    const stopReason = record.completeness?.stop_reason || 'missing';
    stopReasons[stopReason] = (stopReasons[stopReason] || 0) + 1;
    observeCoverage(recordCoverage, record);
    if (record.reviewer) {
      validProfiles += 1;
      observeCoverage(reviewerCoverage, record.reviewer);
      observeCoverage(activityCoverage, record.activity || {});
      if (record.activity?.is_full_history) fullHistoryProfiles += 1;
      if (Number.isFinite(record.activity?.reviews_per_day)) reviewsPerDaySamples.push(record.activity.reviews_per_day);
      if (Number.isFinite(record.activity?.window_span_days)) windowSpanSamples.push(record.activity.window_span_days);
    }
    if (Number.isFinite(record.public_content?.public_review_count)) visibleReviews += record.public_content.public_review_count;
    for (const review of record.public_content?.reviews || []) {
      returnedReviews += 1;
      observeCoverage(reviewCoverage, review);
      observeCoverage(detailCoverage, review.review_details || {});
      observeCoverage(businessCoverage, review.business || {});
      if (present(review.review_id)) reviewsWithId += 1;
      if (present(review.rating)) reviewsWithRating += 1;
      if (present(review.business?.name)) reviewsWithBusinessName += 1;
      if (Number.isFinite(review.business?.coordinates?.lat) && Number.isFinite(review.business?.coordinates?.lng)) reviewsWithCoordinates += 1;
    }
  }

  [recordCoverage, reviewerCoverage, activityCoverage, reviewCoverage, detailCoverage, businessCoverage].forEach(finalizeCoverage);
  let elapsedSeconds = options.elapsedSeconds ?? null;
  if (elapsedSeconds == null && options.liveStatus && fs.existsSync(options.liveStatus)) {
    elapsedSeconds = JSON.parse(fs.readFileSync(options.liveStatus, 'utf8')).elapsed_seconds ?? null;
  }

  return {
    generated_at: new Date().toISOString(),
    input_file: path.resolve(inputFile),
    summary: {
      records,
      attempt_records: attemptRecords,
      attempt_error_records: attemptErrors,
      retried_records: attemptRecords - records,
      valid_profiles: validProfiles,
      profile_success_rate: ratio(validProfiles, records),
      error_records: statuses.error || 0,
      error_rate: ratio(statuses.error || 0, records),
      returned_reviews: returnedReviews,
      visible_reviews_reported: visibleReviews,
      returned_to_visible_ratio: ratio(returnedReviews, visibleReviews),
      statuses,
      stop_reasons: stopReasons,
    },
    performance: {
      elapsed_seconds: elapsedSeconds,
      profiles_per_minute: elapsedSeconds ? Number((60 * records / elapsedSeconds).toFixed(3)) : null,
      seconds_per_profile: records && elapsedSeconds ? Number((elapsedSeconds / records).toFixed(3)) : null,
    },
    core_review_success: {
      review_id: { present: reviewsWithId, total: returnedReviews, rate: ratio(reviewsWithId, returnedReviews) },
      rating: { present: reviewsWithRating, total: returnedReviews, rate: ratio(reviewsWithRating, returnedReviews) },
      business_name: { present: reviewsWithBusinessName, total: returnedReviews, rate: ratio(reviewsWithBusinessName, returnedReviews) },
      coordinates: { present: reviewsWithCoordinates, total: returnedReviews, rate: ratio(reviewsWithCoordinates, returnedReviews) },
    },
    activity: {
      full_history_profiles: fullHistoryProfiles,
      full_history_rate: ratio(fullHistoryProfiles, validProfiles),
      reviews_per_day: quantiles(reviewsPerDaySamples),
      window_span_days: quantiles(windowSpanSamples),
    },
    field_coverage: {
      record: recordCoverage,
      reviewer: reviewerCoverage,
      activity: activityCoverage,
      review: reviewCoverage,
      review_details: detailCoverage,
      business: businessCoverage,
    },
    notes: [
      'Field coverage is observed non-null coverage, not a failure rate; translations, owner responses, media, biography and dining details are optional.',
      'A profile is historically complete only when completeness.stop_reason is complete; service_cap and hidden histories are intentionally incomplete.',
    ],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.input) throw new Error('--input is required');
  const inputFile = path.resolve(root, options.input);
  const report = await analyze(inputFile, {
    liveStatus: options.liveStatus ? path.resolve(root, options.liveStatus) : null,
    elapsedSeconds: options.elapsedSeconds,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputFile = path.resolve(root, options.output);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, json);
  }
  process.stdout.write(json);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[REVIEWER ANALYSIS] ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { analyze, present };
