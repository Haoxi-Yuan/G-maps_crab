#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { SERVICE_MAX_REVIEWS } = require('../reviewer-profile-scraper');
const { scrapeReviewerProfilesParallel } = require('../reviewer-profile-parallel-scraper');

const root = path.resolve(__dirname, '../..');

function usage() {
  console.log(`
Google Maps reviewer-profile global parallel runner

Usage:
  node src/cli/run-reviewers-parallel.js --run-root <reviewer-run> --input <reviews.db> [options]

Options:
  --run-root <dir>             Run containing list/manifest.json and list/shards
  --input <file>               Source reviews DB/NDJSON (metadata only; never written)
  --output-dir <dir>           Override shard output directory
  --live-status <file>         Default: <run-root>/status/reviewers.parallel.live.json
  --concurrency <n>            Global in-flight profiles (default: 27)
  --request-interval-ms <n>    Shared gate across navigation/MAS starts (default: 150)
  --window-size <n>            Control/status window (default: 200)
  --browser-restart-every <n>  Drain and rotate Chromium (default: 2800)
  --max-reviewers <n>          Stop after N profiles (for canaries)
  --max-profile-reviews <n>    1-${SERVICE_MAX_REVIEWS} (default: ${SERVICE_MAX_REVIEWS})
  --fetch-retries <n>          Default: 2
  --no-review-media            Omit review media
  --browser-executable <file>  Optional Chromium/Chrome executable
  --help                       Show this help

One Chromium serves all isolated contexts. The four stable reviewer shards keep
their original append-only output files, and existing non-error reviewer records
are scanned before scheduling so a stopped serial run resumes without re-fetching.
`);
}

function parseArgs(argv) {
  const options = {
    concurrency: 27,
    requestIntervalMs: 150,
    windowSize: 200,
    browserRestartEvery: 2800,
    maxProfileReviews: SERVICE_MAX_REVIEWS,
    maxFetchRetries: 2,
    includeReviewMedia: true,
  };
  const values = new Set([
    '--run-root', '--input', '--output-dir', '--live-status', '--concurrency',
    '--request-interval-ms', '--window-size', '--browser-restart-every',
    '--max-reviewers', '--max-profile-reviews', '--fetch-retries', '--browser-executable',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (key === '--no-review-media') { options.includeReviewMedia = false; continue; }
    if (!values.has(key)) throw new Error(`unknown option: ${key}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value`);
    const value = argv[++index];
    const property = {
      '--run-root': 'runRoot', '--input': 'input', '--output-dir': 'outputDir',
      '--live-status': 'liveStatusFile', '--concurrency': 'concurrency',
      '--request-interval-ms': 'requestIntervalMs', '--window-size': 'windowSize',
      '--browser-restart-every': 'browserRestartEvery', '--max-reviewers': 'maxReviewers',
      '--max-profile-reviews': 'maxProfileReviews', '--fetch-retries': 'maxFetchRetries',
      '--browser-executable': 'browserExecutablePath',
    }[key];
    options[property] = value;
  }
  for (const key of ['concurrency', 'requestIntervalMs', 'windowSize', 'browserRestartEvery', 'maxProfileReviews', 'maxFetchRetries']) {
    options[key] = Number(options[key]);
  }
  if (options.maxReviewers != null) options.maxReviewers = Number(options.maxReviewers);
  for (const key of ['concurrency', 'windowSize', 'browserRestartEvery', 'maxProfileReviews']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  for (const key of ['requestIntervalMs', 'maxFetchRetries']) {
    if (!Number.isInteger(options[key]) || options[key] < 0) throw new Error(`${key} must be a non-negative integer`);
  }
  if (options.maxReviewers != null && (!Number.isInteger(options.maxReviewers) || options.maxReviewers < 1)) throw new Error('--max-reviewers must be a positive integer');
  if (options.maxProfileReviews > SERVICE_MAX_REVIEWS) throw new Error(`--max-profile-reviews cannot exceed ${SERVICE_MAX_REVIEWS}`);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.runRoot || !options.input) throw new Error('--run-root and --input are required');

  const runRoot = path.resolve(root, options.runRoot);
  const input = path.resolve(root, options.input);
  const manifestFile = path.join(runRoot, 'list', 'manifest.json');
  if (!fs.existsSync(input)) throw new Error(`input file not found: ${input}`);
  if (!fs.existsSync(manifestFile)) throw new Error(`manifest not found: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (!Number.isInteger(manifest.shards) || manifest.shards < 1) throw new Error('manifest.shards is invalid');
  if (!Number.isInteger(manifest.unique_google_reviewers) || manifest.unique_google_reviewers < 1) throw new Error('manifest.unique_google_reviewers is invalid');

  const outputDir = options.outputDir ? path.resolve(root, options.outputDir) : path.join(runRoot, 'output');
  const shards = Array.from({ length: manifest.shards }, (_, shard) => ({
    listFile: path.join(runRoot, 'list', 'shards', `reviewers.part-${shard}.ndjson`),
    outputFile: path.join(outputDir, `reviewers.part-${shard}.ndjson`),
  }));
  const liveStatusFile = options.liveStatusFile
    ? path.resolve(root, options.liveStatusFile)
    : path.join(runRoot, 'status', 'reviewers.parallel.live.json');

  await scrapeReviewerProfilesParallel({
    shards,
    totalReviewers: manifest.unique_google_reviewers,
    sourceReviewsFile: input,
  }, {
    ...options,
    liveStatusFile,
    browserExecutablePath: options.browserExecutablePath ? path.resolve(root, options.browserExecutablePath) : undefined,
  });
}

main().catch((error) => {
  console.error(`[REVIEWERS PARALLEL] ERROR: ${error.stack || error.message}`);
  process.exitCode = 1;
});
