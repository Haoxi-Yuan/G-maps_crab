#!/usr/bin/env node
/**
 * Verifies a built SQLite DB against the source NDJSON.
 *
 * Two layers of check:
 *
 * 1. Aggregate counts (over every record, fast)
 *    - DB business row exists for every unique place_id in source.
 *    - reviews and normalized JS image rows follow global review_id UPSERT
 *      semantics: the last source occurrence determines place_id, fields, and
 *      the final image list, even if a review_id moves between places.
 *
 * 2. Field-level spot check (every Nth record; default N=200)
 *    For sampled records we re-run buildBusinessRow / buildReviewRow on the
 *    source object and assert byte-equal to the DB row. JSON-stringified
 *    fields (categories, opening_hours, about, ...) round-trip exactly because
 *    JSON.parse → JSON.stringify is deterministic for the same input. The
 *    only excluded column is `merged_at` (set at build time). Enrichment /
 *    compatibility columns are also accepted when incoming NULL preserved an
 *    existing non-NULL value.
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/verify-db.js \
 *     --db output/singapore/singapore_reviews.db \
 *     --reviews output/singapore/reviews.ndjson \
 *     --places  /path/to/places.ndjson \
 *     [--sample-every 200] [--max-mismatches 50]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  BUSINESS_COLUMNS,
  REVIEW_COLUMNS,
  BUSINESS_PRESERVE_ON_NULL,
  REVIEW_PRESERVE_ON_NULL,
  buildBusinessRow,
  buildReviewRow,
  tableColumns,
} = require('./review-db-schema');

// ---------------------------------------------------------------------------
// Helpers — must match build-sqlite-db.js exactly
// ---------------------------------------------------------------------------

async function* bufferLines(filePath) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 * 1024 });
  let pendingParts = [];
  let pendingBytes = 0;
  for await (const chunk of stream) {
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

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { sampleEvery: 200, maxMismatches: 50 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--db':             a.db = argv[++i]; break;
      case '--reviews':        a.reviews = argv[++i]; break;
      case '--places':         a.places = argv[++i]; break;
      case '--sample-every':   a.sampleEvery = parseInt(argv[++i], 10); break;
      case '--max-mismatches': a.maxMismatches = parseInt(argv[++i], 10); break;
      case '--help':
        console.log('Usage: --db <out.db> --reviews <reviews.ndjson> [--places <places.ndjson>] [--sample-every 200] [--max-mismatches 50]');
        process.exit(0);
    }
  }
  return a;
}

function eq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return Math.abs(a - b) < 1e-9;
    }
  }
  return false;
}

class IssueLog {
  constructor(maxPerCategory) {
    this.cap = maxPerCategory;
    this.byCat = new Map();
    this.totals = new Map();
  }
  push(category, info) {
    this.totals.set(category, (this.totals.get(category) || 0) + 1);
    if (!this.byCat.has(category)) this.byCat.set(category, []);
    const arr = this.byCat.get(category);
    if (arr.length < this.cap) arr.push(info);
  }
  print() {
    if (this.totals.size === 0) {
      console.log('  (no issues)');
      return;
    }
    for (const [cat, total] of this.totals) {
      console.log(`\n  [${cat}]: ${total} occurrence(s); first ${Math.min(this.cap, total)} sample(s):`);
      for (const x of this.byCat.get(cat)) console.log('    -', JSON.stringify(x));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.reviews) {
    console.error('--db and --reviews required');
    process.exit(1);
  }

  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  db.pragma('cache_size = -2097152');

  const missingBusinessColumns = BUSINESS_COLUMNS.filter((name) => !tableColumns(db, 'businesses').has(name));
  const missingReviewColumns = REVIEW_COLUMNS.filter((name) => !tableColumns(db, 'reviews').has(name));
  if (missingBusinessColumns.length || missingReviewColumns.length) {
    console.error('Database schema is missing required columns.');
    if (missingBusinessColumns.length) console.error('  businesses:', missingBusinessColumns.join(', '));
    if (missingReviewColumns.length) console.error('  reviews:', missingReviewColumns.join(', '));
    db.close();
    process.exit(2);
  }

  const issues = new IssueLog(args.maxMismatches);

  // -------------- Stage A: aggregate counts from DB --------------
  console.log('Loading DB aggregates...');
  const t0 = Date.now();

  const dbBizCount = db.prepare('SELECT COUNT(*) c FROM businesses').get().c;
  const dbReviewCount = db.prepare('SELECT COUNT(*) c FROM reviews').get().c;
  const dbImageCount = db.prepare('SELECT COUNT(*) c FROM review_images').get().c;
  const dbJsImageCount = db.prepare("SELECT COUNT(*) c FROM review_images WHERE source = 'js'").get().c;
  console.log(
    `  DB: businesses=${dbBizCount}, reviews=${dbReviewCount}, `
    + `review_images=${dbImageCount} (${dbJsImageCount} source=js)`,
  );

  // place_id -> review count in DB
  const dbReviewsByPlace = new Map();
  for (const row of db.prepare('SELECT place_id, COUNT(*) c FROM reviews GROUP BY place_id').iterate()) {
    dbReviewsByPlace.set(row.place_id, row.c);
  }

  // place_id -> image count in DB
  const dbImagesByPlace = new Map();
  for (const row of db.prepare(`
    SELECT place_id, COUNT(*) c
      FROM review_images
     WHERE source = 'js'
     GROUP BY place_id
  `).iterate()) {
    dbImagesByPlace.set(row.place_id, row.c);
  }

  console.log(`  loaded aggregates in ${Math.round((Date.now() - t0) / 1000)}s`);

  // -------------- Stage B: stream ndjson, build expected sets --------------
  console.log(`\nScanning ${args.reviews}...`);
  const tStream = Date.now();

  // Business rows are keyed by place_id, while review rows are keyed globally
  // by review_id. Keep only the last review occurrence so cross-place moves
  // and duplicate source records exactly match ordered UPSERT semantics.
  const sourcePlaceIds = new Set();
  const lastReviewById = new Map();
  const duplicateReviewIds = new Set();
  const placeIdLineNo = new Map();
  const placeIdOccurrenceCount = new Map();

  let lineNo = 0;
  let parseErrors = 0;

  // For sampling we collect line numbers we want full-detail field checks on.
  const sampleLineNos = new Set();

  for await (const line of bufferLines(args.reviews)) {
    if (!line.trim()) continue;
    lineNo++;
    let place;
    try { place = JSON.parse(line); }
    catch (e) {
      issues.push('parse-error', { line: lineNo, msg: e.message.slice(0, 100) });
      parseErrors++;
      continue;
    }
    const bizRow = buildBusinessRow(place, null);
    if (!bizRow) {
      issues.push('no-place-id', { line: lineNo });
      continue;
    }
    const pid = bizRow.place_id;

    sourcePlaceIds.add(pid);
    placeIdOccurrenceCount.set(pid, (placeIdOccurrenceCount.get(pid) || 0) + 1);
    placeIdLineNo.set(pid, lineNo);

    const reviews = Array.isArray(place.detailedReviews) ? place.detailedReviews : [];
    for (const rev of reviews) {
      if (!rev.review_id) continue;
      const previous = lastReviewById.get(rev.review_id);
      if (previous) duplicateReviewIds.add(rev.review_id);
      lastReviewById.set(rev.review_id, {
        placeId: pid,
        imageCount: Array.isArray(rev.review_images) ? rev.review_images.length : 0,
      });
    }

    if (lineNo % args.sampleEvery === 0) sampleLineNos.add(lineNo);
    if (lineNo % 20000 === 0) console.error(`  scanned ${lineNo} lines in ${Math.round((Date.now() - tStream) / 1000)}s`);
  }
  console.log(`  scanned ${lineNo} lines (${parseErrors} parse errors) in ${Math.round((Date.now() - tStream) / 1000)}s`);

  const expectedReviewsByPlace = new Map();
  const expectedImagesByPlace = new Map();
  for (const pid of sourcePlaceIds) {
    expectedReviewsByPlace.set(pid, 0);
    expectedImagesByPlace.set(pid, 0);
  }
  for (const finalReview of lastReviewById.values()) {
    expectedReviewsByPlace.set(
      finalReview.placeId,
      (expectedReviewsByPlace.get(finalReview.placeId) || 0) + 1,
    );
    expectedImagesByPlace.set(
      finalReview.placeId,
      (expectedImagesByPlace.get(finalReview.placeId) || 0) + finalReview.imageCount,
    );
  }

  // -------------- Stage C: aggregate comparisons --------------
  console.log('\nAggregate comparisons:');
  console.log(`  unique place_ids in source: ${sourcePlaceIds.size}`);
  console.log(`  final unique review_ids in source: ${lastReviewById.size}`);
  console.log(`  duplicate place lines in source: ${[...placeIdOccurrenceCount.values()].filter(n => n > 1).length}`);
  console.log(`  duplicate review_ids in source: ${duplicateReviewIds.size}`);

  // Business existence: every source place_id exists in DB
  for (const pid of sourcePlaceIds) {
    const row = db.prepare('SELECT 1 FROM businesses WHERE place_id = ?').get(pid);
    if (!row) issues.push('business-missing', { placeId: pid, line: placeIdLineNo.get(pid) });
  }

  if (dbReviewCount !== lastReviewById.size) {
    issues.push('review-total-mismatch', { expected: lastReviewById.size, got: dbReviewCount });
  }
  const expectedJsImages = [...expectedImagesByPlace.values()].reduce((sum, count) => sum + count, 0);
  if (dbJsImageCount !== expectedJsImages) {
    issues.push('image-total-mismatch', { expected: expectedJsImages, got: dbJsImageCount });
  }

  // Per-place counts derive from each global review_id's last occurrence.
  let revCountMismatch = 0;
  for (const [pid, expected] of expectedReviewsByPlace) {
    const got = dbReviewsByPlace.get(pid) || 0;
    if (got !== expected) {
      issues.push('review-count-mismatch', { placeId: pid, line: placeIdLineNo.get(pid), expected, got });
      revCountMismatch++;
    }
  }

  let imgCountMismatch = 0;
  for (const [pid, expected] of expectedImagesByPlace) {
    const got = dbImagesByPlace.get(pid) || 0;
    if (got !== expected) {
      issues.push('image-count-mismatch', { placeId: pid, expected, got });
      imgCountMismatch++;
    }
  }

  console.log(`  review-count mismatches: ${revCountMismatch}`);
  console.log(`  image-count mismatches:  ${imgCountMismatch}`);

  // -------------- Stage D: field-level sample compare --------------
  console.log(`\nField-level sample (every ${args.sampleEvery}th line: ${sampleLineNos.size} samples)...`);
  const getBiz = db.prepare('SELECT * FROM businesses WHERE place_id = ?');
  const getReview = db.prepare('SELECT * FROM reviews WHERE review_id = ?');

  // Re-stream and on each sampled line, compare full fields.
  let lineNo3 = 0;
  let businessFieldMismatches = 0;
  let reviewFieldMismatches = 0;
  let sampledBusinesses = 0;
  let sampledReviews = 0;
  // Skip business-field check for places that occur multiple times in the
  // source: only their LAST occurrence matches the DB, but here we're at an
  // arbitrary sampled occurrence (which may be earlier).
  for await (const line of bufferLines(args.reviews)) {
    if (!line.trim()) continue;
    lineNo3++;
    if (!sampleLineNos.has(lineNo3)) continue;
    let place;
    try { place = JSON.parse(line); } catch { continue; }
    const expBiz = buildBusinessRow(place, null);
    if (!expBiz) continue;
    const pid = expBiz.place_id;

    if ((placeIdOccurrenceCount.get(pid) || 1) === 1) {
      const dbBiz = getBiz.get(pid);
      sampledBusinesses++;
      if (!dbBiz) {
        issues.push('business-row-missing-on-sample', { placeId: pid, line: lineNo3 });
      } else {
        for (const k of Object.keys(expBiz)) {
          if (k === 'merged_at') continue;
          if (expBiz[k] == null && BUSINESS_PRESERVE_ON_NULL.has(k) && dbBiz[k] != null) {
            continue;
          }
          if (!eq(expBiz[k], dbBiz[k])) {
            issues.push('business-field-mismatch', {
              placeId: pid, line: lineNo3, field: k,
              expected: String(expBiz[k]).slice(0, 200),
              got: String(dbBiz[k]).slice(0, 200),
            });
            businessFieldMismatches++;
          }
        }
      }
    }

    // A sampled review is byte-comparable only when its global review_id
    // occurs once. Repeated IDs are intentionally resolved by later-wins.
    const reviews = Array.isArray(place.detailedReviews) ? place.detailedReviews : [];
    for (const rev of reviews) {
      const expRev = buildReviewRow(rev, pid);
      if (!expRev || duplicateReviewIds.has(expRev.review_id)) continue;
      const dbRev = getReview.get(expRev.review_id);
      sampledReviews++;
      if (!dbRev) {
        issues.push('review-row-missing-on-sample', { reviewId: expRev.review_id, placeId: pid, line: lineNo3 });
        continue;
      }
      for (const k of Object.keys(expRev)) {
        if (expRev[k] == null && REVIEW_PRESERVE_ON_NULL.has(k) && dbRev[k] != null) {
          continue;
        }
        if (!eq(expRev[k], dbRev[k])) {
          issues.push('review-field-mismatch', {
            reviewId: expRev.review_id, line: lineNo3, field: k,
            expected: String(expRev[k]).slice(0, 200),
            got: String(dbRev[k]).slice(0, 200),
          });
          reviewFieldMismatches++;
        }
      }
    }
  }
  console.log(`  sampled ${sampledBusinesses} unique-place businesses, ${sampledReviews} reviews`);
  console.log(`  business field mismatches: ${businessFieldMismatches}`);
  console.log(`  review   field mismatches: ${reviewFieldMismatches}`);

  // -------------- Stage E: places.ndjson business field check --------------
  if (args.places && fs.existsSync(args.places)) {
    console.log(`\nChecking businesses-from-places.ndjson...`);
    let pLine = 0;
    let pSampled = 0;
    let pMismatch = 0;
    for await (const line of bufferLines(args.places)) {
      if (!line.trim()) continue;
      pLine++;
      if (pLine % args.sampleEvery !== 0) continue;
      let place;
      try { place = JSON.parse(line); } catch { continue; }
      const expBiz = buildBusinessRow(place, null);
      if (!expBiz) continue;
      const pid = expBiz.place_id;
      // Only meaningful if the place_id is NOT in reviews.ndjson (otherwise
      // reviews.ndjson overwrote the row).
      if (sourcePlaceIds.has(pid)) continue;
      pSampled++;
      const dbBiz = getBiz.get(pid);
      if (!dbBiz) { issues.push('places-business-missing', { placeId: pid, line: pLine }); continue; }
      for (const k of Object.keys(expBiz)) {
        if (k === 'merged_at') continue;
        if (expBiz[k] == null && BUSINESS_PRESERVE_ON_NULL.has(k) && dbBiz[k] != null) {
          continue;
        }
        if (!eq(expBiz[k], dbBiz[k])) {
          issues.push('places-business-field-mismatch', {
            placeId: pid, line: pLine, field: k,
            expected: String(expBiz[k]).slice(0, 200),
            got: String(dbBiz[k]).slice(0, 200),
          });
          pMismatch++;
        }
      }
    }
    console.log(`  sampled ${pSampled} place-only businesses; field mismatches: ${pMismatch}`);
  }

  // -------------- Summary --------------
  console.log('\n=== ISSUES ===');
  issues.print();

  const allCounts = [...issues.totals.values()].reduce((s, n) => s + n, 0);
  console.log(`\n=== TOTAL ISSUES: ${allCounts} ===`);
  db.close();
  if (allCounts > 0) process.exit(2);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
