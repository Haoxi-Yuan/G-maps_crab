#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { buildReviewerList, shardFor } = require('../scripts/build-reviewer-list-sqlite');
const {
  computeReviewerActivity,
  findPublicContent,
  parseReviewerMasResponse,
  setReviewerMasMediaEnabled,
  setReviewerMasPageSize,
} = require('../src/reviewer-profile-parser');
const {
  completenessFor,
  expansionPageSizes,
  extractReviewerList,
  extractReviewerListFromDatabase,
  reviewerIdFromLink,
} = require('../src/reviewer-profile-scraper');

function option(id, label, displayLabel = label) {
  const row = [];
  row[0] = [id];
  row[1] = label;
  row[4] = displayLabel;
  return row;
}

function question(id, label, selected = [], score = null) {
  const row = [];
  row[0] = [id];
  row[1] = label;
  row[2] = [selected, 1];
  row[5] = label;
  if (score != null) row[11] = [score];
  return row;
}

function fixtureRoot({ sparse = false } = {}) {
  const profile = [];
  profile[0] = 'Heavy Reviewer';
  profile[1] = [];
  profile[1][6] = ['https://example.test/avatar.jpg'];
  profile[8] = [[
    [1, null, null, null, null, null, 'Reviews', 1030, null, 1098, '1,098 reviews'],
    [3, null, null, null, null, null, 'Photos', 4849, null, 5145, '5,145 photos'],
  ], [24500, 8, null, null, null, 15000, 50000, null, null, null, null, 'level progress']];
  profile[14] = '116448453673911455728';
  profile[18] = 'Test profile biography';

  const reviewer = [];
  reviewer[0] = 'Heavy Reviewer';
  reviewer[1] = 'https://example.test/avatar.jpg';
  reviewer[2] = ['https://www.google.com/maps/contrib/116448453673911455728'];
  reviewer[3] = '116448453673911455728';
  reviewer[5] = 1030;
  reviewer[6] = 4849;

  const reviewerInfo = [];
  reviewerInfo[2] = 1700000000000000;
  reviewerInfo[3] = 1700000100000000;
  reviewerInfo[4] = [];
  reviewerInfo[4][5] = reviewer;
  reviewerInfo[6] = '2 years ago';
  reviewerInfo[15] = 12;

  const contentInfo = [];
  contentInfo[0] = [5];
  contentInfo[6] = [
    question('GUIDED_DINING_MODE', 'Service', [option('DINE_IN', 'Dine in')]),
    question('GUIDED_DINING_PRICE_RANGE', 'Price per person', [option('PRICE_20_30', '$20–30')]),
    question('GUIDED_DINING_MEAL_TYPE', 'Meal type', [option('DINNER', 'Dinner')]),
    question('GUIDED_DINING_FOOD_ASPECT', 'Food', [], 5),
    question('GUIDED_DINING_SERVICE_ASPECT', 'Service', [], 4),
    question('GUIDED_DINING_ATMOSPHERE_ASPECT', 'Atmosphere', [], 3),
    question('GUIDED_DINING_DISH_RECOMMENDATION', 'Recommended dishes', [
      option('DISH_1', 'Laksa'), option('DISH_2', 'Satay'),
    ]),
    question('GUIDED_DINING_SEATING_TYPE', 'Seating type', [option('E:DINING_SEATING_TYPE_OUTDOOR_PATIO', 'Outdoor patio')]),
    question('GUIDED_DINING_NOISE_LEVEL', 'Noise level', [option('E:DINING_NOISE_LEVEL_QUIET', 'Quiet, easy to talk')]),
    question('GUIDED_DINING_RESERVATION', 'Reservation', [option('E:RESERVATIONS_RECOMMENDED', 'Reservations recommended')]),
    question('HOTELS_VIBE', 'Hotel highlights', [option('E:HOTEL_VIBES_GREAT_VIEW', 'Great view')]),
  ];
  contentInfo[14] = ['en', 'zh-CN'];
  contentInfo[15] = [['Original review'], ['翻译后的评论']];

  const ownerResponse = [];
  ownerResponse[1] = 1700100000000000;
  ownerResponse[3] = 'a year ago';
  ownerResponse[14] = [['Thank you'], ['谢谢']];

  const review = [];
  review[0] = 'review-id-1';
  review[1] = reviewerInfo;
  review[2] = contentInfo;
  review[3] = ownerResponse;

  const place = [];
  place[0] = [];
  place[0][2] = 1.3521;
  place[0][3] = 103.8198;
  place[2] = 'Test Restaurant';
  place[3] = '1 Test Street, Singapore';
  place[4] = ['Restaurant', 'Cafe'];
  place[13] = ['Asia/Singapore'];
  place[14] = [];
  place[14][0] = 'place-id-1';
  place[14][10] = 'google-id-1';
  place[17] = ['https://maps.google.com/?cid=1'];
  place[18] = 'ChIJ-test';
  place[19] = 'Restaurant';
  place[24] = [['restaurant'], ['cafe']];
  place[26] = 'Singapore';
  place[27] = 'Singapore';
  place[29] = 'SG';
  place[31] = '$$';
  place[32] = 'Downtown';

  const entry = [];
  entry[2] = review;
  entry[4] = place;

  const root = [];
  root[16] = profile;
  if (sparse) root[17] = { 46: [[entry]] };
  else root[45] = [[entry]];
  return root;
}

function testParser() {
  for (const sparse of [false, true]) {
    const parsed = parseReviewerMasResponse(`)]}'\n${JSON.stringify(fixtureRoot({ sparse }))}`);
    assert.equal(parsed.reviewer.reviewer_id, '116448453673911455728');
    assert.equal(parsed.reviewer.reviewer_bio, 'Test profile biography');
    assert.equal(parsed.reviewer.local_guide.level, 8);
    assert.equal(parsed.reviewer.local_guide.points_to_next_level, 25500);
    assert.equal(parsed.reviewer.contributions.reviews.public_count, 1030);
    assert.equal(parsed.reviewer.contributions.reviews.total_count, 1098);
    assert.equal(parsed.public_content.returned_review_count, 1);
    const review = parsed.public_content.reviews[0];
    assert.equal(review.review_text, 'Original review');
    assert.equal(review.review_text_translated, '翻译后的评论');
    assert.equal(review.business.coordinates.lat, 1.3521);
    assert.equal(review.business.coordinates.lng, 103.8198);
    assert.equal(review.business.place_id, 'place-id-1');
    assert.equal(review.review_details.order_type, 'Dine in');
    assert.equal(review.review_details.price_per_person, '$20–30');
    assert.equal(review.review_details.food_score, 5);
    assert.equal(review.review_details.service_score, 4);
    assert.equal(review.review_details.atmosphere_score, 3);
    assert.deepEqual(review.review_details.recommended_dishes, ['Laksa', 'Satay']);
    assert.equal(review.review_details.seating_type, 'Outdoor patio');
    assert.equal(review.review_details.noise_level, 'Quiet, easy to talk');
    assert.equal(review.review_details.reservation, 'Reservations recommended');
    assert.equal(review.owner_response.response_text, 'Thank you');
    // Question families outside the dining convenience block still survive verbatim.
    const hotelQuestion = review.structured_responses.find((response) => response.id === 'HOTELS_VIBE');
    assert.equal(hotelQuestion.selected_options[0].display_label, 'Great view');
    assert.equal(review.review_details.hotel_vibe, undefined);
    // reviewerInfo[3] (edit time) is later than reviewerInfo[2] (publish time).
    assert.equal(review.last_modified_at, review.edited_at_date);
  }
  assert.equal(findPublicContent([]), null);
}

function testPageSizeRewrite() {
  const url = 'https://www.google.com/locationhistory/preview/mas?pb=!1m2!4m1!3i10!4b1!41m14!1i10!2m9!5b1!7m2!1m1!1e1';
  const rewritten = new URL(setReviewerMasPageSize(url, 200)).searchParams.get('pb');
  // Only field 41's count governs the review count. "!4m1!3i<n>" selects image
  // renditions per media item: raising it inflated the payload (2.18 MB ->
  // 3.02 MB at 50 reviews) without changing the returned reviews or media.
  assert.match(rewritten, /!4m1!3i10!/);
  assert.match(rewritten, /!41m14!1i200!/);
  assert.match(new URL(setReviewerMasPageSize(url, 10)).searchParams.get('pb'), /!41m14!1i10!/);
  assert.throws(() => setReviewerMasPageSize(url, 201), /1 to 200/);

  const withoutMedia = new URL(setReviewerMasMediaEnabled(url, false)).searchParams.get('pb');
  assert.match(withoutMedia, /!2m9!5b0!/);
  assert.equal(new URL(setReviewerMasMediaEnabled(url, true)).searchParams.get('pb'), new URL(url).searchParams.get('pb'));
  assert.throws(() => setReviewerMasMediaEnabled('https://www.google.com/locationhistory/preview/mas?pb=!1m2', false), /review request block/);
  assert.deepEqual(expansionPageSizes(200, 10), [200, 150, 100, 50, 25]);
  assert.deepEqual(expansionPageSizes(100, 10), [100, 50, 25]);
  assert.deepEqual(expansionPageSizes(5, 10), [5]);

  const profile = { public_content: { public_review_count: 1000, total_review_contributions: 1100, returned_review_count: 100 } };
  assert.equal(completenessFor(profile, 200, 100).stop_reason, 'service_cap');
  assert.equal(completenessFor(profile, 100, 100).stop_reason, 'requested_limit');
  const hidden = { public_content: { public_review_count: 0, total_review_contributions: 10, returned_review_count: 0 } };
  assert.deepEqual(completenessFor(hidden, 200, 0), {
    is_complete: false,
    stop_reason: 'private_or_hidden',
    visible_review_count: 0,
    returned_review_count: 0,
  });

  // A counter in the thousands with an empty list at every page size is hidden,
  // not capped: Google's own page says the reviews are not shown. Only call it
  // that once the fallback ladder has been walked, so one short reply stays
  // retryable instead of becoming a terminal state.
  const counterWithoutList = { public_content: { public_review_count: 4269, total_review_contributions: 4569, returned_review_count: 0 } };
  assert.equal(completenessFor(counterWithoutList, 200, 0, { exhaustedFallbacks: true }).stop_reason, 'private_or_hidden');
  assert.equal(completenessFor(counterWithoutList, 200, 0).stop_reason, 'response_shortfall');
}

function testActivityMetrics() {
  const review = (published, edited = null) => ({
    published_at_date: published,
    edited_at_date: edited,
    last_modified_at: edited && edited > published ? edited : published,
  });
  const activity = computeReviewerActivity([
    review('2026-08-20T00:00:00.000Z'),
    review('2026-08-20T12:00:00.000Z'),
    review('2020-01-01T00:00:00.000Z', '2026-08-18T00:00:00.000Z'),
    review('2026-08-10T00:00:00.000Z'),
  ], { now: '2026-08-22T00:00:00.000Z', isFullHistory: true });

  assert.equal(activity.window_basis, 'last_modified_desc');
  assert.equal(activity.is_full_history, true);
  assert.equal(activity.reviews_in_window, 4);
  assert.equal(activity.reviews_with_timestamp, 4);
  // The window runs on last-modified time, so the 2020 review enters at its
  // 2026-08-18 edit, not at its publication date.
  assert.equal(activity.window_newest_at, '2026-08-20T12:00:00.000Z');
  assert.equal(activity.window_oldest_at, '2026-08-10T00:00:00.000Z');
  assert.equal(activity.window_span_days, 10.5);
  // Publication extremes stay available separately.
  assert.equal(activity.published_oldest_at, '2020-01-01T00:00:00.000Z');
  assert.equal(activity.published_newest_at, '2026-08-20T12:00:00.000Z');
  assert.equal(activity.active_days, 3);
  assert.equal(activity.active_months, 1);
  assert.equal(activity.reviews_per_day, Number((4 / 10.5).toFixed(4)));
  assert.equal(activity.reviews_per_active_day, Number((4 / 3).toFixed(4)));
  // Gaps between last-modified stamps are 0.5, 2 and 8 days.
  assert.equal(activity.median_gap_days, 2);
  assert.equal(activity.longest_gap_days, 8);
  assert.equal(activity.days_since_last_review, 1.5);
  assert.equal(activity.edited_share, 0.25);

  const empty = computeReviewerActivity([], { now: '2026-08-22T00:00:00.000Z' });
  assert.equal(empty.reviews_in_window, 0);
  assert.equal(empty.window_span_days, null);
  assert.equal(empty.reviews_per_day, null);
  assert.equal(empty.edited_share, null);

  // A single-day window has no rate denominator; it must not report the count.
  const sameDay = computeReviewerActivity([review('2026-08-20T01:00:00.000Z')], { now: '2026-08-20T01:00:00.000Z' });
  assert.equal(sameDay.window_span_days, 0);
  assert.equal(sameDay.reviews_per_day, null);
  assert.equal(sameDay.reviews_per_active_day, 1);
}

async function testReviewerExtractionAndLegacyRecovery() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-parser-test-'));
  const file = path.join(directory, 'reviews.ndjson');
  const valid = {
    business: { placeId: 'place-a' },
    detailedReviews: [
      { reviewer_name: 'A', reviewer_link: 'https://www.google.com/maps/contrib/100031590000305067255/reviews', reviewer_review_count: 7 },
      { reviewer_name: 'External', reviewer_link: 'https://example.test/profile' },
    ],
  };
  const duplicate = {
    business: { placeId: 'place-b' },
    detailedReviews: [
      { reviewer_name: 'A Updated', reviewer_link: 'https://www.google.com/maps/contrib/100031590000305067255', reviewer_review_count: 9 },
    ],
  };
  const broken = JSON.stringify(duplicate).replace('A Updated', 'A\nUpdated').replace('\\n', '\n');
  fs.writeFileSync(file, `${JSON.stringify(valid)}\n${broken}\n`);
  try {
    const result = await extractReviewerList(file);
    assert.equal(result.reviewers.length, 1);
    assert.equal(result.reviewers[0].source_review_occurrences, 2);
    assert.equal(result.reviewers[0].source_place_count, 2);
    assert.equal(result.reviewers[0].observed_public_review_count, 9);
    assert.equal(result.stats.recoveredRecords, 1);
    assert.equal(result.stats.externalOrInvalidLinks, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(reviewerIdFromLink('https://www.google.com/maps/contrib/12345678/reviews'), '12345678');
  assert.equal(reviewerIdFromLink('https://example.test'), null);
}

function testDatabaseReviewerExtraction() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-db-test-'));
  const file = path.join(directory, 'reviews.db');
  const database = new Database(file);
  database.exec(`
    CREATE TABLE reviews (
      review_id TEXT PRIMARY KEY,
      place_id TEXT,
      reviewer_name TEXT,
      reviewer_link TEXT,
      reviewer_photo_count INTEGER,
      reviewer_review_count INTEGER,
      is_local_guide INTEGER
    )
  `);
  const insert = database.prepare('INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('r1', 'p1', 'Low', 'https://www.google.com/maps/contrib/11111111/reviews', 2, 3, 0);
  insert.run('r2', 'p2', 'High', 'https://www.google.com/maps/contrib/22222222/reviews', 20, 300, 1);
  insert.run('r3', 'p3', 'High', 'https://www.google.com/maps/contrib/22222222/reviews', 21, 301, 1);
  insert.run('r4', 'p4', 'External', 'https://example.test/user', 0, 999, 0);
  database.close();
  try {
    const result = extractReviewerListFromDatabase(file, { listLimit: 1, listOrder: 'review-count-desc' });
    assert.equal(result.reviewers.length, 1);
    assert.equal(result.reviewers[0].reviewer_id, '22222222');
    assert.equal(result.reviewers[0].observed_public_review_count, 301);
    assert.equal(result.reviewers[0].source_review_occurrences, 2);
    assert.equal(result.reviewers[0].source_place_count, 2);
    assert.equal(result.stats.reviewRecords, 4);
    const listFile = path.join(directory, 'reviewers.all.ndjson');
    const shardDir = path.join(directory, 'shards');
    const manifest = buildReviewerList(file, listFile, { shards: 2, shardDir });
    assert.equal(manifest.unique_google_reviewers, 2);
    assert.equal(manifest.shard_counts.reduce((sum, count) => sum + count, 0), 2);
    assert.equal(shardFor('22222222', 2), 0);
    assert.equal(fs.readFileSync(listFile, 'utf8').trim().split('\n').length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  testParser();
  testPageSizeRewrite();
  testActivityMetrics();
  await testReviewerExtractionAndLegacyRecovery();
  testDatabaseReviewerExtraction();
  console.log('Reviewer profile parser tests: passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
