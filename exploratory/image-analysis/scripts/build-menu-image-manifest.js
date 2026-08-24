#!/usr/bin/env node
'use strict';

/**
 * Build an incremental SQLite sidecar that maps downloaded menu images back to
 * their Google Maps POIs. The source review database is always opened read-only.
 *
 * The image URL hashing and relative paths intentionally match
 * scripts/export-photo-category-urls.js and scripts/bulk_image_downloader.py.
 *
 * Example:
 *   node scripts/build-menu-image-manifest.js \
 *     --db output/singapore/singapore_reviews_20260814.db \
 *     --out /data/haoxi/gmaps_images/manifests/sg_menu_full_20260814.db \
 *     --image-root /data/haoxi/gmaps_images \
 *     --list-name sg_menu_full_20260814 \
 *     --label Menu --size s0
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = '1';

function parseArgs(argv) {
  const args = { label: 'Menu', size: 's0', progressEvery: 25000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') args.db = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--image-root') args.imageRoot = argv[++i];
    else if (arg === '--list-name') args.listName = argv[++i];
    else if (arg === '--label') args.label = argv[++i];
    else if (arg === '--size') args.size = argv[++i];
    else if (arg === '--categories-like') args.categoriesLike = argv[++i];
    else if (arg === '--progress-every') args.progressEvery = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const required of ['db', 'out', 'imageRoot', 'listName']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!Number.isInteger(args.progressEvery) || args.progressEvery < 0) {
    throw new Error('--progress-every must be a non-negative integer');
  }
  return args;
}

function urlBase(url) {
  return url.includes('=') ? url.slice(0, url.lastIndexOf('=')) : url;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manifest_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS manifest_runs (
      run_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      status          TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
      source_db       TEXT NOT NULL,
      category_label  TEXT NOT NULL,
      requested_size  TEXT,
      list_name       TEXT NOT NULL,
      category_rows   INTEGER,
      photo_entries   INTEGER,
      videos_skipped  INTEGER,
      invalid_skipped INTEGER,
      poi_count       INTEGER,
      unique_images   INTEGER,
      source_links    INTEGER,
      short_id_collisions INTEGER,
      error_message   TEXT
    );

    CREATE TABLE IF NOT EXISTS pois (
      place_id          TEXT PRIMARY KEY,
      business_name     TEXT,
      main_category     TEXT,
      categories_json   TEXT,
      full_address      TEXT,
      address           TEXT,
      latitude          REAL,
      longitude         REAL,
      rating            REAL,
      review_count      INTEGER,
      price_range       TEXT,
      source_url        TEXT,
      first_seen_run_id INTEGER NOT NULL REFERENCES manifest_runs(run_id),
      last_seen_run_id  INTEGER NOT NULL REFERENCES manifest_runs(run_id),
      active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS images (
      image_id          TEXT PRIMARY KEY,
      short_id          TEXT NOT NULL,
      url_base          TEXT NOT NULL UNIQUE,
      requested_url     TEXT NOT NULL,
      relative_path     TEXT NOT NULL,
      local_path        TEXT NOT NULL,
      source_width      INTEGER,
      source_height     INTEGER,
      first_seen_run_id INTEGER NOT NULL REFERENCES manifest_runs(run_id),
      last_seen_run_id  INTEGER NOT NULL REFERENCES manifest_runs(run_id),
      active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      CHECK (length(image_id) = 64),
      CHECK (length(short_id) = 16)
    );

    CREATE TABLE IF NOT EXISTS image_sources (
      source_id         TEXT PRIMARY KEY,
      image_id          TEXT NOT NULL REFERENCES images(image_id),
      place_id          TEXT NOT NULL REFERENCES pois(place_id),
      photo_id          TEXT,
      media_type        TEXT,
      category_index    INTEGER NOT NULL,
      category_key      TEXT,
      category_label    TEXT NOT NULL,
      image_index       INTEGER NOT NULL,
      source_url        TEXT NOT NULL,
      source_width      INTEGER,
      source_height     INTEGER,
      first_seen_run_id INTEGER NOT NULL REFERENCES manifest_runs(run_id),
      last_seen_run_id  INTEGER NOT NULL REFERENCES manifest_runs(run_id),
      active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );

    CREATE VIEW IF NOT EXISTS current_poi_menu_images AS
    SELECT
      s.place_id,
      p.business_name,
      p.main_category,
      p.full_address,
      s.photo_id,
      s.category_key,
      s.category_label,
      s.category_index,
      s.image_index,
      i.image_id,
      i.short_id,
      i.requested_url,
      i.relative_path,
      i.local_path,
      COALESCE(s.source_width, i.source_width) AS source_width,
      COALESCE(s.source_height, i.source_height) AS source_height
    FROM image_sources s
    JOIN images i ON i.image_id = s.image_id
    JOIN pois p ON p.place_id = s.place_id
    WHERE s.active = 1 AND i.active = 1 AND p.active = 1;

    CREATE VIEW IF NOT EXISTS current_poi_image_counts AS
    SELECT
      place_id,
      business_name,
      COUNT(*) AS source_links,
      COUNT(DISTINCT image_id) AS unique_url_images
    FROM current_poi_menu_images
    GROUP BY place_id, business_name;
  `);
}

function createSecondaryIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_images_short_id ON images(short_id);
    CREATE INDEX IF NOT EXISTS idx_images_active ON images(active);
    CREATE INDEX IF NOT EXISTS idx_image_sources_image ON image_sources(image_id);
    CREATE INDEX IF NOT EXISTS idx_image_sources_place ON image_sources(place_id);
    CREATE INDEX IF NOT EXISTS idx_image_sources_photo ON image_sources(photo_id);
    CREATE INDEX IF NOT EXISTS idx_image_sources_active ON image_sources(active);
  `);
}

function setAndValidateMetadata(db, args) {
  const expected = {
    schema_version: SCHEMA_VERSION,
    source_db: path.resolve(args.db),
    category_label: args.label,
    list_name: args.listName,
  };
  const get = db.prepare('SELECT value FROM manifest_metadata WHERE key = ?');
  const put = db.prepare('INSERT INTO manifest_metadata(key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(expected)) {
    const existing = get.get(key);
    if (existing && existing.value !== value) {
      throw new Error(`Manifest metadata mismatch for ${key}: ${existing.value} != ${value}`);
    }
    if (!existing) put.run(key, value);
  }

  const mutable = {
    image_root: path.resolve(args.imageRoot),
    requested_size: args.size || '',
    updated_at: new Date().toISOString(),
  };
  const upsert = db.prepare(`
    INSERT INTO manifest_metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  for (const [key, value] of Object.entries(mutable)) upsert.run(key, value);
}

function buildManifest(args) {
  const sourcePath = path.resolve(args.db);
  const outputPath = path.resolve(args.out);
  const imageRoot = path.resolve(args.imageRoot);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const out = new Database(outputPath);
  source.pragma('query_only = ON');
  out.pragma('foreign_keys = ON');
  out.pragma('journal_mode = DELETE');
  out.pragma('synchronous = NORMAL');

  createSchema(out);
  setAndValidateMetadata(out, args);
  const freshManifest = out.prepare('SELECT COUNT(*) = 0 AS empty FROM images').get().empty === 1;

  const startedAt = new Date().toISOString();
  const runId = out.prepare(`
    INSERT INTO manifest_runs(
      started_at, status, source_db, category_label, requested_size, list_name
    ) VALUES (?, 'running', ?, ?, ?, ?)
  `).run(startedAt, sourcePath, args.label, args.size || null, args.listName).lastInsertRowid;

  let where = "b.photo_categories IS NOT NULL AND json_extract(c.value, '$.label') = ?";
  const params = [args.label];
  if (args.categoriesLike) {
    const terms = args.categoriesLike.split(',').map((term) => term.trim()).filter(Boolean);
    if (terms.length) {
      where += ` AND (${terms.map(() => 'lower(b.main_category) LIKE ?').join(' OR ')})`;
      params.push(...terms.map((term) => `%${term.toLowerCase()}%`));
    }
  }

  const rows = source.prepare(`
    SELECT
      b.place_id,
      b.name AS business_name,
      b.main_category,
      b.categories AS categories_json,
      b.full_address,
      b.address,
      b.latitude,
      b.longitude,
      b.rating,
      b.review_count,
      b.price_range,
      b.source_url AS business_source_url,
      CAST(c.key AS INTEGER) AS category_index,
      c.value AS category_json
    FROM businesses b, json_each(b.photo_categories) c
    WHERE ${where}
  `).iterate(...params);

  const upsertPoi = out.prepare(`
    INSERT INTO pois(
      place_id, business_name, main_category, categories_json, full_address,
      address, latitude, longitude, rating, review_count, price_range,
      source_url, first_seen_run_id, last_seen_run_id, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(place_id) DO UPDATE SET
      business_name = excluded.business_name,
      main_category = excluded.main_category,
      categories_json = excluded.categories_json,
      full_address = excluded.full_address,
      address = excluded.address,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      rating = excluded.rating,
      review_count = excluded.review_count,
      price_range = excluded.price_range,
      source_url = excluded.source_url,
      last_seen_run_id = excluded.last_seen_run_id,
      active = 1
  `);
  const upsertImage = out.prepare(`
    INSERT INTO images(
      image_id, short_id, url_base, requested_url, relative_path, local_path,
      source_width, source_height, first_seen_run_id, last_seen_run_id, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(image_id) DO UPDATE SET
      requested_url = excluded.requested_url,
      relative_path = excluded.relative_path,
      local_path = excluded.local_path,
      source_width = COALESCE(excluded.source_width, images.source_width),
      source_height = COALESCE(excluded.source_height, images.source_height),
      last_seen_run_id = excluded.last_seen_run_id,
      active = 1
  `);
  const upsertSource = out.prepare(`
    INSERT INTO image_sources(
      source_id, image_id, place_id, photo_id, media_type, category_index,
      category_key, category_label, image_index, source_url, source_width,
      source_height, first_seen_run_id, last_seen_run_id, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(source_id) DO UPDATE SET
      image_id = excluded.image_id,
      photo_id = excluded.photo_id,
      media_type = excluded.media_type,
      category_key = excluded.category_key,
      category_label = excluded.category_label,
      source_url = excluded.source_url,
      source_width = excluded.source_width,
      source_height = excluded.source_height,
      last_seen_run_id = excluded.last_seen_run_id,
      active = 1
  `);

  const stats = {
    categoryRows: 0,
    photoEntries: 0,
    videosSkipped: 0,
    invalidSkipped: 0,
  };
  const seenPois = new Set();
  let nextProgress = args.progressEvery;

  const sync = out.transaction(() => {
    for (const row of rows) {
      stats.categoryRows++;
      let category;
      try {
        category = JSON.parse(row.category_json);
      } catch {
        stats.invalidSkipped++;
        continue;
      }

      const photos = Array.isArray(category.photos) ? category.photos : [];
      for (let imageIndex = 0; imageIndex < photos.length; imageIndex++) {
        const photo = photos[imageIndex];
        if (!photo || photo.mediaType === 'video') {
          if (photo && photo.mediaType === 'video') stats.videosSkipped++;
          else stats.invalidSkipped++;
          continue;
        }
        if (typeof photo.url !== 'string' || !photo.url) {
          stats.invalidSkipped++;
          continue;
        }
        stats.photoEntries++;
        if (args.progressEvery && stats.photoEntries >= nextProgress) {
          console.error(JSON.stringify({
            event: 'manifest_progress',
            runId: Number(runId),
            photoEntries: stats.photoEntries,
            categoryRows: stats.categoryRows,
            poisSeen: seenPois.size,
          }));
          nextProgress += args.progressEvery;
        }

        if (!seenPois.has(row.place_id)) {
          upsertPoi.run(
            row.place_id, row.business_name, row.main_category, row.categories_json,
            row.full_address, row.address, row.latitude, row.longitude, row.rating,
            row.review_count, row.price_range, row.business_source_url, runId, runId,
          );
          seenPois.add(row.place_id);
        }

        const base = urlBase(photo.url);
        const imageId = sha256(base);
        const shortId = imageId.slice(0, 16);
        const relativePath = path.posix.join(
          args.listName, shortId.slice(0, 2), shortId.slice(2, 4), `${shortId}.jpg`,
        );
        const requestedUrl = args.size ? `${base}=${args.size}` : photo.url;
        const width = asFiniteNumber(photo.w ?? photo.width);
        const height = asFiniteNumber(photo.h ?? photo.height);
        upsertImage.run(
          imageId, shortId, base, requestedUrl, relativePath,
          path.join(imageRoot, ...relativePath.split('/')), width, height, runId, runId,
        );

        const photoId = photo.id == null ? null : String(photo.id);
        const sourceId = sha256([
          row.place_id,
          row.category_index,
          photoId || '',
          imageIndex,
          base,
        ].join('\0'));
        upsertSource.run(
          sourceId, imageId, row.place_id, photoId, photo.mediaType || 'photo',
          row.category_index, category.key == null ? null : String(category.key),
          category.label || args.label, imageIndex, photo.url, width, height, runId, runId,
        );
      }
    }

    console.error(JSON.stringify({
      event: 'manifest_stage', runId: Number(runId), stage: 'secondary_indexes', status: 'start',
    }));
    // Secondary indexes are much cheaper to build once than to maintain for
    // every row during a first full import. Existing incremental manifests keep
    // their indexes and CREATE INDEX IF NOT EXISTS is a no-op.
    createSecondaryIndexes(out);
    console.error(JSON.stringify({
      event: 'manifest_stage', runId: Number(runId), stage: 'secondary_indexes', status: 'complete',
    }));

    if (freshManifest) {
      // Every row in a first build was inserted with active=1, so rewriting the
      // full tables would be redundant and exceptionally expensive on spinning
      // storage while the image downloader is active.
      console.error(JSON.stringify({
        event: 'manifest_stage', runId: Number(runId), stage: 'active_refresh', status: 'skipped_fresh_manifest',
      }));
    } else {
      console.error(JSON.stringify({
        event: 'manifest_stage', runId: Number(runId), stage: 'active_refresh', status: 'start',
      }));
      out.prepare('UPDATE image_sources SET active = (last_seen_run_id = ?)').run(runId);
      out.prepare(`
        UPDATE images SET active = EXISTS (
          SELECT 1 FROM image_sources s
          WHERE s.image_id = images.image_id AND s.active = 1
        )
      `).run();
      out.prepare(`
        UPDATE pois SET active = EXISTS (
          SELECT 1 FROM image_sources s
          WHERE s.place_id = pois.place_id AND s.active = 1
        )
      `).run();
      console.error(JSON.stringify({
        event: 'manifest_stage', runId: Number(runId), stage: 'active_refresh', status: 'complete',
      }));
    }

    console.error(JSON.stringify({
      event: 'manifest_stage', runId: Number(runId), stage: 'final_counts', status: 'start',
    }));
    const counts = out.prepare(`
      SELECT
        (SELECT COUNT(*) FROM pois WHERE active = 1) AS poi_count,
        (SELECT COUNT(*) FROM images WHERE active = 1) AS unique_images,
        (SELECT COUNT(*) FROM image_sources WHERE active = 1) AS source_links,
        (SELECT COUNT(*) FROM (
          SELECT short_id FROM images WHERE active = 1
          GROUP BY short_id HAVING COUNT(*) > 1
        )) AS short_id_collisions
    `).get();
    console.error(JSON.stringify({
      event: 'manifest_stage', runId: Number(runId), stage: 'final_counts', status: 'complete',
    }));

    out.prepare(`
      UPDATE manifest_runs SET
        finished_at = ?, status = 'complete', category_rows = ?, photo_entries = ?,
        videos_skipped = ?, invalid_skipped = ?, poi_count = ?, unique_images = ?,
        source_links = ?, short_id_collisions = ?
      WHERE run_id = ?
    `).run(
      new Date().toISOString(), stats.categoryRows, stats.photoEntries,
      stats.videosSkipped, stats.invalidSkipped, counts.poi_count,
      counts.unique_images, counts.source_links, counts.short_id_collisions, runId,
    );
    return counts;
  });

  try {
    const counts = sync();
    return {
      runId: Number(runId),
      sourceDb: sourcePath,
      manifestDb: outputPath,
      listName: args.listName,
      label: args.label,
      requestedSize: args.size || 'as-stored',
      ...stats,
      poiCount: counts.poi_count,
      uniqueImages: counts.unique_images,
      sourceLinks: counts.source_links,
      shortIdCollisions: counts.short_id_collisions,
    };
  } catch (error) {
    out.prepare(`
      UPDATE manifest_runs
      SET finished_at = ?, status = 'failed', error_message = ?
      WHERE run_id = ?
    `).run(new Date().toISOString(), String(error.message || error).slice(0, 2000), runId);
    throw error;
  } finally {
    source.close();
    out.close();
  }
}

function main() {
  const result = buildManifest(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result));
}

if (require.main === module) main();

module.exports = { buildManifest, parseArgs, sha256, urlBase };
