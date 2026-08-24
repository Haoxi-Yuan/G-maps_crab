#!/usr/bin/env node
/**
 * Sharded build: split a large reviews.ndjson into N pieces, build N
 * temporary DBs in parallel (one process per shard), then merge them into
 * the final DB.
 *
 * Why: the serial/MT builds slowed dramatically as the destination DB grew
 * (every per-row UPSERT does a PK lookup; cache bumps didn't help — the
 * bottleneck shifts elsewhere as the per-transaction work explodes). With
 * shards, each per-shard DB stays small (~4 GB, B-tree shallow) and the 8
 * builders run independently. Final merge is one-pass bulk INSERT INTO
 * SELECT which is much faster than per-row inserts.
 *
 * Usage:
 *   node scripts/build-sqlite-db-sharded.js \
 *     --places  /path/to/places.ndjson \
 *     --reviews /path/to/reviews.ndjson \
 *     --output  /path/to/singapore_reviews.db \
 *     [--shards 8] [--shard-dir /path/to/scratch] [--keep-shards] [--fresh]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  INDEXES,
  CLEANUP_STALE_REVIEW_IMAGES_SQL,
  businessSelectUpsertSql,
  reviewSelectUpsertSql,
  reviewImageSelectUpsertSql,
  recordBuildProvenance,
} = require('./review-db-schema');

const BUILDER = path.join(__dirname, 'build-sqlite-db.js');

function parseArgs(argv) {
  const args = { shards: 8 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--places':     args.places  = argv[++i]; break;
      case '--reviews':    args.reviews = argv[++i]; break;
      case '--output':     args.output  = argv[++i]; break;
      case '--shards':     args.shards  = parseInt(argv[++i], 10); break;
      case '--shard-dir':  args.shardDir = argv[++i]; break;
      case '--keep-shards':args.keepShards = true; break;
      case '--fresh':      args.fresh = true; break;
      case '--help':
        console.log('Usage: --places <ndjson> --reviews <ndjson> --output <db> [--shards 8] [--shard-dir DIR] [--keep-shards] [--fresh]');
        process.exit(0);
    }
  }
  return args;
}

// Find LF byte offsets that divide the file into N roughly-equal-byte chunks.
// Boundaries are aligned to LF so each chunk starts at the byte AFTER an LF
// (or at byte 0). Returns an array of N+1 offsets: [0, b1, b2, ..., size].
function findShardBoundaries(filePath, N) {
  const fd = fs.openSync(filePath, 'r');
  const size = fs.fstatSync(fd).size;
  const SCAN_BUF_SIZE = 1024 * 1024;
  const scanBuf = Buffer.alloc(SCAN_BUF_SIZE);
  const boundaries = [0];
  for (let k = 1; k < N; k++) {
    // Ensure strict monotonic increase: if previous boundary is past the
    // ideal target, start scanning from there (one record longer than the
    // ideal slice is fine — better than an empty shard).
    const target = Math.max(Math.floor((size * k) / N), boundaries[boundaries.length - 1]);
    if (target >= size) { boundaries.push(size); continue; }
    let pos = target;
    let foundLF = -1;
    while (pos < size && foundLF < 0) {
      const want = Math.min(SCAN_BUF_SIZE, size - pos);
      const got = fs.readSync(fd, scanBuf, 0, want, pos);
      if (!got) break;
      for (let i = 0; i < got; i++) {
        if (scanBuf[i] === 0x0A) { foundLF = pos + i; break; }
      }
      if (foundLF < 0) pos += got;
    }
    if (foundLF < 0) { boundaries.push(size); continue; }
    boundaries.push(foundLF + 1);
  }
  while (boundaries.length < N + 1) boundaries.push(size);
  boundaries[N] = size;
  fs.closeSync(fd);
  // Drop any shards that ended up empty (consecutive equal boundaries).
  const compact = [boundaries[0]];
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] > compact[compact.length - 1]) compact.push(boundaries[i]);
  }
  return compact;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function inputSnapshot(filePath) {
  const realPath = fs.realpathSync.native
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);
  const stat = fs.statSync(realPath, { bigint: true });
  if (!stat.isFile()) throw new Error(`Input is not a regular file: ${filePath}`);
  return {
    realPath,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function fdSnapshot(fd, realPath) {
  const stat = fs.fstatSync(fd, { bigint: true });
  return {
    realPath,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function assertSameInput(before, after, context) {
  const same = before.realPath === after.realPath
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs;
  if (!same) {
    throw new Error(
      `Input changed ${context}: `
      + `realpath ${before.realPath} -> ${after.realPath}, `
      + `dev/ino ${before.dev}/${before.ino} -> ${after.dev}/${after.ino}, `
      + `size ${before.size} -> ${after.size}, `
      + `mtime_ns ${before.mtimeNs} -> ${after.mtimeNs}`
    );
  }
}

function writeAll(fd, buffer, offset, length) {
  let written = 0;
  while (written < length) {
    const count = fs.writeSync(fd, buffer, offset + written, length - written);
    if (count <= 0) throw new Error('Unable to make progress while writing a shard');
    written += count;
  }
}

function isAsciiJsonWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0D
    || byte === 0x0B || byte === 0x0C;
}

// Read the original file exactly once, in byte order. Each raw Buffer updates
// the SHA-256 digest before its bytes are routed to LF-aligned shard files.
// Synchronous writes deliberately provide backpressure, keeping memory bounded
// by the read stream's highWaterMark rather than the input size.
async function splitAndHash(src, destinations, boundaries, expectedInput) {
  if (boundaries.length !== destinations.length + 1) {
    throw new Error('Shard boundary/destination count mismatch');
  }

  const sourceFd = fs.openSync(src, 'r');
  const outputFds = [];
  const bytesWritten = destinations.map(() => 0n);
  const hash = crypto.createHash('sha256');
  let offset = 0n;
  let shardIndex = 0;
  let streamCompleted = false;
  let inputRecords = 0;
  let lineHasContent = false;

  try {
    const openedInput = fdSnapshot(sourceFd, expectedInput.realPath);
    assertSameInput(expectedInput, openedInput, 'between boundary discovery and sequential split');
    for (const destination of destinations) outputFds.push(fs.openSync(destination, 'w'));

    const stream = fs.createReadStream(src, {
      fd: sourceFd,
      autoClose: false,
      highWaterMark: 16 * 1024 * 1024,
    });
    for await (const chunk of stream) {
      hash.update(chunk);

      // Match the builders' non-blank-line input count without retaining a
      // whole (potentially multi-MB) NDJSON record in memory.
      let lineOffset = 0;
      while (lineOffset < chunk.length) {
        const lf = chunk.indexOf(0x0A, lineOffset);
        const lineEnd = lf < 0 ? chunk.length : lf;
        if (!lineHasContent) {
          for (let i = lineOffset; i < lineEnd; i++) {
            if (!isAsciiJsonWhitespace(chunk[i])) {
              lineHasContent = true;
              break;
            }
          }
        }
        if (lf < 0) break;
        if (lineHasContent) inputRecords++;
        lineHasContent = false;
        lineOffset = lf + 1;
      }

      let chunkOffset = 0;
      while (chunkOffset < chunk.length) {
        while (shardIndex < destinations.length
               && offset >= BigInt(boundaries[shardIndex + 1])) {
          shardIndex++;
        }
        if (shardIndex >= destinations.length) {
          throw new Error(`Read past final shard boundary at byte ${offset}`);
        }
        const shardEnd = BigInt(boundaries[shardIndex + 1]);
        const available = BigInt(chunk.length - chunkOffset);
        const take = Number(available < shardEnd - offset ? available : shardEnd - offset);
        if (take <= 0) throw new Error(`Invalid shard boundary at byte ${offset}`);
        writeAll(outputFds[shardIndex], chunk, chunkOffset, take);
        bytesWritten[shardIndex] += BigInt(take);
        chunkOffset += take;
        offset += BigInt(take);
      }
    }
    if (lineHasContent) inputRecords++;
    streamCompleted = true;

    if (offset !== expectedInput.size) {
      throw new Error(`Sequential split read ${offset} bytes; expected ${expectedInput.size}`);
    }
    for (let i = 0; i < destinations.length; i++) {
      const expectedBytes = BigInt(boundaries[i + 1] - boundaries[i]);
      if (bytesWritten[i] !== expectedBytes) {
        throw new Error(
          `Shard ${i} contains ${bytesWritten[i]} bytes; expected ${expectedBytes}`
        );
      }
    }
  } finally {
    for (const fd of outputFds) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.closeSync(sourceFd); } catch (_) {}
  }

  if (!streamCompleted) throw new Error('Sequential split did not complete');
  const finalInput = inputSnapshot(src);
  assertSameInput(expectedInput, finalInput, 'while being split and hashed');
  return {
    sha256: hash.digest('hex'),
    inputSize: Number(expectedInput.size),
    inputMtimeMs: Number(expectedInput.mtimeNs / 1000000n),
    inputRecords,
    realPath: expectedInput.realPath,
  };
}

function runBuilder(inputs, output, fresh, noIndexes, provenance = {}, childRegistry = null) {
  return new Promise((resolve, reject) => {
    const args = [
      '--max-old-space-size=8192',
      BUILDER,
    ];
    for (const f of inputs) { args.push('--input', f); }
    args.push('--output', output);
    if (fresh) args.push('--fresh');
    if (noIndexes) args.push('--no-indexes');
    if (provenance.disabled) args.push('--no-provenance');
    if (provenance.runId) args.push('--provenance-run-id', provenance.runId);
    if (provenance.builderName) {
      args.push('--provenance-builder-name', provenance.builderName);
    }
    if (provenance.inputIndexStart != null) {
      args.push('--provenance-input-index-start', String(provenance.inputIndexStart));
    }
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (childRegistry) childRegistry.add(child);
    const tag = path.basename(output);
    let parseErrors = 0;
    let stderrTail = '';
    child.stdout.on('data', (b) => process.stdout.write(`[${tag}] ${b}`));
    child.stderr.on('data', (b) => {
      process.stderr.write(`[${tag}] ${b}`);
      const lines = (stderrTail + b.toString('utf8')).split(/\r?\n/);
      stderrTail = lines.pop();
      for (const line of lines) {
        if (line.includes('parse error at')) parseErrors++;
      }
    });
    child.on('error', (error) => {
      if (childRegistry) childRegistry.delete(child);
      reject(error);
    });
    child.on('close', (code) => {
      if (childRegistry) childRegistry.delete(child);
      if (stderrTail.includes('parse error at')) parseErrors++;
      if (code === 0) resolve({ parseErrors });
      else reject(new Error(`${tag} exited with ${code}`));
    });
  });
}

const Database = require('better-sqlite3');

function readShardStats(db) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM s.businesses) AS businesses_written,
      (SELECT COUNT(*) FROM s.reviews) AS reviews_written,
      (SELECT COUNT(*) FROM s.review_images) AS review_images_written
  `).get();
}

function mergeShards(finalDb, shardDbs, provenance) {
  const t0 = Date.now();
  console.log(`\n=== Merging ${shardDbs.length} shards into ${finalDb} ===`);
  const db = new Database(finalDb);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -2097152'); // 2 GB

  const aggregate = {
    businesses_written: 0,
    reviews_written: 0,
    review_images_written: 0,
  };

  for (let i = 0; i < shardDbs.length; i++) {
    const shard = shardDbs[i];
    const tShard = Date.now();
    console.log(`  [${i + 1}/${shardDbs.length}] attaching ${path.basename(shard)}`);
    db.exec(`ATTACH DATABASE '${shard.replace(/'/g, "''")}' AS s`);
    try {
      const shardStats = readShardStats(db);
      const mergeShard = db.transaction(() => {
        db.exec(`
          ${businessSelectUpsertSql('s')};
          ${reviewSelectUpsertSql('s')};
          ${reviewImageSelectUpsertSql('s')};
        `);
      });
      mergeShard();
      for (const key of Object.keys(aggregate)) aggregate[key] += shardStats[key];
    } finally {
      db.exec('DETACH DATABASE s');
    }
    console.log(`     merged in ${Math.round((Date.now() - tShard) / 1000)}s`);
  }

  const staleImagesRemoved = aggregate.reviews_written > 0
    ? db.prepare(CLEANUP_STALE_REVIEW_IMAGES_SQL).run().changes
    : 0;
  if (staleImagesRemoved) {
    console.log(`  removed ${staleImagesRemoved} stale review image row(s)`);
  }

  // Indexes were intentionally NOT created in shard DBs (they slow inserts).
  // Final DB index creation happened in the initial places-phase build via
  // build-sqlite-db.js. Re-run defensively in case schema changes.
  console.log('  creating final indexes...');
  for (const sql of INDEXES) db.exec(sql);
  console.log('  ANALYZE...');
  db.exec('ANALYZE');

  // The transient shard provenance is deliberately not copied. Record one
  // top-level row for the original reviews NDJSON, under the same run as the
  // places child, only after every merge/index operation has succeeded.
  recordBuildProvenance(db, {
    run_id: provenance.runId,
    input_index: 1,
    input_path: provenance.inputPath,
    input_sha256: provenance.sha256,
    input_size: provenance.inputSize,
    input_mtime_ms: provenance.inputMtimeMs,
    builder_name: 'build-sqlite-db-sharded',
    started_at: provenance.startedAt,
    completed_at: new Date().toISOString(),
    input_records: provenance.inputRecords,
    businesses_written: aggregate.businesses_written,
    reviews_written: aggregate.reviews_written,
    review_images_written: aggregate.review_images_written,
    parse_errors: provenance.parseErrors,
    notes: `temporary_shards=${shardDbs.length}; shard_provenance=disabled; `
      + 'written_counts=post_shard_table_counts',
  });

  const bizN = db.prepare('SELECT COUNT(*) c FROM businesses').get().c;
  const revN = db.prepare('SELECT COUNT(*) c FROM reviews').get().c;
  const imgN = db.prepare('SELECT COUNT(*) c FROM review_images').get().c;
  db.close();
  console.log(`Merge done in ${Math.round((Date.now() - t0) / 1000)}s — businesses=${bizN}, reviews=${revN}, review_images=${imgN}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.places || !args.reviews || !args.output) {
    console.error('Usage: --places <ndjson> --reviews <ndjson> --output <db> [--shards 8] [--shard-dir DIR] [--keep-shards] [--fresh]');
    process.exit(1);
  }
  for (const f of [args.places, args.reviews]) {
    if (!fs.existsSync(f)) { console.error('not found:', f); process.exit(1); }
  }
  if (!Number.isInteger(args.shards) || args.shards < 1) {
    throw new Error('--shards must be a positive integer');
  }

  const requestedShards = args.shards;
  const runId = crypto.randomUUID();
  const shardDir = args.shardDir || path.join(path.dirname(args.output), '_shards');
  fs.mkdirSync(shardDir, { recursive: true });

  // ----- Stage 1: split reviews.ndjson into N byte-balanced shards -----
  console.log(`\n=== Stage 1: splitting ${args.reviews} into up to ${requestedShards} shards ===`);
  const t1 = Date.now();
  const reviewsStartedAt = new Date().toISOString();
  const sourceSnapshot = inputSnapshot(args.reviews);
  const size = Number(sourceSnapshot.size);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`Input is too large for byte-safe sharding offsets: ${sourceSnapshot.size}`);
  }
  console.log(`  source size: ${humanBytes(size)}`);
  const boundaries = findShardBoundaries(args.reviews, requestedShards);
  const N = boundaries.length - 1;
  if (N < requestedShards) console.log(`  (got ${N} non-empty shards — file has very uneven record sizes)`);
  for (let i = 0; i < N; i++) {
    console.log(`  shard ${i}: bytes ${boundaries[i]}..${boundaries[i + 1]} (${humanBytes(boundaries[i + 1] - boundaries[i])})`);
  }
  const shardFiles = [];
  for (let i = 0; i < N; i++) {
    shardFiles.push(path.join(shardDir, `reviews.shard_${i}.ndjson`));
  }
  const reviewsProvenance = await splitAndHash(
    args.reviews, shardFiles, boundaries, sourceSnapshot,
  );
  console.log(
    `  split done in ${Math.round((Date.now() - t1) / 1000)}s; `
    + `sha256=${reviewsProvenance.sha256}`
  );

  // ----- Stage 2: places.ndjson into the final DB (small, fast, --fresh) -----
  console.log(`\n=== Stage 2: ingesting places.ndjson into ${args.output} ===`);
  const t2 = Date.now();
  await runBuilder([args.places], args.output, args.fresh, false, {
    runId,
    builderName: 'build-sqlite-db-sharded',
    inputIndexStart: 0,
  });
  console.log(`  places phase done in ${Math.round((Date.now() - t2) / 1000)}s`);

  // ----- Stage 3: build N shard DBs in parallel -----
  console.log(`\n=== Stage 3: building ${N} shard DBs in parallel ===`);
  const t3 = Date.now();
  const shardDbs = shardFiles.map((f, i) => path.join(shardDir, `reviews.shard_${i}.db`));
  const shardChildren = new Set();
  let shardResults;
  try {
    shardResults = await Promise.all(
      shardFiles.map((f, i) => runBuilder(
        [f], shardDbs[i], true, true, { disabled: true }, shardChildren,
      )),
    );
  } catch (error) {
    const stillRunning = [...shardChildren];
    for (const child of stillRunning) child.kill('SIGTERM');
    await Promise.allSettled(stillRunning.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('close', resolve);
    })));
    throw error;
  }
  const parseErrors = shardResults.reduce((sum, result) => sum + result.parseErrors, 0);
  console.log(`  all shards done in ${Math.round((Date.now() - t3) / 1000)}s`);

  // ----- Stage 4: merge shards into final DB -----
  mergeShards(args.output, shardDbs, {
    ...reviewsProvenance,
    runId,
    inputPath: reviewsProvenance.realPath,
    startedAt: reviewsStartedAt,
    parseErrors,
  });

  // ----- Cleanup -----
  if (!args.keepShards) {
    for (const f of [...shardFiles, ...shardDbs, ...shardDbs.map(d => d + '-wal'), ...shardDbs.map(d => d + '-shm')]) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    try { fs.rmdirSync(shardDir); } catch (_) {}
    console.log('Cleaned up shard files.');
  } else {
    console.log(`Shards kept under ${shardDir}`);
  }
  console.log(`\n=== ALL DONE === output: ${args.output}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
