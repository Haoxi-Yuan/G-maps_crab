#!/usr/bin/env node
'use strict';

/**
 * Flatten a multi-boundary batch into one review input.
 *
 * Adjacent boundary buffers overlap heavily, so the same POI appears in several
 * area directories. Reviewing each copy separately wastes the majority of the
 * run, and sharding by area pins one worker to whichever area happens to hold
 * tens of thousands of POIs. This collapses the batch to unique placeIds and
 * keeps a placeId -> areas map so per-area attribution survives the flattening.
 *
 * Existing per-area reviews are concatenated untouched; shard-review-input.js
 * consumes that file to skip places already done.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function usage() {
  console.error('Usage: node scripts/merge-batch-places.js --batch DIR --out-places FILE --out-reviews FILE --out-map FILE');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--batch') args.batch = argv[++i];
    else if (flag === '--out-places') args.outPlaces = argv[++i];
    else if (flag === '--out-reviews') args.outReviews = argv[++i];
    else if (flag === '--out-map') args.outMap = argv[++i];
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function areaSlug(dirName) {
  const marker = dirName.indexOf('__');
  return marker >= 0 ? dirName.slice(marker + 2) : dirName;
}

async function writeAll(stream, chunk) {
  if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.batch || !args.outPlaces || !args.outReviews || !args.outMap) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  const dirs = fs.readdirSync(args.batch, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const placesOut = fs.createWriteStream(args.outPlaces);
  const areasByPlace = new Map();
  let totalLines = 0;
  let unique = 0;
  let unparsed = 0;

  for (const dir of dirs) {
    const slug = areaSlug(dir);
    const file = path.join(args.batch, dir, 'places.ndjson');
    if (!fs.existsSync(file)) continue;
    const reader = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });
    for await (const line of reader) {
      if (!line.trim()) continue;
      totalLines++;
      let placeId = null;
      try {
        const record = JSON.parse(line);
        placeId = (record.business && record.business.placeId)
          || (record._meta && record._meta.placeId)
          || null;
      } catch {
        unparsed++;
        continue;
      }
      if (!placeId) { unparsed++; continue; }
      const known = areasByPlace.get(placeId);
      if (known) { known.push(slug); continue; }
      areasByPlace.set(placeId, [slug]);
      unique++;
      await writeAll(placesOut, line + '\n');
    }
  }
  await new Promise((resolve) => placesOut.end(resolve));

  const mapOut = fs.createWriteStream(args.outMap);
  await writeAll(mapOut, 'placeId\tareas\n');
  for (const [placeId, areas] of areasByPlace) {
    await writeAll(mapOut, `${placeId}\t${areas.join(',')}\n`);
  }
  await new Promise((resolve) => mapOut.end(resolve));

  const reviewsOut = fs.createWriteStream(args.outReviews);
  let reviewFiles = 0;
  let reviewBytes = 0;
  for (const dir of dirs) {
    const file = path.join(args.batch, dir, 'reviews.ndjson');
    if (!fs.existsSync(file)) continue;
    reviewFiles++;
    reviewBytes += fs.statSync(file).size;
    await new Promise((resolve, reject) => {
      const source = fs.createReadStream(file);
      source.on('error', reject);
      source.on('end', resolve);
      source.pipe(reviewsOut, { end: false });
    });
    await writeAll(reviewsOut, '');
  }
  await new Promise((resolve) => reviewsOut.end(resolve));

  console.log(JSON.stringify({
    areas: dirs.length,
    placeLines: totalLines,
    uniquePlaces: unique,
    unparsed,
    reviewFiles,
    reviewBytes,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = { areaSlug, parseArgs };
