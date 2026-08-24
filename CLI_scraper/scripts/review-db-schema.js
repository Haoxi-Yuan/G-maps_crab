'use strict';

const fs = require('fs');
const crypto = require('crypto');

// Shared SQLite schema and NDJSON -> row mapping for the review databases.
// Keep new columns appended to the legacy column order so an upgraded database
// and a freshly-created database have the same physical layout.

const SCHEMA_VERSION = 3;
// Bump whenever builder mapping or conflict semantics change, even if the
// physical SQLite schema itself stays compatible.
const BUILDER_VERSION = '3.0.0';

const BUSINESS_COLUMNS = [
  'place_id', 'name', 'full_address', 'address', 'latitude', 'longitude',
  'rating', 'review_count', 'phone', 'website', 'plus_code', 'main_category',
  'categories', 'price_range', 'scraped_categories', 'opening_hours',
  'popular_times', 'about', 'metadata', 'source_url', 'extracted_at',
  'cleaned_at', 'merged_at', 'image_batch',
  'business_photos', 'chij_id', 'google_id', 'timezone', 'neighborhood',
  'identity_badges', 'owner_info', 'service_options', 'description',
  'source_meta', 'photo_categories', 'scrape_error', 'network_error',
  'is_placeholder', 'source_merged_at', 'business_extra', 'record_extra',
];

const REVIEW_COLUMNS = [
  'review_id', 'place_id', 'rating', 'review_text', 'published_at',
  'published_at_date', 'reviewer_name', 'reviewer_link',
  'reviewer_photo_count', 'reviewer_review_count', 'is_local_guide',
  'review_likes_count', 'response_from_owner_text',
  'response_from_owner_ago', 'edited_at_date', 'timestamp_us',
  'review_images_java', 'local_image_paths', 'extra',
  'review_images_scraped', 'source', 'has_owner_response',
];

const REVIEW_IMAGE_COLUMNS = [
  'review_id', 'place_id', 'image_index', 'url', 'local_path', 'source',
];

const CLEANUP_STALE_REVIEW_IMAGES_SQL = `
  DELETE FROM review_images
   WHERE source = 'js'
     AND (
       image_index IS NULL
       OR image_index < 0
       OR image_index >= COALESCE((
         SELECT CASE
                  WHEN json_valid(reviews.review_images_java)
                    THEN json_array_length(reviews.review_images_java)
                  ELSE 0
                END
           FROM reviews
          WHERE reviews.review_id = review_images.review_id
       ), 0)
     )
`;

const BUSINESS_PRESERVE_ON_NULL = new Set(['cleaned_at', 'image_batch']);
const REVIEW_PRESERVE_ON_NULL = new Set([
  // These are enrichment/compatibility columns rather than authoritative
  // fields in every historical NDJSON generation.  A legacy snapshot that
  // omits them must not erase values already added to the database.
  'local_image_paths', 'review_images_scraped', 'source', 'has_owner_response',
]);

const BUSINESS_ADDITIONAL_COLUMNS = {
  business_photos: 'TEXT',
  chij_id: 'TEXT',
  google_id: 'TEXT',
  timezone: 'TEXT',
  neighborhood: 'TEXT',
  identity_badges: 'TEXT',
  owner_info: 'TEXT',
  service_options: 'TEXT',
  description: 'TEXT',
  source_meta: 'TEXT',
  photo_categories: 'TEXT',
  scrape_error: 'TEXT',
  network_error: 'INTEGER',
  is_placeholder: 'INTEGER',
  source_merged_at: 'TEXT',
  business_extra: 'TEXT',
  record_extra: 'TEXT',
};

const REVIEW_ADDITIONAL_COLUMNS = {
  source: 'TEXT',
  has_owner_response: 'INTEGER',
};

const BUILD_PROVENANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS build_provenance (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                TEXT NOT NULL,
  input_index           INTEGER NOT NULL,
  input_path            TEXT NOT NULL,
  input_sha256          TEXT NOT NULL,
  input_size            INTEGER NOT NULL,
  input_mtime_ms        REAL,
  builder_name          TEXT NOT NULL,
  builder_version       TEXT NOT NULL,
  schema_version        INTEGER NOT NULL,
  started_at            TEXT NOT NULL,
  completed_at          TEXT NOT NULL,
  input_records         INTEGER,
  businesses_written    INTEGER,
  reviews_written       INTEGER,
  review_images_written INTEGER,
  parse_errors          INTEGER,
  notes                 TEXT,
  UNIQUE(run_id, input_index)
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  place_id           TEXT PRIMARY KEY,
  name               TEXT,
  full_address       TEXT,
  address            TEXT,
  latitude           REAL,
  longitude          REAL,
  rating             REAL,
  review_count       INTEGER,
  phone              TEXT,
  website            TEXT,
  plus_code          TEXT,
  main_category      TEXT,
  categories         TEXT,
  price_range        TEXT,
  scraped_categories TEXT,
  opening_hours      TEXT,
  popular_times      TEXT,
  about              TEXT,
  metadata           TEXT,
  source_url         TEXT,
  extracted_at       TEXT,
  cleaned_at         TEXT,
  merged_at          TEXT,
  image_batch        TEXT,
  business_photos    TEXT,
  chij_id             TEXT,
  google_id           TEXT,
  timezone            TEXT,
  neighborhood        TEXT,
  identity_badges     TEXT,
  owner_info          TEXT,
  service_options     TEXT,
  description         TEXT,
  source_meta         TEXT,
  photo_categories    TEXT,
  scrape_error        TEXT,
  network_error       INTEGER,
  is_placeholder      INTEGER,
  source_merged_at    TEXT,
  business_extra      TEXT,
  record_extra        TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  review_id                TEXT PRIMARY KEY,
  place_id                 TEXT NOT NULL REFERENCES businesses(place_id),
  rating                   INTEGER,
  review_text              TEXT,
  published_at             TEXT,
  published_at_date        TEXT,
  reviewer_name            TEXT,
  reviewer_link            TEXT,
  reviewer_photo_count     INTEGER,
  reviewer_review_count    INTEGER,
  is_local_guide           INTEGER,
  review_likes_count       INTEGER,
  response_from_owner_text TEXT,
  response_from_owner_ago  TEXT,
  edited_at_date           TEXT,
  timestamp_us             TEXT,
  review_images_java       TEXT,
  local_image_paths        TEXT,
  extra                    TEXT,
  review_images_scraped    TEXT,
  source                   TEXT,
  has_owner_response       INTEGER
);

CREATE TABLE IF NOT EXISTS review_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   TEXT NOT NULL,
  place_id    TEXT NOT NULL,
  image_index INTEGER,
  url         TEXT,
  local_path  TEXT,
  source      TEXT,
  UNIQUE(review_id, image_index, source)
);

${BUILD_PROVENANCE_SCHEMA}
`;

const VIEWS = `
CREATE VIEW IF NOT EXISTS business_photo_urls AS
SELECT b.place_id,
       CAST(p.key AS INTEGER) AS image_index,
       p.value AS url
FROM businesses AS b, json_each(b.business_photos) AS p
WHERE b.business_photos IS NOT NULL;

CREATE VIEW IF NOT EXISTS photo_category_images AS
SELECT b.place_id,
       CAST(c.key AS INTEGER) AS category_index,
       json_extract(c.value, '$.key') AS category_key,
       json_extract(c.value, '$.label') AS category_label,
       json_extract(c.value, '$.totalCount') AS total_count,
       json_extract(c.value, '$.photoCount') AS photo_count,
       CAST(p.key AS INTEGER) AS image_index,
       json_extract(p.value, '$.id') AS photo_id,
       json_extract(p.value, '$.mediaType') AS media_type,
       json_extract(p.value, '$.url') AS url,
       json_extract(p.value, '$.w') AS width,
       json_extract(p.value, '$.h') AS height
FROM businesses AS b,
     json_each(b.photo_categories) AS c,
     json_each(json_extract(c.value, '$.photos')) AS p
WHERE b.photo_categories IS NOT NULL;
`;

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_reviews_place_id ON reviews(place_id)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(published_at_date)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_local_guide ON reviews(is_local_guide)',
  'CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(main_category)',
  'CREATE INDEX IF NOT EXISTS idx_businesses_rating ON businesses(rating)',
  'CREATE INDEX IF NOT EXISTS idx_businesses_lat_lng ON businesses(latitude, longitude)',
  'CREATE INDEX IF NOT EXISTS idx_review_images_review ON review_images(review_id)',
  'CREATE INDEX IF NOT EXISTS idx_review_images_place ON review_images(place_id)',
  'CREATE INDEX IF NOT EXISTS idx_build_provenance_sha256 ON build_provenance(input_sha256)',
];

const BUSINESS_SOURCE_KEYS = new Set([
  'placeId', 'name', 'fullAddress', 'address', 'latitude', 'longitude',
  'coordinates', 'rating', 'reviewCount', 'phone', 'website', 'plusCode',
  'mainCategory', 'categories', 'priceRange', 'categoryIds', 'photos',
  'chijId', 'googleId', 'timezone', 'neighborhood', 'identityBadges',
  'ownerInfo', 'serviceOptions', 'description',
]);

const RECORD_SOURCE_KEYS = new Set([
  'business', '_meta', 'openingHours', 'popularTimes', 'about', 'metadata',
  'sourceUrl', 'extractedAt', 'cleanedAt', 'mergedAt', 'imageBatch',
  'scraped_categories', 'detailedReviews', 'photoCategories', '_error',
  '_network_error', '_placeholder',
]);

const REVIEW_SOURCE_KEYS = new Set([
  'review_id', 'rating', 'review_text', 'published_at', 'published_at_date',
  'reviewer_name', 'reviewer_link', 'reviewer_photo_count',
  'reviewer_review_count', 'is_local_guide', 'review_likes_count',
  'response_from_owner_text', 'response_from_owner_ago', 'edited_at_date',
  '_timestamp_us', 'review_images', 'local_image_paths', 'extra',
  'review_images_scraped', '_source', 'has_owner_response',
]);

const jsonOrNull = (value) => (
  value === undefined || value === null ? null : JSON.stringify(value)
);

const emptyArrayToNull = (value) => (
  Array.isArray(value) && value.length === 0 ? null : value
);

const coerceBool = (value) => (
  value === true ? 1 : value === false ? 0 : value == null ? null : Number(value) ? 1 : 0
);

function scalarOrJson(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function unknownFields(obj, knownKeys) {
  const extra = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (!knownKeys.has(key)) extra[key] = value;
  }
  return Object.keys(extra).length ? extra : null;
}

function buildReviewExtra(rev) {
  const unknown = unknownFields(rev, REVIEW_SOURCE_KEYS);
  if (!unknown) return jsonOrNull(rev.extra);
  if (rev.extra === undefined) return JSON.stringify(unknown);
  return JSON.stringify({ _original_extra: rev.extra, _unmapped: unknown });
}

function buildBusinessRow(place, mergedAt) {
  const biz = place.business || {};
  const meta = place._meta || {};
  const placeId = biz.placeId || meta.placeId;
  if (!placeId) return null;

  return {
    place_id:             placeId,
    name:                 biz.name ?? null,
    full_address:         biz.fullAddress ?? null,
    address:              jsonOrNull(emptyArrayToNull(biz.address)),
    latitude:             biz.latitude ?? (biz.coordinates && biz.coordinates.lat) ?? null,
    longitude:            biz.longitude ?? (biz.coordinates && biz.coordinates.lng) ?? null,
    rating:               biz.rating ?? null,
    review_count:         biz.reviewCount ?? null,
    phone:                biz.phone ?? null,
    website:              biz.website ?? null,
    plus_code:            biz.plusCode ?? null,
    main_category:        biz.mainCategory ?? null,
    categories:           jsonOrNull(emptyArrayToNull(biz.categories)),
    price_range:          biz.priceRange ?? null,
    scraped_categories:   jsonOrNull(emptyArrayToNull(biz.categoryIds ?? place.scraped_categories)),
    opening_hours:        jsonOrNull(place.openingHours),
    popular_times:        jsonOrNull(place.popularTimes),
    about:                jsonOrNull(place.about),
    metadata:             jsonOrNull(place.metadata),
    source_url:           place.sourceUrl ?? meta.sourceUrl ?? null,
    extracted_at:         place.extractedAt ?? null,
    cleaned_at:           place.cleanedAt ?? null,
    merged_at:            mergedAt,
    image_batch:          place.imageBatch ?? null,
    business_photos:      jsonOrNull(biz.photos),
    chij_id:              biz.chijId ?? meta.chijId ?? null,
    google_id:            biz.googleId ?? meta.googleId ?? null,
    timezone:             biz.timezone ?? meta.timezone ?? null,
    neighborhood:         biz.neighborhood ?? meta.neighborhood ?? null,
    identity_badges:      jsonOrNull(biz.identityBadges),
    owner_info:           jsonOrNull(biz.ownerInfo),
    service_options:      jsonOrNull(biz.serviceOptions),
    description:          scalarOrJson(biz.description),
    source_meta:          jsonOrNull(place._meta),
    photo_categories:     jsonOrNull(place.photoCategories),
    scrape_error:         scalarOrJson(place._error),
    network_error:        coerceBool(place._network_error),
    is_placeholder:       coerceBool(place._placeholder),
    source_merged_at:     place.mergedAt ?? null,
    business_extra:       jsonOrNull(unknownFields(biz, BUSINESS_SOURCE_KEYS)),
    record_extra:         jsonOrNull(unknownFields(place, RECORD_SOURCE_KEYS)),
  };
}

function buildReviewRow(rev, placeId) {
  const reviewId = rev.review_id;
  if (!reviewId) return null;
  return {
    review_id:                reviewId,
    place_id:                 placeId,
    rating:                   rev.rating ?? null,
    review_text:              rev.review_text ?? null,
    published_at:            rev.published_at ?? null,
    published_at_date:       rev.published_at_date ?? null,
    reviewer_name:           rev.reviewer_name ?? null,
    reviewer_link:           rev.reviewer_link ?? null,
    reviewer_photo_count:    rev.reviewer_photo_count ?? null,
    reviewer_review_count:   rev.reviewer_review_count ?? null,
    is_local_guide:          coerceBool(rev.is_local_guide),
    review_likes_count:      rev.review_likes_count ?? null,
    response_from_owner_text:rev.response_from_owner_text ?? null,
    response_from_owner_ago: rev.response_from_owner_ago ?? null,
    edited_at_date:          rev.edited_at_date ?? null,
    timestamp_us:            jsonOrNull(rev._timestamp_us),
    review_images_java:      jsonOrNull(emptyArrayToNull(rev.review_images)),
    local_image_paths:       jsonOrNull(emptyArrayToNull(rev.local_image_paths)),
    extra:                   buildReviewExtra(rev),
    review_images_scraped:   jsonOrNull(emptyArrayToNull(rev.review_images_scraped)),
    source:                  rev._source ?? null,
    has_owner_response:      coerceBool(rev.has_owner_response),
  };
}

function upsertAssignments(table, columns, conflictColumn, preserveOnNull = new Set()) {
  return columns
    .filter((name) => name !== conflictColumn)
    .map((name) => {
      if (preserveOnNull.has(name)) {
        return `${name} = COALESCE(excluded.${name}, ${table}.${name})`;
      }
      return `${name} = excluded.${name}`;
    })
    .join(',\n      ');
}

function valueUpsertSql(table, columns, conflictColumn, preserveOnNull = new Set()) {
  return `
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${columns.map((name) => `@${name}`).join(', ')})
    ON CONFLICT(${conflictColumn}) DO UPDATE SET
      ${upsertAssignments(table, columns, conflictColumn, preserveOnNull)}
  `;
}

function selectUpsertSql(table, columns, conflictColumn, sourceSchema, preserveOnNull = new Set()) {
  return `
    INSERT INTO ${table} (${columns.join(', ')})
    SELECT ${columns.join(', ')} FROM ${sourceSchema}.${table} WHERE 1
    ON CONFLICT(${conflictColumn}) DO UPDATE SET
      ${upsertAssignments(table, columns, conflictColumn, preserveOnNull)}
  `;
}

function businessValueUpsertSql() {
  return valueUpsertSql('businesses', BUSINESS_COLUMNS, 'place_id', BUSINESS_PRESERVE_ON_NULL);
}

function reviewValueUpsertSql() {
  return valueUpsertSql('reviews', REVIEW_COLUMNS, 'review_id', REVIEW_PRESERVE_ON_NULL);
}

function businessSelectUpsertSql(sourceSchema = 's') {
  return selectUpsertSql(
    'businesses', BUSINESS_COLUMNS, 'place_id', sourceSchema, BUSINESS_PRESERVE_ON_NULL,
  );
}

function reviewSelectUpsertSql(sourceSchema = 's') {
  return selectUpsertSql(
    'reviews', REVIEW_COLUMNS, 'review_id', sourceSchema, REVIEW_PRESERVE_ON_NULL,
  );
}

function reviewImageUpsertAssignments() {
  return `
      place_id = excluded.place_id,
      url = excluded.url,
      local_path = CASE
        WHEN excluded.url IS review_images.url
          THEN COALESCE(excluded.local_path, review_images.local_path)
        ELSE excluded.local_path
      END
  `;
}

function reviewImageValueUpsertSql() {
  return `
    INSERT INTO review_images (${REVIEW_IMAGE_COLUMNS.join(', ')})
    VALUES (${REVIEW_IMAGE_COLUMNS.map((name) => `@${name}`).join(', ')})
    ON CONFLICT(review_id, image_index, source) DO UPDATE SET
      ${reviewImageUpsertAssignments()}
  `;
}

function reviewImageSelectUpsertSql(sourceSchema = 's') {
  return `
    INSERT INTO review_images (${REVIEW_IMAGE_COLUMNS.join(', ')})
    SELECT ${REVIEW_IMAGE_COLUMNS.join(', ')}
      FROM ${sourceSchema}.review_images WHERE 1
    ON CONFLICT(review_id, image_index, source) DO UPDATE SET
      ${reviewImageUpsertAssignments()}
  `;
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function addMissingColumns(db, table, definitions, overrides = {}) {
  const existing = tableColumns(db, table);
  for (const [name, baseDefinition] of Object.entries(definitions)) {
    if (existing.has(name)) continue;
    const definition = overrides[name] || baseDefinition;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function hasReviewImageNaturalKey(db) {
  for (const index of db.prepare('PRAGMA index_list(review_images)').all()) {
    if (!index.unique || index.partial) continue;
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`)
      .all()
      .map((row) => row.name);
    if (columns.join(',') === 'review_id,image_index,source') return true;
  }
  return false;
}

function ensureReviewImageNaturalKey(db) {
  if (hasReviewImageNaturalKey(db)) return { migrated: false, duplicatesRemoved: 0 };

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_review_images_dedup
        ON review_images(review_id, image_index, source, id);
    `);
    db.prepare(`
      UPDATE review_images AS keep
         SET local_path = (
           SELECT duplicate.local_path
             FROM review_images AS duplicate
            WHERE duplicate.review_id = keep.review_id
              AND duplicate.image_index IS keep.image_index
              AND duplicate.source = keep.source
              AND duplicate.url IS keep.url
              AND duplicate.local_path IS NOT NULL
            ORDER BY duplicate.id DESC
            LIMIT 1
         )
       WHERE keep.source IS NOT NULL
         AND keep.local_path IS NULL
         AND keep.id = (
           SELECT MAX(latest.id)
             FROM review_images AS latest
            WHERE latest.review_id = keep.review_id
              AND latest.image_index IS keep.image_index
              AND latest.source = keep.source
         )
         AND EXISTS (
           SELECT 1
             FROM review_images AS with_path
            WHERE with_path.review_id = keep.review_id
              AND with_path.image_index IS keep.image_index
              AND with_path.source = keep.source
              AND with_path.url IS keep.url
              AND with_path.local_path IS NOT NULL
         )
    `).run();
    const duplicatesRemoved = db.prepare(`
      DELETE FROM review_images
       WHERE source IS NOT NULL
         AND id <> (
           SELECT MAX(latest.id)
             FROM review_images AS latest
            WHERE latest.review_id = review_images.review_id
              AND latest.image_index IS review_images.image_index
              AND latest.source = review_images.source
         )
    `).run().changes;
    db.exec(`
      DROP INDEX idx_review_images_dedup;
      CREATE UNIQUE INDEX uq_review_images_natural_v3
        ON review_images(review_id, image_index, source);
    `);
    return duplicatesRemoved;
  });
  const duplicatesRemoved = migrate();
  if (!hasReviewImageNaturalKey(db)) {
    throw new Error('Failed to create the review_images natural-key constraint');
  }
  return { migrated: true, duplicatesRemoved };
}

function migrateLegacyBuildProvenance(db) {
  const columns = tableColumns(db, 'build_provenance');
  if (columns.has('input_index')) return;

  const migrate = db.transaction(() => {
    const rows = db.prepare('SELECT * FROM build_provenance ORDER BY id').all();
    db.exec('DROP INDEX IF EXISTS idx_build_provenance_sha256');
    db.exec('ALTER TABLE build_provenance RENAME TO build_provenance_legacy');
    db.exec(BUILD_PROVENANCE_SCHEMA);

    const nextIndex = new Map();
    for (const row of rows) {
      const runId = row.run_id || crypto.randomUUID();
      const inputIndex = nextIndex.get(runId) || 0;
      nextIndex.set(runId, inputIndex + 1);
      recordBuildProvenance(db, {
        ...row,
        run_id: runId,
        input_index: inputIndex,
      });
    }
    db.exec('DROP TABLE build_provenance_legacy');
    db.exec('CREATE INDEX IF NOT EXISTS idx_build_provenance_sha256 ON build_provenance(input_sha256)');
  });
  migrate();
}

function ensureSchema(db, options = {}) {
  const currentVersion = db.pragma('user_version', { simple: true });
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `Database schema user_version=${currentVersion} is newer than supported version ${SCHEMA_VERSION}`
    );
  }
  db.exec(SCHEMA);
  migrateLegacyBuildProvenance(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_build_provenance_sha256 ON build_provenance(input_sha256)');
  const reviewOverrides = {};
  if (options.reviewSourceDefault !== undefined && options.reviewSourceDefault !== null) {
    reviewOverrides.source = `TEXT DEFAULT ${quoteSqlString(options.reviewSourceDefault)}`;
  }
  addMissingColumns(db, 'businesses', BUSINESS_ADDITIONAL_COLUMNS);
  addMissingColumns(db, 'reviews', REVIEW_ADDITIONAL_COLUMNS, reviewOverrides);
  db.exec(VIEWS);
  if (currentVersion < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function recordBuildProvenance(db, row) {
  const data = {
    run_id: row.run_id || crypto.randomUUID(),
    input_index: row.input_index ?? 0,
    input_path: row.input_path,
    input_sha256: row.input_sha256,
    input_size: row.input_size,
    input_mtime_ms: row.input_mtime_ms ?? null,
    builder_name: row.builder_name,
    builder_version: row.builder_version || BUILDER_VERSION,
    schema_version: row.schema_version || SCHEMA_VERSION,
    started_at: row.started_at,
    completed_at: row.completed_at,
    input_records: row.input_records ?? null,
    businesses_written: row.businesses_written ?? null,
    reviews_written: row.reviews_written ?? null,
    review_images_written: row.review_images_written ?? null,
    parse_errors: row.parse_errors ?? 0,
    notes: row.notes ?? null,
  };
  if (!data.input_path || !data.input_sha256 || data.input_size == null
      || !data.builder_name || !data.started_at || !data.completed_at
      || !Number.isInteger(data.input_index) || data.input_index < 0
      || !/^[0-9a-f]{64}$/i.test(data.input_sha256)) {
    throw new Error('Incomplete build provenance row');
  }
  db.prepare(`
    INSERT INTO build_provenance
      (run_id, input_index, input_path, input_sha256, input_size, input_mtime_ms,
       builder_name, builder_version, schema_version, started_at, completed_at,
       input_records, businesses_written, reviews_written, review_images_written,
       parse_errors, notes)
    VALUES
      (@run_id, @input_index, @input_path, @input_sha256, @input_size, @input_mtime_ms,
       @builder_name, @builder_version, @schema_version, @started_at, @completed_at,
       @input_records, @businesses_written, @reviews_written, @review_images_written,
       @parse_errors, @notes)
  `).run(data);
  return data;
}

function hashFileSha256(filePath, options = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, {
      highWaterMark: options.highWaterMark || 8 * 1024 * 1024,
    });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = {
  SCHEMA_VERSION,
  BUILDER_VERSION,
  BUSINESS_COLUMNS,
  REVIEW_COLUMNS,
  REVIEW_IMAGE_COLUMNS,
  CLEANUP_STALE_REVIEW_IMAGES_SQL,
  BUSINESS_ADDITIONAL_COLUMNS,
  REVIEW_ADDITIONAL_COLUMNS,
  BUSINESS_PRESERVE_ON_NULL,
  REVIEW_PRESERVE_ON_NULL,
  SCHEMA,
  VIEWS,
  INDEXES,
  BUSINESS_SOURCE_KEYS,
  RECORD_SOURCE_KEYS,
  REVIEW_SOURCE_KEYS,
  jsonOrNull,
  emptyArrayToNull,
  coerceBool,
  scalarOrJson,
  unknownFields,
  buildBusinessRow,
  buildReviewRow,
  businessValueUpsertSql,
  reviewValueUpsertSql,
  businessSelectUpsertSql,
  reviewSelectUpsertSql,
  reviewImageValueUpsertSql,
  reviewImageSelectUpsertSql,
  hasReviewImageNaturalKey,
  ensureReviewImageNaturalKey,
  ensureSchema,
  tableColumns,
  recordBuildProvenance,
  hashFileSha256,
};
