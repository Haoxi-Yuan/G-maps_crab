#!/usr/bin/env node
'use strict';

/**
 * Create a deterministic, POI-aware evaluation sample from a menu image
 * manifest. The default design yields 300 images:
 *   - 200 one-image samples: 50 POIs from each image-count bin
 *   - 100 grouped samples: 25 POIs x 4 images for merge/dedup evaluation
 *
 * Only images that already exist on disk are selected.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = {
    runId: 'menu_ocr_pilot_v1',
    seed: 'menu-ocr-pilot-v1',
    singlePerBin: 50,
    multiPois: 25,
    imagesPerMulti: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest') args.manifest = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--run-id') args.runId = argv[++i];
    else if (arg === '--seed') args.seed = argv[++i];
    else if (arg === '--single-per-bin') args.singlePerBin = Number(argv[++i]);
    else if (arg === '--multi-pois') args.multiPois = Number(argv[++i]);
    else if (arg === '--images-per-multi') args.imagesPerMulti = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.manifest || !args.out) throw new Error('--manifest and --out are required');
  for (const key of ['singlePerBin', 'multiPois', 'imagesPerMulti']) {
    if (!Number.isInteger(args[key]) || args[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  return args;
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function imageCountBin(count) {
  if (count <= 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  return '21+';
}

function orientation(width, height) {
  if (!(width > 0) || !(height > 0)) return 'unknown';
  const ratio = width / height;
  if (ratio > 1.15) return 'landscape';
  if (ratio < 0.87) return 'portrait';
  return 'squareish';
}

function resolutionBin(width, height) {
  if (!(width > 0) || !(height > 0)) return 'unknown';
  const megapixels = (width * height) / 1e6;
  if (megapixels < 1) return '<1MP';
  if (megapixels < 4) return '1-4MP';
  if (megapixels < 12) return '4-12MP';
  return '12MP+';
}

function createOutputSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sample_runs (
      run_id            TEXT PRIMARY KEY,
      created_at        TEXT NOT NULL,
      source_manifest   TEXT NOT NULL,
      seed              TEXT NOT NULL,
      single_per_bin    INTEGER NOT NULL,
      multi_pois        INTEGER NOT NULL,
      images_per_multi  INTEGER NOT NULL,
      sample_count      INTEGER NOT NULL,
      poi_count         INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS samples (
      sample_id           TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES sample_runs(run_id),
      cohort              TEXT NOT NULL CHECK (cohort IN ('single_stratified', 'multi_poi')),
      group_id            TEXT NOT NULL,
      group_image_index   INTEGER NOT NULL,
      place_id            TEXT NOT NULL,
      business_name       TEXT,
      main_category       TEXT,
      full_address        TEXT,
      poi_unique_images   INTEGER NOT NULL,
      poi_image_bin       TEXT NOT NULL,
      image_id            TEXT NOT NULL,
      photo_id            TEXT,
      local_path          TEXT NOT NULL,
      source_width        INTEGER,
      source_height       INTEGER,
      orientation         TEXT NOT NULL,
      resolution_bin      TEXT NOT NULL,
      file_size_bytes     INTEGER NOT NULL,
      UNIQUE(run_id, image_id)
    );

    CREATE INDEX IF NOT EXISTS idx_samples_run ON samples(run_id);
    CREATE INDEX IF NOT EXISTS idx_samples_place ON samples(place_id);
    CREATE INDEX IF NOT EXISTS idx_samples_cohort ON samples(cohort);
  `);
}

function selectExistingImages(manifest, placeId, seed, limit, excludedImages) {
  const rows = manifest.prepare(`
    SELECT DISTINCT
      m.image_id, m.photo_id, m.local_path, m.source_width, m.source_height
    FROM current_poi_menu_images m
    WHERE m.place_id = ?
    ORDER BY seed_order(m.image_id)
  `).all(placeId);
  const selected = [];
  for (const row of rows) {
    if (excludedImages.has(row.image_id)) continue;
    let stat;
    try {
      stat = fs.statSync(row.local_path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    selected.push({ ...row, file_size_bytes: stat.size });
    if (selected.length >= limit) break;
  }
  return selected;
}

function buildPilotSample(args) {
  const manifestPath = path.resolve(args.manifest);
  const outputPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const manifest = new Database(manifestPath, { readonly: true, fileMustExist: true });
  manifest.function('seed_order', { deterministic: true }, (value) => digest(`${args.seed}\0${value}`));
  const out = new Database(outputPath);
  out.pragma('foreign_keys = ON');
  createOutputSchema(out);
  if (out.prepare('SELECT 1 FROM sample_runs WHERE run_id = ?').get(args.runId)) {
    throw new Error(`Sample run already exists: ${args.runId}`);
  }

  const selected = [];
  const selectedPois = new Set();
  const selectedImages = new Set();

  const poiImageStatement = manifest.prepare(`
    SELECT
      c.place_id, c.business_name, c.unique_url_images,
      p.main_category, p.full_address
    FROM current_poi_image_counts c
    JOIN pois p ON p.place_id = c.place_id
    WHERE c.unique_url_images BETWEEN ? AND ?
    ORDER BY seed_order(c.place_id)
  `);

  const bins = [
    { label: '1', min: 1, max: 1 },
    { label: '2-5', min: 2, max: 5 },
    { label: '6-20', min: 6, max: 20 },
    { label: '21+', min: 21, max: 2147483647 },
  ];

  for (const bin of bins) {
    let count = 0;
    for (const poi of poiImageStatement.iterate(bin.min, bin.max)) {
      if (selectedPois.has(poi.place_id)) continue;
      const images = selectExistingImages(manifest, poi.place_id, args.seed, 1, selectedImages);
      if (!images.length) continue;
      const image = images[0];
      selected.push({
        cohort: 'single_stratified',
        group_id: poi.place_id,
        group_image_index: 0,
        ...poi,
        ...image,
      });
      selectedPois.add(poi.place_id);
      selectedImages.add(image.image_id);
      count++;
      if (count >= args.singlePerBin) break;
    }
    if (count < args.singlePerBin) {
      throw new Error(`Only found ${count}/${args.singlePerBin} existing-image POIs for bin ${bin.label}`);
    }
  }

  const multiCandidates = manifest.prepare(`
    SELECT
      c.place_id, c.business_name, c.unique_url_images,
      p.main_category, p.full_address
    FROM current_poi_image_counts c
    JOIN pois p ON p.place_id = c.place_id
    WHERE c.unique_url_images >= ?
    ORDER BY seed_order(c.place_id)
  `).iterate(args.imagesPerMulti);
  let multiPoiCount = 0;
  for (const poi of multiCandidates) {
    if (selectedPois.has(poi.place_id)) continue;
    const images = selectExistingImages(
      manifest, poi.place_id, args.seed, args.imagesPerMulti, selectedImages,
    );
    if (images.length < args.imagesPerMulti) continue;
    for (let i = 0; i < images.length; i++) {
      selected.push({
        cohort: 'multi_poi',
        group_id: poi.place_id,
        group_image_index: i,
        ...poi,
        ...images[i],
      });
      selectedImages.add(images[i].image_id);
    }
    selectedPois.add(poi.place_id);
    multiPoiCount++;
    if (multiPoiCount >= args.multiPois) break;
  }
  if (multiPoiCount < args.multiPois) {
    throw new Error(`Only found ${multiPoiCount}/${args.multiPois} multi-image POIs`);
  }

  const insertRun = out.prepare(`
    INSERT INTO sample_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSample = out.prepare(`
    INSERT INTO samples(
      sample_id, run_id, cohort, group_id, group_image_index, place_id,
      business_name, main_category, full_address, poi_unique_images,
      poi_image_bin, image_id, photo_id, local_path, source_width,
      source_height, orientation, resolution_bin, file_size_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const write = out.transaction(() => {
    insertRun.run(
      args.runId, new Date().toISOString(), manifestPath, args.seed,
      args.singlePerBin, args.multiPois, args.imagesPerMulti,
      selected.length, selectedPois.size,
    );
    for (const row of selected) {
      insertSample.run(
        digest(`${args.runId}\0${row.image_id}`).slice(0, 24),
        args.runId, row.cohort, row.group_id, row.group_image_index,
        row.place_id, row.business_name, row.main_category, row.full_address,
        row.unique_url_images, imageCountBin(row.unique_url_images), row.image_id,
        row.photo_id, row.local_path, row.source_width, row.source_height,
        orientation(row.source_width, row.source_height),
        resolutionBin(row.source_width, row.source_height), row.file_size_bytes,
      );
    }
  });
  write();

  const distributions = {
    cohort: out.prepare(`SELECT cohort AS key, COUNT(*) AS count FROM samples WHERE run_id = ? GROUP BY cohort ORDER BY cohort`).all(args.runId),
    poiImageBin: out.prepare(`SELECT poi_image_bin AS key, COUNT(*) AS count FROM samples WHERE run_id = ? GROUP BY poi_image_bin ORDER BY poi_image_bin`).all(args.runId),
    orientation: out.prepare(`SELECT orientation AS key, COUNT(*) AS count FROM samples WHERE run_id = ? GROUP BY orientation ORDER BY orientation`).all(args.runId),
    resolution: out.prepare(`SELECT resolution_bin AS key, COUNT(*) AS count FROM samples WHERE run_id = ? GROUP BY resolution_bin ORDER BY resolution_bin`).all(args.runId),
  };
  manifest.close();
  out.close();
  return {
    runId: args.runId,
    output: outputPath,
    sampleCount: selected.length,
    poiCount: selectedPois.size,
    distributions,
  };
}

function main() {
  console.log(JSON.stringify(buildPilotSample(parseArgs(process.argv.slice(2)))));
}

if (require.main === module) main();

module.exports = { buildPilotSample, imageCountBin, orientation, parseArgs, resolutionBin };
