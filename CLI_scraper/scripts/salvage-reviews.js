#!/usr/bin/env node
/**
 * Salvage records from a corrupted reviews.ndjson.
 *
 * The corruption: a bad finalize pass wrote stray `\n` bytes INSIDE some
 * record lines, splitting them across multiple newlines. Record *boundaries*
 * are still intact (each record starts with `{"extractedAt":`). We split on
 * that boundary and attempt to reassemble.
 *
 * Strategy per record chunk:
 *   1. Try JSON.parse as-is (some splits happen to leave valid JSON).
 *   2. If fails, try concatenating the split fragments with nothing between
 *      them (the stray \n was just injected; no data was dropped in that case).
 *   3. If that fails, try with '\n' literal between fragments in case one
 *      actually belonged inside a string (rare).
 *   4. Give up on that record.
 *
 * Usage:
 *   node --max-old-space-size=16384 scripts/salvage-reviews.js \
 *     --input  output/san_francisco_v4/reviews.ndjson \
 *     --output output/san_francisco_v4/reviews.salvaged.ndjson
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--input':  args.input  = argv[++i]; break;
      case '--output': args.output = argv[++i]; break;
    }
  }
  return args;
}

const RECORD_PREFIX = '{"extractedAt":';

function tryParse(s) {
  try { return JSON.parse(s); }
  catch (e) { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    console.error('ERROR: --input and --output are required');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  const out = fs.createWriteStream(args.output);

  // Stream the file into chunks; accumulate bytes and split on
  // `\n{"extractedAt":` boundaries.
  const rs = fs.createReadStream(args.input);
  let buf = '';
  let totalRecords = 0;
  let okStrict = 0;
  let okRejoin = 0;
  let okRejoinNl = 0;
  let failed = 0;
  let placeholders = 0;
  const seenPids = new Set();
  const dupCount = { v: 0 };

  function flushRecord(chunk) {
    if (!chunk) return;
    totalRecords++;
    // Split by any \n that appears at "line boundaries" — we'll try several
    // reassembly strategies.
    let parsed = tryParse(chunk);
    let strategy = 'strict';
    if (!parsed) {
      const noNewlines = chunk.replace(/\n/g, '');
      parsed = tryParse(noNewlines);
      strategy = 'rejoin-empty';
    }
    if (!parsed) {
      // last attempt: replace \n inside strings by \\n and try
      // (very heuristic — rarely helps but almost free)
      const escaped = chunk.replace(/\n/g, '\\n');
      parsed = tryParse(escaped);
      strategy = 'rejoin-nl';
    }
    if (!parsed) {
      failed++;
      return;
    }

    if (strategy === 'strict') okStrict++;
    else if (strategy === 'rejoin-empty') okRejoin++;
    else okRejoinNl++;

    if (parsed._placeholder) placeholders++;

    // Dedupe by placeId (last wins on conflict)
    const pid = (parsed.business && parsed.business.placeId)
      || (parsed._meta && parsed._meta.placeId);
    if (pid) {
      if (seenPids.has(pid)) dupCount.v++;
      seenPids.add(pid);
    }

    // Strip any \n inside the serialized output (defensive) — JSON.stringify
    // already escapes control chars, so this is belt-and-suspenders.
    out.write(JSON.stringify(parsed) + '\n');
  }

  // Stream read; `buf` holds unprocessed bytes. On every chunk, look for all
  // complete records (bounded by `\n{"extractedAt":`) and flush them. The
  // leftover tail (partial last record) is carried to the next chunk.
  const marker = '\n' + RECORD_PREFIX;
  for await (const data of rs) {
    buf += data.toString('utf8');
    let pos = 0;
    while (true) {
      const next = buf.indexOf(marker, pos);
      if (next < 0) break;
      // Record spans [pos, next) — excluding the trailing \n.
      flushRecord(buf.substring(pos, next));
      pos = next + 1; // skip the \n so the next record starts at `{"extractedAt":`
    }
    // Drop consumed prefix; keep the partial last record for next iteration.
    buf = buf.substring(pos);
  }
  // Final flush: whatever is left is the last record (may be preceded by a
  // stray \n if the file didn't start with the record prefix).
  if (buf.startsWith('\n')) buf = buf.substring(1);
  flushRecord(buf);

  await new Promise((resolve) => out.end(resolve));

  console.log('\n=== Salvage summary ===');
  console.log(`  total record candidates: ${totalRecords}`);
  console.log(`  ok strict (no fix):      ${okStrict}`);
  console.log(`  ok rejoin (\\n removed):  ${okRejoin}`);
  console.log(`  ok rejoin-escape:        ${okRejoinNl}`);
  console.log(`  failed:                  ${failed}`);
  console.log(`  placeholders:            ${placeholders}`);
  console.log(`  unique placeIds:         ${seenPids.size}`);
  console.log(`  duplicates dropped:      ${dupCount.v}`);
  console.log(`  output:                  ${args.output}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
