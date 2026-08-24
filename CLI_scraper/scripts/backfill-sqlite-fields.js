#!/usr/bin/env node
/**
 * Add the lossless-source columns to an existing review DB and backfill them
 * from one or more reviews.ndjson files without rebuilding the large tables.
 *
 * Fast path for the current API datasets:
 *   --source-default api
 * adds reviews.source with an O(1) SQLite DEFAULT and derives the owner-response
 * flag from the already-stored response columns after validating every source
 * review. Without --source-default, review fields are updated exactly per row
 * and can be much slower on multi-million-row databases.
 *
 * Usage:
 *   node scripts/backfill-sqlite-fields.js \
 *     --db output/berlin/berlin_reviews.db \
 *     --input output/berlin/reviews.ndjson \
 *     --source-default api
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
  BUILDER_VERSION,
  SCHEMA_VERSION,
  BUSINESS_ADDITIONAL_COLUMNS,
  buildBusinessRow,
  buildReviewRow,
  coerceBool,
  ensureSchema,
  recordBuildProvenance,
  tableColumns,
} = require('./review-db-schema');

async function* bufferLines(filePath, onChunk) {
  // Keep the read buffer deliberately small: a single NDJSON record can itself
  // be large, so buffering another 64 MiB provides little benefit on laptops.
  const stream = fs.createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 });
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

function inputIdentity(filePath) {
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
  const after = inputIdentity(filePath);
  const changed = ['realpath', 'dev', 'ino', 'size', 'mtimeMs']
    .filter((key) => after[key] !== before[key]);
  if (changed.length) {
    throw new Error(
      `Input changed while being read (${changed.join(', ')}): ${filePath}`,
    );
  }
  return after;
}

function truncateCheckpoint(db) {
  const rows = db.pragma('wal_checkpoint(TRUNCATE)');
  const result = Array.isArray(rows) ? rows[0] : rows;
  if (result && Number(result.busy) !== 0) {
    throw new Error(`WAL checkpoint was busy: ${JSON.stringify(result)}`);
  }
  return result;
}

function parseArgs(argv) {
  const args = { inputs: [], batchSize: 20 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--db': args.db = argv[++i]; break;
      case '--input': args.inputs.push(argv[++i]); break;
      case '--batch-size': args.batchSize = Math.max(1, Number.parseInt(argv[++i], 10)); break;
      case '--source-default': args.sourceDefault = argv[++i]; break;
      case '--schema-only': args.schemaOnly = true; break;
      case '--skip-reviews': args.skipReviews = true; break;
      case '--help':
        console.log('Usage: --db <db> [--input <reviews.ndjson> ...] [--source-default api] [--batch-size 20] [--schema-only] [--skip-reviews]');
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function begin(db) { db.exec('BEGIN IMMEDIATE'); }
function commit(db) { db.exec('COMMIT'); }
function rollback(db) {
  if (db.inTransaction) db.exec('ROLLBACK');
}

function mainCounts(db) {
  return {
    businesses: db.prepare('SELECT COUNT(*) AS c FROM businesses').get().c,
    reviews: db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c,
    reviewImages: db.prepare('SELECT COUNT(*) AS c FROM review_images').get().c,
  };
}

function sameCounts(a, b) {
  return a.businesses === b.businesses
    && a.reviews === b.reviews
    && a.reviewImages === b.reviewImages;
}

function updateReviewsInRowidBatches(db, sql, baseParams, label, batchSize = 100000) {
  const bounds = db.prepare('SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM reviews').get();
  if (bounds.lo == null || bounds.hi == null) return 0;
  const statement = db.prepare(sql);
  const runBatch = db.transaction((lo, hi) => statement.run({ ...baseParams, lo, hi }).changes);
  let changed = 0;
  let batches = 0;
  for (let lo = bounds.lo; lo <= bounds.hi; lo += batchSize) {
    const hi = Math.min(bounds.hi, lo + batchSize - 1);
    changed += runBatch(lo, hi);
    batches++;
    if (batches % 10 === 0) {
      db.pragma('wal_checkpoint(PASSIVE)');
      console.log(`  ${label}: scanned through rowid ${hi}, changed=${changed}`);
    }
  }
  db.pragma('wal_checkpoint(PASSIVE)');
  return changed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || (!args.schemaOnly && args.inputs.length === 0)) {
    throw new Error('--db and at least one --input are required (unless --schema-only is used)');
  }
  if (!fs.existsSync(args.db)) throw new Error(`Database not found: ${args.db}`);
  for (const input of args.inputs) {
    if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
  }

  const db = new Database(args.db, { fileMustExist: true });
  const originalJournalMode = db.pragma('journal_mode', { simple: true });
  db.pragma('busy_timeout = 60000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  // Bound SQLite's resident memory. JSON parsing is the dominant transient
  // allocation, so leave headroom for unusually large place records.
  db.pragma('cache_size = -131072');
  db.pragma('mmap_size = 0');
  db.pragma('wal_autocheckpoint = 16384');

  const before = mainCounts(db);
  const sourceColumnExisted = tableColumns(db, 'reviews').has('source');
  ensureSchema(db, { reviewSourceDefault: args.sourceDefault });
  console.log(`Schema upgraded to user_version=${db.pragma('user_version', { simple: true })}`);

  if (args.schemaOnly) {
    console.log('Schema-only migration complete.');
    truncateCheckpoint(db);
    if (originalJournalMode !== 'wal') db.pragma(`journal_mode = ${originalJournalMode}`);
    db.close();
    return;
  }

  const businessBackfillColumns = Object.keys(BUSINESS_ADDITIONAL_COLUMNS);
  const updateBusiness = db.prepare(`
    UPDATE businesses
       SET ${businessBackfillColumns.map((name) => `${name} = @${name}`).join(', ')}
     WHERE place_id = @place_id
  `);
  const updateReview = args.sourceDefault === undefined
    ? db.prepare(`
        UPDATE reviews
           SET source = @source,
               has_owner_response = @has_owner_response
         WHERE review_id = @review_id AND place_id = @place_id
      `)
    : null;

  let placeLines = 0;
  let placesUpdated = 0;
  let missingBusinesses = 0;
  let reviewOccurrences = 0;
  let reviewsUpdated = 0;
  let missingReviews = 0;
  let parseErrors = 0;
  let sourceMismatches = 0;
  let ownerDerivationMismatches = 0;
  let businessPhotoPlaces = 0;
  let businessPhotoUrls = 0;
  let photoCategoryPlaces = 0;
  let photoCategories = 0;
  let photoCategoryItems = 0;
  let peakObservedRss = process.memoryUsage().rss;
  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  const provenanceRows = [];

  try {
    begin(db);
    let inBatch = 0;
    for (let inputIndex = 0; inputIndex < args.inputs.length; inputIndex++) {
      const input = args.inputs[inputIndex];
      const identity = inputIdentity(input);
      const inputStartedAt = new Date().toISOString();
      const inputHash = crypto.createHash('sha256');
      let inputPlacesUpdated = 0;
      let inputReviewsUpdated = 0;
      console.log(`Scanning and backfilling ${input}`);
      let inputLine = 0;
      for await (const line of bufferLines(input, (chunk) => inputHash.update(chunk))) {
        if (!line.trim()) continue;
        inputLine++;
        placeLines++;
        let place;
        try {
          place = JSON.parse(line);
        } catch (error) {
          parseErrors++;
          throw new Error(`JSON parse error in ${input} line ${inputLine}: ${error.message}`);
        }

        const row = buildBusinessRow(place, null);
        if (!row) throw new Error(`No place_id in ${input} line ${inputLine}`);
        const result = updateBusiness.run(row);
        if (result.changes === 1) {
          placesUpdated++;
          inputPlacesUpdated++;
        }
        else missingBusinesses++;

        const businessPhotos = Array.isArray(place.business?.photos) ? place.business.photos : [];
        if (businessPhotos.length) {
          businessPhotoPlaces++;
          businessPhotoUrls += businessPhotos.length;
        }
        const categories = Array.isArray(place.photoCategories) ? place.photoCategories : [];
        if (categories.length) photoCategoryPlaces++;
        photoCategories += categories.length;
        for (const category of categories) {
          if (Array.isArray(category?.photos)) photoCategoryItems += category.photos.length;
        }

        if (!args.skipReviews) {
          const reviews = Array.isArray(place.detailedReviews) ? place.detailedReviews : [];
          for (const rev of reviews) {
            if (!rev?.review_id) continue;
            reviewOccurrences++;
            if (args.sourceDefault !== undefined) {
              if (rev._source !== args.sourceDefault) sourceMismatches++;
              const sourceOwner = coerceBool(rev.has_owner_response);
              const derivedOwner = rev.response_from_owner_ago != null || rev.response_from_owner_text != null ? 1 : null;
              if (sourceOwner !== derivedOwner) ownerDerivationMismatches++;
            } else {
              const reviewRow = buildReviewRow(rev, row.place_id);
              const reviewResult = updateReview.run(reviewRow);
              if (reviewResult.changes === 1) {
                reviewsUpdated++;
                inputReviewsUpdated++;
              }
              else missingReviews++;
            }
          }
        }

        inBatch++;
        if (inBatch >= args.batchSize) {
          commit(db);
          begin(db);
          inBatch = 0;
        }
        if (placeLines % 2000 === 0) {
          const seconds = Math.round((Date.now() - startedAt) / 1000);
          const rss = process.memoryUsage().rss;
          peakObservedRss = Math.max(peakObservedRss, rss);
          console.log(
            `  ${placeLines} places, ${reviewOccurrences} review occurrences, ${seconds}s, `
            + `rss=${Math.round(rss / 1024 / 1024)} MiB`,
          );
        }
      }
      assertInputUnchanged(input, identity);
      provenanceRows.push({
        run_id: runId,
        input_index: inputIndex,
        input_path: identity.realpath,
        input_sha256: inputHash.digest('hex'),
        input_size: identity.size,
        input_mtime_ms: identity.mtimeMs,
        builder_name: 'backfill-sqlite-fields',
        builder_version: BUILDER_VERSION,
        schema_version: SCHEMA_VERSION,
        started_at: inputStartedAt,
        input_records: inputLine,
        businesses_written: inputPlacesUpdated,
        reviews_written: args.skipReviews
          ? 0
          : (args.sourceDefault === undefined ? inputReviewsUpdated : null),
        review_images_written: 0,
        parse_errors: 0,
        notes: args.sourceDefault !== undefined && !args.skipReviews
          ? 'reviews_written is null because --source-default validation is per input but source/owner-response updates are applied in database-wide batches.'
          : 'Lossless-source field backfill; core table row counts are required to remain unchanged.',
      });
    }
    commit(db);
  } catch (error) {
    rollback(db);
    db.close();
    throw error;
  }

  if (parseErrors || missingBusinesses || missingReviews) {
    db.close();
    throw new Error(`Backfill incomplete: parseErrors=${parseErrors}, missingBusinesses=${missingBusinesses}, missingReviews=${missingReviews}`);
  }

  if (args.sourceDefault !== undefined && !args.skipReviews) {
    if (sourceMismatches || ownerDerivationMismatches) {
      db.close();
      throw new Error(
        `Fast review backfill validation failed: sourceMismatches=${sourceMismatches}, ownerDerivationMismatches=${ownerDerivationMismatches}`,
      );
    }

    // If source existed before this migration, ALTER TABLE could not attach a
    // new DEFAULT. Fill only NULL rows in that compatibility case.
    if (sourceColumnExisted) {
      console.log('Filling NULL reviews.source values in the pre-existing source column...');
      updateReviewsInRowidBatches(
        db,
        'UPDATE reviews SET source = @value WHERE rowid BETWEEN @lo AND @hi AND source IS NULL',
        { value: args.sourceDefault },
        'reviews.source',
      );
    }
    console.log('Deriving has_owner_response from the preserved response fields...');
    updateReviewsInRowidBatches(
      db,
      `UPDATE reviews
          SET has_owner_response = 1
        WHERE rowid BETWEEN @lo AND @hi
          AND has_owner_response IS NULL
          AND (response_from_owner_ago IS NOT NULL OR response_from_owner_text IS NOT NULL)`,
      {},
      'has_owner_response',
    );
  }

  const after = mainCounts(db);
  if (!sameCounts(before, after)) {
    db.close();
    throw new Error(`Core row counts changed: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }

  const coverage = db.prepare(`
    SELECT
      SUM(business_photos IS NOT NULL) AS business_photo_places,
      SUM(photo_categories IS NOT NULL) AS photo_category_records,
      SUM(chij_id IS NOT NULL) AS chij_ids,
      SUM(owner_info IS NOT NULL) AS owner_info,
      SUM(service_options IS NOT NULL) AS service_options,
      SUM(scrape_error IS NOT NULL) AS scrape_errors,
      SUM(network_error = 1) AS network_errors
    FROM businesses
  `).get();
  const reviewCoverage = db.prepare(`
    SELECT
      SUM(source IS NOT NULL) AS sources,
      SUM(has_owner_response = 1) AS owner_responses
    FROM reviews
  `).get();
  const invalidJson = db.prepare(`
    SELECT COUNT(*) AS c FROM businesses
     WHERE (business_photos IS NOT NULL AND NOT json_valid(business_photos))
        OR (identity_badges IS NOT NULL AND NOT json_valid(identity_badges))
        OR (owner_info IS NOT NULL AND NOT json_valid(owner_info))
        OR (service_options IS NOT NULL AND NOT json_valid(service_options))
        OR (source_meta IS NOT NULL AND NOT json_valid(source_meta))
        OR (photo_categories IS NOT NULL AND NOT json_valid(photo_categories))
        OR (business_extra IS NOT NULL AND NOT json_valid(business_extra))
        OR (record_extra IS NOT NULL AND NOT json_valid(record_extra))
  `).get().c;
  if (invalidJson) {
    db.close();
    throw new Error(`Invalid JSON in ${invalidJson} business rows`);
  }

  const quickCheck = db.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') {
    db.close();
    throw new Error(`SQLite quick_check failed: ${quickCheck}`);
  }

  // Record only fully validated builds. A parse/coverage failure or a busy
  // checkpoint must never leave a misleading completed provenance row.
  truncateCheckpoint(db);
  const completedAt = new Date().toISOString();
  const writeProvenance = db.transaction((rows) => {
    for (const row of rows) {
      recordBuildProvenance(db, { ...row, completed_at: completedAt });
    }
  });
  writeProvenance(provenanceRows);
  truncateCheckpoint(db);
  if (originalJournalMode !== 'wal') db.pragma(`journal_mode = ${originalJournalMode}`);
  console.log('Backfill complete:');
  console.log(`  core rows unchanged: ${JSON.stringify(after)}`);
  console.log(`  source records: places=${placeLines}, review occurrences=${reviewOccurrences}`);
  console.log(`  business photos: places=${businessPhotoPlaces}, urls=${businessPhotoUrls}`);
  console.log(`  photo categories: places=${photoCategoryPlaces}, categories=${photoCategories}, items=${photoCategoryItems}`);
  console.log(`  DB coverage: ${JSON.stringify({ ...coverage, ...reviewCoverage })}`);
  console.log(`  peak observed RSS: ${Math.round(peakObservedRss / 1024 / 1024)} MiB`);
  console.log(`  quick_check: ${quickCheck}`);
  console.log(`  provenance: run_id=${runId}, inputs=${provenanceRows.length}, builder=${BUILDER_VERSION}`);
  db.close();
}

main().catch((error) => {
  console.error('Fatal:', error.message || error);
  process.exit(1);
});
