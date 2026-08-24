#!/usr/bin/env node
/**
 * Build a SQLite DB from a finalized reviews.ndjson.
 *
 * The versioned schema and all NDJSON mappings live in review-db-schema.js.
 * Keep that shared module as the single source of truth: serial, worker,
 * sharded, migration, and verification paths all consume it. Evolving complex
 * source fields are stored as JSON and unknown keys are retained in explicit
 * fallback columns instead of being silently dropped.
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/build-sqlite-db.js \
 *     --input  output/san_francisco_v4/reviews.ndjson \
 *     --output output/san_francisco_v4/san_francisco_reviews.db
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
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

// Buffer-based line splitter. We deliberately avoid readline.createInterface
// because it silently splits very long lines (multi-MB JSON records) into
// phantom pieces that then fail to parse. Splitting on raw 0x0A is safe for
// UTF-8: continuation bytes are 0x80-0xBF, never 0x0A.
async function* bufferLines(filePath, onChunk = null) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 16 * 1024 * 1024 });
  let pendingParts = [];
  let pendingBytes = 0;
  for await (const chunk of stream) {
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

function parseArgs(argv) {
  const args = { inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--input':  args.inputs.push(argv[++i]); break;
      case '--output': args.output = argv[++i]; break;
      case '--fresh':  args.fresh  = true; break;
      case '--no-indexes': args.noIndexes = true; break;
      case '--no-provenance': args.noProvenance = true; break;
      case '--provenance-run-id': args.provenanceRunId = argv[++i]; break;
      case '--provenance-builder-name': args.provenanceBuilderName = argv[++i]; break;
      case '--provenance-input-index-start':
        args.provenanceInputIndexStart = Number(argv[++i]);
        break;
      case '--help':
        console.log('Usage: node scripts/build-sqlite-db.js --input <file.ndjson> [--input <...>] --output <out.db> [--fresh]');
        console.log('');
        console.log('  --input may be repeated. Files are processed in order.');
        console.log('  Each record is ingested with an explicit UPSERT, so later source fields update earlier rows without deleting them.');
        console.log('  Both places.ndjson (business-only) and reviews.ndjson (with detailedReviews) are accepted.');
        process.exit(0);
    }
  }
  return args;
}

function inputSnapshot(filePath) {
  const realpath = fs.realpathSync(filePath);
  const stat = fs.statSync(realpath);
  if (!stat.isFile()) throw new Error(`Input is not a regular file: ${filePath}`);
  return {
    realpath,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function assertInputUnchanged(filePath, before) {
  const after = inputSnapshot(filePath);
  for (const key of ['realpath', 'dev', 'ino', 'size', 'mtimeMs']) {
    if (after[key] !== before[key]) {
      throw new Error(`Input changed while being read (${key}): ${filePath}`);
    }
  }
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
  // synchronous=OFF is safe here: this is a derived index, not source data,
  // and a power-loss corruption is recoverable by rebuilding from ndjson.
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -262144');
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
    if (!fs.existsSync(f)) {
      console.error('ERROR: input not found:', f);
      process.exit(1);
    }
  }

  const db = openDb(args.output, args.fresh);
  const mergedAt = new Date().toISOString();
  if (args.provenanceInputIndexStart !== undefined
      && (!Number.isInteger(args.provenanceInputIndexStart)
          || args.provenanceInputIndexStart < 0)) {
    throw new Error('--provenance-input-index-start must be a non-negative integer');
  }
  const runId = args.provenanceRunId || crypto.randomUUID();
  const provenanceRows = [];

  const insertBiz = db.prepare(businessValueUpsertSql());

  const insertReview = db.prepare(reviewValueUpsertSql());

  const insertImage = db.prepare(reviewImageValueUpsertSql());

  // Per-place ingestion (no transaction here — the batch wrapper provides one).
  const ingestPlace = (place) => {
    const bizRow = buildBusinessRow(place, mergedAt);
    if (!bizRow) return { reviews: 0, images: 0, skipped: true };
    insertBiz.run(bizRow);
    const pid = bizRow.place_id;
    let revCount = 0, imgCount = 0;
    const reviews = Array.isArray(place.detailedReviews) ? place.detailedReviews : [];
    for (const rev of reviews) {
      const row = buildReviewRow(rev, pid);
      if (!row) continue;
      insertReview.run(row);
      revCount++;
      const urls = Array.isArray(rev.review_images) ? rev.review_images : [];
      for (let idx = 0; idx < urls.length; idx++) {
        insertImage.run({
          review_id: row.review_id,
          place_id:  pid,
          image_index: idx,
          url: urls[idx],
          local_path: null,
          source: 'js',
        });
        imgCount++;
      }
    }
    return { reviews: revCount, images: imgCount, skipped: false };
  };

  // Batch many places into one BEGIN/COMMIT — the per-place fsync overhead
  // dominated wall time at ~1.7 places/sec; batching lifts it ~50x.
  const BATCH_SIZE = 200;
  const ingestBatch = db.transaction((places) => {
    const acc = { placesOk: 0, placeholders: 0, reviews: 0, images: 0 };
    for (const place of places) {
      if (place._placeholder) acc.placeholders++;
      const r = ingestPlace(place);
      if (!r.skipped) acc.placesOk++;
      acc.reviews += r.reviews;
      acc.images += r.images;
    }
    return acc;
  });

  let placesIn = 0, placesOut = 0, placeholders = 0, reviewsOut = 0, imagesOut = 0;
  const startedAt = Date.now();

  for (let inputIndex = 0; inputIndex < args.inputs.length; inputIndex++) {
    const inputFile = args.inputs[inputIndex];
    console.log(`\n=== Ingesting ${inputFile} ===`);
    const inputStartedAt = new Date().toISOString();
    const inputStat = inputSnapshot(inputFile);
    const inputHash = crypto.createHash('sha256');
    let fileLines = 0;
    let filePlacesOut = 0, filePlaceholders = 0, fileReviewsOut = 0, fileImagesOut = 0;
    let fileParseErrors = 0;
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const r = ingestBatch(batch);
      placesOut    += r.placesOk;
      placeholders += r.placeholders;
      reviewsOut   += r.reviews;
      imagesOut    += r.images;
      filePlacesOut   += r.placesOk;
      filePlaceholders += r.placeholders;
      fileReviewsOut  += r.reviews;
      fileImagesOut   += r.images;
      batch = [];
    };
    for await (const line of bufferLines(inputFile, (chunk) => inputHash.update(chunk))) {
      if (!line.trim()) continue;
      placesIn++; fileLines++;
      let place;
      try { place = JSON.parse(line); }
      catch (e) {
        fileParseErrors++;
        console.warn(`  parse error at ${inputFile} line ${fileLines}: ${e.message}; skipping`);
        continue;
      }
      batch.push(place);
      if (batch.length >= BATCH_SIZE) {
        flush();
        if (placesIn % 2000 === 0) {
          const secs = Math.round((Date.now() - startedAt) / 1000);
          console.log(
            `  processed ${placesIn} places (${placesOut} with id, ${placeholders} placeholders), ` +
            `${reviewsOut} reviews, ${imagesOut} images — ${secs}s`
          );
        }
      }
    }
    flush();
    assertInputUnchanged(inputFile, inputStat);
    const sha256 = inputHash.digest('hex');
    provenanceRows.push({
      run_id: runId,
      input_index: (args.provenanceInputIndexStart || 0) + inputIndex,
      input_path: inputStat.realpath,
      input_sha256: sha256,
      input_size: inputStat.size,
      input_mtime_ms: inputStat.mtimeMs,
      builder_name: args.provenanceBuilderName || 'build-sqlite-db',
      started_at: inputStartedAt,
      input_records: fileLines,
      businesses_written: filePlacesOut,
      reviews_written: fileReviewsOut,
      review_images_written: fileImagesOut,
      parse_errors: fileParseErrors,
      notes: filePlaceholders ? `placeholders=${filePlaceholders}` : null,
    });
    console.log(`  done ${inputFile}: ${fileLines} lines, sha256=${sha256}`);
  }

  const staleImagesRemoved = reviewsOut > 0
    ? db.prepare(CLEANUP_STALE_REVIEW_IMAGES_SQL).run().changes
    : 0;
  if (staleImagesRemoved) {
    console.log(`Removed ${staleImagesRemoved} stale review image row(s).`);
  }

  if (args.noIndexes) {
    console.log('Skipping index creation (--no-indexes)');
  } else {
    console.log('Creating indexes...');
    for (const sql of INDEXES) db.exec(sql);
    console.log('Running ANALYZE...');
    db.exec('ANALYZE');
  }

  if (!args.noProvenance) {
    const completedAt = new Date().toISOString();
    const saveProvenance = db.transaction((rows) => {
      for (const row of rows) {
        recordBuildProvenance(db, { ...row, completed_at: completedAt });
      }
    });
    saveProvenance(provenanceRows);
  }

  const bizN = db.prepare('SELECT COUNT(*) c FROM businesses').get().c;
  const revN = db.prepare('SELECT COUNT(*) c FROM reviews').get().c;
  const imgN = db.prepare('SELECT COUNT(*) c FROM review_images').get().c;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  console.log('\n=== DONE ===');
  console.log(`  input lines:   ${placesIn}`);
  console.log(`  placeholders:  ${placeholders}`);
  console.log(`  businesses:    ${bizN}`);
  console.log(`  reviews:       ${revN}`);
  console.log(`  review_images: ${imgN}`);
  console.log(`  elapsed:       ${elapsed}s`);
  console.log(`  output:        ${args.output}`);

  db.close();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
