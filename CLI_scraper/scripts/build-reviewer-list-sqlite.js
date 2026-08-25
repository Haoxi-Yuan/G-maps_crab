#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { reviewerIdFromLink } = require('../src/reviewer-profile-scraper');

function usage() {
  console.log(`
Build a complete, sharded Google reviewer list from a review SQLite database

Usage:
  node scripts/build-reviewer-list-sqlite.js --db <reviews.db> --output <list.ndjson> [options]

Options:
  --shard-dir <dir>  Write stable reviewer shard files
  --shards <n>       Number of stable shards (default: 4)
  --manifest <file>  Manifest JSON path (default: beside output)
  --help             Show this help
`);
}

function parseArgs(argv) {
  const options = { shards: 4 };
  const values = new Set(['--db', '--output', '--shard-dir', '--shards', '--manifest']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (!values.has(key)) throw new Error(`unknown option: ${key}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value`);
    options[{ '--db': 'db', '--output': 'output', '--shard-dir': 'shardDir', '--shards': 'shards', '--manifest': 'manifest' }[key]] = argv[++index];
  }
  options.shards = Number(options.shards);
  if (!Number.isInteger(options.shards) || options.shards < 1) throw new Error('--shards must be a positive integer');
  return options;
}

function shardFor(reviewerId, shardCount) {
  return Number(BigInt(reviewerId) % BigInt(shardCount));
}

function openAtomicWriter(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.partial-${process.pid}`;
  return { file, temporary, fd: fs.openSync(temporary, 'w') };
}

function closeAndPublish(writer) {
  fs.fsyncSync(writer.fd);
  fs.closeSync(writer.fd);
  fs.renameSync(writer.temporary, writer.file);
}

function estimatedTableRows(database, table) {
  try {
    const rows = database.prepare('SELECT stat FROM sqlite_stat1 WHERE tbl = ?').all(table);
    const estimates = rows
      .map((row) => Number(String(row.stat || '').split(' ')[0]))
      .filter((value) => Number.isInteger(value) && value >= 0);
    return estimates.length ? Math.max(...estimates) : null;
  } catch (_) {
    return null;
  }
}

function buildReviewerList(databaseFile, outputFile, options = {}) {
  const shardCount = options.shards || 4;
  const shardDirectory = options.shardDir || path.join(path.dirname(outputFile), `reviewer-shards-${shardCount}`);
  const manifestFile = options.manifest || path.join(path.dirname(outputFile), 'reviewer-list-manifest.json');
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  database.pragma('query_only = ON');
  database.pragma('temp_store = FILE');
  const sourceStat = fs.statSync(databaseFile);
  // COUNT(*) and SQL GROUP BY both scan/sort a multi-gigabyte table before
  // yielding the first reviewer. sqlite_stat1 gives an auditable row estimate;
  // the list itself is built in one sequential pass and deduplicated in JS.
  const totalSourceReviews = estimatedTableRows(database, 'reviews');
  const mainWriter = openAtomicWriter(outputFile);
  const shardWriters = Array.from({ length: shardCount }, (_, shard) => openAtomicWriter(path.join(shardDirectory, `reviewers.part-${shard}.ndjson`)));
  const shardCounts = new Array(shardCount).fill(0);
  const seenReviewerIds = new Set();
  let uniqueReviewers = 0;
  let duplicateReviewerLinks = 0;
  let invalidLinks = 0;
  let sourceRowsScanned = 0;
  const started = Date.now();

  const query = database.prepare(`
    SELECT reviewer_link,
           reviewer_name,
           reviewer_review_count,
           reviewer_photo_count,
           is_local_guide
    FROM reviews
    WHERE reviewer_link IS NOT NULL
  `);

  try {
    for (const row of query.iterate()) {
      sourceRowsScanned += 1;
      const reviewerId = reviewerIdFromLink(row.reviewer_link);
      if (!reviewerId) { invalidLinks += 1; continue; }
      if (seenReviewerIds.has(reviewerId)) { duplicateReviewerLinks += 1; continue; }
      seenReviewerIds.add(reviewerId);
      const record = {
        reviewer_id: reviewerId,
        reviewer_name: row.reviewer_name || null,
        reviewer_link: row.reviewer_link,
        observed_names: row.reviewer_name ? [row.reviewer_name] : [],
        observed_public_review_count: row.reviewer_review_count ?? null,
        observed_public_photo_count: row.reviewer_photo_count ?? null,
        observed_local_guide: row.is_local_guide === 1,
        // Exact per-reviewer occurrence/place counts require two disk-backed
        // GROUP BY trees and are unnecessary for fetching the public profile.
        source_review_occurrences: null,
        source_place_count: null,
        source_reviews_file: path.resolve(databaseFile),
      };
      const line = `${JSON.stringify(record)}\n`;
      fs.writeSync(mainWriter.fd, line);
      const shard = shardFor(reviewerId, shardCount);
      fs.writeSync(shardWriters[shard].fd, line);
      shardCounts[shard] += 1;
      uniqueReviewers += 1;
      if (uniqueReviewers % 100000 === 0) {
        const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
        console.log(`[REVIEWER LIST] ${uniqueReviewers} unique (${Math.round(uniqueReviewers / seconds)}/s)`);
      }
    }
    closeAndPublish(mainWriter);
    shardWriters.forEach(closeAndPublish);
  } finally {
    database.close();
  }

  const elapsedSeconds = Number(((Date.now() - started) / 1000).toFixed(3));
  const manifest = {
    created_at: new Date().toISOString(),
    database: path.resolve(databaseFile),
    database_size_bytes: sourceStat.size,
    database_mtime: sourceStat.mtime.toISOString(),
    total_source_reviews: totalSourceReviews,
    total_source_reviews_basis: totalSourceReviews == null ? null : 'sqlite_stat1',
    source_rows_scanned: sourceRowsScanned,
    unique_google_reviewers: uniqueReviewers,
    duplicate_reviewer_links: duplicateReviewerLinks,
    invalid_links: invalidLinks,
    shards: shardCount,
    shard_counts: shardCounts,
    elapsed_seconds: elapsedSeconds,
    reviewers_per_second: elapsedSeconds ? Number((uniqueReviewers / elapsedSeconds).toFixed(3)) : null,
    output: path.resolve(outputFile),
    shard_directory: path.resolve(shardDirectory),
  };
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  const temporaryManifest = `${manifestFile}.partial-${process.pid}`;
  fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporaryManifest, manifestFile);
  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.db || !options.output) throw new Error('--db and --output are required');
  buildReviewerList(path.resolve(options.db), path.resolve(options.output), {
    shards: options.shards,
    shardDir: options.shardDir ? path.resolve(options.shardDir) : undefined,
    manifest: options.manifest ? path.resolve(options.manifest) : undefined,
  });
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`[REVIEWER LIST] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildReviewerList, shardFor };
