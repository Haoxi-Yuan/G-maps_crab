#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = { runId: 'menu_merged_smoke_v1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--crop-db') args.cropDb = argv[++i];
    else if (arg === '--parent-sample-db') args.parentSampleDb = argv[++i];
    else if (arg === '--luna-db') args.lunaDb = argv[++i];
    else if (arg === '--luna-run-id') args.lunaRunId = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--run-id') args.runId = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ['cropDb', 'parentSampleDb', 'lunaDb', 'lunaRunId', 'out']) {
    if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return args;
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merged_runs (
      run_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      crop_db TEXT NOT NULL,
      parent_sample_db TEXT NOT NULL,
      luna_db TEXT NOT NULL,
      luna_run_id TEXT NOT NULL,
      parent_count INTEGER NOT NULL,
      item_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merged_items (
      item_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_sample_id TEXT NOT NULL,
      place_id TEXT NOT NULL,
      business_name TEXT,
      main_category TEXT,
      section_name TEXT,
      dish_raw TEXT NOT NULL,
      dish_normalized TEXT NOT NULL,
      price_text TEXT,
      price_normalized TEXT NOT NULL,
      price_value REAL,
      currency TEXT,
      description_raw TEXT,
      variants_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      occurrence_count INTEGER NOT NULL,
      source_crop_ids_json TEXT NOT NULL,
      display_text TEXT NOT NULL,
      UNIQUE(run_id, parent_sample_id, dish_normalized, price_normalized)
    );
    CREATE INDEX IF NOT EXISTS idx_merged_items_place ON merged_items(place_id);
    CREATE INDEX IF NOT EXISTS idx_merged_items_parent ON merged_items(parent_sample_id);
  `);
}

function mergeLunaCrops(args) {
  const crop = new Database(path.resolve(args.cropDb), { readonly: true, fileMustExist: true });
  const parent = new Database(path.resolve(args.parentSampleDb), { readonly: true, fileMustExist: true });
  const luna = new Database(path.resolve(args.lunaDb), { readonly: true, fileMustExist: true });
  const out = new Database(path.resolve(args.out));
  createSchema(out);
  if (out.prepare('SELECT 1 FROM merged_runs WHERE run_id = ?').get(args.runId)) {
    throw new Error(`Merged run already exists: ${args.runId}`);
  }
  const cropRows = crop.prepare('SELECT sample_id, parent_sample_id, crop_index FROM samples ORDER BY parent_sample_id, crop_index').all();
  const parentQuery = parent.prepare('SELECT * FROM samples WHERE sample_id = ?');
  const itemQuery = luna.prepare(`
    SELECT * FROM menu_items WHERE run_id = ? AND sample_id = ?
    ORDER BY section_index, item_index
  `);
  const groups = new Map();
  for (const cropRow of cropRows) {
    for (const item of itemQuery.all(args.lunaRunId, cropRow.sample_id)) {
      const dishNormalized = normalizeText(item.dish_raw);
      const priceNormalized = normalizeText(item.price_text);
      if (!dishNormalized) continue;
      const key = `${cropRow.parent_sample_id}\0${dishNormalized}\0${priceNormalized}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          parentSampleId: cropRow.parent_sample_id,
          dishNormalized,
          priceNormalized,
          best: item,
          sources: new Set(),
          occurrences: 0,
        };
        groups.set(key, group);
      }
      group.occurrences++;
      group.sources.add(cropRow.sample_id);
      if ((item.confidence ?? 0) > (group.best.confidence ?? 0)) group.best = item;
    }
  }
  const insert = out.prepare(`
    INSERT INTO merged_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const parentIds = new Set();
  const transaction = out.transaction(() => {
    for (const group of groups.values()) {
      const metadata = parentQuery.get(group.parentSampleId);
      if (!metadata) throw new Error(`Missing parent sample: ${group.parentSampleId}`);
      const item = group.best;
      const displayText = `${item.dish_raw} - ${item.price_text ?? ''}`;
      const itemId = digest(`${args.runId}\0${group.parentSampleId}\0${group.dishNormalized}\0${group.priceNormalized}`).slice(0, 24);
      insert.run(
        itemId, args.runId, group.parentSampleId, metadata.place_id,
        metadata.business_name, metadata.main_category, item.section_name,
        item.dish_raw, group.dishNormalized, item.price_text, group.priceNormalized,
        item.price_value, item.currency, item.description_raw, item.variants_json,
        item.confidence, group.occurrences, JSON.stringify([...group.sources].sort()),
        displayText,
      );
      parentIds.add(group.parentSampleId);
    }
    out.prepare('INSERT INTO merged_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      args.runId, new Date().toISOString(), path.resolve(args.cropDb),
      path.resolve(args.parentSampleDb), path.resolve(args.lunaDb), args.lunaRunId,
      parentIds.size, groups.size,
    );
  });
  transaction();
  const summary = out.prepare(`
    SELECT parent_sample_id, business_name, COUNT(*) AS unique_items,
      SUM(price_text IS NOT NULL) AS priced_items
    FROM merged_items WHERE run_id = ?
    GROUP BY parent_sample_id, business_name ORDER BY parent_sample_id
  `).all(args.runId);
  crop.close();
  parent.close();
  luna.close();
  out.close();
  return { runId: args.runId, parentCount: parentIds.size, itemCount: groups.size, summary };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(mergeLunaCrops(args), null, 2));
}

if (require.main === module) main();

module.exports = { mergeLunaCrops, normalizeText, parseArgs };
