#!/usr/bin/env node
'use strict';

/**
 * Export a bulk-downloader URL list for one photo category label.
 *
 * Mirrors scripts/export_image_url_lists.py's conventions so the artifacts stay
 * interchangeable: dedupe on the URL with its trailing size suffix stripped,
 * name each file sha256(that base)[:16], and emit `sha16 \t full-url` for
 * scripts/bulk_image_downloader.py. Videos are skipped — they are not images
 * and the downloader would store them under a .jpg name.
 *
 * Usage:
 *   node scripts/export-photo-category-urls.js --db DB --label Menu --out list.tsv
 *   [--categories-like 'restaurant,cafe']   restrict by businesses.main_category
 */

const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = { label: 'Menu' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i];
    else if (argv[i] === '--label') args.label = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--categories-like') args.categoriesLike = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.db || !args.out) throw new Error('--db and --out are required');
  return args;
}

const urlBase = (u) => (u.includes('=') ? u.slice(0, u.lastIndexOf('=')) : u);
const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.db, { readonly: true });

  let where = "b.photo_categories IS NOT NULL AND json_extract(c.value,'$.label') = ?";
  const params = [args.label];
  if (args.categoriesLike) {
    const terms = args.categoriesLike.split(',').map((t) => t.trim()).filter(Boolean);
    where += ' AND (' + terms.map(() => 'lower(b.main_category) LIKE ?').join(' OR ') + ')';
    params.push(...terms.map((t) => `%${t.toLowerCase()}%`));
  }

  const rows = db.prepare(`
    SELECT b.place_id, b.main_category, c.value AS cat
    FROM businesses b, json_each(b.photo_categories) c
    WHERE ${where}
  `).iterate(...params);

  const seen = new Set();
  const out = fs.createWriteStream(args.out);
  let categories = 0, photos = 0, videos = 0, written = 0;
  for (const row of rows) {
    categories++;
    let parsed;
    try { parsed = JSON.parse(row.cat); } catch { continue; }
    for (const p of parsed.photos || []) {
      if (!p || !p.url) continue;
      if (p.mediaType === 'video') { videos++; continue; }
      photos++;
      const base = urlBase(p.url);
      if (seen.has(base)) continue;
      seen.add(base);
      written++;
      out.write(`${sha16(base)}\t${p.url}\n`);
    }
  }
  out.end();
  db.close();
  console.log(JSON.stringify({
    label: args.label, categoryRows: categories, photoEntries: photos,
    videosSkipped: videos, uniqueUrls: written, out: args.out,
  }));
}

if (require.main === module) main();
