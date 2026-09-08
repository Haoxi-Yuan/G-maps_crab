#!/usr/bin/env node
/**
 * Sharded build: one temporary DB per input file, built in parallel, then
 * merged into the final database with bulk INSERT ... SELECT.
 *
 * Why not build serially into one DB: build-sqlite-db-sharded.js already
 * recorded the reason for the review databases, and it applies unchanged here.
 * A single growing destination slows down badly because every row's primary-key
 * insert walks a deeper B-tree, and raising the page cache does not fix it. Per
 * shard the destination stays small, the builders are independent, and the
 * final merge is one sequential pass instead of millions of point inserts.
 *
 * Sharding by file is only safe because the reviewer ids are disjoint across
 * files: the six runs never overlap (each new run's list was the previous
 * remainder), and the 174 ids that repeat inside reviewer_profiles_full_20260824
 * repeat within a single part file, never across two. The per-shard builder
 * resolves those; the merge then needs no cross-shard conflict handling.
 * Re-check that property before reusing this on a different set of runs.
 *
 * Usage:
 *   node scripts/build-reviewer-profile-db-sharded.js \
 *     --output <dataset.db> --shard-dir <tmp> --concurrency 12 \
 *     --source <label>=<dir> [--source ...] [--manifest <sources.jsonl>]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const S = require('./reviewer-profile-db-schema');

function parseArgs(argv) {
  const options = { sources: [], concurrency: 12 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help') { options.help = true; continue; }
    const value = argv[i + 1];
    if (key === '--source') { options.sources.push(value); i += 1; continue; }
    if (key === '--output') { options.output = value; i += 1; continue; }
    if (key === '--shard-dir') { options.shardDir = value; i += 1; continue; }
    if (key === '--manifest') { options.manifest = value; i += 1; continue; }
    if (key === '--concurrency') { options.concurrency = Number(value); i += 1; continue; }
    if (key === '--keep-shards') { options.keepShards = true; continue; }
  }
  return options;
}

const log = (m) => console.log(`[sharded] ${new Date().toISOString().slice(11, 19)} ${m}`);

function runBuilder(builder, shard) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--max-old-space-size=4096', builder,
      '--output', shard.db,
      '--source', `${shard.label}=${shard.file}`,
      '--progress-every', '1000000',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (d) => { tail = (tail + d).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`shard ${shard.name} exited ${code}\n${tail}`));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.output || !options.sources.length) {
    console.log('see header for usage');
    return;
  }
  if (fs.existsSync(options.output)) {
    throw new Error(`refusing to overwrite an existing database: ${options.output}`);
  }
  const shardDir = options.shardDir || `${options.output}.shards`;
  fs.mkdirSync(shardDir, { recursive: true });

  const shards = [];
  for (const spec of options.sources) {
    const at = spec.indexOf('=');
    const label = spec.slice(0, at);
    const dir = path.resolve(spec.slice(at + 1));
    for (const f of fs.readdirSync(dir).filter((n) => /^reviewers\.part-\d+\.ndjson$/.test(n)).sort()) {
      const name = `${label}__${f.replace(/\.ndjson$/, '')}`;
      shards.push({
        label, name,
        file: path.join(dir, f),
        db: path.join(shardDir, `${name}.db`),
        bytes: fs.statSync(path.join(dir, f)).size,
      });
    }
  }
  // Largest first: the long pole starts immediately instead of last.
  shards.sort((a, b) => b.bytes - a.bytes);
  log(`${shards.length} shards, ${(shards.reduce((s, x) => s + x.bytes, 0) / 1073741824).toFixed(1)} GB, concurrency ${options.concurrency}`);

  const builder = path.join(__dirname, 'build-reviewer-profile-db.js');
  const started = Date.now();
  let next = 0;
  let done = 0;
  const failures = [];
  async function worker() {
    while (next < shards.length) {
      const shard = shards[next]; next += 1;
      if (fs.existsSync(shard.db)) fs.unlinkSync(shard.db);
      const t0 = Date.now();
      try {
        await runBuilder(builder, shard);
        done += 1;
        log(`built ${shard.name} (${(shard.bytes / 1073741824).toFixed(1)} GB) in ${((Date.now() - t0) / 60000).toFixed(1)} min  [${done}/${shards.length}]`);
      } catch (error) {
        failures.push(`${shard.name}: ${error.message}`);
        log(`FAILED ${shard.name}: ${error.message.split('\n')[0]}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  if (failures.length) throw new Error(`${failures.length} shard(s) failed:\n${failures.join('\n')}`);
  log(`all shards built in ${((Date.now() - started) / 60000).toFixed(1)} min; merging`);

  const temporary = `${options.output}.building`;
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  const db = new Database(temporary);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -4000000');
  db.exec(S.SCHEMA);

  const mergeStarted = Date.now();
  const audit = [];
  for (const shard of shards) {
    db.exec(`ATTACH DATABASE '${shard.db.replace(/'/g, "''")}' AS shard`);
    db.exec('BEGIN');
    db.exec('INSERT OR REPLACE INTO main.reviewer_profiles SELECT * FROM shard.reviewer_profiles');
    db.exec('INSERT OR REPLACE INTO main.reviewer_reviews SELECT * FROM shard.reviewer_reviews');
    db.exec('INSERT OR REPLACE INTO main.unresolved_reviewers SELECT * FROM shard.unresolved_reviewers');
    const bp = db.prepare('SELECT profiles_written, reviews_written, unresolved_written, duplicates_replaced FROM shard.build_provenance WHERE id = 1').get();
    db.exec('COMMIT');
    db.exec('DETACH DATABASE shard');
    audit.push({ shard: shard.name, ...bp });
    log(`merged ${shard.name}`);
  }

  log('creating indexes');
  db.exec(S.INDEXES);
  log('ANALYZE');
  db.exec('ANALYZE');

  const finalCounts = {
    profiles: db.prepare('SELECT COUNT(*) c FROM reviewer_profiles').get().c,
    reviews: db.prepare('SELECT COUNT(*) c FROM reviewer_reviews').get().c,
    unresolved: db.prepare('SELECT COUNT(*) c FROM unresolved_reviewers').get().c,
  };
  const elapsed = (Date.now() - started) / 1000;
  db.prepare(
    `INSERT OR REPLACE INTO build_provenance
     (id, built_at, builder_version, schema_version, host, sources_json,
      source_manifest_json, profiles_written, reviews_written, unresolved_written,
      duplicates_replaced, elapsed_seconds)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(), 'build-reviewer-profile-db-sharded.js@1', S.SCHEMA_VERSION,
    os.hostname(),
    JSON.stringify({ shards: audit, final_rows: finalCounts, merge_seconds: (Date.now() - mergeStarted) / 1000 }),
    options.manifest && fs.existsSync(options.manifest) ? fs.readFileSync(options.manifest, 'utf8') : null,
    finalCounts.profiles, finalCounts.reviews, finalCounts.unresolved,
    audit.reduce((s, a) => s + (a.duplicates_replaced || 0), 0), elapsed,
  );
  db.pragma('journal_mode = DELETE');
  db.close();
  fs.renameSync(temporary, options.output);

  if (!options.keepShards) {
    for (const shard of shards) { try { fs.unlinkSync(shard.db); } catch { /* already gone */ } }
    try { fs.rmdirSync(shardDir); } catch { /* not empty, leave it */ }
  }
  log(`done in ${(elapsed / 60).toFixed(1)} min`);
  log(`rows: profiles=${finalCounts.profiles} reviews=${finalCounts.reviews} unresolved=${finalCounts.unresolved}`);
  log(`output -> ${options.output}`);
}

main().catch((error) => {
  console.error(`[sharded] ERROR: ${error.stack || error.message}`);
  process.exitCode = 1;
});
