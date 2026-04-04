/**
 * API Review Fetcher
 *
 * Extracts reviews via Google Maps' internal /maps/rpc/listugcposts API endpoint.
 * ~10x faster than DOM scrolling, no ~3000 cap, gets 100% of reviews.
 *
 * Usage (from Playwright page context):
 *   const fetcher = require('./api-review-fetcher');
 *   const { reviews, detectedCount } = await fetcher.fetchAllReviews(page, { maxReviews: 25000 });
 *
 * Requirements:
 *   - Page must have Reviews tab visible (two-step load completed)
 *   - Reviews tab must be clicked to trigger first API call
 */

'use strict';

/**
 * Fetch all reviews for the current place via API pagination.
 *
 * @param {import('playwright').Page} page - Playwright page with place loaded
 * @param {Object} opts
 * @param {number} [opts.maxReviews=25000] - Stop after this many reviews
 * @param {number} [opts.pageSize=20] - Reviews per API page (10 or 20, 50+ gets empty)
 * @param {number} [opts.delayMs=200] - Delay between API calls
 * @param {Function} [opts.onProgress] - Callback(count, total) for progress reporting
 * @param {Function} [opts.onFlush] - Callback(reviewsBatch) for incremental persistence
 * @param {number} [opts.flushEvery=100] - Flush every N reviews
 * @returns {Promise<{reviews: Array, detectedCount: number|null, error: string|null}>}
 */
async function fetchAllReviews(page, opts = {}) {
  const {
    maxReviews = 25000,
    pageSize = 20,
    delayMs = 200,
    reviewSort = 'newest',  // 'newest' gives deepest pagination
    onProgress = null,
    onFlush = null,
    flushEvery = 100,
  } = opts;

  // Step 1: Detect review count + capture listugcposts URL
  let capturedUrl = null;
  let detectedCount = null;

  // Listen for the API URL (any sort — we'll force the sort via regex later)
  const requestHandler = (req) => {
    if (req.url().includes('listugcposts')) capturedUrl = req.url(); // Keep updating (last = best)
  };
  page.on('request', requestHandler);

  // Detect review count from page (before tab click, while Overview is visible)
  detectedCount = await page.evaluate(() => {
    let best = 0;
    for (const el of document.querySelectorAll('[aria-label]')) {
      const m = (el.getAttribute('aria-label') || '').match(/^([\d,]+)\s+reviews?$/i);
      if (m) { const n = parseInt(m[1].replace(/\D/g, ''), 10); if (n > best && n < 1e7) best = n; }
    }
    for (const el of document.querySelectorAll('button, span')) {
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
      const m = own.match(/^([\d,]+)\s+reviews?$/i);
      if (m) { const n = parseInt(m[1].replace(/\D/g, ''), 10); if (n > best && n < 1e7) best = n; }
    }
    for (const el of document.querySelectorAll('button')) {
      for (const str of [el.getAttribute('aria-label') || '', el.textContent.trim()]) {
        const m = str.match(/More reviews\s*\(([\d,]+)\)/i);
        if (m) { const n = parseInt(m[1].replace(/\D/g, ''), 10); if (n > best && n < 1e7) best = n; }
      }
    }
    return best > 0 ? best : null;
  });

  // Click Reviews tab to trigger the first API call
  const tabClicked = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('button[role="tab"]'))
      .find(t => t.textContent.toLowerCase().includes('review'));
    if (t) { t.click(); return true; }
    return false;
  });

  if (!tabClicked) {
    page.off('request', requestHandler);
    return { reviews: [], detectedCount, error: 'reviews_tab_not_found' };
  }

  // Wait for API URL to be captured (tab click triggers it)
  for (let i = 0; i < 20 && !capturedUrl; i++) {
    await page.waitForTimeout(500);
  }
  page.off('request', requestHandler);

  if (!capturedUrl) {
    return { reviews: [], detectedCount, error: 'api_url_not_captured' };
  }

  // Step 2: Build the optimal URL — force pageSize and sort via regex
  // No need for UI sort switching — just modify the URL params directly.
  // Sort: !13m1!1eN (1=relevant, 2=newest, 3=highest, 4=lowest)
  // PageSize: !1iN
  // Pagination token: !2s (clear for first page)
  const sortNumMap = { 'newest': 2, 'relevant': 1, 'highest': 3, 'lowest': 4 };
  const sortNum = sortNumMap[reviewSort] || 2;
  const baseUrl = capturedUrl
    .replace(/!1i\d+/, '!1i' + pageSize)
    .replace(/!13m1!1e\d+/, '!13m1!1e' + sortNum)
    .replace(/!2s[^!]*/, '!2s'); // Clear pagination token for fresh start
  const effectiveMax = detectedCount ? Math.min(maxReviews, detectedCount) : maxReviews;

  // Step 3: Paginate
  const reviews = [];
  const seenIds = new Set();
  let nextToken = '';
  let pageNum = 0;
  let lastFlushAt = 0;
  let consecutiveEmpty = 0;
  const startTime = Date.now();

  while (reviews.length < effectiveMax) {
    const apiUrl = nextToken
      ? baseUrl.replace(/!2s[^!]*/, '!2s' + encodeURIComponent(nextToken))
      : baseUrl.replace(/!2s[^!]*/, '!2s');

    let pageReviews;
    try {
      const resp = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return { error: r.status };
        return { text: await r.text() };
      }, apiUrl);

      if (resp.error) {
        if (resp.error === 429) {
          // Rate limited — wait and retry
          await page.waitForTimeout(10000);
          continue;
        }
        break;
      }

      const data = JSON.parse(resp.text.replace(/^\)\]\}'\n/, ''));
      nextToken = data[1] || '';
      pageReviews = data[2] || [];
    } catch (e) {
      // Parse error or network error — stop
      break;
    }

    if (pageReviews.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
      await page.waitForTimeout(1000);
      continue;
    }

    // Track actual new reviews added (not just pageReviews.length)
    const reviewsBefore = reviews.length;

    // Extract review data
    for (const review of pageReviews) {
      if (reviews.length >= effectiveMax) break;
      try {
        const r = review[0];
        const id = r[0];
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const reviewerInfo = r[1] || [];
        const contentInfo = r[2] || [];

        // Timestamps: r[1][2] = created (microseconds), r[1][3] = edited (microseconds)
        const createdUs = reviewerInfo[2] || null;
        const editedUs = reviewerInfo[3] || null;
        const toISO = (us) => us && us > 1e12 ? new Date(us / 1000).toISOString() : null;

        // Extract photos
        const photos = [];
        const photoArray = contentInfo[2] || [];
        for (const photo of photoArray) {
          const url = photo?.[1]?.[6]?.[0];
          if (url && url.includes('googleusercontent') && !url.includes('/a-/') && !url.includes('/a/')) {
            photos.push(url);
          }
        }

        // Owner response: typically in r[3] or r[1][14] area
        let ownerResponse = null;
        if (r[3] && Array.isArray(r[3]) && r[3].length > 0) {
          // r[3] sometimes contains owner response as nested array with text
          try {
            const resp = r[3][0];
            if (typeof resp === 'string') ownerResponse = resp;
            else if (Array.isArray(resp) && typeof resp[0] === 'string') ownerResponse = resp[0];
          } catch (e) {}
        }

        reviews.push({
          review_id: id,
          rating: contentInfo[0]?.[0] || null,
          review_text: contentInfo[15]?.[0]?.[0] || null,
          published_at: reviewerInfo[6] || null,
          published_at_date: toISO(createdUs),
          edited_at_date: (editedUs && editedUs !== createdUs) ? toISO(editedUs) : null,
          _timestamp_us: createdUs ? { created: createdUs, edited: editedUs } : null,
          reviewer_name: reviewerInfo[4]?.[5]?.[0] || null,
          reviewer_link: reviewerInfo[4]?.[5]?.[2]?.[0] || null,
          reviewer_photo_count: reviewerInfo[4]?.[5]?.[6] || null,
          reviewer_review_count: reviewerInfo[4]?.[5]?.[5] || null,
          is_local_guide: !!(reviewerInfo[4]?.[5]?.[8]?.[0]),
          review_likes_count: reviewerInfo[15] || 0,
          response_from_owner_text: ownerResponse,
          response_from_owner_ago: null,
          review_images: photos.length > 0 ? photos : undefined,
          _source: 'api',
        });
      } catch (e) {
        // Skip malformed review
      }
    }

    // Check if this page actually added new reviews
    const newThisPage = reviews.length - reviewsBefore;
    if (newThisPage === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break; // 3 pages with no new unique reviews = done
    } else {
      consecutiveEmpty = 0;
    }

    pageNum++;

    // Progress callback
    if (onProgress && pageNum % 10 === 0) {
      onProgress(reviews.length, effectiveMax);
    }

    // Incremental flush
    if (onFlush && reviews.length - lastFlushAt >= flushEvery) {
      onFlush(reviews.slice(lastFlushAt));
      lastFlushAt = reviews.length;
    }

    // No more pages
    if (!nextToken) break;

    await page.waitForTimeout(delayMs);
  }

  // Final flush
  if (onFlush && reviews.length > lastFlushAt) {
    onFlush(reviews.slice(lastFlushAt));
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const withText = reviews.filter(r => r.review_text).length;

  return {
    reviews,
    detectedCount,
    withText,
    elapsed,
    pages: pageNum,
    error: null,
  };
}

module.exports = { fetchAllReviews };
