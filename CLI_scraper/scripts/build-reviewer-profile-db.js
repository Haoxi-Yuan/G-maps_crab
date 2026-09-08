#!/usr/bin/env node
/**
 * Build a SQLite DB from reviewer-profile NDJSON produced by
 * src/cli/run-reviewers-parallel.js, merging several runs into one dataset.
 *
 * The versioned schema and every NDJSON -> row mapping live in
 * reviewer-profile-db-schema.js; keep that module the single source of truth.
 *
 * Terminal records become reviewer_profiles rows with their reviews expanded
 * into reviewer_reviews. Error records go to unresolved_reviewers instead of
 * being dropped, so the database accounts for its own gaps.
 *
 * A reviewer seen twice keeps the last record read, matching the "later record
 * wins" rule merge-review-shards.js already uses. Pass sources in the order you
 * want that to resolve: original runs first, re-scrapes last.
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/build-reviewer-profile-db.js \
 *     --output <dataset.db> \
 *     --source <label>=<dir-of-reviewers.part-N.ndjson> [--source ...] \
 *     [--manifest <sources.jsonl>] [--progress-every 200000]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

const S = require('./reviewer-profile-db-schema');

function parseArgs(argv) {
  const options = { sources: [], progressEvery: 200000 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help') { options.help = true; continue; }
    const value = argv[i + 1];
    if (key === '--source') { options.sources.push(value); i += 1; continue; }
    if (key === '--output') { options.output = value; i += 1; continue; }
    if (key === '--manifest') { options.manifest = value; i += 1; continue; }
    if (key === '--progress-every') { options.progressEvery = Number(value); i += 1; continue; }
  }
  return options;
}

function usage() {
  console.log(`
Build a reviewer-profile SQLite DB from one or more run outputs

  --output <file>            Database to create (must not already exist)
  --source <label>=<dir>     Run output directory; repeatable, order matters
  --manifest <file>          Source manifest JSONL recorded into build_provenance
  --progress-every <n>       Progress line cadence (default 200000)
`);
}

const log = (m) => console.log(`[reviewer-db] ${m}`);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.output) throw new Error('--output is required');
  if (!options.sources.length) throw new Error('at least one --source is required');
  if (fs.existsSync(options.output)) {
    throw new Error(`refusing to overwrite an existing database: ${options.output}`);
  }

  const sources = options.sources.map((spec) => {
    const at = spec.indexOf('=');
    if (at < 1) throw new Error(`--source must be <label>=<dir>, got: ${spec}`);
    const label = spec.slice(0, at);
    const target = path.resolve(spec.slice(at + 1));
    if (!fs.existsSync(target)) throw new Error(`source not found: ${target}`);
    // A single file is accepted so the sharded orchestrator can hand one shard
    // per process; a directory keeps the plain single-process build usable.
    if (fs.statSync(target).isFile()) return { label, dir: path.dirname(target), files: [target] };
    const files = fs.readdirSync(target)
      .filter((f) => /^reviewers\.part-\d+\.ndjson$/.test(f))
      .sort()
      .map((f) => path.join(target, f));
    if (!files.length) throw new Error(`no reviewers.part-N.ndjson under ${target}`);
    return { label, dir: target, files };
  });

  const temporary = `${options.output}.building`;
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  const db = new Database(temporary);

  // Bulk-load settings. The database is rebuilt from NDJSON on demand, so
  // durability during the build buys nothing; the atomic rename at the end is
  // what makes the published file safe.
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -2000000');
  db.exec(S.SCHEMA);

  const insertProfile = db.prepare(
    `INSERT OR REPLACE INTO reviewer_profiles (${S.PROFILE_COLUMNS.join(', ')}) VALUES (${S.placeholders(S.PROFILE_COLUMNS)})`,
  );
  const insertReview = db.prepare(
    `INSERT OR REPLACE INTO reviewer_reviews (${S.REVIEW_COLUMNS.join(', ')}) VALUES (${S.placeholders(S.REVIEW_COLUMNS)})`,
  );
  const insertUnresolved = db.prepare(
    `INSERT OR REPLACE INTO unresolved_reviewers (${S.UNRESOLVED_COLUMNS.join(', ')}) VALUES (${S.placeholders(S.UNRESOLVED_COLUMNS)})`,
  );
  const deleteReviews = db.prepare('DELETE FROM reviewer_reviews WHERE reviewer_id = ?');

  const started = Date.now();
  const counts = { profiles: 0, reviews: 0, unresolved: 0, duplicates: 0, lines: 0, unparsed: 0 };
  const perSource = [];
  // Only reviewers already written need a cascade delete before rewriting.
  // 4.2M short ids is a few hundred MB, far cheaper than probing SQLite per row.
  const seen = new Set();

  db.exec('BEGIN');
  let pending = 0;
  const commitEvery = 2000;

  for (const source of sources) {
    const before = { ...counts };
    for (const file of source.files) {
      log(`reading ${source.label}: ${path.basename(file)}`);
      const stream = fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      // better-sqlite3 is synchronous, so every statement below completes before
      // the next line is pulled; awaiting the reader only parks the open
      // transaction, which is safe in a single-threaded builder.
      for await (const line of rl) {
        if (!line) continue;
        counts.lines += 1;
        let record;
        try { record = JSON.parse(line); } catch { counts.unparsed += 1; continue; }
        const id = record && record.reviewer_id;
        if (!id) { counts.unparsed += 1; continue; }

        if (record._status === 'error') {
          insertUnresolved.run(S.unresolvedRow(record, source.label));
          counts.unresolved += 1;
        } else {
          if (seen.has(id)) { deleteReviews.run(id); counts.duplicates += 1; } else { seen.add(id); }
          insertProfile.run(S.profileRow(record, source.label));
          counts.profiles += 1;
          const reviews = (record.public_content && record.public_content.reviews) || [];
          for (let i = 0; i < reviews.length; i += 1) {
            const review = reviews[i];
            if (!review || !review.review_id) continue;
            insertReview.run(S.reviewRow(review, id, i));
            counts.reviews += 1;
          }
        }

        pending += 1;
        if (pending >= commitEvery) {
          db.exec('COMMIT'); db.exec('BEGIN'); pending = 0;
        }
        if (counts.lines % options.progressEvery === 0) {
          const secs = (Date.now() - started) / 1000;
          log(`lines=${counts.lines} profiles=${counts.profiles} reviews=${counts.reviews} unresolved=${counts.unresolved} ${(counts.lines / secs).toFixed(0)}/s rss=${(process.memoryUsage().rss / 1073741824).toFixed(1)}GB`);
        }
      }
    }
    perSource.push({
      label: source.label,
      dir: source.dir,
      profiles: counts.profiles - before.profiles,
      reviews: counts.reviews - before.reviews,
      unresolved: counts.unresolved - before.unresolved,
    });
  }

  db.exec('COMMIT');
  log('creating indexes');
  db.exec(S.INDEXES);
  log('ANALYZE');
  db.exec('ANALYZE');

  const elapsed = (Date.now() - started) / 1000;
  // Record what the tables actually hold, not how many statements ran. A
  // reviewer seen twice costs two inserts but leaves one row, so the insert
  // counters would overstate the dataset; they stay in sources_json for audit.
  const finalCounts = {
    profiles: db.prepare('SELECT COUNT(*) c FROM reviewer_profiles').get().c,
    reviews: db.prepare('SELECT COUNT(*) c FROM reviewer_reviews').get().c,
    unresolved: db.prepare('SELECT COUNT(*) c FROM unresolved_reviewers').get().c,
  };
  const audit = { inserts: { ...counts }, per_source: perSource, final_rows: finalCounts };
  db.prepare(
    `INSERT OR REPLACE INTO build_provenance
     (id, built_at, builder_version, schema_version, host, sources_json,
      source_manifest_json, profiles_written, reviews_written, unresolved_written,
      duplicates_replaced, elapsed_seconds)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(), 'build-reviewer-profile-db.js@1', S.SCHEMA_VERSION,
    os.hostname(), JSON.stringify(audit),
    options.manifest && fs.existsSync(options.manifest) ? fs.readFileSync(options.manifest, 'utf8') : null,
    finalCounts.profiles, finalCounts.reviews, finalCounts.unresolved,
    counts.duplicates, elapsed,
  );

  db.pragma('journal_mode = DELETE');
  db.close();
  fs.renameSync(temporary, options.output);

  log(`done in ${(elapsed / 60).toFixed(1)} min`);
  log(`rows: profiles=${finalCounts.profiles} reviews=${finalCounts.reviews} unresolved=${finalCounts.unresolved}`);
  log(`inserts: profiles=${counts.profiles} reviews=${counts.reviews} duplicates_replaced=${counts.duplicates} unparsed=${counts.unparsed}`);
  log(`output -> ${options.output}`);
}

main().catch((error) => {
  console.error(`[reviewer-db] ERROR: ${error.stack || error.message}`);
  process.exitCode = 1;
});
