#!/usr/bin/env node
/**
 * Multi-threaded variant of build-sqlite-db.js.
 *
 * Architecture:
 *   - Main thread:  read ndjson lines (buffer-based, bypasses readline bug),
 *                   distribute to a pool of N worker threads, collect parsed
 *                   rows back, batch insert into SQLite (single writer).
 *   - Worker:       receive raw JSON string -> JSON.parse -> build business
 *                   row + review rows + image rows -> postMessage back.
 *
 * The serial version was CPU-bound on JSON.parse of multi-MB review records.
 * Workers parallelise that. SQLite stays single-writer (WAL allows only one
 * writer at a time anyway). Backpressure caps in-flight messages so memory
 * stays bounded.
 *
 * Schema and mappings are shared with build-sqlite-db.js through
 * review-db-schema.js. Same CLI as build-sqlite-db.js. Extra env var:
 *   WORKERS=8        (default 8) — number of parser worker threads
 *   BATCH_SIZE=500   (default 500) — places per SQLite transaction
 *   SQLITE_CACHE_MB / SQLITE_MMAP_MB — optional memory-budget overrides
 *
 * Usage:
 *   node --max-old-space-size=4096 scripts/build-sqlite-db-mt.js \
 *     --input  output/singapore/places.ndjson \
 *     --input  output/singapore/reviews.ndjson \
 *     --output output/singapore/singapore_reviews.db --fresh
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const {
  SCHEMA_VERSION,
  BUILDER_VERSION,
  INDEXES,
  CLEANUP_STALE_REVIEW_IMAGES_SQL,
  buildBusinessRow,
  buildReviewRow,
  businessValueUpsertSql,
  reviewValueUpsertSql,
  reviewImageValueUpsertSql,
  ensureSchema,
  hasReviewImageNaturalKey,
  ensureReviewImageNaturalKey,
  recordBuildProvenance,
} = require('./review-db-schema');

// ---------------------------------------------------------------------------
// Shared helpers (run in BOTH main and worker)
// ---------------------------------------------------------------------------

function buildRowsForPlace(place, mergedAt) {
  const bizRow = buildBusinessRow(place, mergedAt);
  if (!bizRow) return { skipped: true };
  const pid = bizRow.place_id;
  const reviewRows = [];
  const imageRows = [];
  const reviews = Array.isArray(place.detailedReviews) ? place.detailedReviews : [];
  for (const rev of reviews) {
    const row = buildReviewRow(rev, pid);
    if (!row) continue;
    reviewRows.push(row);
    const urls = Array.isArray(rev.review_images) ? rev.review_images : [];
    for (let idx = 0; idx < urls.length; idx++) {
      imageRows.push({
        review_id: row.review_id,
        place_id:  pid,
        image_index: idx,
        url: urls[idx],
        local_path: null,
        source: 'js',
      });
    }
  }
  return {
    bizRow, reviewRows, imageRows,
    isPlaceholder: !!place._placeholder,
  };
}

// ---------------------------------------------------------------------------
// WORKER: receive {line, mergedAt, seq, inputIndex, inputFile} -> parse +
// build rows -> postMessage back. The routing metadata is echoed so the main
// thread can restore source order before writing to SQLite.
// ---------------------------------------------------------------------------

if (!isMainThread) {
  parentPort.on('message', (msg) => {
    if (msg === null) { parentPort.close(); return; }
    const { line, mergedAt, seq, lineIdx, inputIndex, inputFile } = msg;
    const source = { seq, lineIdx, inputIndex, inputFile };
    let place;
    try { place = JSON.parse(line); }
    catch (e) {
      parentPort.postMessage({ ...source, parseError: e.message });
      return;
    }
    const result = buildRowsForPlace(place, mergedAt);
    parentPort.postMessage({ ...source, ...result });
  });
  return;
}

// ---------------------------------------------------------------------------
// MAIN THREAD
// ---------------------------------------------------------------------------

const Database = require('better-sqlite3');

async function* bufferLines(filePath, onChunk) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 16 * 1024 * 1024 });
  let pendingParts = [];
  let pendingBytes = 0;
  for await (const chunk of stream) {
    // Hash the exact source bytes, including original newline bytes. Hashing
    // decoded lines would lose the distinction between final-newline forms.
    if (onChunk) onChunk(chunk);
    let start = 0;
    while (true) {
      const lf = chunk.indexOf(0x0A, start);
      if (lf < 0) break;
      const tail = chunk.subarray(start, lf);
      if (pendingParts.length) {
        pendingParts.push(tail);
        yield Buffer.concat(pendingParts, pendingBytes + tail.length).toString('utf8');
        pendingParts = [];
        pendingBytes = 0;
      } else {
        yield tail.toString('utf8');
      }
      start = lf + 1;
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      pendingParts.push(tail);
      pendingBytes += tail.length;
    }
  }
  if (pendingBytes) yield Buffer.concat(pendingParts, pendingBytes).toString('utf8');
}

function sameFileStat(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs;
}

function parseArgs(argv) {
  const args = { inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--input':  args.inputs.push(argv[++i]); break;
      case '--output': args.output = argv[++i]; break;
      case '--fresh':  args.fresh  = true; break;
      case '--help':
        console.log('Usage: node scripts/build-sqlite-db-mt.js --input <file.ndjson> [--input <...>] --output <out.db> [--fresh]');
        console.log('Env: WORKERS=8 BATCH_SIZE=500 SQLITE_CACHE_MB=<MiB> SQLITE_MMAP_MB=<MiB>');
        process.exit(0);
    }
  }
  return args;
}

function openDb(outputFile, fresh) {
  if (fresh) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const f = outputFile + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const db = new Database(outputFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  const totalMemoryMb = Math.floor(os.totalmem() / 1024 / 1024);
  const defaultCacheMb = Math.max(256, Math.min(8192, Math.floor(totalMemoryMb / 10)));
  const cacheMb = Number.parseInt(process.env.SQLITE_CACHE_MB || String(defaultCacheMb), 10);
  const mmapMb = Number.parseInt(process.env.SQLITE_MMAP_MB || String(cacheMb), 10);
  if (!Number.isInteger(cacheMb) || cacheMb < 64
      || !Number.isInteger(mmapMb) || mmapMb < 0) {
    throw new Error('SQLITE_CACHE_MB must be >= 64 and SQLITE_MMAP_MB must be >= 0');
  }
  // Use at most 10% of host RAM by default (capped at 8 GiB), with explicit
  // overrides for high-memory servers and tighter laptops.
  db.pragma(`cache_size = -${cacheMb * 1024}`);
  db.pragma(`mmap_size = ${mmapMb * 1024 * 1024}`);
  console.log(`SQLite cache: ${cacheMb} MiB, mmap: ${mmapMb} MiB`);
  // Push autocheckpoint up so we don't checkpoint mid-batch on huge transactions.
  db.pragma('wal_autocheckpoint = 100000');
  ensureSchema(db);
  if (!hasReviewImageNaturalKey(db)) {
    console.log('Migrating legacy review_images to its natural key (one-time indexed scan)...');
  }
  const imageMigration = ensureReviewImageNaturalKey(db);
  if (imageMigration.migrated) {
    console.log(
      `Migrated review_images natural key; removed ${imageMigration.duplicatesRemoved} duplicate row(s).`
    );
  }
  return db;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputs.length || !args.output) {
    console.error('ERROR: at least one --input and --output are required');
    process.exit(1);
  }
  for (const f of args.inputs) {
    if (!fs.existsSync(f)) { console.error('ERROR: input not found:', f); process.exit(1); }
  }

  const N_WORKERS = Math.max(1, parseInt(process.env.WORKERS || '8', 10));
  const BATCH_SIZE = Math.max(1, parseInt(process.env.BATCH_SIZE || '500', 10));
  const MAX_PENDING_PER_WORKER = 4;
  const MAX_OUTSTANDING = N_WORKERS * MAX_PENDING_PER_WORKER;

  console.log(`Workers: ${N_WORKERS}, batch size: ${BATCH_SIZE}, max outstanding: ${MAX_OUTSTANDING}`);

  const db = openDb(args.output, args.fresh);
  const mergedAt = new Date().toISOString();

  const insertBiz = db.prepare(businessValueUpsertSql());
  const insertReview = db.prepare(reviewValueUpsertSql());

  const insertImage = db.prepare(reviewImageValueUpsertSql());

  const perInput = args.inputs.map((inputFile, inputIndex) => ({
    inputIndex,
    inputFile,
    inputPath: path.resolve(inputFile),
    startedAt: null,
    sourceStat: null,
    sha256: null,
    inputRecords: 0,
    businessesWritten: 0,
    reviewsWritten: 0,
    reviewImagesWritten: 0,
    parseErrors: 0,
  }));

  const ingestBatch = db.transaction((results) => {
    const acc = { placesOk: 0, placeholders: 0, reviews: 0, images: 0, parseErrors: 0 };
    for (const r of results) {
      const inputAcc = perInput[r.inputIndex];
      if (!inputAcc) throw new Error(`Worker returned invalid inputIndex: ${r.inputIndex}`);
      inputAcc.inputRecords++;
      if (r.parseError) {
        acc.parseErrors++;
        inputAcc.parseErrors++;
        continue;
      }
      if (r.skipped || !r.bizRow) continue;
      insertBiz.run(r.bizRow);
      acc.placesOk++;
      inputAcc.businessesWritten++;
      if (r.isPlaceholder) acc.placeholders++;
      for (const rr of r.reviewRows) {
        insertReview.run(rr);
        acc.reviews++;
        inputAcc.reviewsWritten++;
      }
      for (const ir of r.imageRows) {
        insertImage.run(ir);
        acc.images++;
        inputAcc.reviewImagesWritten++;
      }
    }
    return acc;
  });

  // Worker pool
  const workers = [];
  for (let i = 0; i < N_WORKERS; i++) workers.push(new Worker(__filename));

  let inflight = 0;
  let outstanding = 0;
  let capacityWaiter = null;
  const resultsQueue = [];
  let resultsWaiter = null;

  for (const w of workers) {
    w.on('message', (result) => {
      inflight--;
      if (resultsWaiter) {
        const r = resultsWaiter; resultsWaiter = null;
        r(result);
      } else {
        resultsQueue.push(result);
      }
    });
    w.on('error', (e) => { console.error('Worker error:', e); process.exit(1); });
  }

  function waitForCapacity() {
    if (outstanding < MAX_OUTSTANDING) return null;
    return new Promise((resolve) => { capacityWaiter = resolve; });
  }

  function nextResult() {
    if (resultsQueue.length) return Promise.resolve(resultsQueue.shift());
    return new Promise((resolve) => { resultsWaiter = resolve; });
  }

  let nextWorker = 0;
  function dispatch(line, seq, lineIdx, inputIndex, inputFile) {
    workers[nextWorker].postMessage({
      line, mergedAt, seq, lineIdx, inputIndex, inputFile,
    });
    nextWorker = (nextWorker + 1) % N_WORKERS;
    inflight++;
    outstanding++;
  }

  let placesIn = 0, placesOut = 0, placeholders = 0, reviewsOut = 0, imagesOut = 0, parseErrors = 0;
  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  let totalSent = 0;
  let producerDone = false;
  let producerError = null;

  const producer = (async () => {
    try {
      for (const inputAcc of perInput) {
        const { inputFile, inputIndex } = inputAcc;
        console.log(`\n=== Ingesting ${inputFile} ===`);
        inputAcc.startedAt = new Date().toISOString();
        inputAcc.inputPath = await fs.promises.realpath(inputFile);
        const before = await fs.promises.stat(inputAcc.inputPath, { bigint: true });
        if (!before.isFile()) throw new Error(`Input is not a regular file: ${inputFile}`);
        const hash = crypto.createHash('sha256');
        let fileLines = 0;
        for await (const line of bufferLines(inputFile, (chunk) => hash.update(chunk))) {
          if (!line.trim()) continue;
          fileLines++;
          const cap = waitForCapacity();
          if (cap) await cap;
          const seq = totalSent++;
          dispatch(line, seq, fileLines, inputIndex, inputFile);
        }
        const finalRealpath = await fs.promises.realpath(inputFile);
        const finalStat = await fs.promises.stat(finalRealpath, { bigint: true });
        if (!sameFileStat(before, finalStat) || finalRealpath !== inputAcc.inputPath) {
          throw new Error(`Input changed while being read: ${inputFile}`);
        }
        inputAcc.sourceStat = before;
        inputAcc.sha256 = hash.digest('hex');
        console.log(
          `  done reading ${inputFile}: ${fileLines} lines sent, sha256=${inputAcc.sha256}`
        );
      }
    } catch (e) {
      producerError = e;
    } finally {
      producerDone = true;
      // Empty inputs (or an early read failure before dispatch) otherwise leave
      // the consumer waiting for a worker result that will never arrive.
      if (inflight === 0 && resultsWaiter) {
        const resolve = resultsWaiter;
        resultsWaiter = null;
        resolve(null);
      }
    }
  })();

  // Consumer: workers finish out of order, but duplicate IDs must follow the
  // source's global order so later NDJSON records deterministically win.
  let batch = [];
  const pendingBySeq = new Map();
  let nextSeqToWrite = 0;
  const flush = () => {
    if (!batch.length) return;
    const r = ingestBatch(batch);
    placesIn   += batch.length;
    placesOut  += r.placesOk;
    placeholders += r.placeholders;
    reviewsOut += r.reviews;
    imagesOut  += r.images;
    parseErrors += r.parseErrors;
    batch = [];
  };

  let lastLogged = 0;
  while (true) {
    if (producerDone && inflight === 0 && resultsQueue.length === 0) break;
    const result = await nextResult();
    if (result !== null) {
      if (!Number.isInteger(result.seq) || result.seq < nextSeqToWrite || pendingBySeq.has(result.seq)) {
        throw new Error(`Invalid or duplicate worker sequence: ${result.seq}`);
      }
      pendingBySeq.set(result.seq, result);
      while (pendingBySeq.has(nextSeqToWrite)) {
        batch.push(pendingBySeq.get(nextSeqToWrite));
        pendingBySeq.delete(nextSeqToWrite);
        nextSeqToWrite++;
        outstanding--;
        if (capacityWaiter) {
          const resolve = capacityWaiter;
          capacityWaiter = null;
          resolve();
        }
        if (batch.length >= BATCH_SIZE) {
          flush();
          if (placesIn - lastLogged >= 2000) {
            const secs = Math.round((Date.now() - startedAt) / 1000);
            console.log(
              `  processed ${placesIn} places (${placesOut} with id, ${placeholders} placeholders, ${parseErrors} parse errors), ` +
              `${reviewsOut} reviews, ${imagesOut} images — ${secs}s`
            );
            lastLogged = placesIn;
          }
        }
      }
    }
  }
  flush();
  await producer;
  if (producerError) throw producerError;
  if (pendingBySeq.size || nextSeqToWrite !== totalSent || outstanding !== 0) {
    throw new Error(
      `Missing worker results: dispatched=${totalSent}, ordered=${nextSeqToWrite}, `
      + `pending=${pendingBySeq.size}, outstanding=${outstanding}`
    );
  }

  // Shut down workers
  for (const w of workers) w.postMessage(null);
  await Promise.all(workers.map((w) => new Promise((resolve) => w.once('exit', resolve))));

  const staleImagesRemoved = reviewsOut > 0
    ? db.prepare(CLEANUP_STALE_REVIEW_IMAGES_SQL).run().changes
    : 0;
  if (staleImagesRemoved) {
    console.log(`Removed ${staleImagesRemoved} stale review image row(s).`);
  }

  console.log('Creating indexes...');
  for (const sql of INDEXES) db.exec(sql);
  console.log('Running ANALYZE...');
  db.exec('ANALYZE');

  // Mark inputs complete only after ingestion, index creation, and ANALYZE
  // have all succeeded. A single run_id groups the ordered input files.
  const completedAt = new Date().toISOString();
  const writeProvenance = db.transaction((inputs) => {
    for (const inputAcc of inputs) {
      if (!inputAcc.sourceStat || !inputAcc.sha256) {
        throw new Error(`Missing provenance metadata for ${inputAcc.inputFile}`);
      }
      recordBuildProvenance(db, {
        run_id: runId,
        input_index: inputAcc.inputIndex,
        input_path: inputAcc.inputPath,
        input_sha256: inputAcc.sha256,
        input_size: Number(inputAcc.sourceStat.size),
        input_mtime_ms: Number(inputAcc.sourceStat.mtimeNs) / 1e6,
        builder_name: 'build-sqlite-db-mt',
        builder_version: BUILDER_VERSION,
        schema_version: SCHEMA_VERSION,
        started_at: inputAcc.startedAt,
        completed_at: completedAt,
        input_records: inputAcc.inputRecords,
        businesses_written: inputAcc.businessesWritten,
        reviews_written: inputAcc.reviewsWritten,
        review_images_written: inputAcc.reviewImagesWritten,
        parse_errors: inputAcc.parseErrors,
        notes: `workers=${N_WORKERS}; batch_size=${BATCH_SIZE}`,
      });
    }
  });
  writeProvenance(perInput);

  const bizN = db.prepare('SELECT COUNT(*) c FROM businesses').get().c;
  const revN = db.prepare('SELECT COUNT(*) c FROM reviews').get().c;
  const imgN = db.prepare('SELECT COUNT(*) c FROM review_images').get().c;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  console.log('\n=== DONE ===');
  console.log(`  input lines:   ${placesIn}`);
  console.log(`  parse errors:  ${parseErrors}`);
  console.log(`  placeholders:  ${placeholders}`);
  console.log(`  businesses:    ${bizN}`);
  console.log(`  reviews:       ${revN}`);
  console.log(`  review_images: ${imgN}`);
  console.log(`  elapsed:       ${elapsed}s`);
  console.log(`  output:        ${args.output}`);

  db.close();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
