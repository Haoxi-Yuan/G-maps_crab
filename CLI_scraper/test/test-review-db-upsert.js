#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const {
  SCHEMA_VERSION,
  BUILDER_VERSION,
  BUSINESS_COLUMNS,
  REVIEW_COLUMNS,
  businessValueUpsertSql,
  reviewValueUpsertSql,
  reviewImageValueUpsertSql,
  businessSelectUpsertSql,
  reviewSelectUpsertSql,
  ensureSchema,
  hasReviewImageNaturalKey,
  ensureReviewImageNaturalKey,
  recordBuildProvenance,
} = require('../scripts/review-db-schema');

function completeRow(columns, values) {
  return Object.fromEntries(columns.map((column) => [column, values[column] ?? null]));
}

function plainInsert(db, schema, table, columns, row) {
  const placeholders = columns.map((column) => `@${column}`).join(', ');
  db.prepare(`INSERT INTO ${schema}.${table} (${columns.join(', ')}) VALUES (${placeholders})`)
    .run(row);
}

function testSerialBuilderIntegration() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'review-db-v3-'));
  try {
    const firstInput = path.join(temporary, 'first.ndjson');
    const secondInput = path.join(temporary, 'second.ndjson');
    const output = path.join(temporary, 'reviews.db');
    const firstBytes = Buffer.from(
      '{"business":{"placeId":"integration","name":"first"},'
      + '"detailedReviews":[{"review_id":"integration-review","review_text":"first",'
      + '"review_images":["https://example.invalid/one.jpg","https://example.invalid/two.jpg"]}]}\r\n',
    );
    const secondBytes = Buffer.from(
      '{"business":{"placeId":"integration","name":"second"},'
      + '"detailedReviews":[{"review_id":"integration-review","review_text":"second",'
      + '"review_images":["https://example.invalid/one.jpg"]}]}',
    );
    fs.writeFileSync(firstInput, firstBytes);
    fs.writeFileSync(secondInput, secondBytes);

    const build = spawnSync(process.execPath, [
      path.resolve(__dirname, '..', 'scripts', 'build-sqlite-db.js'),
      '--input', firstInput,
      '--input', secondInput,
      '--output', output,
      '--fresh',
      '--no-indexes',
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const built = new Database(output, { readonly: true, fileMustExist: true });
    assert.equal(built.prepare('SELECT name FROM businesses').pluck().get(), 'second');
    assert.equal(built.prepare('SELECT review_text FROM reviews').pluck().get(), 'second');
    assert.equal(built.prepare('SELECT COUNT(*) FROM review_images').pluck().get(), 1,
      'later input must remove image indexes no longer present');
    const businessRowid = built.prepare('SELECT rowid FROM businesses').pluck().get();
    const provenance = built.prepare(`
      SELECT run_id, input_index, input_path, input_sha256,
             builder_name, builder_version, schema_version
        FROM build_provenance ORDER BY input_index
    `).all();
    assert.equal(provenance.length, 2);
    assert.equal(provenance[0].run_id, provenance[1].run_id);
    assert.deepEqual(provenance.map((row) => row.input_index), [0, 1]);
    assert.deepEqual(provenance.map((row) => row.input_sha256), [
      crypto.createHash('sha256').update(firstBytes).digest('hex'),
      crypto.createHash('sha256').update(secondBytes).digest('hex'),
    ]);
    assert.deepEqual(provenance.map((row) => row.input_path), [
      fs.realpathSync(firstInput), fs.realpathSync(secondInput),
    ]);
    for (const row of provenance) {
      assert.equal(row.builder_name, 'build-sqlite-db');
      assert.equal(row.builder_version, BUILDER_VERSION);
      assert.equal(row.schema_version, SCHEMA_VERSION);
    }
    built.close();

    const rebuild = spawnSync(process.execPath, [
      path.resolve(__dirname, '..', 'scripts', 'build-sqlite-db.js'),
      '--input', secondInput,
      '--output', output,
      '--no-indexes',
    ], { encoding: 'utf8' });
    assert.equal(rebuild.status, 0, rebuild.stderr || rebuild.stdout);
    const rebuilt = new Database(output, { readonly: true, fileMustExist: true });
    assert.equal(rebuilt.prepare('SELECT rowid FROM businesses').pluck().get(), businessRowid);
    assert.equal(rebuilt.prepare('SELECT COUNT(*) FROM review_images').pluck().get(), 1,
      'non-fresh reruns must not duplicate review images');
    assert.equal(rebuilt.prepare('SELECT COUNT(*) FROM build_provenance').pluck().get(), 3,
      'a repeated input in a new run must append provenance history');
    rebuilt.close();
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);

  const upsertBusiness = db.prepare(businessValueUpsertSql());
  const upsertReview = db.prepare(reviewValueUpsertSql());
  const upsertImage = db.prepare(reviewImageValueUpsertSql());
  const business = (values) => completeRow(BUSINESS_COLUMNS, values);
  const review = (values) => completeRow(REVIEW_COLUMNS, values);

  upsertBusiness.run(business({
    place_id: 'p1', name: 'before', rating: 5,
    cleaned_at: 'local-clean', image_batch: 'local-batch',
  }));
  upsertReview.run(review({
    review_id: 'r1', place_id: 'p1', review_text: 'before', rating: 5,
    local_image_paths: '["local"]', review_images_scraped: '["scraped"]',
    extra: '{"old":true}', source: 'api', has_owner_response: 1,
  }));
  const businessRowid = db.prepare('SELECT rowid FROM businesses WHERE place_id = ?').pluck().get('p1');
  const reviewRowid = db.prepare('SELECT rowid FROM reviews WHERE review_id = ?').pluck().get('r1');

  db.exec(`
    CREATE TABLE audit (event TEXT NOT NULL);
    CREATE TRIGGER audit_business_insert AFTER INSERT ON businesses
      BEGIN INSERT INTO audit VALUES ('insert'); END;
    CREATE TRIGGER audit_business_update AFTER UPDATE ON businesses
      BEGIN INSERT INTO audit VALUES ('update'); END;
    CREATE TRIGGER audit_business_delete AFTER DELETE ON businesses
      BEGIN INSERT INTO audit VALUES ('delete'); END;
  `);

  upsertBusiness.run(business({ place_id: 'p1', name: 'after' }));
  upsertReview.run(review({
    review_id: 'r1', place_id: 'p1', review_text: 'after',
  }));

  const gotBusiness = db.prepare('SELECT rowid, * FROM businesses WHERE place_id = ?').get('p1');
  const gotReview = db.prepare('SELECT rowid, * FROM reviews WHERE review_id = ?').get('r1');
  assert.equal(gotBusiness.rowid, businessRowid, 'UPSERT must preserve business rowid');
  assert.equal(gotReview.rowid, reviewRowid, 'UPSERT must preserve review rowid');
  assert.equal(gotBusiness.name, 'after');
  assert.equal(gotBusiness.rating, null, 'authoritative source NULL must clear ordinary columns');
  assert.equal(gotBusiness.cleaned_at, 'local-clean');
  assert.equal(gotBusiness.image_batch, 'local-batch');
  assert.equal(gotReview.review_text, 'after');
  assert.equal(gotReview.rating, null);
  assert.equal(gotReview.local_image_paths, '["local"]');
  assert.equal(gotReview.review_images_scraped, '["scraped"]');
  assert.equal(gotReview.source, 'api');
  assert.equal(gotReview.has_owner_response, 1);
  assert.equal(gotReview.extra, null, 'source-backed extra must follow the latest snapshot');
  assert.equal(db.prepare("SELECT COUNT(*) FROM audit WHERE event = 'update'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM audit WHERE event = 'insert'").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM audit WHERE event = 'delete'").pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM reviews WHERE place_id = ?').pluck().get('p1'), 1,
    'updating a business must not break existing foreign-key children');

  upsertImage.run({
    review_id: 'r1', place_id: 'p1', image_index: 0,
    url: 'https://example.invalid/image.jpg', local_path: '/local/image.jpg', source: 'js',
  });
  const imageRowid = db.prepare('SELECT id FROM review_images').pluck().get();
  upsertImage.run({
    review_id: 'r1', place_id: 'p1', image_index: 0,
    url: 'https://example.invalid/image.jpg', local_path: null, source: 'js',
  });
  assert.deepEqual(
    db.prepare('SELECT id, local_path FROM review_images').get(),
    { id: imageRowid, local_path: '/local/image.jpg' },
    'same image URL must preserve its downloaded local path',
  );
  upsertImage.run({
    review_id: 'r1', place_id: 'p1', image_index: 0,
    url: 'https://example.invalid/replaced.jpg', local_path: null, source: 'js',
  });
  assert.deepEqual(
    db.prepare('SELECT id, url, local_path FROM review_images').get(),
    { id: imageRowid, url: 'https://example.invalid/replaced.jpg', local_path: null },
    'a changed URL must clear the stale local path without replacing the row',
  );

  upsertBusiness.run(business({
    place_id: 'p1', name: 'nonnull enrichment', cleaned_at: 'new-clean', image_batch: 'new-batch',
  }));
  upsertReview.run(review({
    review_id: 'r1', place_id: 'p1', review_text: 'nonnull enrichment',
    local_image_paths: '["new-local"]', review_images_scraped: '["new-scraped"]',
    source: 'new-source', has_owner_response: 0,
  }));
  assert.deepEqual(
    db.prepare('SELECT cleaned_at, image_batch FROM businesses WHERE place_id = ?').get('p1'),
    { cleaned_at: 'new-clean', image_batch: 'new-batch' },
  );
  assert.deepEqual(
    db.prepare(`SELECT local_image_paths, review_images_scraped, source, has_owner_response
                FROM reviews WHERE review_id = ?`).get('r1'),
    {
      local_image_paths: '["new-local"]',
      review_images_scraped: '["new-scraped"]',
      source: 'new-source',
      has_owner_response: 0,
    },
  );

  // Sequential duplicates are deterministic: the later source row wins.
  upsertBusiness.run(business({ place_id: 'ordered', name: 'first' }));
  upsertBusiness.run(business({ place_id: 'ordered', name: 'second' }));
  assert.equal(db.prepare('SELECT name FROM businesses WHERE place_id = ?').pluck().get('ordered'), 'second');

  // Exercise the sharded INSERT ... SELECT path, including SQLite's required
  // WHERE-clause disambiguation before ON CONFLICT.
  db.exec(`
    ATTACH DATABASE ':memory:' AS shard;
    CREATE TABLE shard.businesses AS SELECT * FROM main.businesses WHERE 0;
    CREATE TABLE shard.reviews AS SELECT * FROM main.reviews WHERE 0;
  `);
  plainInsert(db, 'shard', 'businesses', BUSINESS_COLUMNS,
    business({ place_id: 'p1', name: 'from shard' }));
  plainInsert(db, 'shard', 'reviews', REVIEW_COLUMNS,
    review({ review_id: 'r1', place_id: 'p1', review_text: 'from shard' }));
  db.exec(businessSelectUpsertSql('shard'));
  db.exec(reviewSelectUpsertSql('shard'));
  assert.equal(db.prepare('SELECT rowid FROM businesses WHERE place_id = ?').pluck().get('p1'), businessRowid);
  assert.equal(db.prepare('SELECT rowid FROM reviews WHERE review_id = ?').pluck().get('r1'), reviewRowid);
  assert.equal(db.prepare('SELECT name FROM businesses WHERE place_id = ?').pluck().get('p1'), 'from shard');
  assert.equal(db.prepare('SELECT review_text FROM reviews WHERE review_id = ?').pluck().get('r1'), 'from shard');
  assert.equal(db.prepare('SELECT cleaned_at FROM businesses WHERE place_id = ?').pluck().get('p1'), 'new-clean');
  assert.equal(db.prepare('SELECT source FROM reviews WHERE review_id = ?').pluck().get('r1'), 'new-source');

  const provenanceBase = {
    run_id: 'test-run', input_index: 0, input_path: '/fixture.ndjson',
    input_sha256: 'a'.repeat(64), input_size: 123, builder_name: 'test-builder',
    started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:01.000Z',
  };
  recordBuildProvenance(db, provenanceBase);
  assert.throws(
    () => recordBuildProvenance(db, { ...provenanceBase, input_sha256: 'b'.repeat(64) }),
    /UNIQUE constraint failed/,
    'completed provenance rows must be immutable audit history',
  );
  recordBuildProvenance(db, { ...provenanceBase, run_id: 'test-run-2' });
  const provenance = db.prepare(`
    SELECT run_id, input_index, input_sha256, builder_version, schema_version
      FROM build_provenance ORDER BY id
  `).all();
  assert.equal(provenance.length, 2, 'a new run retains independent history');
  assert.equal(provenance[0].input_sha256, 'a'.repeat(64));
  assert.equal(provenance[0].builder_version, BUILDER_VERSION);
  assert.equal(provenance[0].schema_version, SCHEMA_VERSION);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);

  db.close();

  // Databases created by the short-lived pre-v3 provenance prototype used a
  // content-identity UNIQUE key and had no input_index. Ensure schema startup
  // upgrades that shape without discarding its audit row.
  const legacy = new Database(':memory:');
  legacy.exec(`
    CREATE TABLE build_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      input_path TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      input_size INTEGER NOT NULL,
      builder_name TEXT NOT NULL,
      builder_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      UNIQUE(input_path, input_sha256, builder_name, builder_version)
    );
    INSERT INTO build_provenance
      (run_id, input_path, input_sha256, input_size, builder_name,
       builder_version, schema_version, started_at, completed_at)
    VALUES
      ('legacy-run', '/legacy.ndjson', '${'c'.repeat(64)}', 42,
       'legacy-builder', '2.9.0', 2,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
  `);
  ensureSchema(legacy);
  assert.deepEqual(
    legacy.prepare(`SELECT run_id, input_index, input_sha256
                      FROM build_provenance`).get(),
    { run_id: 'legacy-run', input_index: 0, input_sha256: 'c'.repeat(64) },
  );
  legacy.close();

  const legacyImages = new Database(':memory:');
  legacyImages.exec(`
    CREATE TABLE review_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL,
      place_id TEXT NOT NULL,
      image_index INTEGER,
      url TEXT,
      local_path TEXT,
      source TEXT
    );
    INSERT INTO review_images
      (review_id, place_id, image_index, url, local_path, source)
    VALUES
      ('legacy-review', 'legacy-place', 0, 'https://example.invalid/legacy.jpg', '/local/legacy.jpg', 'js'),
      ('legacy-review', 'legacy-place', 0, 'https://example.invalid/legacy.jpg', NULL, 'js');
  `);
  ensureSchema(legacyImages);
  assert.equal(hasReviewImageNaturalKey(legacyImages), false,
    'schema checks must not silently rewrite an existing image table');
  assert.deepEqual(
    ensureReviewImageNaturalKey(legacyImages),
    { migrated: true, duplicatesRemoved: 1 },
  );
  assert.equal(hasReviewImageNaturalKey(legacyImages), true);
  assert.deepEqual(
    legacyImages.prepare('SELECT id, local_path FROM review_images').get(),
    { id: 2, local_path: '/local/legacy.jpg' },
  );
  legacyImages.close();

  const future = new Database(':memory:');
  future.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(
    () => ensureSchema(future),
    /newer than supported/,
    'an older builder must not write into a future schema',
  );
  assert.equal(
    future.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'").pluck().get(),
    0,
  );
  future.close();

  testSerialBuilderIntegration();

  console.log('Review DB explicit UPSERT and provenance tests: passed');
}

main();
