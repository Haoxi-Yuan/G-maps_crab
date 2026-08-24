#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');
const { scrapeReviews } = require('../review-scraper');

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
  --fresh                Remove an existing output file before starting
  --help                 Show this help
`);
}

function parseArgs(argv) {
  const options = { maxReviews: 50000, minCount: 0, fresh: false };
  const values = new Set(['--city', '--input', '--output', '--max-reviews', '--min-count', '--live-status']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (key === '--fresh') { options.fresh = true; continue; }
    if (!values.has(key)) throw new Error(`unknown option: ${key}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value`);
    const value = argv[++index];
    const property = {
      '--city': 'city', '--input': 'input', '--output': 'output',
      '--max-reviews': 'maxReviews', '--min-count': 'minCount', '--live-status': 'liveStatusFile',
    }[key];
    options[property] = value;
  }
  options.maxReviews = Number(options.maxReviews);
  options.minCount = Number(options.minCount);
  if (!Number.isInteger(options.maxReviews) || options.maxReviews < 1) throw new Error('--max-reviews must be a positive integer');
  if (!Number.isInteger(options.minCount) || options.minCount < 0) throw new Error('--min-count must be a non-negative integer');
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
}

main().catch((error) => {
  console.error(`[REVIEWS] ERROR: ${error.message}`);
  process.exitCode = 1;
});
