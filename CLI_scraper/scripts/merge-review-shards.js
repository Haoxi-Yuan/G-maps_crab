#!/usr/bin/env node
'use strict';

/**
 * Low-memory, exact placeId deduplication for large review NDJSON files.
 *
 * Pass 1 records only the last (file,line) occurrence for each placeId.
 * Pass 2 copies those raw records into the output. Record bodies are never
 * decoded as JavaScript strings, so memory is bounded by one NDJSON record
 * plus a small placeId index. Later inputs win on duplicate placeIds.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');

function usage() {
  console.error('Usage: node scripts/merge-review-shards.js --expected PLACES --output OUT REVIEWS_BASE PART0 [PART1 ...]');
}

function parseArgs(argv) {
  const args = { inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--expected') args.expected = argv[++i];
    else if (flag === '--output') args.output = argv[++i];
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`);
    else args.inputs.push(flag);
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

function hasObjectEnvelope(chunks) {
  let first = null;
  let last = null;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length && first === null; i++) {
      if (chunk[i] > 0x20) first = chunk[i];
    }
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] > 0x20) {
        last = chunk[i];
        break;
      }
    }
  }
  return first === 0x7b && last === 0x7d; // { ... }
}

async function scanLines(filename, onLine) {
  let chunks = [];
  let lineNo = 0;
  let endedWithNewline = true;

  async function finishLine() {
    if (!chunks.length) return;
    lineNo++;
    await onLine(chunks, lineNo);
    chunks = [];
  }

  const input = fs.createReadStream(filename);
  for await (const chunk of input) {
    let start = 0;
    endedWithNewline = false;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      if (i > start) chunks.push(chunk.subarray(start, i));
      await finishLine();
      start = i + 1;
      endedWithNewline = i === chunk.length - 1;
    }
    if (start < chunk.length) chunks.push(chunk.subarray(start));
  }
  if (chunks.length) {
    endedWithNewline = false;
    await finishLine();
  }
  return { lines: lineNo, endedWithNewline };
}

async function expectedPlaceIds(filename) {
  const ids = new Set();
  let invalid = 0;
  const input = fs.createReadStream(filename, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const pid = (row.business && row.business.placeId) || (row._meta && row._meta.placeId);
      if (pid) ids.add(pid);
      else invalid++;
    } catch (_) {
      invalid++;
    }
  }
  if (invalid) throw new Error(`Expected places file has ${invalid} invalid or placeId-less line(s)`);
  return ids;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.expected || !args.output || !args.inputs.length) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (fs.existsSync(args.output)) throw new Error(`Refusing to overwrite output: ${args.output}`);
  for (const file of [args.expected, ...args.inputs]) {
    if (!fs.existsSync(file)) throw new Error(`Missing input: ${file}`);
  }

  const expected = await expectedPlaceIds(args.expected);
  console.log(`[MERGE] expected unique placeIds=${expected.size}`);
  const last = new Map();
  const stats = [];
  const pidRe = /"placeId"\s*:\s*"([^"]+)"/;
  let invalid = 0;
  let occurrences = 0;

  for (let fileIndex = 0; fileIndex < args.inputs.length; fileIndex++) {
    const filename = args.inputs[fileIndex];
    const result = await scanLines(filename, async (chunks, lineNo) => {
      if (!hasObjectEnvelope(chunks)) {
        invalid++;
        return;
      }
      const match = headText(chunks).match(pidRe);
      if (!match) {
        invalid++;
        return;
      }
      occurrences++;
      last.set(match[1], { fileIndex, lineNo });
    });
    if (!result.endedWithNewline && result.lines > 0) {
      throw new Error(`Input does not end with newline: ${filename}`);
    }
    stats.push({ file: path.resolve(filename), lines: result.lines });
    console.log(`[MERGE] indexed file=${filename} lines=${result.lines} unique_so_far=${last.size}`);
  }
  if (invalid) throw new Error(`Review inputs contain ${invalid} malformed or placeId-less line(s)`);

  let missing = 0;
  for (const pid of expected) if (!last.has(pid)) missing++;
  let extra = 0;
  for (const pid of last.keys()) if (!expected.has(pid)) extra++;
  if (missing || extra) throw new Error(`Coverage mismatch: missing=${missing} extra=${extra}`);

  const outputHash = crypto.createHash('sha256');
  const output = fs.createWriteStream(args.output, { flags: 'wx' });
  let written = 0;
  let outputBytes = 0;
  try {
    for (let fileIndex = 0; fileIndex < args.inputs.length; fileIndex++) {
      const filename = args.inputs[fileIndex];
      await scanLines(filename, async (chunks, lineNo) => {
        const match = headText(chunks).match(pidRe);
        if (!match) return;
        const keep = last.get(match[1]);
        if (!keep || keep.fileIndex !== fileIndex || keep.lineNo !== lineNo) return;
        for (const chunk of chunks) {
          if (!output.write(chunk)) await once(output, 'drain');
          outputHash.update(chunk);
          outputBytes += chunk.length;
        }
        const newline = Buffer.from('\n');
        if (!output.write(newline)) await once(output, 'drain');
        outputHash.update(newline);
        outputBytes++;
        written++;
      });
    }
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    try { fs.unlinkSync(args.output); } catch (_) {}
    throw error;
  }
  if (written !== expected.size) {
    try { fs.unlinkSync(args.output); } catch (_) {}
    throw new Error(`Written count mismatch: wrote=${written} expected=${expected.size}`);
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    expectedPlaces: path.resolve(args.expected),
    expectedUniquePlaceIds: expected.size,
    inputs: stats,
    inputOccurrences: occurrences,
    duplicatesRemoved: occurrences - written,
    output: path.resolve(args.output),
    outputLines: written,
    outputBytes,
    outputSha256: outputHash.digest('hex'),
  };
  fs.writeFileSync(`${args.output}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(`[MERGE] ERROR: ${error.stack || error.message}`);
  process.exitCode = 1;
});
