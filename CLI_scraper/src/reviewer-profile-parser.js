'use strict';

const CONTRIBUTION_KEYS = {
  1: 'reviews',
  2: 'ratings',
  3: 'photos',
  4: 'answers',
  5: 'places_added',
  6: 'edits',
  7: 'facts_checked',
  10: 'videos',
  12: 'q_and_a',
  15: 'roads_added',
  17: 'photo_captions',
  18: 'reported_incorrect',
};

// Convenience keys for the guided-dining question family. Google asks more
// question families than this (hotels, and whatever it adds next); every
// question is retained verbatim under structured_responses regardless, and
// scripts/analyze-structured-responses.js enumerates the observed universe.
const REVIEW_DETAIL_KEYS = {
  GUIDED_DINING_MODE: 'order_type',
  GUIDED_DINING_PRICE_RANGE: 'price_per_person',
  GUIDED_DINING_MEAL_TYPE: 'meal_type',
  GUIDED_DINING_GROUP_SIZE: 'group_size',
  GUIDED_DINING_WAIT_TIME: 'wait_time',
  GUIDED_DINING_FOOD_ASPECT: 'food_score',
  GUIDED_DINING_SERVICE_ASPECT: 'service_score',
  GUIDED_DINING_ATMOSPHERE_ASPECT: 'atmosphere_score',
  GUIDED_DINING_DISH_RECOMMENDATION: 'recommended_dishes',
  GUIDED_DINING_SEATING_TYPE: 'seating_type',
  GUIDED_DINING_NOISE_LEVEL: 'noise_level',
  GUIDED_DINING_RESERVATION: 'reservation',
  GUIDED_DINING_RECOMMEND_TO_VEGETARIANS: 'recommend_to_vegetarians',
  GUIDED_DINING_VEGETARIAN_OFFERINGS_INFO: 'vegetarian_offerings',
  GUIDED_DINING_PARKING_SPACE_AVAILABILITY: 'parking_space',
  GUIDED_DINING_PARKING_OPTIONS: 'parking_options',
  GUIDED_DINING_TIPS_TOPICS: 'tips_topics',
};

// Questions that accept several answers. Keeping them arrays even when one
// option came back stops downstream code from having to type-switch per row.
const ARRAY_DETAIL_KEYS = new Set(['recommended_dishes', 'tips_topics']);

const MILLISECONDS_PER_DAY = 86400000;

function stripXssiPrefix(text) {
  return String(text || '').replace(/^\)\]\}'\s*\n?/, '');
}

function parseMasRoot(text) {
  return JSON.parse(stripXssiPrefix(text));
}

// Large MAS replies encode protobuf field 46 as a sparse-object tail instead
// of materialising null slots through root[45]. Support both wire shapes.
function findPublicContent(root) {
  if (Array.isArray(root?.[45])) return root[45];
  for (const value of root || []) {
    if (value && !Array.isArray(value) && typeof value === 'object' && Array.isArray(value[46])) {
      return value[46];
    }
  }
  return null;
}

function toIso(microseconds) {
  return Number.isFinite(microseconds) && microseconds > 0
    ? new Date(microseconds / 1000).toISOString()
    : null;
}

function selectedOptions(question) {
  const options = [];
  for (const container of [question?.[2], question?.[3]]) {
    const candidate = container?.[0];
    if (!Array.isArray(candidate)) continue;
    const isOption = (row) => Array.isArray(row) && Array.isArray(row[0]) && typeof row[0][0] === 'string';
    const rows = isOption(candidate) ? [candidate] : candidate.filter(isOption);
    for (const row of rows) {
      options.push({
        id: row?.[0]?.[0] || null,
        label: row?.[1] || null,
        display_label: row?.[4] || row?.[1] || null,
      });
    }
  }
  return options;
}

function parseStructuredResponses(contentInfo) {
  const responses = [];
  const details = {};
  for (const key of Object.values(REVIEW_DETAIL_KEYS)) {
    details[key] = ARRAY_DETAIL_KEYS.has(key) ? [] : null;
  }

  for (const question of Array.isArray(contentInfo?.[6]) ? contentInfo[6] : []) {
    const id = question?.[0]?.[0] || null;
    const options = selectedOptions(question);
    const score = Number.isFinite(question?.[11]?.[0]) ? question[11][0] : null;
    const parsed = {
      id,
      question: question?.[1] || null,
      label: question?.[5] || null,
      score,
      selected_options: options,
    };
    responses.push(parsed);

    const detailKey = REVIEW_DETAIL_KEYS[id];
    if (!detailKey) continue;
    if (detailKey.endsWith('_score')) details[detailKey] = score;
    else if (ARRAY_DETAIL_KEYS.has(detailKey)) details[detailKey] = options.map((option) => option.display_label || option.label).filter(Boolean);
    else details[detailKey] = options.length <= 1 ? (options[0]?.display_label || null) : options.map((option) => option.display_label);
  }

  return { responses, details };
}

function parseReviewEntry(entry) {
  const review = entry?.[2] || [];
  const reviewerInfo = review[1] || [];
  const contentInfo = review[2] || [];
  const ownerResponse = review[3] || [];
  const reviewer = reviewerInfo?.[4]?.[5] || [];
  const place = entry?.[4] || [];
  const { responses, details } = parseStructuredResponses(contentInfo);

  const images = [];
  for (const media of Array.isArray(contentInfo[2]) ? contentInfo[2] : []) {
    const id = typeof media?.[0] === 'string' ? media[0] : null;
    const url = media?.[1]?.[6]?.[0] || null;
    if (id || url) images.push({ id, url });
  }

  return {
    review_id: review[0] || null,
    rating: contentInfo?.[0]?.[0] ?? null,
    review_text: contentInfo?.[15]?.[0]?.[0] || null,
    review_text_translated: contentInfo?.[15]?.[1]?.[0] || null,
    language: contentInfo?.[14]?.[0] || null,
    translated_language: contentInfo?.[14]?.[1] || null,
    published_at: reviewerInfo[6] || null,
    published_at_date: toIso(reviewerInfo[2]),
    edited_at_date: reviewerInfo[3] && reviewerInfo[3] !== reviewerInfo[2] ? toIso(reviewerInfo[3]) : null,
    // The service orders the window by this value, not by publication time.
    last_modified_at: toIso(Math.max(reviewerInfo[2] || 0, reviewerInfo[3] || 0)),
    review_likes_count: reviewerInfo[15] ?? 0,
    reviewer: {
      id: reviewer[3] || null,
      name: reviewer[0] || null,
      avatar_url: reviewer[1] || null,
      profile_url: reviewer?.[2]?.[0] || null,
      public_review_count: reviewer[5] ?? null,
      public_photo_count: reviewer[6] ?? null,
      badge_data: reviewer[8] || null,
    },
    review_details: details,
    structured_responses: responses,
    review_images: images,
    owner_response: ownerResponse[1] ? {
      published_at: ownerResponse[3] || null,
      published_at_date: toIso(ownerResponse[1]),
      response_text: ownerResponse?.[14]?.[0]?.[0] || null,
      response_text_translated: ownerResponse?.[14]?.[1]?.[0] || null,
    } : null,
    business: {
      name: place[2] || null,
      full_address: place[3] || null,
      coordinates: {
        lat: place?.[0]?.[2] ?? null,
        lng: place?.[0]?.[3] ?? null,
      },
      categories: Array.isArray(place[4]) ? place[4] : [],
      category_ids: Array.isArray(place[24]) ? place[24].map((value) => value?.[0]).filter(Boolean) : [],
      main_category: place[19] || null,
      price_range: place[31] || null,
      place_id: place?.[14]?.[0] || null,
      google_id: place?.[14]?.[10] || null,
      chij_id: place[18] || null,
      timezone: place?.[13]?.[0] || null,
      locality: place[26] || null,
      country: place[27] || null,
      country_code: place[29] || null,
      neighborhood: place[32] || null,
      google_maps_url: place?.[17]?.[0] || null,
    },
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/**
 * Activity metrics over the returned review window.
 *
 * The service orders the window by last-modified time — max(published, edited)
 * descending — so an old review that was recently edited re-enters the window
 * ahead of newer untouched ones. Every metric here is therefore a property of
 * that window, not of the reviewer's lifetime, unless is_full_history is true
 * (the window covered the whole public review count and nothing was cut off).
 *
 * Raw quantities only. No composite index: any weighting of rate against
 * recency against persistence is an analytical choice for the consumer.
 */
function computeReviewerActivity(reviews, options = {}) {
  const nowMs = options.now == null ? Date.now() : new Date(options.now).getTime();
  const stamps = [];
  let editedCount = 0;

  for (const review of reviews) {
    if (review.edited_at_date) editedCount += 1;
    const modified = review.last_modified_at || review.published_at_date;
    if (modified) stamps.push(Date.parse(modified));
  }
  const usable = stamps.filter(Number.isFinite).sort((left, right) => right - left);

  const published = reviews
    .map((review) => review.published_at_date)
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((left, right) => right - left);

  const activity = {
    window_basis: 'last_modified_desc',
    is_full_history: options.isFullHistory === true,
    reviews_in_window: reviews.length,
    reviews_with_timestamp: usable.length,
    window_newest_at: null,
    window_oldest_at: null,
    window_span_days: null,
    published_newest_at: published.length ? new Date(published[0]).toISOString() : null,
    published_oldest_at: published.length ? new Date(published[published.length - 1]).toISOString() : null,
    reviews_per_day: null,
    active_days: null,
    active_months: null,
    reviews_per_active_day: null,
    median_gap_days: null,
    longest_gap_days: null,
    days_since_last_review: null,
    edited_share: reviews.length ? round(editedCount / reviews.length, 4) : null,
  };
  if (!usable.length) return activity;

  const newest = usable[0];
  const oldest = usable[usable.length - 1];
  activity.window_newest_at = new Date(newest).toISOString();
  activity.window_oldest_at = new Date(oldest).toISOString();
  activity.days_since_last_review = round(Math.max(0, nowMs - newest) / MILLISECONDS_PER_DAY, 2);

  const days = new Set();
  const months = new Set();
  for (const stamp of usable) {
    const iso = new Date(stamp).toISOString();
    days.add(iso.slice(0, 10));
    months.add(iso.slice(0, 7));
  }
  activity.active_days = days.size;
  activity.active_months = months.size;
  activity.reviews_per_active_day = round(usable.length / days.size, 4);

  const spanDays = (newest - oldest) / MILLISECONDS_PER_DAY;
  activity.window_span_days = round(spanDays, 2);
  // A single-day window has no meaningful rate denominator; leave it null
  // rather than dividing by zero or silently inflating the rate to the count.
  if (spanDays > 0) activity.reviews_per_day = round(usable.length / spanDays, 4);

  if (usable.length > 1) {
    const gaps = [];
    for (let index = 1; index < usable.length; index += 1) {
      gaps.push((usable[index - 1] - usable[index]) / MILLISECONDS_PER_DAY);
    }
    activity.median_gap_days = round(median(gaps), 4);
    activity.longest_gap_days = round(Math.max(...gaps), 4);
  }
  return activity;
}

function parseContributionStats(profile) {
  const stats = profile?.[8] || [];
  const contributionRows = Array.isArray(stats[0]) ? stats[0] : [];
  const contributions = {};
  for (const row of contributionRows) {
    const key = CONTRIBUTION_KEYS[row?.[0]] || `type_${row?.[0]}`;
    contributions[key] = {
      type_id: row?.[0] ?? null,
      label: row?.[6] || null,
      public_count: row?.[7] ?? null,
      total_count: row?.[9] ?? row?.[7] ?? null,
      display_text: row?.[10] || null,
    };
  }
  return { contributions, level: Array.isArray(stats[1]) ? stats[1] : [] };
}

function parseReviewerMasResponse(text, options = {}) {
  const root = parseMasRoot(text);
  const profile = root?.[16] || [];
  const { contributions, level } = parseContributionStats(profile);
  const publicContent = findPublicContent(root);
  const reviewEntries = Array.isArray(publicContent?.[0]) ? publicContent[0] : [];
  const currentLevel = level[1] ?? null;
  const isLocalGuide = Number.isFinite(currentLevel) && currentLevel > 0;
  const points = isLocalGuide ? (level[0] ?? null) : null;
  const currentMinimum = level[5] ?? null;
  const nextMinimum = level[6] ?? null;
  const progressPercent = [points, currentMinimum, nextMinimum].every(Number.isFinite) && nextMinimum > currentMinimum
    ? Math.round(100 * (points - currentMinimum) / (nextMinimum - currentMinimum))
    : (Number.isFinite(currentLevel) && currentLevel >= 10 ? 100 : null);

  const reviews = reviewEntries.map(parseReviewEntry);
  const publicReviewCount = contributions.reviews?.public_count ?? null;

  return {
    reviewer: {
      reviewer_id: profile[14] || options.reviewerId || null,
      reviewer_name: profile[0] || options.reviewerName || null,
      reviewer_profile_url: profile[14] ? `https://www.google.com/maps/contrib/${profile[14]}` : null,
      reviewer_avatar_url: profile?.[1]?.[6]?.[0] || null,
      reviewer_bio: profile[18] || null,
      is_local_guide: isLocalGuide,
      total_contribution_actions: level[9] ?? null,
      contribution_summary_text: profile?.[8]?.[2]?.[4] || null,
      local_guide: {
        level: currentLevel,
        points,
        current_level_min_points: currentMinimum,
        next_level_points: nextMinimum,
        points_to_next_level: Number.isFinite(points) && Number.isFinite(nextMinimum)
          ? Math.max(0, nextMinimum - points)
          : null,
        progress_percent: progressPercent,
        progress_text: level?.[12]?.[3]?.[0] || level?.[11] || null,
      },
      contributions,
    },
    public_content: {
      public_review_count: publicReviewCount,
      total_review_contributions: contributions.reviews?.total_count ?? null,
      public_rating_count: contributions.ratings?.public_count ?? null,
      total_rating_contributions: contributions.ratings?.total_count ?? null,
      returned_review_count: reviewEntries.length,
      returned_photo_count: root?.[22]?.[2] ?? null,
      reviews,
    },
    activity: computeReviewerActivity(reviews, {
      now: options.now,
      isFullHistory: Number.isFinite(publicReviewCount) && reviews.length >= publicReviewCount,
    }),
  };
}

function setReviewerMasPageSize(inputUrl, pageSize) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new Error('reviewer MAS page size must be an integer from 1 to 200');
  }
  const url = new URL(inputUrl);
  const pb = url.searchParams.get('pb');
  if (!pb) throw new Error('reviewer MAS URL has no pb parameter');
  // Only protobuf field 41's count governs how many reviews come back. The
  // "!4m1!3i<n>" field the page also carries selects image renditions per media
  // item: raising it changed neither the returned review count nor the parsed
  // media items on a media-heavy profile, only the payload (2.18 MB -> 3.02 MB
  // at 50 reviews). Leave it at whatever the page sent.
  if (!/!41m\d+!1i\d+(?=!|$)/.test(pb)) {
    throw new Error('reviewer MAS URL does not contain the expected review count field');
  }
  const withReviews = pb.replace(/!41m(\d+)!1i\d+(?=!|$)/, (match, tokens) => `!41m${tokens}!1i${pageSize}`);
  url.searchParams.set('pb', withReviews);
  return url.toString();
}

/**
 * Drop review media from the response. Verified on a media-heavy profile: 978
 * images over 50 reviews collapse to 0 while text, coordinates, place ids,
 * structured responses and owner responses are unchanged, and the payload
 * shrinks 2.26 MB -> 0.31 MB.
 */
function setReviewerMasMediaEnabled(inputUrl, enabled) {
  const url = new URL(inputUrl);
  const pb = url.searchParams.get('pb');
  if (!pb) throw new Error('reviewer MAS URL has no pb parameter');
  const block = pb.match(/!41m\d+!1i\d+.*$/)?.[0];
  if (!block) throw new Error('reviewer MAS URL does not contain the review request block');
  const replaced = block.replace(enabled ? '!5b0' : '!5b1', enabled ? '!5b1' : '!5b0');
  url.searchParams.set('pb', pb.replace(block, replaced));
  return url.toString();
}

module.exports = {
  ARRAY_DETAIL_KEYS,
  CONTRIBUTION_KEYS,
  REVIEW_DETAIL_KEYS,
  computeReviewerActivity,
  findPublicContent,
  parseMasRoot,
  setReviewerMasMediaEnabled,
  parseReviewerMasResponse,
  parseReviewEntry,
  parseStructuredResponses,
  setReviewerMasPageSize,
  stripXssiPrefix,
};
