#!/usr/bin/env node
/**
 * Verifies a built SQLite DB against the source NDJSON.
 *
 * Two layers of check:
 *
 * 1. Aggregate counts (over every record, fast)
 *    - DB business row exists for every unique place_id in source.
 *    - DB unique review_id count per place == unique review_id count in source
 *      (handles duplicate place_id occurrences in reviews.ndjson by union of
 *       review_ids).
 *    - Total image_rows(place) == sum over the LAST occurrence of each
 *      place_id of (unique review_id × that review's image count). Since
 *      review_images has no natural unique key, duplicate place occurrences
 *      append duplicate image rows; we use last-occurrence semantics matching
 *      the build's INSERT OR REPLACE on review_id.
 *
 * 2. Field-level spot check (every Nth record; default N=200)
 *    For sampled records we re-run buildBusinessRow / buildReviewRow on the
 *    source object and assert byte-equal to the DB row. JSON-stringified
 *    fields (categories, opening_hours, about, ...) round-trip exactly because
 *    JSON.parse → JSON.stringify is deterministic for the same input. The
 *    only excluded column is `merged_at` (set at build time).
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

// ---------------------------------------------------------------------------
// Helpers — must match build-sqlite-db.js exactly
// ---------------------------------------------------------------------------
const jsonOrNull = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const emptyArrayToNull = (v) => (Array.isArray(v) && v.length === 0 ? null : v);
const coerceBool = (v) => (v === true ? 1 : v === false ? 0 : v == null ? null : Number(v) ? 1 : 0);

function buildBusinessRow(place, mergedAt) {
  const biz = place.business || {};
  const meta = place._meta || {};
  const placeId = biz.placeId || meta.placeId;
  if (!placeId) return null;
  return {
    place_id:           placeId,
    name:               biz.name ?? null,
    full_address:       biz.fullAddress ?? null,
    address:            jsonOrNull(emptyArrayToNull(biz.address)),
    latitude:           biz.latitude ?? (biz.coordinates && biz.coordinates.lat) ?? null,
    longitude:          biz.longitude ?? (biz.coordinates && biz.coordinates.lng) ?? null,
    rating:             biz.rating ?? null,
    review_count:       biz.reviewCount ?? null,
    phone:              biz.phone ?? null,
    website:            biz.website ?? null,
    plus_code:          biz.plusCode ?? null,
    main_category:      biz.mainCategory ?? null,
    categories:         jsonOrNull(emptyArrayToNull(biz.categories)),
    price_range:        biz.priceRange ?? null,
    scraped_categories: jsonOrNull(emptyArrayToNull(biz.categoryIds)),
    opening_hours:      jsonOrNull(place.openingHours),
    popular_times:      jsonOrNull(place.popularTimes),
    about:              jsonOrNull(place.about),
    metadata:           jsonOrNull(place.metadata),
    source_url:         place.sourceUrl ?? meta.sourceUrl ?? null,
    extracted_at:       place.extractedAt ?? null,
    cleaned_at:         null,
    merged_at:          mergedAt,
    image_batch:        null,
  };
}

function buildReviewRow(rev, placeId) {
  const reviewId = rev.review_id;
  if (!reviewId) return null;
  return {
    review_id:               reviewId,
    place_id:                placeId,
    rating:                  rev.rating ?? null,
    review_text:             rev.review_text ?? null,
    published_at:            rev.published_at ?? null,
    published_at_date:       rev.published_at_date ?? null,
    reviewer_name:           rev.reviewer_name ?? null,
    reviewer_link:           rev.reviewer_link ?? null,
    reviewer_photo_count:    rev.reviewer_photo_count ?? null,
    reviewer_review_count:   rev.reviewer_review_count ?? null,
    is_local_guide:          coerceBool(rev.is_local_guide),
    review_likes_count:      rev.review_likes_count ?? null,
    response_from_owner_text:rev.response_from_owner_text ?? null,
    response_from_owner_ago: rev.response_from_owner_ago ?? null,
    edited_at_date:          rev.edited_at_date ?? null,
    timestamp_us:            jsonOrNull(rev._timestamp_us),
    review_images_java:      jsonOrNull(emptyArrayToNull(rev.review_images)),
    local_image_paths:       null,
    extra:                   null,
    review_images_scraped:   null,
  };
}

async function* bufferLines(filePath) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 * 1024 });
  let pending = null;
  for await (const chunk of stream) {
    let combined = pending ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    while (true) {
      const lf = combined.indexOf(0x0A, start);
      if (lf < 0) break;
      yield combined.slice(start, lf).toString('utf8');
      start = lf + 1;
    }
    pending = start < combined.length ? combined.slice(start) : null;
  }
  if (pending && pending.length) yield pending.toString('utf8');
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

  const issues = new IssueLog(args.maxMismatches);

  // -------------- Stage A: aggregate counts from DB --------------
  console.log('Loading DB aggregates...');
  const t0 = Date.now();

  const dbBizCount = db.prepare('SELECT COUNT(*) c FROM businesses').get().c;
  const dbReviewCount = db.prepare('SELECT COUNT(*) c FROM reviews').get().c;
  const dbImageCount = db.prepare('SELECT COUNT(*) c FROM review_images').get().c;
  console.log(`  DB: businesses=${dbBizCount}, reviews=${dbReviewCount}, review_images=${dbImageCount}`);

  // place_id -> review count in DB
  const dbReviewsByPlace = new Map();
  for (const row of db.prepare('SELECT place_id, COUNT(*) c FROM reviews GROUP BY place_id').iterate()) {
    dbReviewsByPlace.set(row.place_id, row.c);
  }

  // place_id -> image count in DB
  const dbImagesByPlace = new Map();
  for (const row of db.prepare('SELECT place_id, COUNT(*) c FROM review_images GROUP BY place_id').iterate()) {
    dbImagesByPlace.set(row.place_id, row.c);
  }

  console.log(`  loaded aggregates in ${Math.round((Date.now() - t0) / 1000)}s`);

  // -------------- Stage B: stream ndjson, build expected sets --------------
  console.log(`\nScanning ${args.reviews}...`);
  const tStream = Date.now();

  // For each place: SET of unique review_ids across all source occurrences,
  // plus an occurrence counter (lets us skip sampled field checks on places
  // that appear in multiple ndjson lines — for those, we can't tell which
  // occurrence the DB row reflects without a third pass).
  const expectedReviewsByPlace = new Map();
  const placeIdLineNo = new Map();
  const placeIdOccurrenceCount = new Map();

  let lineNo = 0;
  let parseErrors = 0;
  let totalUniqueReviewIds = 0; // counts increments only when a new id is added

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

    placeIdOccurrenceCount.set(pid, (placeIdOccurrenceCount.get(pid) || 0) + 1);
    placeIdLineNo.set(pid, lineNo);

    let revSet = expectedReviewsByPlace.get(pid);
    if (!revSet) { revSet = new Set(); expectedReviewsByPlace.set(pid, revSet); }

    const reviews = Array.isArray(place.detailedReviews) ? place.detailedReviews : [];
    for (const rev of reviews) {
      if (!rev.review_id) continue;
      if (!revSet.has(rev.review_id)) totalUniqueReviewIds++;
      revSet.add(rev.review_id);
    }

    if (lineNo % args.sampleEvery === 0) sampleLineNos.add(lineNo);
    if (lineNo % 20000 === 0) console.error(`  scanned ${lineNo} lines in ${Math.round((Date.now() - tStream) / 1000)}s`);
  }
  console.log(`  scanned ${lineNo} lines (${parseErrors} parse errors) in ${Math.round((Date.now() - tStream) / 1000)}s`);

  // -------------- Stage C: aggregate comparisons --------------
  console.log('\nAggregate comparisons:');
  console.log(`  unique place_ids in source: ${expectedReviewsByPlace.size}`);
  console.log(`  unique review_ids in source: ${totalUniqueReviewIds}`);
  console.log(`  duplicate place lines in source: ${[...placeIdOccurrenceCount.values()].filter(n => n > 1).length}`);

  // Business existence: every source place_id exists in DB
  for (const pid of expectedReviewsByPlace.keys()) {
    const row = db.prepare('SELECT 1 FROM businesses WHERE place_id = ?').get(pid);
    if (!row) issues.push('business-missing', { placeId: pid, line: placeIdLineNo.get(pid) });
  }

  // Per-place review count: DB == |unique review_ids in source|
  let revCountMismatch = 0;
  for (const [pid, revSet] of expectedReviewsByPlace) {
    const expected = revSet.size;
    const got = dbReviewsByPlace.get(pid) || 0;
    if (got !== expected) {
      issues.push('review-count-mismatch', { placeId: pid, line: placeIdLineNo.get(pid), expected, got });
      revCountMismatch++;
    }
  }

  // Per-place image count: this is harder due to duplicate occurrences. We
  // check against TWO interpretations:
  //   (a) union (last-occurrence wins on review_id, sum images for last occ)
  //   (b) cumulative (sum across all occurrences as the build actually did)
  // The build does (b) since insertImage has no PK on natural key. Compare
  // against (b).
  const expectedImagesCumByPlace = new Map();
  // Need a second pass for cumulative — the count we accumulated above was
  // the LAST occurrence only. Re-compute cumulative by re-streaming.
  console.log('\nComputing cumulative image counts (rescan)...');
  const tImg = Date.now();
  let lineNo2 = 0;
  for await (const line of bufferLines(args.reviews)) {
    if (!line.trim()) continue;
    lineNo2++;
    let place;
    try { place = JSON.parse(line); } catch { continue; }
    const pid = place?.business?.placeId || place?._meta?.placeId;
    if (!pid) continue;
    const reviews = Array.isArray(place.detailedReviews) ? place.detailedReviews : [];
    let count = 0;
    for (const rev of reviews) {
      if (!rev.review_id) continue;
      const imgs = Array.isArray(rev.review_images) ? rev.review_images : [];
      count += imgs.length;
    }
    expectedImagesCumByPlace.set(pid, (expectedImagesCumByPlace.get(pid) || 0) + count);
    if (lineNo2 % 30000 === 0) console.error(`  rescan ${lineNo2}`);
  }
  console.log(`  rescan done in ${Math.round((Date.now() - tImg) / 1000)}s`);

  let imgCountMismatch = 0;
  for (const [pid, expected] of expectedImagesCumByPlace) {
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

    // Review field check: only safe when this place has a single occurrence
    // in the source (otherwise the DB row reflects the last occurrence, which
    // may not be this one).
    if ((placeIdOccurrenceCount.get(pid) || 1) === 1) {
      const reviews = Array.isArray(place.detailedReviews) ? place.detailedReviews : [];
      for (const rev of reviews) {
        const expRev = buildReviewRow(rev, pid);
        if (!expRev) continue;
        const dbRev = getReview.get(expRev.review_id);
        sampledReviews++;
        if (!dbRev) {
          issues.push('review-row-missing-on-sample', { reviewId: expRev.review_id, placeId: pid, line: lineNo3 });
          continue;
        }
        for (const k of Object.keys(expRev)) {
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
      if (expectedReviewsByPlace.has(pid)) continue;
      pSampled++;
      const dbBiz = getBiz.get(pid);
      if (!dbBiz) { issues.push('places-business-missing', { placeId: pid, line: pLine }); continue; }
      for (const k of Object.keys(expBiz)) {
        if (k === 'merged_at') continue;
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
