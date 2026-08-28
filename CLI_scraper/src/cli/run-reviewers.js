#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { scrapeReviewerProfiles, SERVICE_MAX_REVIEWS } = require('../reviewer-profile-scraper');

const root = path.resolve(__dirname, '../..');

function usage() {
  console.log(`
Google Maps reviewer-profile runner

Usage:
  node src/cli/run-reviewers.js --city <slug> [options]
  node src/cli/run-reviewers.js --input <reviews.ndjson> [options]

Options:
  --city <slug>                Resolve output/<slug>/reviews.ndjson
  --input <file>               Explicit reviews NDJSON
                               or review SQLite database
  --output <file>              Profile NDJSON (default: reviewers.ndjson beside input)
  --list-output <file>         Unique reviewer list (default: reviewers.list.ndjson)
  --reviewer-list-input <file> Use a prebuilt/sharded reviewer list
  --list-limit <n>             Keep at most N unique reviewers in the list
  --list-order <mode>          source or review-count-desc (default: source)
  --list-only                  Generate the reviewer list without opening a browser
  --max-reviewers <n>          Process at most N pending reviewers
  --max-profile-reviews <n>    Public reviews per profile, 1-${SERVICE_MAX_REVIEWS} (default: ${SERVICE_MAX_REVIEWS})
  --delay-ms <n>               Delay between profiles (default: 500)
  --fetch-retries <n>          Retries for transient profile failures (default: 2)
  --no-review-media            Drop review photos from the response (about 7x
                               smaller payloads; text, coordinates, place ids
                               and structured answers are unaffected)
  --live-status <file>         Live status JSON path
  --browser-executable <file>  Optional Chromium/Chrome executable
  --fresh                      Remove existing profile output before starting
  --help                       Show this help

The output is append-only and resumable. Google caps a profile response at
${SERVICE_MAX_REVIEWS} public reviews and rejects any larger request outright;
completeness.stop_reason records complete, private_or_hidden, requested_limit,
service_cap, response_shortfall, or fetch_error.
`);
}

function parseArgs(argv) {
  const options = {
    maxProfileReviews: SERVICE_MAX_REVIEWS, delayMs: 500, maxFetchRetries: 2, fresh: false, listOnly: false, includeReviewMedia: true,
  };
  const values = new Set([
    '--city', '--input', '--output', '--list-output', '--reviewer-list-input', '--list-limit', '--list-order', '--max-reviewers',
    '--max-profile-reviews', '--delay-ms', '--fetch-retries', '--live-status', '--browser-executable',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (key === '--fresh') { options.fresh = true; continue; }
    if (key === '--list-only') { options.listOnly = true; continue; }
    if (key === '--no-review-media') { options.includeReviewMedia = false; continue; }
    if (!values.has(key)) throw new Error(`unknown option: ${key}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value`);
    const value = argv[++index];
    const property = {
      '--city': 'city',
      '--input': 'input',
      '--output': 'output',
      '--list-output': 'listOutput',
      '--reviewer-list-input': 'reviewerListInput',
      '--list-limit': 'listLimit',
      '--list-order': 'listOrder',
      '--max-reviewers': 'maxReviewers',
      '--max-profile-reviews': 'maxProfileReviews',
      '--delay-ms': 'delayMs',
      '--fetch-retries': 'maxFetchRetries',
      '--live-status': 'liveStatusFile',
      '--browser-executable': 'browserExecutablePath',
    }[key];
    options[property] = value;
  }
  if (options.maxReviewers != null) options.maxReviewers = Number(options.maxReviewers);
  if (options.listLimit != null) options.listLimit = Number(options.listLimit);
  options.maxProfileReviews = Number(options.maxProfileReviews);
  options.delayMs = Number(options.delayMs);
  options.maxFetchRetries = Number(options.maxFetchRetries);
  if (options.maxReviewers != null && (!Number.isInteger(options.maxReviewers) || options.maxReviewers < 1)) {
    throw new Error('--max-reviewers must be a positive integer');
  }
  if (options.listLimit != null && (!Number.isInteger(options.listLimit) || options.listLimit < 1)) {
    throw new Error('--list-limit must be a positive integer');
  }
  if (options.listOrder != null && !['source', 'review-count-desc'].includes(options.listOrder)) {
    throw new Error('--list-order must be source or review-count-desc');
  }
  if (!Number.isInteger(options.maxProfileReviews) || options.maxProfileReviews < 1 || options.maxProfileReviews > SERVICE_MAX_REVIEWS) {
    throw new Error(`--max-profile-reviews must be an integer from 1 to ${SERVICE_MAX_REVIEWS}`);
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) throw new Error('--delay-ms must be a non-negative integer');
  if (!Number.isInteger(options.maxFetchRetries) || options.maxFetchRetries < 0) throw new Error('--fetch-retries must be a non-negative integer');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.city && !options.input) throw new Error('--city or --input is required');

  const inputFile = options.input
    ? path.resolve(root, options.input)
    : path.join(root, 'output', options.city, 'reviews.ndjson');
  if (!fs.existsSync(inputFile)) throw new Error(`input file not found: ${inputFile}`);

  const outputFile = options.output
    ? path.resolve(root, options.output)
    : path.join(path.dirname(inputFile), 'reviewers.ndjson');
  const listFile = options.listOutput
    ? path.resolve(root, options.listOutput)
    : path.join(path.dirname(outputFile), 'reviewers.list.ndjson');
  if (options.fresh) {
    // Remove the output and its resume sidecar together so a stale index can
    // never point at a freshly emptied output.
    for (const file of [outputFile, `${outputFile}.done`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }

  await scrapeReviewerProfiles(inputFile, outputFile, {
    listFile,
    reviewerListInput: options.reviewerListInput ? path.resolve(root, options.reviewerListInput) : undefined,
    listLimit: options.listLimit,
    listOrder: options.listOrder,
    listOnly: options.listOnly,
    maxReviewers: options.maxReviewers,
    maxProfileReviews: options.maxProfileReviews,
    includeReviewMedia: options.includeReviewMedia,
    delayMs: options.delayMs,
    maxFetchRetries: options.maxFetchRetries,
    liveStatusFile: options.liveStatusFile ? path.resolve(root, options.liveStatusFile) : undefined,
    browserExecutablePath: options.browserExecutablePath ? path.resolve(root, options.browserExecutablePath) : undefined,
  });
}

main().catch((error) => {
  console.error(`[REVIEWERS] ERROR: ${error.message}`);
  process.exitCode = 1;
});
