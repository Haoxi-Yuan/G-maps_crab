#!/usr/bin/env node
/**
 * Build a SQLite DB from a finalized reviews.ndjson, using the same 3-table
 * schema as the Singapore package (singapore_reviews.db):
 *
 *   businesses(place_id, name, full_address, address, latitude, longitude,
 *              rating, review_count, phone, website, plus_code, main_category,
 *              categories, price_range, scraped_categories, opening_hours,
 *              popular_times, about, metadata, source_url, extracted_at,
 *              cleaned_at, merged_at, image_batch)
 *   reviews(review_id, place_id, rating, review_text, published_at,
 *           published_at_date, reviewer_name, reviewer_link,
 *           reviewer_photo_count, reviewer_review_count, is_local_guide,
 *           review_likes_count, response_from_owner_text,
 *           response_from_owner_ago, edited_at_date, timestamp_us,
 *           review_images_java, local_image_paths, extra, review_images_scraped)
 *   review_images(id, review_id, place_id, image_index, url, local_path, source)
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/build-sqlite-db.js \
 *     --input  output/san_francisco_v4/reviews.ndjson \
 *     --output output/san_francisco_v4/san_francisco_reviews.db
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
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

const jsonOrNull = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const emptyArrayToNull = (v) => (Array.isArray(v) && v.length === 0 ? null : v);
const coerceBool = (v) => (v === true ? 1 : v === false ? 0 : v == null ? null : Number(v) ? 1 : 0);

function parseArgs(argv) {
  const args = { inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--input':  args.inputs.push(argv[++i]); break;
      case '--output': args.output = argv[++i]; break;
      case '--fresh':  args.fresh  = true; break;
      case '--help':
        console.log('Usage: node scripts/build-sqlite-db.js --input <file.ndjson> [--input <...>] --output <out.db> [--fresh]');
        console.log('');
        console.log('  --input may be repeated. Files are processed in order.');
        console.log('  Each record is ingested with INSERT OR REPLACE, so later files overwrite earlier on placeId / review_id conflict.');
        console.log('  Both places.ndjson (business-only) and reviews.ndjson (with detailedReviews) are accepted.');
        process.exit(0);
    }
  }
  return args;
}

function openDb(outputFile, fresh) {
  if (fresh && fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const db = new Database(outputFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.exec(SCHEMA);
  return db;
}

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

  // Transaction handling each place: one BEGIN per place gives us ACID per row.
  const ingestPlace = db.transaction((place) => {
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
  });

  let placesIn = 0, placesOut = 0, placeholders = 0, reviewsOut = 0, imagesOut = 0;
  const startedAt = Date.now();

  for (const inputFile of args.inputs) {
    console.log(`\n=== Ingesting ${inputFile} ===`);
    let fileLines = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(inputFile, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      placesIn++; fileLines++;
      let place;
      try { place = JSON.parse(line); }
      catch (e) {
        console.warn(`  parse error at ${inputFile} line ${fileLines}: ${e.message}; skipping`);
        continue;
      }
      if (place._placeholder) placeholders++;
      const r = ingestPlace(place);
      if (!r.skipped) placesOut++;
      reviewsOut += r.reviews;
      imagesOut += r.images;

      if (placesIn % 2000 === 0) {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        console.log(
          `  processed ${placesIn} places (${placesOut} with id, ${placeholders} placeholders), ` +
          `${reviewsOut} reviews, ${imagesOut} images — ${secs}s`
        );
      }
    }
    console.log(`  done ${inputFile}: ${fileLines} lines from this file`);
  }

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
  console.log(`  placeholders:  ${placeholders}`);
  console.log(`  businesses:    ${bizN}`);
  console.log(`  reviews:       ${revN}`);
  console.log(`  review_images: ${imgN}`);
  console.log(`  elapsed:       ${elapsed}s`);
  console.log(`  output:        ${args.output}`);

  db.close();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
