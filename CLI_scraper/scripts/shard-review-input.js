#!/usr/bin/env node
'use strict';

/**
 * Split only unfinished places into balanced review-scraper inputs.
 *
 * The existing reviews file is scanned as raw Buffers so an unusually large
 * NDJSON record is never decoded in full. A place is considered complete with
 * the same markers used by src/review-scraper.js: it has detailedReviews and
 * is neither a placeholder nor a network-layer failure.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');

function usage() {
  console.error('Usage: node scripts/shard-review-input.js --places FILE --reviews FILE --out-dir DIR [--shards 4] [--max-reviews 50000]');
}

function parseArgs(argv) {
  const args = { shards: 4, maxReviews: 50000 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--places') args.places = argv[++i];
    else if (flag === '--reviews') args.reviews = argv[++i];
    else if (flag === '--out-dir') args.outDir = argv[++i];
    else if (flag === '--shards') args.shards = Number(argv[++i]);
    else if (flag === '--max-reviews') args.maxReviews = Number(argv[++i]);
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function headText(chunks, limit = 8192) {
  const slices = [];
  let taken = 0;
  for (const chunk of chunks) {
    if (taken >= limit) break;
    const slice = chunk.subarray(0, Math.min(limit - taken, chunk.length));
    slices.push(slice);
    taken += slice.length;
  }
  return Buffer.concat(slices, taken).toString('utf8');
}

function chunksContain(chunks, needle) {
  let tail = Buffer.alloc(0);
  for (const chunk of chunks) {
    const scan = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    if (scan.indexOf(needle) >= 0) return true;
    tail = scan.subarray(Math.max(0, scan.length - needle.length + 1));
  }
  return false;
}

async function scanCompletedReviews(filename) {
  const done = new Set();
  const hash = crypto.createHash('sha256');
  const pidRe = /"placeId"\s*:\s*"([^"]+)"/;
  const detailed = Buffer.from('"detailedReviews"');
  const placeholder = Buffer.from('"_placeholder":true');
  const networkError = Buffer.from('"_network_error":true');
  let chunks = [];
  let lines = 0;
  let pidless = 0;

  function finishLine() {
    if (!chunks.length) return;
    lines++;
    const match = headText(chunks).match(pidRe);
    if (!match) {
      pidless++;
      chunks = [];
      return;
    }
    if (chunksContain(chunks, detailed)
        && !chunksContain(chunks, placeholder)
        && !chunksContain(chunks, networkError)) {
      done.add(match[1]);
    }
    chunks = [];
  }

  const input = fs.createReadStream(filename);
  for await (const chunk of input) {
    hash.update(chunk);
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      if (i > start) chunks.push(chunk.subarray(start, i));
      finishLine();
      start = i + 1;
    }
    if (start < chunk.length) chunks.push(chunk.subarray(start));
  }
  finishLine();
  return { done, lines, pidless, sha256: hash.digest('hex') };
}

function workload(reviewCount, maxReviews) {
  const expected = Number.isFinite(reviewCount) && reviewCount > 0 ? reviewCount : 0;
  // Each POI has a fixed page/photo cost plus roughly one unit per review page.
  return 10 + Math.ceil(Math.min(expected, maxReviews) / 100);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.places || !args.reviews || !args.outDir
      || !Number.isInteger(args.shards) || args.shards < 1
      || !Number.isFinite(args.maxReviews) || args.maxReviews < 1) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(args.places)) throw new Error(`Missing places file: ${args.places}`);
  if (!fs.existsSync(args.reviews)) throw new Error(`Missing reviews file: ${args.reviews}`);
  fs.mkdirSync(args.outDir, { recursive: true });

  const reviewScan = await scanCompletedReviews(args.reviews);
  console.log(`[SHARD] reviews lines=${reviewScan.lines} completed_place_ids=${reviewScan.done.size} pidless=${reviewScan.pidless}`);
  if (reviewScan.pidless) throw new Error(`Existing reviews file has ${reviewScan.pidless} line(s) without placeId`);

  const shards = [];
  for (let i = 0; i < args.shards; i++) {
    const filename = path.join(args.outDir, `places.part-${i}.ndjson`);
    const stream = fs.createWriteStream(filename, { flags: 'wx' });
    shards.push({
      index: i,
      filename,
      stream,
      hash: crypto.createHash('sha256'),
      count: 0,
      expectedReviews: 0,
      workUnits: 0,
      bytes: 0,
    });
  }

  const placeHash = crypto.createHash('sha256');
  const seenInput = new Set();
  let inputLines = 0;
  let inputUnique = 0;
  let duplicateInput = 0;
  let parseErrors = 0;
  let doneInInput = 0;

  const input = fs.createReadStream(args.places, { encoding: 'utf8' });
  input.on('data', (chunk) => placeHash.update(chunk, 'utf8'));
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    inputLines++;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_) {
      parseErrors++;
      continue;
    }
    const business = row.business || {};
    const pid = business.placeId || (row._meta && row._meta.placeId);
    if (!pid) {
      parseErrors++;
      continue;
    }
    if (seenInput.has(pid)) {
      duplicateInput++;
      continue;
    }
    seenInput.add(pid);
    inputUnique++;
    if (reviewScan.done.has(pid)) {
      doneInInput++;
      continue;
    }

    let target = shards[0];
    for (let i = 1; i < shards.length; i++) {
      if (shards[i].workUnits < target.workUnits
          || (shards[i].workUnits === target.workUnits && shards[i].count < target.count)) {
        target = shards[i];
      }
    }
    const expected = Number(business.reviewCount) || 0;
    const encoded = Buffer.from(`${line}\n`);
    if (!target.stream.write(encoded)) await once(target.stream, 'drain');
    target.hash.update(encoded);
    target.count++;
    target.expectedReviews += Math.max(0, expected);
    target.workUnits += workload(expected, args.maxReviews);
    target.bytes += encoded.length;
  }

  for (const shard of shards) shard.stream.end();
  await Promise.all(shards.map((shard) => once(shard.stream, 'finish')));
  if (parseErrors) throw new Error(`Places input has ${parseErrors} invalid or placeId-less line(s)`);

  const remaining = shards.reduce((sum, shard) => sum + shard.count, 0);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    places: path.resolve(args.places),
    placesSha256: placeHash.digest('hex'),
    reviewsBase: path.resolve(args.reviews),
    reviewsBaseSha256: reviewScan.sha256,
    reviewLines: reviewScan.lines,
    completedPlaceIds: reviewScan.done.size,
    inputLines,
    inputUniquePlaceIds: inputUnique,
    duplicateInputPlaceIds: duplicateInput,
    completedPlaceIdsInInput: doneInInput,
    remainingPlaceIds: remaining,
    shards: shards.map((shard) => ({
      index: shard.index,
      file: path.resolve(shard.filename),
      placeIds: shard.count,
      expectedReviews: shard.expectedReviews,
      workUnits: shard.workUnits,
      bytes: shard.bytes,
      sha256: shard.hash.digest('hex'),
    })),
  };
  if (doneInInput + remaining !== inputUnique) {
    throw new Error(`Accounting mismatch: done=${doneInInput} remaining=${remaining} inputUnique=${inputUnique}`);
  }
  const manifestFile = path.join(args.outDir, 'shard-manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(`[SHARD] ERROR: ${error.stack || error.message}`);
  process.exitCode = 1;
});
