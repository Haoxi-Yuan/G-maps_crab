#!/usr/bin/env node
'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');
const {
  BUSINESS_COLUMNS,
  REVIEW_COLUMNS,
  hasReviewImageNaturalKey,
  tableColumns,
} = require('./review-db-schema');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i];
    else if (argv[i] === '--quick-check') args.quickCheck = true;
    else if (argv[i] === '--help') {
      console.log('Usage: node scripts/summarize-review-db.js --db <database> [--quick-check]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function scalarCounts(db) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM businesses) AS businesses,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM review_images) AS review_images,
      (SELECT COUNT(*) FROM businesses WHERE business_photos IS NOT NULL) AS business_photo_records,
      (SELECT COUNT(*) FROM businesses WHERE photo_categories IS NOT NULL) AS photo_category_records,
      (SELECT COUNT(*) FROM businesses WHERE chij_id IS NOT NULL) AS chij_ids,
      (SELECT COUNT(*) FROM businesses WHERE scrape_error IS NOT NULL) AS scrape_errors,
      (SELECT COUNT(*) FROM businesses WHERE network_error = 1) AS network_errors,
      (SELECT COUNT(*) FROM reviews WHERE source IS NOT NULL) AS review_sources,
      (SELECT COUNT(*) FROM reviews WHERE has_owner_response = 1) AS owner_responses
  `).get();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db) throw new Error('--db is required');
  if (!fs.existsSync(args.db)) throw new Error(`Database not found: ${args.db}`);
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  const businessColumns = tableColumns(db, 'businesses');
  const reviewColumns = tableColumns(db, 'reviews');
  const missingBusinessColumns = BUSINESS_COLUMNS.filter((name) => !businessColumns.has(name));
  const missingReviewColumns = REVIEW_COLUMNS.filter((name) => !reviewColumns.has(name));
  const result = {
    database: args.db,
    user_version: db.pragma('user_version', { simple: true }),
    missing_business_columns: missingBusinessColumns,
    missing_review_columns: missingReviewColumns,
    review_image_natural_key: hasReviewImageNaturalKey(db),
  };
  const hasProvenance = !!db.prepare(`
    SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'build_provenance'
  `).get();
  if (hasProvenance) {
    result.provenance_count = db.prepare('SELECT COUNT(*) AS c FROM build_provenance').get().c;
    result.latest_provenance = db.prepare(`
      SELECT run_id, input_index, input_path, input_sha256, input_size,
             builder_name, builder_version, schema_version, started_at,
             completed_at, input_records, businesses_written, reviews_written,
             review_images_written, parse_errors, notes
        FROM build_provenance
       ORDER BY id DESC
       LIMIT 20
    `).all();
  } else {
    result.provenance_count = 0;
    result.latest_provenance = [];
  }
  if (!missingBusinessColumns.length && !missingReviewColumns.length) {
    result.counts = scalarCounts(db);
    result.invalid_business_json = db.prepare(`
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
  }
  if (args.quickCheck) result.quick_check = db.pragma('quick_check', { simple: true });
  db.close();
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error('Fatal:', error.message || error);
  process.exit(1);
}
