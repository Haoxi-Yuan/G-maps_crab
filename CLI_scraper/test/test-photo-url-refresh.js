#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const {
  openPhotoUrlCache,
  preparePhotoUrlLookup,
  upsertPhotoUrls,
} = require('../src/photo-url-cache');
const { parseArgs, loadTargets, matchFreshCategory } = require('../scripts/refresh-photo-category-urls');

const repo = path.resolve(__dirname, '..');
const script = path.join(repo, 'scripts', 'refresh-photo-category-urls.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-url-refresh-test-'));

try {
  const dbPath = path.join(temp, 'fixture.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE businesses (
      place_id TEXT PRIMARY KEY, name TEXT, main_category TEXT,
      categories TEXT, scraped_categories TEXT, photo_categories TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO businesses VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('p0', 'Food Without Menu', 'Restaurant', '["Cafe"]', null, JSON.stringify([
    { key: 'outside', label: 'Exterior', photos: [{ id: 'CIABIhOutside', url: 'https://old/out=s400' }] },
  ]));
  insert.run('p1', 'Cafe One', 'Cafe restaurant', '["Bakery"]', null, JSON.stringify([
    { key: 'menu-key', label: 'Menu', photos: [
      { id: 'CIABIhPermanentOne', mediaType: 'photo', url: 'https://old/one=s400' },
      { id: 'CIHM0ogPermanentTwo', mediaType: 'photo', url: 'https://old/two=s400' },
    ] },
  ]));
  insert.run('p2', 'Museum Menu', 'Museum', '["Attraction"]', null, JSON.stringify([
    { key: 'menu-key', label: 'Menu', photos: [{ id: 'CIABIhMuseum', url: 'https://old/museum=s400' }] },
  ]));

  const args = parseArgs([
    '--db', dbPath, '--cache', path.join(temp, 'unused.db'),
    '--category', 'menu', '--poi-category', 'restaurant,cafe',
    '--max-pois', '1', '--max-images-per-poi', '1',
  ]);
  const targets = loadTargets(db, args);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].place_id, 'p1');
  assert.deepEqual(targets[0].categories[0].targetPhotoIds, ['CIABIhPermanentOne']);
  assert.equal(matchFreshCategory(
    { key: 'old-key', label: 'Menu' },
    [{ key: 'fresh-key', label: 'menu' }],
  ).key, 'fresh-key');
  db.close();

  const fixturePath = path.join(temp, 'rpc-fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify({
    p1: {
      categories: [{
        key: 'menu-key',
        label: 'Menu',
        photos: [{
          id: 'CIABIhPermanentOne',
          url: 'https://lh3.googleusercontent.com/fresh-one=w203-h270-k-no',
          w: 1536,
          h: 2048,
          mediaType: 'photo',
        }],
      }],
    },
  }));
  const cachePath = path.join(temp, 'photo-url-cache.db');
  execFileSync(process.execPath, [script,
    '--db', dbPath, '--cache', cachePath,
    '--category', 'menu', '--poi-category', 'restaurant,cafe',
    '--max-pois', '1', '--max-images-per-poi', '1',
    '--fixture', fixturePath,
  ], { cwd: repo, stdio: 'pipe' });

  const cacheDb = openPhotoUrlCache(cachePath, { readonly: true, fileMustExist: true });
  const lookup = preparePhotoUrlLookup(cacheDb);
  const cached = lookup('CIABIhPermanentOne');
  assert.equal(cached.url, 'https://lh3.googleusercontent.com/fresh-one=w203-h270-k-no');
  assert.equal(cached.place_id, 'p1');
  assert.equal(cached.width, 1536);
  cacheDb.close();

  const writable = openPhotoUrlCache(cachePath);
  upsertPhotoUrls(writable, [{
    photo_id: 'CIABIhPermanentOne',
    url: 'https://lh3.googleusercontent.com/newer-token=w203-h270-k-no',
    refreshed_at: '2026-07-12T01:02:03.000Z',
  }]);
  const updated = preparePhotoUrlLookup(writable)('CIABIhPermanentOne');
  assert.equal(updated.url, 'https://lh3.googleusercontent.com/newer-token=w203-h270-k-no');
  assert.equal(updated.place_id, 'p1');
  assert.equal(updated.refreshed_at, '2026-07-12T01:02:03.000Z');
  writable.close();

  console.log('photo URL refresh/cache fixture: ok');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
