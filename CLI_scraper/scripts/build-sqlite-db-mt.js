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
 * Same CLI as build-sqlite-db.js. Extra env var:
 *   WORKERS=8        (default 8) — number of parser worker threads
 *   BATCH_SIZE=500   (default 500) — places per SQLite transaction
 *
 * Usage:
 *   node --max-old-space-size=16384 scripts/build-sqlite-db-mt.js \
 *     --input  output/singapore/places.ndjson \
 *     --input  output/singapore/reviews.ndjson \
 *     --output output/singapore/singapore_reviews.db --fresh
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');

// ---------------------------------------------------------------------------
// Shared helpers (run in BOTH main and worker)
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
  return { bizRow, reviewRows, imageRows, isPlaceholder: !!place._placeholder };
}

// ---------------------------------------------------------------------------
// WORKER: receive {line, mergedAt} -> parse + build rows -> postMessage back
// ---------------------------------------------------------------------------

if (!isMainThread) {
  parentPort.on('message', (msg) => {
    if (msg === null) { parentPort.close(); return; }
    const { line, mergedAt, lineIdx, inputFile } = msg;
    let place;
    try { place = JSON.parse(line); }
    catch (e) {
      parentPort.postMessage({ lineIdx, parseError: e.message, inputFile });
      return;
    }
    const result = buildRowsForPlace(place, mergedAt);
    parentPort.postMessage({ lineIdx, ...result });
  });
  return;
}

// ---------------------------------------------------------------------------
// MAIN THREAD
// ---------------------------------------------------------------------------

const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  place_id           TEXT PRIMARY KEY,
  name               TEXT,
  full_address       TEXT,
  address            TEXT,
  latitude           REAL,
  longitude          REAL,
  rating             REAL,
  review_count       INTEGER,
  phone              TEXT,
  website            TEXT,
  plus_code          TEXT,
  main_category      TEXT,
  categories         TEXT,
  price_range        TEXT,
  scraped_categories TEXT,
  opening_hours      TEXT,
  popular_times      TEXT,
  about              TEXT,
  metadata           TEXT,
  source_url         TEXT,
  extracted_at       TEXT,
  cleaned_at         TEXT,
  merged_at          TEXT,
  image_batch        TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  review_id              TEXT PRIMARY KEY,
  place_id               TEXT NOT NULL REFERENCES businesses(place_id),
  rating                 INTEGER,
  review_text            TEXT,
  published_at           TEXT,
  published_at_date      TEXT,
  reviewer_name          TEXT,
  reviewer_link          TEXT,
  reviewer_photo_count   INTEGER,
  reviewer_review_count  INTEGER,
  is_local_guide         INTEGER,
  review_likes_count     INTEGER,
  response_from_owner_text TEXT,
  response_from_owner_ago  TEXT,
  edited_at_date         TEXT,
  timestamp_us           TEXT,
  review_images_java     TEXT,
  local_image_paths      TEXT,
  extra                  TEXT,
  review_images_scraped  TEXT
);

CREATE TABLE IF NOT EXISTS review_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   TEXT NOT NULL,
  place_id    TEXT NOT NULL,
  image_index INTEGER,
  url         TEXT,
  local_path  TEXT,
  source      TEXT
);
`;

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_reviews_place_id ON reviews(place_id)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(published_at_date)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_local_guide ON reviews(is_local_guide)',
  'CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(main_category)',
  'CREATE INDEX IF NOT EXISTS idx_businesses_rating ON businesses(rating)',
  'CREATE INDEX IF NOT EXISTS idx_businesses_lat_lng ON businesses(latitude, longitude)',
  'CREATE INDEX IF NOT EXISTS idx_review_images_review ON review_images(review_id)',
  'CREATE INDEX IF NOT EXISTS idx_review_images_place ON review_images(place_id)',
];

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

function parseArgs(argv) {
  const args = { inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--input':  args.inputs.push(argv[++i]); break;
      case '--output': args.output = argv[++i]; break;
      case '--fresh':  args.fresh  = true; break;
      case '--help':
        console.log('Usage: node scripts/build-sqlite-db-mt.js --input <file.ndjson> [--input <...>] --output <out.db> [--fresh]');
        console.log('Env: WORKERS=8 BATCH_SIZE=500');
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
  // 16 GB page cache. Final DB is ~30 GB; with 230+ GB system free we'd rather
  // pay RAM than thrash disk on every PK lookup during INSERT OR REPLACE. The
  // earlier 256 MB cache caused per-batch time to grow ~14× as DB outgrew it.
  db.pragma('cache_size = -16777216');
  db.pragma('mmap_size = 17179869184');
  // Push autocheckpoint up so we don't checkpoint mid-batch on huge transactions.
  db.pragma('wal_autocheckpoint = 100000');
  db.exec(SCHEMA);
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
  const MAX_INFLIGHT = N_WORKERS * MAX_PENDING_PER_WORKER;

  console.log(`Workers: ${N_WORKERS}, batch size: ${BATCH_SIZE}, max in-flight: ${MAX_INFLIGHT}`);

  const db = openDb(args.output, args.fresh);
  const mergedAt = new Date().toISOString();

  const insertBiz = db.prepare(`
    INSERT OR REPLACE INTO businesses
    (place_id, name, full_address, address, latitude, longitude, rating, review_count,
     phone, website, plus_code, main_category, categories, price_range, scraped_categories,
     opening_hours, popular_times, about, metadata, source_url, extracted_at, cleaned_at,
     merged_at, image_batch)
    VALUES
    (@place_id, @name, @full_address, @address, @latitude, @longitude, @rating, @review_count,
     @phone, @website, @plus_code, @main_category, @categories, @price_range, @scraped_categories,
     @opening_hours, @popular_times, @about, @metadata, @source_url, @extracted_at, @cleaned_at,
     @merged_at, @image_batch)
  `);

  const insertReview = db.prepare(`
    INSERT OR REPLACE INTO reviews
    (review_id, place_id, rating, review_text, published_at, published_at_date,
     reviewer_name, reviewer_link, reviewer_photo_count, reviewer_review_count,
     is_local_guide, review_likes_count, response_from_owner_text, response_from_owner_ago,
     edited_at_date, timestamp_us, review_images_java, local_image_paths, extra, review_images_scraped)
    VALUES
    (@review_id, @place_id, @rating, @review_text, @published_at, @published_at_date,
     @reviewer_name, @reviewer_link, @reviewer_photo_count, @reviewer_review_count,
     @is_local_guide, @review_likes_count, @response_from_owner_text, @response_from_owner_ago,
     @edited_at_date, @timestamp_us, @review_images_java, @local_image_paths, @extra, @review_images_scraped)
  `);

  const insertImage = db.prepare(`
    INSERT INTO review_images (review_id, place_id, image_index, url, local_path, source)
    VALUES (@review_id, @place_id, @image_index, @url, @local_path, @source)
  `);

  const ingestBatch = db.transaction((results) => {
    const acc = { placesOk: 0, placeholders: 0, reviews: 0, images: 0, parseErrors: 0 };
    for (const r of results) {
      if (r.parseError) { acc.parseErrors++; continue; }
      if (r.skipped || !r.bizRow) continue;
      insertBiz.run(r.bizRow);
      acc.placesOk++;
      if (r.isPlaceholder) acc.placeholders++;
      for (const rr of r.reviewRows) { insertReview.run(rr); acc.reviews++; }
      for (const ir of r.imageRows) { insertImage.run(ir); acc.images++; }
    }
    return acc;
  });

  // Worker pool
  const workers = [];
  for (let i = 0; i < N_WORKERS; i++) workers.push(new Worker(__filename));

  let inflight = 0;
  let inflightWaiter = null;
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
      if (inflightWaiter) {
        const r = inflightWaiter; inflightWaiter = null;
        r();
      }
    });
    w.on('error', (e) => { console.error('Worker error:', e); process.exit(1); });
  }

  function waitForCapacity() {
    if (inflight < MAX_INFLIGHT) return null;
    return new Promise((resolve) => { inflightWaiter = resolve; });
  }

  function nextResult() {
    if (resultsQueue.length) return Promise.resolve(resultsQueue.shift());
    return new Promise((resolve) => { resultsWaiter = resolve; });
  }

  let nextWorker = 0;
  function dispatch(line, lineIdx, inputFile) {
    workers[nextWorker].postMessage({ line, mergedAt, lineIdx, inputFile });
    nextWorker = (nextWorker + 1) % N_WORKERS;
    inflight++;
  }

  let placesIn = 0, placesOut = 0, placeholders = 0, reviewsOut = 0, imagesOut = 0, parseErrors = 0;
  const startedAt = Date.now();
  let totalSent = 0;
  let producerDone = false;

  const producer = (async () => {
    for (const inputFile of args.inputs) {
      console.log(`\n=== Ingesting ${inputFile} ===`);
      let fileLines = 0;
      for await (const line of bufferLines(inputFile)) {
        if (!line.trim()) continue;
        fileLines++;
        const cap = waitForCapacity();
        if (cap) await cap;
        dispatch(line, fileLines, inputFile);
        totalSent++;
      }
      console.log(`  done reading ${inputFile}: ${fileLines} lines sent`);
    }
    producerDone = true;
  })();

  // Consumer: drain results into batches, flush to SQLite
  let batch = [];
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
    batch.push(result);
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
  flush();
  await producer; // surface any error

  // Shut down workers
  for (const w of workers) w.postMessage(null);
  await Promise.all(workers.map((w) => new Promise((resolve) => w.once('exit', resolve))));

  console.log('Creating indexes...');
  for (const sql of INDEXES) db.exec(sql);
  console.log('Running ANALYZE...');
  db.exec('ANALYZE');

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
