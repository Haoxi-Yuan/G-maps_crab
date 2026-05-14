#!/usr/bin/env node
/**
 * Sharded build: split a large reviews.ndjson into N pieces, build N
 * temporary DBs in parallel (one process per shard), then merge them into
 * the final DB.
 *
 * Why: the serial/MT builds slowed dramatically as the destination DB grew
 * (every INSERT OR REPLACE does a PK lookup; cache bumps didn't help — the
 * bottleneck shifts elsewhere as the per-transaction work explodes). With
 * shards, each per-shard DB stays small (~4 GB, B-tree shallow) and the 8
 * builders run independently. Final merge is one-pass bulk INSERT INTO
 * SELECT which is much faster than per-row inserts.
 *
 * Usage:
 *   node scripts/build-sqlite-db-sharded.js \
 *     --places  /path/to/places.ndjson \
 *     --reviews /path/to/reviews.ndjson \
 *     --output  /path/to/singapore_reviews.db \
 *     [--shards 8] [--shard-dir /path/to/scratch] [--keep-shards] [--fresh]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BUILDER = path.join(__dirname, 'build-sqlite-db.js');

function parseArgs(argv) {
  const args = { shards: 8 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--places':     args.places  = argv[++i]; break;
      case '--reviews':    args.reviews = argv[++i]; break;
      case '--output':     args.output  = argv[++i]; break;
      case '--shards':     args.shards  = parseInt(argv[++i], 10); break;
      case '--shard-dir':  args.shardDir = argv[++i]; break;
      case '--keep-shards':args.keepShards = true; break;
      case '--fresh':      args.fresh = true; break;
      case '--help':
        console.log('Usage: --places <ndjson> --reviews <ndjson> --output <db> [--shards 8] [--shard-dir DIR] [--keep-shards] [--fresh]');
        process.exit(0);
    }
  }
  return args;
}

// Find LF byte offsets that divide the file into N roughly-equal-byte chunks.
// Boundaries are aligned to LF so each chunk starts at the byte AFTER an LF
// (or at byte 0). Returns an array of N+1 offsets: [0, b1, b2, ..., size].
function findShardBoundaries(filePath, N) {
  const fd = fs.openSync(filePath, 'r');
  const size = fs.fstatSync(fd).size;
  const SCAN_BUF_SIZE = 1024 * 1024;
  const scanBuf = Buffer.alloc(SCAN_BUF_SIZE);
  const boundaries = [0];
  for (let k = 1; k < N; k++) {
    // Ensure strict monotonic increase: if previous boundary is past the
    // ideal target, start scanning from there (one record longer than the
    // ideal slice is fine — better than an empty shard).
    const target = Math.max(Math.floor((size * k) / N), boundaries[boundaries.length - 1]);
    if (target >= size) { boundaries.push(size); continue; }
    let pos = target;
    let foundLF = -1;
    while (pos < size && foundLF < 0) {
      const want = Math.min(SCAN_BUF_SIZE, size - pos);
      const got = fs.readSync(fd, scanBuf, 0, want, pos);
      if (!got) break;
      for (let i = 0; i < got; i++) {
        if (scanBuf[i] === 0x0A) { foundLF = pos + i; break; }
      }
      if (foundLF < 0) pos += got;
    }
    if (foundLF < 0) { boundaries.push(size); continue; }
    boundaries.push(foundLF + 1);
  }
  while (boundaries.length < N + 1) boundaries.push(size);
  boundaries[N] = size;
  fs.closeSync(fd);
  // Drop any shards that ended up empty (consecutive equal boundaries).
  const compact = [boundaries[0]];
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] > compact[compact.length - 1]) compact.push(boundaries[i]);
  }
  return compact;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// Stream a byte range from src to a new file. No transformation — preserves
// the original NDJSON content of the slice. Boundaries are LF-aligned by the
// caller, so each slice starts at the beginning of a record.
async function copyRange(src, dst, startByte, endByte) {
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src, {
      start: startByte,
      end: endByte - 1,
      highWaterMark: 64 * 1024 * 1024,
    });
    const ws = fs.createWriteStream(dst);
    rs.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    rs.on('error', reject);
  });
}

function runBuilder(inputs, output, fresh, noIndexes) {
  return new Promise((resolve, reject) => {
    const args = [
      '--max-old-space-size=8192',
      BUILDER,
    ];
    for (const f of inputs) { args.push('--input', f); }
    args.push('--output', output);
    if (fresh) args.push('--fresh');
    if (noIndexes) args.push('--no-indexes');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const tag = path.basename(output);
    child.stdout.on('data', (b) => process.stdout.write(`[${tag}] ${b}`));
    child.stderr.on('data', (b) => process.stderr.write(`[${tag}] ${b}`));
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${tag} exited with ${code}`)));
  });
}

const Database = require('better-sqlite3');

function mergeShards(finalDb, shardDbs) {
  const t0 = Date.now();
  console.log(`\n=== Merging ${shardDbs.length} shards into ${finalDb} ===`);
  const db = new Database(finalDb);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -2097152'); // 2 GB

  for (let i = 0; i < shardDbs.length; i++) {
    const shard = shardDbs[i];
    const tShard = Date.now();
    console.log(`  [${i + 1}/${shardDbs.length}] attaching ${path.basename(shard)}`);
    db.exec(`ATTACH DATABASE '${shard.replace(/'/g, "''")}' AS s`);
    db.exec(`
      INSERT OR REPLACE INTO businesses
        SELECT * FROM s.businesses;
      INSERT OR REPLACE INTO reviews
        SELECT * FROM s.reviews;
      INSERT INTO review_images (review_id, place_id, image_index, url, local_path, source)
        SELECT review_id, place_id, image_index, url, local_path, source FROM s.review_images;
    `);
    db.exec('DETACH DATABASE s');
    console.log(`     merged in ${Math.round((Date.now() - tShard) / 1000)}s`);
  }

  // Indexes were intentionally NOT created in shard DBs (they slow inserts).
  // Final DB index creation happened in the initial places-phase build via
  // build-sqlite-db.js. Re-run defensively in case schema changes.
  console.log('  creating final indexes...');
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
  for (const sql of INDEXES) db.exec(sql);
  console.log('  ANALYZE...');
  db.exec('ANALYZE');

  const bizN = db.prepare('SELECT COUNT(*) c FROM businesses').get().c;
  const revN = db.prepare('SELECT COUNT(*) c FROM reviews').get().c;
  const imgN = db.prepare('SELECT COUNT(*) c FROM review_images').get().c;
  db.close();
  console.log(`Merge done in ${Math.round((Date.now() - t0) / 1000)}s — businesses=${bizN}, reviews=${revN}, review_images=${imgN}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.places || !args.reviews || !args.output) {
    console.error('Usage: --places <ndjson> --reviews <ndjson> --output <db> [--shards 8] [--shard-dir DIR] [--keep-shards] [--fresh]');
    process.exit(1);
  }
  for (const f of [args.places, args.reviews]) {
    if (!fs.existsSync(f)) { console.error('not found:', f); process.exit(1); }
  }

  const requestedShards = args.shards;
  const shardDir = args.shardDir || path.join(path.dirname(args.output), '_shards');
  fs.mkdirSync(shardDir, { recursive: true });

  // ----- Stage 1: split reviews.ndjson into N byte-balanced shards -----
  console.log(`\n=== Stage 1: splitting ${args.reviews} into up to ${requestedShards} shards ===`);
  const t1 = Date.now();
  const size = fs.statSync(args.reviews).size;
  console.log(`  source size: ${humanBytes(size)}`);
  const boundaries = findShardBoundaries(args.reviews, requestedShards);
  const N = boundaries.length - 1;
  if (N < requestedShards) console.log(`  (got ${N} non-empty shards — file has very uneven record sizes)`);
  for (let i = 0; i < N; i++) {
    console.log(`  shard ${i}: bytes ${boundaries[i]}..${boundaries[i + 1]} (${humanBytes(boundaries[i + 1] - boundaries[i])})`);
  }
  const shardFiles = [];
  for (let i = 0; i < N; i++) {
    shardFiles.push(path.join(shardDir, `reviews.shard_${i}.ndjson`));
  }
  // Copy slices in parallel (IO-bound, lots of headroom)
  await Promise.all(shardFiles.map((dst, i) => copyRange(args.reviews, dst, boundaries[i], boundaries[i + 1])));
  console.log(`  split done in ${Math.round((Date.now() - t1) / 1000)}s`);

  // ----- Stage 2: places.ndjson into the final DB (small, fast, --fresh) -----
  console.log(`\n=== Stage 2: ingesting places.ndjson into ${args.output} ===`);
  const t2 = Date.now();
  await runBuilder([args.places], args.output, args.fresh);
  console.log(`  places phase done in ${Math.round((Date.now() - t2) / 1000)}s`);

  // ----- Stage 3: build N shard DBs in parallel -----
  console.log(`\n=== Stage 3: building ${N} shard DBs in parallel ===`);
  const t3 = Date.now();
  const shardDbs = shardFiles.map((f, i) => path.join(shardDir, `reviews.shard_${i}.db`));
  await Promise.all(shardFiles.map((f, i) => runBuilder([f], shardDbs[i], true, true)));
  console.log(`  all shards done in ${Math.round((Date.now() - t3) / 1000)}s`);

  // ----- Stage 4: merge shards into final DB -----
  mergeShards(args.output, shardDbs);

  // ----- Cleanup -----
  if (!args.keepShards) {
    for (const f of [...shardFiles, ...shardDbs, ...shardDbs.map(d => d + '-wal'), ...shardDbs.map(d => d + '-shm')]) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    try { fs.rmdirSync(shardDir); } catch (_) {}
    console.log('Cleaned up shard files.');
  } else {
    console.log(`Shards kept under ${shardDir}`);
  }
  console.log(`\n=== ALL DONE === output: ${args.output}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
