/**
 * On-disk cache for fresh Google Maps photo-category URLs.
 *
 * The permanent Google photo id is the key; signed/rotating image URLs are
 * merely the latest value.  The cache deliberately stays in a separate
 * SQLite file so refreshing URLs never mutates the review database.
 */

'use strict';

const Database = require('better-sqlite3');

const CACHE_SCHEMA_VERSION = 1;

const CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS photo_url_cache (
  photo_id       TEXT PRIMARY KEY NOT NULL,
  url            TEXT NOT NULL,
  place_id       TEXT,
  category_key   TEXT,
  category_label TEXT,
  media_type     TEXT,
  width          INTEGER,
  height         INTEGER,
  refreshed_at   TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'ListEntityPhotos'
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_photo_url_cache_place
  ON photo_url_cache(place_id);
CREATE INDEX IF NOT EXISTS idx_photo_url_cache_refreshed
  ON photo_url_cache(refreshed_at);

CREATE TABLE IF NOT EXISTS photo_url_refresh_runs (
  run_id          TEXT PRIMARY KEY NOT NULL,
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  status          TEXT NOT NULL,
  source_db       TEXT,
  selection_json  TEXT,
  stats_json      TEXT,
  error           TEXT
) WITHOUT ROWID;
`;

const UPSERT_SQL = `
INSERT INTO photo_url_cache (
  photo_id, url, place_id, category_key, category_label, media_type,
  width, height, refreshed_at, source
) VALUES (
  @photo_id, @url, @place_id, @category_key, @category_label, @media_type,
  @width, @height, @refreshed_at, @source
)
ON CONFLICT(photo_id) DO UPDATE SET
  url = excluded.url,
  place_id = coalesce(excluded.place_id, photo_url_cache.place_id),
  category_key = coalesce(excluded.category_key, photo_url_cache.category_key),
  category_label = coalesce(excluded.category_label, photo_url_cache.category_label),
  media_type = coalesce(excluded.media_type, photo_url_cache.media_type),
  width = coalesce(excluded.width, photo_url_cache.width),
  height = coalesce(excluded.height, photo_url_cache.height),
  refreshed_at = excluded.refreshed_at,
  source = excluded.source
`;

function ensureCacheSchema(db) {
  db.exec(CACHE_SCHEMA_SQL);
  const current = db.pragma('user_version', { simple: true });
  if (current > CACHE_SCHEMA_VERSION) {
    throw new Error(
      `photo URL cache schema ${current} is newer than supported ${CACHE_SCHEMA_VERSION}`,
    );
  }
  if (current < CACHE_SCHEMA_VERSION) db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`);
}

function validateCacheSchema(db) {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'photo_url_cache'
  `).get();
  if (!table) throw new Error('URL cache has no photo_url_cache table');
  const columns = new Set(db.prepare('PRAGMA table_info(photo_url_cache)').all().map((r) => r.name));
  for (const name of ['photo_id', 'url', 'refreshed_at', 'source']) {
    if (!columns.has(name)) throw new Error(`URL cache is missing ${name} column`);
  }
}

function openPhotoUrlCache(filePath, { readonly = false, fileMustExist = readonly } = {}) {
  const db = new Database(filePath, { readonly, fileMustExist });
  db.pragma('busy_timeout = 5000');
  if (readonly) {
    db.pragma('query_only = ON');
    validateCacheSchema(db);
  } else {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    ensureCacheSchema(db);
  }
  return db;
}

function normalizeCacheRow(row, fallbackTimestamp = new Date().toISOString()) {
  if (!row || typeof row.photo_id !== 'string' || !row.photo_id.trim()) {
    throw new Error('photo URL cache row requires photo_id');
  }
  if (!row.url || typeof row.url !== 'string') {
    throw new Error(`photo URL cache row ${row.photo_id} requires url`);
  }
  let parsed;
  try { parsed = new URL(row.url); } catch (error) {
    throw new Error(`photo URL cache row ${row.photo_id} has invalid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`photo URL cache row ${row.photo_id} requires an HTTPS URL`);
  }
  const integerOrNull = (value) => (
    Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null
  );
  return {
    photo_id: row.photo_id.trim(),
    url: row.url,
    place_id: row.place_id || null,
    category_key: row.category_key || null,
    category_label: row.category_label || null,
    media_type: row.media_type || null,
    width: integerOrNull(row.width),
    height: integerOrNull(row.height),
    refreshed_at: row.refreshed_at || fallbackTimestamp,
    source: row.source || 'ListEntityPhotos',
  };
}

function upsertPhotoUrls(db, rows, { refreshedAt = new Date().toISOString() } = {}) {
  const statement = db.prepare(UPSERT_SQL);
  const write = db.transaction((items) => {
    let count = 0;
    for (const row of items) {
      statement.run(normalizeCacheRow(row, refreshedAt));
      count++;
    }
    return count;
  });
  return write(rows);
}

function preparePhotoUrlLookup(db) {
  const statement = db.prepare(`
    SELECT photo_id, url, place_id, category_key, category_label, media_type,
           width, height, refreshed_at, source
      FROM photo_url_cache
     WHERE photo_id = ?
  `);
  return (photoId) => (photoId ? (statement.get(photoId) || null) : null);
}

function startRefreshRun(db, row) {
  db.prepare(`
    INSERT INTO photo_url_refresh_runs (
      run_id, started_at, status, source_db, selection_json
    ) VALUES (@run_id, @started_at, 'running', @source_db, @selection_json)
  `).run({
    run_id: row.run_id,
    started_at: row.started_at,
    source_db: row.source_db || null,
    selection_json: JSON.stringify(row.selection || {}),
  });
}

function finishRefreshRun(db, runId, { status, stats = null, error = null }) {
  db.prepare(`
    UPDATE photo_url_refresh_runs
       SET completed_at = @completed_at,
           status = @status,
           stats_json = @stats_json,
           error = @error
     WHERE run_id = @run_id
  `).run({
    run_id: runId,
    completed_at: new Date().toISOString(),
    status,
    stats_json: stats ? JSON.stringify(stats) : null,
    error: error ? String(error).slice(0, 1000) : null,
  });
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  CACHE_SCHEMA_SQL,
  ensureCacheSchema,
  validateCacheSchema,
  openPhotoUrlCache,
  normalizeCacheRow,
  upsertPhotoUrls,
  preparePhotoUrlLookup,
  startRefreshRun,
  finishRefreshRun,
};
