#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { buildPilotSample } = require('../scripts/sample-menu-ocr-pilot');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-ocr-sample-test-'));
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

try {
  const manifestPath = path.join(temp, 'manifest.db');
  const outputPath = path.join(temp, 'pilot.db');
  const manifest = new Database(manifestPath);
  manifest.exec(`
    CREATE TABLE pois (
      place_id TEXT PRIMARY KEY, business_name TEXT, main_category TEXT,
      full_address TEXT, active INTEGER NOT NULL
    );
    CREATE TABLE images (
      image_id TEXT PRIMARY KEY, local_path TEXT, source_width INTEGER,
      source_height INTEGER, active INTEGER NOT NULL
    );
    CREATE TABLE image_sources (
      image_id TEXT, place_id TEXT, photo_id TEXT, active INTEGER NOT NULL
    );
    CREATE VIEW current_poi_menu_images AS
      SELECT s.place_id, p.business_name, p.main_category, p.full_address,
             s.photo_id, i.image_id, i.local_path, i.source_width, i.source_height
      FROM image_sources s JOIN images i USING(image_id) JOIN pois p USING(place_id)
      WHERE s.active=1 AND i.active=1 AND p.active=1;
    CREATE VIEW current_poi_image_counts AS
      SELECT place_id, business_name, COUNT(DISTINCT image_id) unique_url_images
      FROM current_poi_menu_images GROUP BY place_id, business_name;
  `);
  const putPoi = manifest.prepare('INSERT INTO pois VALUES (?, ?, ?, ?, 1)');
  const putImage = manifest.prepare('INSERT INTO images VALUES (?, ?, ?, ?, 1)');
  const putSource = manifest.prepare('INSERT INTO image_sources VALUES (?, ?, ?, 1)');
  const addPoi = (placeId, count) => {
    putPoi.run(placeId, `Business ${placeId}`, 'Restaurant', `${placeId} Road`);
    for (let i = 0; i < count; i++) {
      const imageId = digest(`${placeId}-${i}`);
      const localPath = path.join(temp, `${imageId}.jpg`);
      fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
      putImage.run(imageId, localPath, 1200 + i, 900 + i);
      putSource.run(imageId, placeId, `photo-${placeId}-${i}`);
    }
  };
  addPoi('bin-1', 1);
  addPoi('bin-2-5', 2);
  addPoi('bin-6-20', 6);
  addPoi('bin-21', 21);
  addPoi('multi', 4);
  manifest.close();

  const result = buildPilotSample({
    manifest: manifestPath,
    out: outputPath,
    runId: 'fixture',
    seed: 'fixture-seed',
    singlePerBin: 1,
    multiPois: 1,
    imagesPerMulti: 2,
  });
  assert.equal(result.sampleCount, 6);
  assert.equal(result.poiCount, 5);

  const out = new Database(outputPath, { readonly: true });
  assert.equal(out.prepare('SELECT COUNT(*) n FROM samples').get().n, 6);
  assert.equal(out.prepare("SELECT COUNT(*) n FROM samples WHERE cohort='single_stratified'").get().n, 4);
  assert.equal(out.prepare("SELECT COUNT(*) n FROM samples WHERE cohort='multi_poi'").get().n, 2);
  assert.equal(out.prepare('SELECT COUNT(DISTINCT image_id) n FROM samples').get().n, 6);
  assert.equal(out.prepare('SELECT MIN(file_size_bytes) n FROM samples').get().n, 3);
  out.close();
  console.log('menu OCR pilot sampler fixture: ok');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
