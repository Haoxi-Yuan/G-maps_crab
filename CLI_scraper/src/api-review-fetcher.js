/**
 * API Review Fetcher
 *
 * Extracts reviews via Google Maps' internal MapsUgcPostService.ListUgcPosts
 * RPC, served via the /maps/_/MapsWizUi/data/batchexecute gateway.
 *
 * (Google retired the old /maps/rpc/listugcposts GET endpoint; reviews now
 *  ride on the same batchexecute infrastructure used by other Maps RPCs.
 *  We capture one autonomous POST after the Reviews tab is clicked, then
 *  replay it with mutated pagination tokens.)
 *
 * Usage (from Playwright page context):
 *   const fetcher = require('./api-review-fetcher');
 *   const { reviews, detectedCount } = await fetcher.fetchAllReviews(page, { maxReviews: 25000 });
 *
 * Requirements:
 *   - Page must have Reviews tab visible (two-step load completed)
 *   - Reviews tab will be clicked to trigger first API call
 */

'use strict';

const REVIEW_RPC_ID = 'qv9Egd'; // MapsUgcPostService.ListUgcPosts

/**
 * Parse Google's chunked batchexecute response and return the inner data
 * for our service. Format on the wire:
 *   )]}'\n
 *   <len1>\n
 *   [["wrb.fr","<service>","<json-as-string>",null,null,null,"generic"], ...]\n
 *   <len2>\n
 *   [["e",...]]  <- sentinel
 *
 * Returns parsed inner JSON array for the requested RPC, or null.
 */
function parseBatchexecuteResponse(text, rpcServicePath = '/MapsUgcPostService.ListUgcPosts') {
  // Find the wrb.fr array by walking brackets — chunk lengths are byte-counted
  // and unreliable to skip past in JS string space, so we bypass them entirely.
  let pos = 0;
  while (pos < text.length) {
    const startIdx = text.indexOf('[["wrb.fr"', pos);
    if (startIdx < 0) return null;
    // Walk brackets to find matching close, respecting JSON string escapes
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = startIdx; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) return null;
    let envelope;
    try { envelope = JSON.parse(text.slice(startIdx, end)); }
    catch { pos = startIdx + 1; continue; }
    // envelope = [["wrb.fr","<service>","<inner-as-string>",null,null,null,"generic"], ...]
    for (const entry of envelope) {
      if (Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === rpcServicePath) {
        try { return JSON.parse(entry[2]); } catch { return null; }
      }
    }
    pos = end;
  }
  return null;
}

/**
 * Build a new POST body for the next pagination call by replacing the
 * [pageSize, token] tuple in the inner JSON at position [1].
 *
 * The original body is URL-encoded form data:
 *   f.req=<encoded-outer-json>&...
 * where outer-json = [[["<service>", "<inner-as-string>", null, "generic"]]]
 */
function buildPaginatedBody(originalBody, nextToken, pageSize) {
  const params = new URLSearchParams(originalBody);
  const freq = params.get('f.req');
  if (!freq) throw new Error('original body has no f.req');
  const outer = JSON.parse(freq);
  // outer = [[["<service>", "<inner-string>", null, "generic"]]]
  const inner = JSON.parse(outer[0][0][1]);
  // inner[1] = [pageSize, nextToken]
  inner[1] = [pageSize, nextToken || ''];
  outer[0][0][1] = JSON.stringify(inner);
  params.set('f.req', JSON.stringify(outer));
  return params.toString();
}

/**
 * Increment the _reqid URL param. Google clients typically bump by 100000
 * between calls; the server tolerates any monotonic value.
 */
function bumpReqId(url, step = 100000) {
  return url.replace(/([?&]_reqid=)(\d+)/, (_, p, n) => p + (parseInt(n, 10) + step));
}

/**
 * Fetch all reviews for the current place via API pagination.
 *
 * @param {import('playwright').Page} page - Playwright page with place loaded
 * @param {Object} opts
 * @param {number} [opts.maxReviews=25000] - Stop after this many reviews
 * @param {number} [opts.pageSize=10] - Reviews per API page (10 is Google's default; 20 also works)
 * @param {number} [opts.delayMs=200] - Delay between API calls
 * @param {Function} [opts.onProgress] - Callback(count, total) for progress reporting
 * @param {Function} [opts.onFlush] - Callback(reviewsBatch) for incremental persistence
 * @param {number} [opts.flushEvery=100] - Flush every N reviews
 * @returns {Promise<{reviews: Array, detectedCount: number|null, error: string|null}>}
 */
async function fetchAllReviews(page, opts = {}) {
  const {
    maxReviews = 25000,
    pageSize = 10,
    delayMs = 200,
    onProgress = null,
    onFlush = null,
    flushEvery = 100,
  } = opts;

  // --- Step 1: Detect count + capture the first ListUgcPosts POST ---
  let capturedUrl = null;
  let capturedBody = null;
  let capturedHeaders = null;
  let detectedCount = null;

  const requestHandler = (req) => {
    const u = req.url();
    if (capturedUrl) return;
    if (!u.includes('rpcids=' + REVIEW_RPC_ID)) return;
    capturedUrl = u;
    capturedBody = req.postData() || '';
    // Google now enforces per-request anti-bot headers on the batchexecute
    // gateway (x-maps-bgbind = query context, x-maps-bgkey = signed token,
    // x-same-domain, origin, sec-ch-ua, ...). A replay that omits them gets a
    // 200 with an empty body `[null,null,null,null,null,true]` — which the
    // pagination loop used to misread as "blocked". Capture the real headers
    // and replay them verbatim. Drop forbidden/auto-managed ones (the browser
    // fetch sets host/content-length/cookie itself; credentials:'include'
    // carries cookies).
    const raw = req.headers();
    const hdr = {};
    for (const [k, v] of Object.entries(raw || {})) {
      const lk = k.toLowerCase();
      if (lk.startsWith(':')) continue;
      if (['host', 'content-length', 'cookie', 'accept-encoding', 'connection'].includes(lk)) continue;
      hdr[k] = v;
    }
    if (!hdr['content-type']) hdr['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    capturedHeaders = hdr;
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
    return { reviews: [], detectedCount, error: 'reviews_tab_not_found', stopReason: 'reviews_tab_not_found' };
  }

  // Wait for the first ListUgcPosts POST to fire (tab click triggers it)
  for (let i = 0; i < 30 && !capturedBody; i++) {
    await page.waitForTimeout(500);
  }
  page.off('request', requestHandler);

  if (!capturedBody) {
    return { reviews: [], detectedCount, error: 'api_url_not_captured', stopReason: 'api_url_not_captured' };
  }

  const effectiveMax = detectedCount ? Math.min(maxReviews, detectedCount) : maxReviews;

  // --- Step 2: Paginate via POST replay ---
  const reviews = [];
  const seenIds = new Set();
  let nextToken = '';
  let pageNum = 0;
  let currentUrl = capturedUrl;
  let lastFlushAt = 0;
  let consecutiveEmpty = 0;
  let blocked = false;
  // Tracks the FIRST terminating break path (see all the `break;` below);
  // surfaced so callers can distinguish "Google ran out" from "we hit a bug".
  let stopReason = null;
  const startTime = Date.now();

  while (reviews.length < effectiveMax) {
    const postBody = buildPaginatedBody(capturedBody, nextToken, pageSize);
    const apiUrl = currentUrl;

    let inner;
    try {
      const resp = await page.evaluate(async ({ url, body, headers }) => {
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers,
          body,
        });
        if (!r.ok) return { error: r.status };
        return { text: await r.text() };
      }, { url: apiUrl, body: postBody, headers: capturedHeaders });

      if (resp.error) {
        if (resp.error === 429 || resp.error === 403) {
          if (onProgress) onProgress(reviews.length, effectiveMax, `HTTP ${resp.error}, pausing 30s...`);
          await page.waitForTimeout(30000);
          const retry = await page.evaluate(async ({ url, body, headers }) => {
            const r = await fetch(url, {
              method: 'POST', credentials: 'include',
              headers,
              body,
            });
            if (!r.ok) return { error: r.status };
            return { text: await r.text() };
          }, { url: apiUrl, body: postBody, headers: capturedHeaders });
          if (retry.error) { blocked = true; stopReason = 'blocked_http_' + retry.error; break; }
          inner = parseBatchexecuteResponse(retry.text);
        } else {
          stopReason = 'http_error_' + resp.error;
          break;
        }
      } else {
        inner = parseBatchexecuteResponse(resp.text);
      }
    } catch (e) {
      stopReason = 'fetch_exception:' + (e && e.message || 'unknown').substring(0, 60);
      break;
    }

    if (!inner) { stopReason = 'parse_failure'; break; }

    // inner = [null, nextToken, reviewsArray]
    nextToken = inner[1] || '';
    const pageReviews = Array.isArray(inner[2]) ? inner[2] : [];

    if (pageReviews.length === 0) {
      const coverage = detectedCount ? (reviews.length / detectedCount) : 1;
      if (coverage < 0.8) {
        // Suspect block — pause and retry
        if (onProgress) onProgress(reviews.length, effectiveMax, 'Empty page, suspect block, pausing 30s...');
        await page.waitForTimeout(30000);
        const retryBody = buildPaginatedBody(capturedBody, nextToken, pageSize);
        const retryResp = await page.evaluate(async ({ url, body, headers }) => {
          const r = await fetch(url, {
            method: 'POST', credentials: 'include',
            headers,
            body,
          });
          if (!r.ok) return { error: r.status };
          return { text: await r.text() };
        }, { url: apiUrl, body: retryBody, headers: capturedHeaders });
        if (retryResp.error) { blocked = true; stopReason = 'blocked_low_coverage_http_' + retryResp.error; break; }
        const retryInner = parseBatchexecuteResponse(retryResp.text);
        if (!retryInner || !Array.isArray(retryInner[2]) || retryInner[2].length === 0) {
          blocked = true; stopReason = 'blocked_low_coverage_empty_retry'; break;
        }
        nextToken = retryInner[1] || '';
        pageReviews.push(...retryInner[2]);
      } else {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) { stopReason = 'consecutive_empty_pages'; break; }
        await page.waitForTimeout(1000);
        if (!nextToken) { stopReason = 'no_token_after_empty'; break; }
        currentUrl = bumpReqId(currentUrl);
        continue;
      }
    }

    const reviewsBefore = reviews.length;

    for (const review of pageReviews) {
      if (reviews.length >= effectiveMax) break;
      try {
        // Each review entry is [reviewBody, ?, ?] — the actual review data
        // is at index [0] of the wrapper, mirroring the old listugcposts shape.
        const r = review[0];
        if (!Array.isArray(r)) continue;
        const id = r[0];
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);

        const reviewerInfo = r[1] || [];
        const contentInfo = r[2] || [];

        const createdUs = reviewerInfo[2] || null;
        const editedUs = reviewerInfo[3] || null;
        const toISO = (us) => us && us > 1e12 ? new Date(us / 1000).toISOString() : null;

        const photos = [];
        const photoArray = contentInfo[2] || [];
        for (const photo of photoArray) {
          const url = photo?.[1]?.[6]?.[0];
          if (url && url.includes('googleusercontent') && !url.includes('/a-/') && !url.includes('/a/')) {
            photos.push(url);
          }
        }

        let ownerResponseAgo = null;
        let hasOwnerResponse = false;
        if (r[3] && Array.isArray(r[3]) && r[3][1]) {
          hasOwnerResponse = true;
          ownerResponseAgo = r[3][3] || null;
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
          response_from_owner_text: null,
          response_from_owner_ago: ownerResponseAgo,
          has_owner_response: hasOwnerResponse || undefined,
          review_images: photos.length > 0 ? photos : undefined,
          _source: 'api',
        });
      } catch (e) {
        // Skip malformed review
      }
    }

    const newThisPage = reviews.length - reviewsBefore;
    if (newThisPage === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) { stopReason = 'consecutive_duplicate_pages'; break; }
    } else {
      consecutiveEmpty = 0;
    }

    pageNum++;

    if (onProgress && pageNum % 10 === 0) {
      onProgress(reviews.length, effectiveMax);
    }

    if (onFlush && reviews.length - lastFlushAt >= flushEvery) {
      onFlush(reviews.slice(lastFlushAt));
      lastFlushAt = reviews.length;
    }

    if (!nextToken) { stopReason = 'no_token'; break; }
    currentUrl = bumpReqId(currentUrl);
    await page.waitForTimeout(delayMs);
  }

  if (stopReason === null) {
    stopReason = reviews.length >= effectiveMax ? 'reached_max' : 'loop_exit';
  }

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
    blocked,
    stopReason,
    error: blocked ? 'api_blocked_fallback_to_dom' : null,
  };
}

module.exports = { fetchAllReviews };
