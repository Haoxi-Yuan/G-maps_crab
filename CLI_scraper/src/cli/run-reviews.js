#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');
const { scrapeReviews } = require('../review-scraper');
const { scrapeReviewerProfiles, SERVICE_MAX_REVIEWS } = require('../reviewer-profile-scraper');

const root = path.resolve(__dirname, '../..');

function usage() {
  console.log(`
Cross-platform review runner

Usage:
  node src/cli/run-reviews.js --city <slug> [options]
  node src/cli/run-reviews.js --input <places.ndjson> [options]

Options:
  --city <slug>          Resolve output/<slug>/places.ndjson
  --input <file>         Explicit places NDJSON
  --output <file>        Reviews NDJSON (default: beside the input)
  --max-reviews <n>      Maximum reviews per place (default: 50000)
  --min-count <n>        Only scrape places with at least N reviews
  --live-status <file>   Live status JSON path
  --reviewers            Continue with reviewer profiles after reviews finish
  --reviewers-output <file>       Profile NDJSON (default: reviewers.ndjson)
  --reviewers-list-output <file>  Unique reviewer list NDJSON
  --reviewer-max-reviews <n>      Public reviews/profile, 1-${SERVICE_MAX_REVIEWS} (default: ${SERVICE_MAX_REVIEWS})
  --reviewer-max-reviewers <n>    Process at most N pending reviewers
  --reviewer-delay-ms <n>         Delay between profiles (default: 500)
  --reviewer-live-status <file>   Reviewer live status JSON
  --reviewers-fresh               Remove existing reviewer output first
  --fresh                Remove an existing output file before starting
  --help                 Show this help
`);
}

function parseArgs(argv) {
  const options = { maxReviews: 50000, minCount: 0, reviewerMaxReviews: SERVICE_MAX_REVIEWS, reviewerDelayMs: 500, fresh: false, reviewers: false, reviewersFresh: false };
  const values = new Set([
    '--city', '--input', '--output', '--max-reviews', '--min-count', '--live-status',
    '--reviewers-output', '--reviewers-list-output', '--reviewer-max-reviews',
    '--reviewer-max-reviewers', '--reviewer-delay-ms', '--reviewer-live-status',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (key === '--fresh') { options.fresh = true; continue; }
    if (key === '--reviewers') { options.reviewers = true; continue; }
    if (key === '--reviewers-fresh') { options.reviewersFresh = true; continue; }
    if (!values.has(key)) throw new Error(`unknown option: ${key}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value`);
    const value = argv[++index];
    const property = {
      '--city': 'city', '--input': 'input', '--output': 'output',
      '--max-reviews': 'maxReviews', '--min-count': 'minCount', '--live-status': 'liveStatusFile',
      '--reviewers-output': 'reviewersOutput', '--reviewers-list-output': 'reviewersListOutput',
      '--reviewer-max-reviews': 'reviewerMaxReviews', '--reviewer-max-reviewers': 'reviewerMaxReviewers',
      '--reviewer-delay-ms': 'reviewerDelayMs', '--reviewer-live-status': 'reviewerLiveStatusFile',
    }[key];
    options[property] = value;
  }
  options.maxReviews = Number(options.maxReviews);
  options.minCount = Number(options.minCount);
  options.reviewerMaxReviews = Number(options.reviewerMaxReviews);
  options.reviewerDelayMs = Number(options.reviewerDelayMs);
  if (options.reviewerMaxReviewers != null) options.reviewerMaxReviewers = Number(options.reviewerMaxReviewers);
  if (!Number.isInteger(options.maxReviews) || options.maxReviews < 1) throw new Error('--max-reviews must be a positive integer');
  if (!Number.isInteger(options.minCount) || options.minCount < 0) throw new Error('--min-count must be a non-negative integer');
  if (!Number.isInteger(options.reviewerMaxReviews) || options.reviewerMaxReviews < 1 || options.reviewerMaxReviews > SERVICE_MAX_REVIEWS) {
    throw new Error(`--reviewer-max-reviews must be an integer from 1 to ${SERVICE_MAX_REVIEWS}`);
  }
  if (!Number.isInteger(options.reviewerDelayMs) || options.reviewerDelayMs < 0) throw new Error('--reviewer-delay-ms must be a non-negative integer');
  if (options.reviewerMaxReviewers != null && (!Number.isInteger(options.reviewerMaxReviewers) || options.reviewerMaxReviewers < 1)) {
    throw new Error('--reviewer-max-reviewers must be a positive integer');
  }
  return options;
}

async function filteredInput(inputFile, minimum) {
  if (!minimum) return inputFile;
  const target = inputFile.replace(/\.ndjson$/i, `.min-${minimum}.ndjson`);
  const reader = readline.createInterface({ input: fs.createReadStream(inputFile), crlfDelay: Infinity });
  const writer = fs.createWriteStream(target, { flags: 'w' });
  let kept = 0;
  for await (const line of reader) {
    if (!line.trim()) continue;
    const place = JSON.parse(line);
    const reviewCount = Number(place.business && place.business.reviewCount || 0);
    if (reviewCount < minimum) continue;
    if (!writer.write(`${line}\n`)) await once(writer, 'drain');
    kept += 1;
  }
  writer.end();
  await once(writer, 'finish');
  console.log(`[REVIEWS] filtered input: ${kept} places with at least ${minimum} reviews`);
  return target;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.city && !options.input) throw new Error('--city or --input is required');

  let inputFile = options.input
    ? path.resolve(root, options.input)
    : path.join(root, 'output', options.city, 'places.ndjson');
  if (!fs.existsSync(inputFile)) throw new Error(`input file not found: ${inputFile}`);
  inputFile = await filteredInput(inputFile, options.minCount);

  const outputFile = options.output
    ? path.resolve(root, options.output)
    : path.join(path.dirname(inputFile), 'reviews.ndjson');
  if (options.fresh && fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

  await scrapeReviews(inputFile, outputFile, {
    maxReviews: options.maxReviews,
    liveStatusFile: options.liveStatusFile ? path.resolve(root, options.liveStatusFile) : undefined,
  });

  if (options.reviewers) {
    const reviewersOutput = options.reviewersOutput
      ? path.resolve(root, options.reviewersOutput)
      : path.join(path.dirname(outputFile), 'reviewers.ndjson');
    if (options.reviewersFresh && fs.existsSync(reviewersOutput)) fs.unlinkSync(reviewersOutput);
    await scrapeReviewerProfiles(outputFile, reviewersOutput, {
      listFile: options.reviewersListOutput ? path.resolve(root, options.reviewersListOutput) : undefined,
      maxReviewers: options.reviewerMaxReviewers,
      maxProfileReviews: options.reviewerMaxReviews,
      delayMs: options.reviewerDelayMs,
      liveStatusFile: options.reviewerLiveStatusFile ? path.resolve(root, options.reviewerLiveStatusFile) : undefined,
    });
  }
}

main().catch((error) => {
  console.error(`[REVIEWS] ERROR: ${error.message}`);
  process.exitCode = 1;
});
