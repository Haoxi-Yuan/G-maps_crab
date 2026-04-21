#!/usr/bin/env node
/**
 * Interactive wizard for Stage 4 — build a SQLite DB from ndjson sources.
 *
 * The heavy lifting (schema, inserts, transactions) lives in
 * scripts/build-sqlite-db.js. This file just lets the user pick a city,
 * select which ndjson source files to feed in, and launches the builder.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BUILDER = path.join(ROOT, 'scripts', 'build-sqlite-db.js');

function ask(rl, q, def) {
  return new Promise((resolve) => {
    const suffix = def !== undefined && def !== '' ? ` [${def}]` : '';
    rl.question(`${q}${suffix}> `, (ans) => {
      ans = (ans || '').trim();
      resolve(ans === '' ? def : ans);
    });
  });
}

function askYesNo(rl, q, def = 'y') {
  return ask(rl, `${q} (y/n)`, def).then((a) =>
    String(a).toLowerCase().startsWith('y')
  );
}

function banner() {
  console.log('');
  console.log('=========================================');
  console.log('  Stage 4 — Build SQLite DB from ndjson');
  console.log('=========================================');
  console.log('');
}

function listCities() {
  const outDir = path.join(ROOT, 'output');
  if (!fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      const dir = path.join(outDir, name);
      // Show a city if it has any plausible source file
      return ['places.ndjson', 'reviews.ndjson', 'reviews.salvaged.ndjson',
              'reviews.rescrape.ndjson', 'reviews.gap.ndjson']
        .some((f) => fs.existsSync(path.join(dir, f)));
    })
    .sort();
}

/**
 * Candidate source files, in the order they should be ingested.
 * Later files overwrite earlier ones on (place_id, review_id) conflict,
 * which is what we want: fresh rescrapes fix up earlier broken ones.
 */
const CANDIDATE_SOURCES = [
  { file: 'places.ndjson',             desc: 'all businesses (business-only, no reviews)' },
  { file: 'reviews.ndjson',            desc: 'primary scraped reviews' },
  { file: 'reviews.salvaged.ndjson',   desc: 'salvaged reviews (recovered from corruption)' },
  { file: 'reviews.rescrape.ndjson',   desc: 'rescrape batch' },
  { file: 'reviews.gap.ndjson',        desc: 'gap-fix rescrape batch' },
];

function availableSources(cityDir) {
  return CANDIDATE_SOURCES
    .map((s) => ({ ...s, path: path.join(cityDir, s.file) }))
    .filter((s) => fs.existsSync(s.path))
    .map((s) => {
      const stat = fs.statSync(s.path);
      const lines = countLines(s.path);
      return { ...s, sizeBytes: stat.size, lines };
    });
}

function countLines(filePath) {
  // Cheap approximation: count newlines in chunks, avoid loading the whole file
  const fd = fs.openSync(filePath, 'r');
  const BUF = Buffer.alloc(256 * 1024);
  let count = 0;
  while (true) {
    const n = fs.readSync(fd, BUF, 0, BUF.length, null);
    if (n === 0) break;
    for (let i = 0; i < n; i++) if (BUF[i] === 0x0A) count++;
  }
  fs.closeSync(fd);
  return count;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function runBuilder(args) {
  return new Promise((resolve, reject) => {
    // Use --max-old-space-size=16384 so very large single lines (100+ MB
    // per place when a restaurant has 50k reviews) don't blow the heap
    // during JSON.parse.
    const child = spawn(process.execPath,
      ['--max-old-space-size=16384', BUILDER, ...args],
      { stdio: 'inherit', cwd: ROOT }
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`builder exited with ${code}`))
    );
  });
}

async function main() {
  banner();

  const cities = listCities();
  if (!cities.length) {
    console.error('No cities in output/ have any ndjson sources yet.');
    console.error('Run Stage 2 (POI search) and/or Stage 3 (Review scrape) first.');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Cities with ndjson sources:');
    cities.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
    console.log('');
    const pick = await ask(rl, `Select [1-${cities.length}]`, '1');
    const idx = parseInt(pick, 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > cities.length) {
      console.error('Invalid selection.');
      process.exit(1);
    }
    const city = cities[idx - 1];
    const cityDir = path.join(ROOT, 'output', city);

    // --- Available sources ---
    const sources = availableSources(cityDir);
    if (!sources.length) {
      console.error('No recognised ndjson files in', path.relative(ROOT, cityDir));
      process.exit(1);
    }

    console.log('');
    console.log(`Sources found in output/${city}/:`);
    sources.forEach((s, i) => {
      console.log(`  [${i + 1}] ${s.file.padEnd(32)} ${String(s.lines).padStart(8)} lines  ${humanBytes(s.sizeBytes).padStart(8)}`);
      console.log(`      ${s.desc}`);
    });
    console.log('');
    console.log('Pick source files (comma-separated indices, or "all" for every available in order).');
    console.log('Files are ingested left-to-right; later files overwrite earlier on conflicts.');
    const defaultPick = sources.map((_, i) => i + 1).join(',');
    const selRaw = await ask(rl, 'Selection', defaultPick);
    let selected;
    if (selRaw === 'all') {
      selected = sources;
    } else {
      const indices = selRaw.split(',').map((s) => parseInt(s.trim(), 10));
      if (indices.some((i) => !Number.isFinite(i) || i < 1 || i > sources.length)) {
        console.error('Invalid selection.');
        process.exit(1);
      }
      selected = indices.map((i) => sources[i - 1]);
    }

    // --- Output DB path ---
    const defaultOut = path.join(cityDir, `${city}_reviews.db`);
    const outRaw = await ask(rl, 'Output DB path', defaultOut);
    const outPath = path.isAbsolute(outRaw) ? outRaw : path.join(ROOT, outRaw);

    // --- Fresh or incremental? ---
    let fresh = false;
    if (fs.existsSync(outPath)) {
      console.log(`  existing DB: ${path.relative(ROOT, outPath)} (${humanBytes(fs.statSync(outPath).size)})`);
      fresh = await askYesNo(rl, 'Start fresh? (n = incremental upsert into existing)', 'n');
    }

    rl.close();

    // --- Confirm + launch ---
    console.log('');
    console.log('=== Build plan ===');
    console.log(`  city:    ${city}`);
    console.log(`  output:  ${path.relative(ROOT, outPath)}`);
    console.log(`  fresh:   ${fresh ? 'yes (delete existing)' : 'no (incremental)'}`);
    console.log(`  sources (in order):`);
    selected.forEach((s) => console.log(`    ${s.file}  (${s.lines} lines, ${humanBytes(s.sizeBytes)})`));
    console.log('');

    const args = [];
    for (const s of selected) args.push('--input', s.path);
    args.push('--output', outPath);
    if (fresh) args.push('--fresh');

    console.log('Launching builder...');
    console.log('');
    try {
      await runBuilder(args);
    } catch (e) {
      console.error('Builder failed:', e.message);
      process.exit(1);
    }

    console.log('');
    console.log('Stage 4 complete.');
    console.log(`DB: ${path.relative(ROOT, outPath)}`);
  } catch (e) {
    try { rl.close(); } catch (_) {}
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
