#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { openPhotoUrlCache, upsertPhotoUrls } = require('../src/photo-url-cache');

const repo = path.resolve(__dirname, '..');
const script = path.join(repo, 'scripts', 'download-db-images.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-image-download-test-'));

function manifestImages(dir) {
  return fs.readFileSync(path.join(dir, 'manifest.ndjson'), 'utf8')
    .trim().split('\n').map(JSON.parse).filter((row) => row.type === 'image');
}

try {
  const dbPath = path.join(temp, 'fixture.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE businesses (
      place_id TEXT PRIMARY KEY, name TEXT, main_category TEXT,
      categories TEXT, scraped_categories TEXT, photo_categories TEXT
    );
    CREATE TABLE review_images (
      id INTEGER PRIMARY KEY, review_id TEXT, place_id TEXT,
      image_index INTEGER, url TEXT, local_path TEXT, source TEXT
    );
  `);
  const addBusiness = db.prepare('INSERT INTO businesses VALUES (?, ?, ?, ?, ?, ?)');
  addBusiness.run('p0', 'Restaurant Without Menu', 'Restaurant', '["Cafe"]', null, JSON.stringify([
    { key: 'outside', label: 'Exterior', photos: [
      { id: 'e0', mediaType: 'photo', url: 'https://lh3.googleusercontent.com/no-menu=s400' },
    ] },
  ]));
  addBusiness.run('p1', 'Cafe One', 'Cafe restaurant', '["Cafe"]', null, JSON.stringify([
    { key: 'menu-key', label: 'Menu', photos: [
      { id: 'm1', mediaType: 'photo', url: 'https://lh3.googleusercontent.com/a=w200-h200-k-no' },
      { id: 'm2', mediaType: 'photo', url: 'https://lh3.googleusercontent.com/b=s400' },
    ] },
    { key: 'outside', label: 'Exterior', photos: [
      { id: 'e1', mediaType: 'photo', url: 'https://lh3.googleusercontent.com/c=s400' },
    ] },
  ]));
  addBusiness.run('p2', 'Museum', 'Museum', '["Attraction"]', null, JSON.stringify([
    { key: 'menu-key', label: 'Menu', photos: [
      { id: 'm3', mediaType: 'photo', url: 'https://lh3.googleusercontent.com/d=s400' },
    ] },
  ]));
  const addImage = db.prepare('INSERT INTO review_images VALUES (?, ?, ?, ?, ?, NULL, ?)');
  addImage.run(1, 'r1', 'p1', 0, 'https://lh3.googleusercontent.com/r1=s400', 'js');
  addImage.run(2, 'r2', 'p1', 0, 'https://lh3.googleusercontent.com/r2=s400', 'js');
  addImage.run(10, 'r3', 'p2', 0, 'https://lh3.googleusercontent.com/r3=s400', 'js');
  db.close();

  const cachePath = path.join(temp, 'photo-url-cache.db');
  const cacheDb = openPhotoUrlCache(cachePath);
  upsertPhotoUrls(cacheDb, [{
    photo_id: 'm1',
    url: 'https://lh3.googleusercontent.com/fresh-menu-token=w203-h270-k-no',
    place_id: 'p1',
    category_key: 'menu-key',
    category_label: 'Menu',
    refreshed_at: '2026-07-12T00:00:00.000Z',
  }]);
  cacheDb.close();

  const menuOut = path.join(temp, 'menu');
  execFileSync(process.execPath, [script,
    '--db', dbPath, '--output', menuOut,
    '--source', 'photo-categories', '--category', 'menu',
    '--poi-category', 'restaurant,cafe', '--max-pois', '1',
    '--max-images-per-poi', '1', '--size-suffix', 's1024-w1024-h1024-k-no',
    '--url-cache', cachePath,
    '--dry-run',
  ], { cwd: repo, stdio: 'pipe' });
  const menu = manifestImages(menuOut);
  assert.equal(menu.length, 1);
  assert.equal(menu[0].place_id, 'p1');
  assert.equal(menu[0].category_label, 'Menu');
  assert.match(menu[0].fetch_url, /=s1024-w1024-h1024-k-no$/);
  assert.match(menu[0].fetch_url, /fresh-menu-token=/);
  assert.equal(menu[0].original_url, 'https://lh3.googleusercontent.com/a=w200-h200-k-no');
  assert.equal(menu[0].database_url, 'https://lh3.googleusercontent.com/a=w200-h200-k-no');
  assert.equal(menu[0].db_original_url, 'https://lh3.googleusercontent.com/a=w200-h200-k-no');
  assert.equal(menu[0].resolved_url, 'https://lh3.googleusercontent.com/fresh-menu-token=w203-h270-k-no');
  assert.equal(menu[0].cache_url, 'https://lh3.googleusercontent.com/fresh-menu-token=w203-h270-k-no');
  assert.equal(menu[0].cache_hit, true);
  assert.equal(menu[0].url_source, 'photo-url-cache');
  assert.equal(menu[0].url_cache_refreshed_at, '2026-07-12T00:00:00.000Z');
  assert.equal(menu[0].identity_source, 'photo-id');

  const menuWithoutCacheOut = path.join(temp, 'menu-without-cache');
  execFileSync(process.execPath, [script,
    '--db', dbPath, '--output', menuWithoutCacheOut,
    '--source', 'photo-categories', '--category', 'menu',
    '--poi-category', 'restaurant,cafe', '--max-pois', '1',
    '--max-images-per-poi', '1', '--size-suffix', 's1024-w1024-h1024-k-no',
    '--dry-run',
  ], { cwd: repo, stdio: 'pipe' });
  const menuWithoutCache = manifestImages(menuWithoutCacheOut);
  assert.equal(menuWithoutCache[0].cache_hit, false);
  assert.equal(menuWithoutCache[0].cache_url, null);
  assert.equal(
    menuWithoutCache[0].relative_path,
    menu[0].relative_path,
    'photo_id must keep output path stable when a signed URL is refreshed',
  );

  const reviewOut = path.join(temp, 'reviews');
  execFileSync(process.execPath, [script,
    '--db', dbPath, '--output', reviewOut,
    '--source', 'review-images', '--max-images', '2',
    '--sample-strategy', 'even', '--dry-run',
  ], { cwd: repo, stdio: 'pipe' });
  const reviews = manifestImages(reviewOut);
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((row) => row.review_id), ['r1', 'r3']);

  console.log('download-db-images fixture dry-run: ok');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
