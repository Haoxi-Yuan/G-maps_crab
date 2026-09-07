// Shared SQLite schema and NDJSON -> row mapping for the reviewer-profile
// databases. Mirrors the role review-db-schema.js plays for the review
// databases: this module is the single source of truth, and the builder and
// the verifier both consume it rather than restating column lists.
//
// Shape follows contracts/reviewer-profiles-ndjson-keys.v1.json. Scalars are
// promoted to columns so they are queryable; every nested structure that can
// still evolve (local_guide, contributions, review_details,
// structured_responses, business, ...) is retained verbatim as JSON, and any
// top-level key the contract does not name lands in extra_json instead of
// being dropped.
'use strict';

const SCHEMA_VERSION = 1;

const ACTIVITY_FIELDS = [
  'window_basis', 'is_full_history', 'reviews_in_window', 'reviews_with_timestamp',
  'window_newest_at', 'window_oldest_at', 'window_span_days', 'published_newest_at',
  'published_oldest_at', 'reviews_per_day', 'active_days', 'active_months',
  'reviews_per_active_day', 'median_gap_days', 'longest_gap_days',
  'days_since_last_review', 'edited_share',
];

const PROFILE_TOP_LEVEL_KNOWN = new Set([
  'extracted_at', 'reviewer_id', 'reviewer', 'public_content', 'activity',
  'completeness', 'source_summary', '_status', '_source', '_error', '_meta',
]);

const REVIEW_KNOWN = new Set([
  'review_id', 'rating', 'review_text', 'review_text_translated', 'language',
  'translated_language', 'published_at', 'published_at_date', 'edited_at_date',
  'last_modified_at', 'review_likes_count', 'reviewer', 'review_details',
  'structured_responses', 'review_images', 'owner_response', 'business',
]);

const SCHEMA = `
PRAGMA user_version = ${SCHEMA_VERSION};

CREATE TABLE IF NOT EXISTS build_provenance (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  built_at            TEXT NOT NULL,
  builder_version     TEXT NOT NULL,
  schema_version      INTEGER NOT NULL,
  host                TEXT,
  sources_json        TEXT,
  source_manifest_json TEXT,
  profiles_written    INTEGER,
  reviews_written     INTEGER,
  unresolved_written  INTEGER,
  duplicates_replaced INTEGER,
  elapsed_seconds     REAL
);

CREATE TABLE IF NOT EXISTS reviewer_profiles (
  reviewer_id                     TEXT PRIMARY KEY,
  origin_run                      TEXT NOT NULL,
  extracted_at                    TEXT,
  status                          TEXT,
  source                          TEXT,

  reviewer_name                   TEXT,
  reviewer_profile_url            TEXT,
  reviewer_avatar_url             TEXT,
  reviewer_bio                    TEXT,
  is_local_guide                  INTEGER,
  total_contribution_actions      INTEGER,
  contribution_summary_text       TEXT,
  local_guide_json                TEXT,
  contributions_json              TEXT,

  public_review_count             INTEGER,
  total_review_contributions      INTEGER,
  public_rating_count             INTEGER,
  total_rating_contributions      INTEGER,
  returned_review_count           INTEGER,
  returned_photo_count            INTEGER,

  is_complete                     INTEGER,
  stop_reason                     TEXT,
  visible_review_count            INTEGER,

  activity_window_basis           TEXT,
  activity_is_full_history        INTEGER,
  activity_reviews_in_window      INTEGER,
  activity_reviews_with_timestamp INTEGER,
  activity_window_newest_at       TEXT,
  activity_window_oldest_at       TEXT,
  activity_window_span_days       REAL,
  activity_published_newest_at    TEXT,
  activity_published_oldest_at    TEXT,
  activity_reviews_per_day        REAL,
  activity_active_days            INTEGER,
  activity_active_months          INTEGER,
  activity_reviews_per_active_day REAL,
  activity_median_gap_days        REAL,
  activity_longest_gap_days       REAL,
  activity_days_since_last_review REAL,
  activity_edited_share           REAL,

  source_summary_json             TEXT,
  meta_json                       TEXT,
  extra_json                      TEXT
);

CREATE TABLE IF NOT EXISTS reviewer_reviews (
  reviewer_id               TEXT NOT NULL,
  review_id                 TEXT NOT NULL,
  seq                       INTEGER NOT NULL,
  rating                    REAL,
  review_text               TEXT,
  review_text_translated    TEXT,
  language                  TEXT,
  translated_language       TEXT,
  published_at              TEXT,
  published_at_date         TEXT,
  edited_at_date            TEXT,
  last_modified_at          TEXT,
  review_likes_count        INTEGER,

  business_place_id         TEXT,
  business_name             TEXT,
  business_main_category    TEXT,
  business_json             TEXT,

  review_reviewer_json      TEXT,
  review_details_json       TEXT,
  structured_responses_json TEXT,
  review_images_json        TEXT,
  owner_response_json       TEXT,
  extra_json                TEXT,
  PRIMARY KEY (reviewer_id, review_id)
) WITHOUT ROWID;

-- Reviewers the scraper could not resolve after every retry. Kept so the
-- dataset accounts for its own gaps instead of leaving them implicit.
CREATE TABLE IF NOT EXISTS unresolved_reviewers (
  reviewer_id         TEXT PRIMARY KEY,
  origin_run          TEXT,
  last_status         TEXT,
  stop_reason         TEXT,
  reviewer_name       TEXT,
  reviewer_link       TEXT,
  last_extracted_at   TEXT,
  error_message       TEXT,
  source_summary_json TEXT
);
`;

// Built after the bulk load; creating them up front would slow every insert.
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_profiles_origin       ON reviewer_profiles(origin_run);
CREATE INDEX IF NOT EXISTS idx_profiles_stop_reason  ON reviewer_profiles(stop_reason);
CREATE INDEX IF NOT EXISTS idx_profiles_local_guide  ON reviewer_profiles(is_local_guide);
CREATE INDEX IF NOT EXISTS idx_profiles_public_count ON reviewer_profiles(public_review_count);
CREATE INDEX IF NOT EXISTS idx_reviews_business      ON reviewer_reviews(business_place_id);
CREATE INDEX IF NOT EXISTS idx_reviews_published     ON reviewer_reviews(published_at_date);
CREATE INDEX IF NOT EXISTS idx_reviews_review_id     ON reviewer_reviews(review_id);
`;

const PROFILE_COLUMNS = [
  'reviewer_id', 'origin_run', 'extracted_at', 'status', 'source',
  'reviewer_name', 'reviewer_profile_url', 'reviewer_avatar_url', 'reviewer_bio',
  'is_local_guide', 'total_contribution_actions', 'contribution_summary_text',
  'local_guide_json', 'contributions_json',
  'public_review_count', 'total_review_contributions', 'public_rating_count',
  'total_rating_contributions', 'returned_review_count', 'returned_photo_count',
  'is_complete', 'stop_reason', 'visible_review_count',
  ...ACTIVITY_FIELDS.map((f) => `activity_${f}`),
  'source_summary_json', 'meta_json', 'extra_json',
];

const REVIEW_COLUMNS = [
  'reviewer_id', 'review_id', 'seq', 'rating', 'review_text',
  'review_text_translated', 'language', 'translated_language', 'published_at',
  'published_at_date', 'edited_at_date', 'last_modified_at', 'review_likes_count',
  'business_place_id', 'business_name', 'business_main_category', 'business_json',
  'review_reviewer_json', 'review_details_json', 'structured_responses_json',
  'review_images_json', 'owner_response_json', 'extra_json',
];

const UNRESOLVED_COLUMNS = [
  'reviewer_id', 'origin_run', 'last_status', 'stop_reason', 'reviewer_name',
  'reviewer_link', 'last_extracted_at', 'error_message', 'source_summary_json',
];

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const bool = (v) => (v === undefined || v === null ? null : (v ? 1 : 0));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === 'string' ? v : (v === undefined || v === null ? null : String(v)));

function extras(obj, known) {
  if (!obj) return null;
  const rest = {};
  let any = false;
  for (const k of Object.keys(obj)) {
    if (known.has(k)) continue;
    rest[k] = obj[k];
    any = true;
  }
  return any ? JSON.stringify(rest) : null;
}

function profileRow(record, originRun) {
  const r = record.reviewer || {};
  const pc = record.public_content || {};
  const c = record.completeness || {};
  const a = record.activity || {};
  return [
    text(record.reviewer_id), originRun, text(record.extracted_at),
    text(record._status), text(record._source),
    text(r.reviewer_name), text(r.reviewer_profile_url), text(r.reviewer_avatar_url),
    text(r.reviewer_bio), bool(r.is_local_guide), num(r.total_contribution_actions),
    text(r.contribution_summary_text), json(r.local_guide), json(r.contributions),
    num(pc.public_review_count), num(pc.total_review_contributions),
    num(pc.public_rating_count), num(pc.total_rating_contributions),
    num(pc.returned_review_count), num(pc.returned_photo_count),
    bool(c.is_complete), text(c.stop_reason), num(c.visible_review_count),
    ...ACTIVITY_FIELDS.map((f) => {
      const v = a[f];
      if (typeof v === 'boolean') return bool(v);
      if (typeof v === 'number') return num(v);
      return text(v);
    }),
    json(record.source_summary), json(record._meta),
    extras(record, PROFILE_TOP_LEVEL_KNOWN),
  ];
}

function reviewRow(review, reviewerId, seq) {
  const b = review.business || {};
  return [
    reviewerId, text(review.review_id), seq, num(review.rating),
    text(review.review_text), text(review.review_text_translated),
    text(review.language), text(review.translated_language),
    text(review.published_at), text(review.published_at_date),
    text(review.edited_at_date), text(review.last_modified_at),
    num(review.review_likes_count),
    text(b.place_id), text(b.name), text(b.main_category), json(review.business),
    json(review.reviewer), json(review.review_details),
    json(review.structured_responses), json(review.review_images),
    json(review.owner_response), extras(review, REVIEW_KNOWN),
  ];
}

function unresolvedRow(record, originRun) {
  const s = record.source_summary || {};
  const c = record.completeness || {};
  return [
    text(record.reviewer_id), originRun, text(record._status), text(c.stop_reason),
    text(s.reviewer_name), text(s.reviewer_link), text(record.extracted_at),
    text(record._error), json(record.source_summary),
  ];
}

const placeholders = (cols) => cols.map(() => '?').join(', ');

module.exports = {
  SCHEMA_VERSION, SCHEMA, INDEXES,
  ACTIVITY_FIELDS,
  PROFILE_COLUMNS, REVIEW_COLUMNS, UNRESOLVED_COLUMNS,
  profileRow, reviewRow, unresolvedRow,
  placeholders,
};
