/**
 * Photo Category Fetcher
 *
 * Adaptive enumeration of Google Maps' photo categories per place.
 *
 *   Step 1 (parse): from the place's /maps/preview/place response, pull
 *     out every photo category (label + key + sample photo). Labels are
 *     whatever Google generated for this place (Menu, Food & drink, Soup,
 *     Hainanese chicken rice, Cendol, …) — never hardcoded.
 *
 *   Step 2 (fetch): for each category, POST directly to
 *     /maps/_/MapsWizUi/data/batchexecute?rpcids=hspqX with the
 *     /MapsPhotoService.ListEntityPhotos RPC. Paginate via the cursor
 *     embedded in each response. No UI clicks, no scrolling — the page
 *     is only loaded once to seat cookies + capture a session token.
 *
 * Reverse-engineered from discovery/poc_v2 (see discovery/FINDINGS.md).
 *
 * Usage (from Playwright context, after `page.goto(placeUrl)` ran):
 *   const photo = require('./photo-category-fetcher');
 *   const previewText = ...captured during navigation...
 *   const categories = await photo.fetchAllPhotoCategories(page, previewText);
 *   // [{ key, label, totalCount, photos: [{id, url, w, h}, ...] }, ...]
 */

'use strict';

// Neither page.evaluate nor an in-page fetch has a default timeout, so a
// stalled ListEntityPhotos response wedges the whole worker: the photos phase
// writes its sidecar once on entry and has no heartbeat, so the stall shows up
// only as a process burning no CPU. One was measured stuck for 49 minutes on a
// hawker centre, at 14 s of CPU against ~4 min for its siblings. Abort instead
// and let the existing _error path close the category out.
const PHOTO_FETCH_TIMEOUT_MS = Number(process.env.PHOTO_FETCH_TIMEOUT_MS) || 45000;

// Same renderer-wedge guard the review fetcher uses: the in-page abort cannot
// fire if the renderer is dead, so race page.evaluate in Node as well.
const { evaluateWithTimeout, PageEvalTimeout } = require('./api-review-fetcher');

// ============================================================
// Parsing preview/place response
// ============================================================

/**
 * Walk a parsed preview/place JSON and return all entries that look like
 * a photo category: [<base64-ish key>, "<0ahUK token>", "<label>",
 * [[<sample_photo>...]], ...].
 *
 * Adaptive — does not match on label strings. Any node whose shape fits
 * the category signature counts, so dish-specific tags like "Pork Satay"
 * or "Original Chendol from Nonya Chendol" are picked up automatically.
 */
function extractPhotoCategoriesFromPreview(previewText) {
  if (!previewText) return [];
  let data;
  try {
    data = JSON.parse(previewText.replace(/^\)\]\}'\n/, ''));
  } catch (e) { return []; }

  const out = [];
  const seenKeys = new Set();

  // Recursively walk; recognise category by shape.
  function walk(node) {
    if (!Array.isArray(node)) return;
    if (
      node.length >= 4 &&
      // Key is the protobuf wire-format field for the category filter,
      // base64-encoded. First byte is always 0x0A (field 1, wire type 2),
      // which encodes as `C<varies>` depending on the following length
      // byte: `Cg`=length 2, `Ch`=length 17, `Ci`=length 33, etc. So we
      // anchor on the leading `C` only, not on the second char.
      typeof node[0] === 'string' && /^C[A-Za-z0-9_=+/-]{3,}$/.test(node[0]) &&
      typeof node[1] === 'string' && node[1].startsWith('0ahUK') &&
      typeof node[2] === 'string' && node[2].length > 0 &&
      Array.isArray(node[3])
    ) {
      const key = node[0].replace(/=+$/, ''); // URL-form drops trailing '='
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        // Sample photo: node[3][0] is the first sample entry; its [0] is
        // the photo id, [6] is [url, "", [w, h], [thumb_w, thumb_h]].
        let samplePhoto = null;
        try {
          const s = node[3][0];
          if (Array.isArray(s) && typeof s[0] === 'string') {
            samplePhoto = {
              id: s[0],
              url: (s[6] && s[6][0]) || null,
              w: (s[6] && s[6][2] && s[6][2][0]) || null,
              h: (s[6] && s[6][2] && s[6][2][1]) || null,
            };
          }
        } catch (e) {}
        out.push({ key, label: node[2], samplePhoto });
      }
    }
    for (const child of node) walk(child);
  }
  walk(data);
  return out;
}

/**
 * Pull place identifiers out of preview/place so we can fill the POST body.
 * Returns { ftid, kgId, lat, lng, name } — null fields if not found.
 */
function extractPlaceMeta(previewText) {
  const meta = { ftid: null, kgId: null, lat: null, lng: null, name: null };
  if (!previewText) return meta;
  try {
    const data = JSON.parse(previewText.replace(/^\)\]\}'\n/, ''));
    // Place node is at data[6] for the place-detail endpoint.
    const p = data[6];
    if (Array.isArray(p)) {
      if (typeof p[10] === 'string' && /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(p[10])) meta.ftid = p[10];
      if (typeof p[11] === 'string') meta.name = p[11];
      if (Array.isArray(p[9]) && p[9][2] != null) { meta.lat = p[9][2]; meta.lng = p[9][3]; }
    }
    // KG id: look for "/g/XXX" or "/m/XXX" string anywhere in p — they're
    // stored several times; first match is fine.
    const kgMatch = JSON.stringify(p).match(/"\/([gm])\/([a-z0-9_]+)"/);
    if (kgMatch) meta.kgId = `/${kgMatch[1]}/${kgMatch[2]}`;
  } catch (e) {}
  return meta;
}

// ============================================================
// Building the batchexecute POST body
// ============================================================

/**
 * Construct the f.req body for one ListEntityPhotos call.
 *
 * Reverse-engineered template — fields with names like "filters",
 * "session", "counter" come from one captured auto-fired POST and are
 * forwarded verbatim; only ftid/kg/category-key/cursor change per call.
 */
function buildListEntityPhotosBody({
  ftid, kgId, sessionToken, counter,
  categoryKey, cursor, pageSize = 20,
}) {
  // Match field order from captured POST. The values below are exact
  // forwards of what Google's web client sends — including the magic
  // arrays at filter positions which we don't need to understand.
  const rpcArg = [
    2, null,
    [ftid, null, null, null, null, null, null, null, 0, null, null, null, null, null,
      [[null, null, null, kgId]]],
    null,
    [null, [203, 100], [null, pageSize, cursor, null, 1], null, null, null,
      [[[1, 0, 3], [2, 1, 2], [2, 0, 3], [8, 0, 3], [10, 0, 3], [10, 1, 2], [10, 0, 4], [9, 1, 2]], 1],
      null, 0, null, null, null, null, null,
      [[[[[[2]]], [195, 195], 20]]]],
    [sessionToken, null, null, null, null, null, 81, null, null, null, null, null, null, null, counter],
    null, null, null, null, null, null, null, null, null,
    [[categoryKey], 1, null, 1],
  ];

  const outer = [[["/MapsPhotoService.ListEntityPhotos", JSON.stringify(rpcArg), null, "generic"]]];
  return 'f.req=' + encodeURIComponent(JSON.stringify(outer)) + '&';
}

// ============================================================
// Response parsing
// ============================================================

// Media entry pattern. Sub-type after `,10,`:
//   10 = video (the URL is the poster thumbnail; the viewer plays it via !1e5!...!3e10)
//   11 = Street View / 360° panorama (URL is a flat preview)
//   12 = ordinary photo
// All share the same URL/dims layout that follows.
const PHOTO_ENTRY_RE = /\\"(CI(?:HM|ABIh)[A-Za-z0-9_-]+)\\",10,(1[012]),null,null,null,\[\\"(https:\/\/lh3\.googleusercontent\.com\/[^"]+?)\\",\\"\\",\[(\d+),(\d+)\]/g;

const SUBTYPE_TO_MEDIATYPE = { 10: 'video', 11: 'streetview', 12: 'photo' };
const NEXT_CURSOR_RE = /,(\d+),null,\\"[^"]+\\",null,\\"([A-Za-z0-9_-]{40,})\\"/;
const TOTAL_COUNT_FOLLOWS_PHOTOS_RE = /\]\],(\d+),null,\\"/; // [<last photo>]],<count>,null,"<token>"

/**
 * Pull all photos + the next-page cursor out of one batchexecute response.
 *
 * Photos appear as `\"<id>\",10,12,null,null,null,[\"<url>\",\"\",[w,h]…`.
 * The cursor follows the last photo entry as the 5th field after a
 * `<count>,null,\"<short_token>\",null,\"<cursor>\"` sequence.
 *
 * Returns { photos: [{id, url, w, h}], nextCursor: string|null, totalCount: number|null }.
 */
/**
 * Sidebar boundary: after the cursor field, the response includes a
 * second array of "related categories" each with one sample photo. We
 * must not let those samples be counted as photos of the active
 * category, so we slice the response at this boundary before extracting.
 *
 * Boundary pattern: `,null,null,null,null,<bool>,null,[[[` after the
 * cursor field. Robust across pages — present even when main-page
 * photos array is empty (`[null,...]`).
 */
const SIDEBAR_BOUNDARY_RE = /,null,null,null,null,(?:true|false),null,\[\[\[/;

function parseListEntityPhotosResponse(text) {
  const sidebarMatch = text.match(SIDEBAR_BOUNDARY_RE);
  const mainText = sidebarMatch ? text.slice(0, sidebarMatch.index) : text;

  const photos = [];
  const seen = new Set();
  let m;
  PHOTO_ENTRY_RE.lastIndex = 0;
  while ((m = PHOTO_ENTRY_RE.exec(mainText)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const subtype = parseInt(m[2], 10);
    photos.push({
      id,
      mediaType: SUBTYPE_TO_MEDIATYPE[subtype] || 'unknown',
      // Response is JSON-inside-JSON, so escape sequences are doubled.
      // The captured text has literal `\\u003d` (2 backslashes); unescape
      // both forms to be safe. Same for `/` → `\\/`.
      url: m[3]
        .replace(/\\\\u003d/g, '=').replace(/\\u003d/g, '=')
        .replace(/\\\\\//g, '/').replace(/\\\//g, '/'),
      w: parseInt(m[4], 10),
      h: parseInt(m[5], 10),
    });
  }
  const cursorMatch = mainText.match(NEXT_CURSOR_RE);
  const totalMatch = mainText.match(TOTAL_COUNT_FOLLOWS_PHOTOS_RE);
  return {
    photos,
    nextCursor: cursorMatch ? cursorMatch[2] : null,
    totalCount: totalMatch ? parseInt(totalMatch[1], 10) : null,
  };
}

// ============================================================
// Driving the page (capture session token, then fetch loop)
// ============================================================

/**
 * Wait for the first batchexecute POST that the page auto-fires after
 * load and lift its session-token + counter out. We need these to
 * impersonate the client in our own POSTs.
 *
 * Caller must register the listener BEFORE navigating.
 */
function makeSessionCapturer(page) {
  const captured = { sessionToken: null, counter: null, reqIdSeed: null };
  const handler = (req) => {
    if (captured.sessionToken) return;
    const u = req.url();
    // Accept ANY batchexecute RPC — all share the same session-token
    // block, and the hspqX (ListEntityPhotos) call doesn't always auto-
    // fire on page load. GetAreaTraffic, MapsTrafficService, etc. all
    // work as token sources.
    if (!/\/batchexecute\?/.test(u)) return;
    const body = req.postData();
    if (!body) return;
    // Body is URL-encoded f.req=...; extract session block via regex over
    // the decoded form. The encoded \" inside JSON-as-string survives one
    // decodeURIComponent.
    let decoded;
    try { decoded = decodeURIComponent(body); } catch (e) { return; }
    // Pattern: [\"<sessionToken>\",null,null,null,null,null,81,null,null,null,null,null,null,null,<counter>
    // (No trailing \] — different RPCs append more fields after counter,
    //  but the prefix is identical across all batchexecute calls.)
    const m = decoded.match(/\[\\"([A-Za-z0-9_-]{15,})\\",null,null,null,null,null,81,null,null,null,null,null,null,null,(\d+)/);
    if (m) {
      captured.sessionToken = m[1];
      captured.counter = parseInt(m[2], 10);
    }
    const reqidMatch = u.match(/[?&]_reqid=(\d+)/);
    if (reqidMatch) captured.reqIdSeed = parseInt(reqidMatch[1], 10);
  };
  page.on('request', handler);
  return {
    captured,
    detach() { page.off('request', handler); },
    async wait(timeoutMs = 15000) {
      const start = Date.now();
      while (!captured.sessionToken && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 250));
      }
      return !!captured.sessionToken;
    },
  };
}

/**
 * Fetch all photos in one category by paginating batchexecute directly
 * via in-page fetch (cookies/auth come from the loaded place page).
 */
async function fetchPhotosForCategory(page, placeMeta, category, session, opts = {}) {
  const {
    pageSize = 20,
    maxPhotos = 5000,
    maxPages = 200,
    onProgress = null,
    stopWhenPhotoIds = null,
  } = opts;

  const all = [];
  const seen = new Set();
  const remainingPhotoIds = stopWhenPhotoIds
    ? new Set(Array.from(stopWhenPhotoIds).filter(Boolean))
    : null;
  let cursor = null;
  let totalCount = null;
  let reqId = (session.reqIdSeed || 100000) + Math.floor(Math.random() * 1e5);

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    const body = buildListEntityPhotosBody({
      ftid: placeMeta.ftid,
      kgId: placeMeta.kgId,
      sessionToken: session.sessionToken,
      counter: session.counter || 1,
      categoryKey: category.key,
      cursor,
      pageSize,
    });
    reqId += 100000;
    const url = `/maps/_/MapsWizUi/data/batchexecute?rpcids=hspqX&hl=en&_reqid=${reqId}&rt=c`;

    let respText;
    try {
      respText = await evaluateWithTimeout(page, async ({ u, b, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const r = await fetch(u, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: b,
            credentials: 'include',
            signal: controller.signal,
          });
          if (!r.ok) return { _error: r.status };
          return await r.text();
        } catch (e) {
          if (e && e.name === 'AbortError') return { _error: 'timeout' };
          throw e;
        } finally {
          clearTimeout(timer);
        }
      }, { u: url, b: body, timeoutMs: PHOTO_FETCH_TIMEOUT_MS });
    } catch (e) {
      if (onProgress) onProgress({ category: category.label, error: e.message });
      break;
    }
    if (respText && respText._error) {
      if (onProgress) onProgress({ category: category.label, httpError: respText._error });
      break;
    }

    const { photos, nextCursor, totalCount: tc } = parseListEntityPhotosResponse(respText);
    if (tc != null && totalCount == null) totalCount = tc;
    let added = 0;
    for (const p of photos) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      all.push(p);
      if (remainingPhotoIds) remainingPhotoIds.delete(p.id);
      added++;
      if (all.length >= maxPhotos) break;
    }
    if (onProgress) onProgress({ category: category.label, page: pageNum, added, total: all.length, expected: totalCount });

    if (added === 0) break;                          // no new photos this page
    if (remainingPhotoIds && remainingPhotoIds.size === 0) break;
    if (!nextCursor) break;                          // no more pages
    if (all.length >= maxPhotos) break;
    if (totalCount != null && all.length >= totalCount) break;
    cursor = nextCursor;
  }

  return { photos: all, totalCount };
}

/**
 * Top-level: given a Playwright page with cookies/state for a place and
 * the captured preview/place response text, enumerate every category and
 * fetch all photos in each.
 */
async function fetchAllPhotoCategories(page, previewText, session, opts = {}) {
  const { onProgress = null, perCategoryOpts = {} } = opts;
  const placeMeta = extractPlaceMeta(previewText);
  const categories = extractPhotoCategoriesFromPreview(previewText);

  if (!placeMeta.ftid || !placeMeta.kgId) {
    return { placeMeta, categories: [], error: 'missing_ftid_or_kgid' };
  }
  if (!session || !session.sessionToken) {
    return { placeMeta, categories: [], error: 'no_session_token' };
  }

  const results = [];
  for (let i = 0; i < categories.length; i++) {
    const c = categories[i];
    if (onProgress) onProgress({ stage: 'category_start', index: i, label: c.label, key: c.key });
    const { photos, totalCount } = await fetchPhotosForCategory(
      page, placeMeta, c, session,
      Object.assign({ onProgress }, perCategoryOpts),
    );
    results.push({ key: c.key, label: c.label, totalCount, photoCount: photos.length, photos });
  }
  return { placeMeta, categories: results, error: null };
}

module.exports = {
  extractPhotoCategoriesFromPreview,
  extractPlaceMeta,
  buildListEntityPhotosBody,
  parseListEntityPhotosResponse,
  makeSessionCapturer,
  fetchPhotosForCategory,
  fetchAllPhotoCategories,
};
