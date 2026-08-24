#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const repo = path.resolve(__dirname, '..');
const script = path.join(repo, 'scripts', 'build-menu-image-manifest.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-image-manifest-test-'));

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

try {
  const sourcePath = path.join(temp, 'reviews.db');
  const outputPath = path.join(temp, 'manifests', 'menu.db');
  const imageRoot = path.join(temp, 'images');
  const source = new Database(sourcePath);
  source.exec(`
    CREATE TABLE businesses (
      place_id TEXT PRIMARY KEY,
      name TEXT,
      main_category TEXT,
      categories TEXT,
      full_address TEXT,
      address TEXT,
      latitude REAL,
      longitude REAL,
      rating REAL,
      review_count INTEGER,
      price_range TEXT,
      source_url TEXT,
      photo_categories TEXT
    );
  `);
  const insert = source.prepare(`
    INSERT INTO businesses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'poi-1', 'Cafe One', 'Cafe', '["Cafe","Restaurant"]', '1 Test Road',
    '1 Test Road', 1.3, 103.8, 4.5, 120, '$$', 'https://maps/poi-1',
    JSON.stringify([
      {
        key: 'menu', label: 'Menu', photos: [
          { id: 'photo-shared', mediaType: 'photo', url: 'https://img/shared=s400', w: 1200, h: 900 },
          { id: 'photo-unique', mediaType: 'photo', url: 'https://img/unique', width: 800, height: 1000 },
          { id: 'video-1', mediaType: 'video', url: 'https://img/video=s400' },
          { id: 'invalid-1', mediaType: 'photo' },
        ],
      },
      { key: 'inside', label: 'Interior', photos: [{ id: 'not-menu', url: 'https://img/inside=s400' }] },
    ]),
  );
  insert.run(
    'poi-2', 'Bistro Two', 'Restaurant', '["Restaurant"]', '2 Test Road',
    '2 Test Road', 1.31, 103.81, 4.2, 80, '$', 'https://maps/poi-2',
    JSON.stringify([{
      key: 'menu-two', label: 'Menu', photos: [
        { id: 'photo-shared-again', mediaType: 'photo', url: 'https://img/shared=w203-h270-k-no', w: 1200, h: 900 },
      ],
    }]),
  );
  insert.run(
    'poi-3', 'No Menu Shop', 'Shop', '["Shop"]', '3 Test Road',
    '3 Test Road', 1.32, 103.82, 4.0, 30, null, 'https://maps/poi-3',
    JSON.stringify([{ key: 'outside', label: 'Exterior', photos: [{ id: 'outside', url: 'https://img/outside=s400' }] }]),
  );
  source.close();

  const args = [
    script,
    '--db', sourcePath,
    '--out', outputPath,
    '--image-root', imageRoot,
    '--list-name', 'sg_menu_fixture',
    '--label', 'Menu',
    '--size', 's0',
  ];
  const first = JSON.parse(execFileSync(process.execPath, args, { cwd: repo, encoding: 'utf8' }));
  assert.equal(first.categoryRows, 2);
  assert.equal(first.photoEntries, 3);
  assert.equal(first.videosSkipped, 1);
  assert.equal(first.invalidSkipped, 1);
  assert.equal(first.poiCount, 2);
  assert.equal(first.uniqueImages, 2);
  assert.equal(first.sourceLinks, 3);
  assert.equal(first.shortIdCollisions, 0);

  const manifest = new Database(outputPath, { readonly: true });
  assert.equal(manifest.prepare('SELECT COUNT(*) AS n FROM pois').get().n, 2);
  assert.equal(manifest.prepare('SELECT COUNT(*) AS n FROM images').get().n, 2);
  assert.equal(manifest.prepare('SELECT COUNT(*) AS n FROM image_sources').get().n, 3);

  const sharedBase = 'https://img/shared';
  const sharedId = digest(sharedBase);
  const shared = manifest.prepare('SELECT * FROM images WHERE image_id = ?').get(sharedId);
  assert.equal(shared.short_id, sharedId.slice(0, 16));
  assert.equal(shared.requested_url, `${sharedBase}=s0`);
  assert.equal(
    shared.relative_path,
    `sg_menu_fixture/${shared.short_id.slice(0, 2)}/${shared.short_id.slice(2, 4)}/${shared.short_id}.jpg`,
  );
  assert.equal(manifest.prepare(`
    SELECT COUNT(*) AS n FROM image_sources WHERE image_id = ?
  `).get(sharedId).n, 2);
  assert.deepEqual(
    manifest.prepare(`
      SELECT place_id, unique_url_images FROM current_poi_image_counts ORDER BY place_id
    `).all(),
    [
      { place_id: 'poi-1', unique_url_images: 2 },
      { place_id: 'poi-2', unique_url_images: 1 },
    ],
  );
  manifest.close();

  const second = JSON.parse(execFileSync(process.execPath, args, { cwd: repo, encoding: 'utf8' }));
  assert.equal(second.uniqueImages, 2);
  assert.equal(second.sourceLinks, 3);
  const rerun = new Database(outputPath, { readonly: true });
  assert.equal(rerun.prepare('SELECT COUNT(*) AS n FROM manifest_runs').get().n, 2);
  assert.equal(rerun.prepare('SELECT COUNT(*) AS n FROM image_sources').get().n, 3);
  assert.equal(rerun.prepare("SELECT value FROM manifest_metadata WHERE key = 'schema_version'").get().value, '1');
  rerun.close();

  console.log('menu image manifest fixture: ok');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
