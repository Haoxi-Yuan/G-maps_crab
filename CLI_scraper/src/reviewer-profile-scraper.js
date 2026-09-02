'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const stealth = require('./stealth');
const { iterateNdjsonRecords } = require('./ndjson-reader');
const {
  parseReviewerMasResponse,
  setReviewerMasMediaEnabled,
  setReviewerMasPageSize,
} = require('./reviewer-profile-parser');
const { withDeadline } = require('./async-deadline');
const { evaluateWithTimeout } = require('./api-review-fetcher');

// Bound every in-page fetch / body wait so a stalled renderer can never wedge a
// worker. Same failure the review-fetch path already hit (two Singapore shards
// frozen a day each); the fix there was evaluateWithTimeout, applied here too.
const MAS_BODY_TIMEOUT_MS = Number(process.env.REVIEWER_MAS_BODY_TIMEOUT_MS) || 30000;
const MAS_EVAL_TIMEOUT_MS = Number(process.env.REVIEWER_MAS_EVAL_TIMEOUT_MS) || 40000;

// In-page MAS fetch with an AbortController so it aborts even when the renderer
// is alive-but-slow, and an outer evaluate deadline in case the renderer is gone.
async function fetchMasInPage(page, url, timeoutMs = MAS_EVAL_TIMEOUT_MS) {
  return evaluateWithTimeout(page, async ({ target, budgetMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const response = await fetch(target, { credentials: 'include', signal: controller.signal });
      return { status: response.status, ok: response.ok, text: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }, { target: url, budgetMs: timeoutMs }, timeoutMs);
}

const GOOGLE_REVIEWER_RE = /\/maps\/contrib\/(\d{8,})/;
const REVIEWER_MAS_RE = /\/locationhistory\/preview\/mas(?:\?|$)/;
const SERVICE_MAX_REVIEWS = 200;

function reviewerIdFromLink(link) {
  if (typeof link !== 'string') return null;
  return link.match(GOOGLE_REVIEWER_RE)?.[1] || null;
}

function normalizeReviewerRecord(item) {
  return {
    reviewer_id: item.reviewer_id,
    reviewer_name: item.reviewer_name,
    reviewer_link: item.reviewer_link,
    observed_names: [...item.observed_names],
    observed_public_review_count: item.observed_public_review_count,
    observed_public_photo_count: item.observed_public_photo_count,
    observed_local_guide: item.observed_local_guide,
    source_review_occurrences: item.source_review_occurrences,
    source_place_count: item.source_place_ids.size,
  };
}

function extractReviewerListFromDatabase(databaseFile, options = {}) {
  const Database = require('better-sqlite3');
  const listLimit = options.listLimit == null ? null : options.listLimit;
  const listOrder = options.listOrder || 'source';
  if (listLimit != null && (!Number.isInteger(listLimit) || listLimit < 1)) throw new Error('listLimit must be a positive integer');
  if (!['source', 'review-count-desc'].includes(listOrder)) throw new Error('listOrder must be source or review-count-desc');

  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  database.pragma('query_only = ON');
  try {
    const reviewers = new Map();
    let candidateRows;
    if (listLimit == null) {
      candidateRows = database.prepare(`
        SELECT reviewer_link,
               MAX(reviewer_name) AS reviewer_name,
               MAX(reviewer_review_count) AS reviewer_review_count,
               MAX(reviewer_photo_count) AS reviewer_photo_count,
               MAX(is_local_guide) AS is_local_guide,
               COUNT(*) AS occurrence_count,
               COUNT(DISTINCT place_id) AS place_count
        FROM reviews
        WHERE reviewer_link LIKE '%/maps/contrib/%'
        GROUP BY reviewer_link
        ${listOrder === 'review-count-desc' ? 'ORDER BY MAX(COALESCE(reviewer_review_count, 0)) DESC' : ''}
      `).all();
    } else {
      // High-volume reviewers can occupy thousands of review rows each. Keep
      // the candidate set bounded, but wide enough to yield the requested
      // number of unique IDs without grouping the entire multi-million-row DB.
      const candidateLimit = Math.max(100000, listLimit * 1000);
      const orderClause = listOrder === 'review-count-desc'
        ? 'ORDER BY COALESCE(reviewer_review_count, 0) DESC'
        : 'ORDER BY rowid';
      const sampled = database.prepare(`
        SELECT reviewer_link, reviewer_name, reviewer_review_count,
               reviewer_photo_count, is_local_guide, place_id
        FROM reviews
        WHERE reviewer_link LIKE '%/maps/contrib/%'
        ${orderClause}
        LIMIT ?
      `).all(candidateLimit);
      const selectedLinks = [];
      const seenIds = new Set();
      for (const row of sampled) {
        const reviewerId = reviewerIdFromLink(row.reviewer_link);
        if (!reviewerId || seenIds.has(reviewerId)) continue;
        seenIds.add(reviewerId);
        selectedLinks.push(row.reviewer_link);
        if (selectedLinks.length >= listLimit) break;
      }
      if (!selectedLinks.length) candidateRows = [];
      else {
        const placeholders = selectedLinks.map(() => '?').join(',');
        candidateRows = database.prepare(`
          SELECT reviewer_link,
                 MAX(reviewer_name) AS reviewer_name,
                 MAX(reviewer_review_count) AS reviewer_review_count,
                 MAX(reviewer_photo_count) AS reviewer_photo_count,
                 MAX(is_local_guide) AS is_local_guide,
                 COUNT(*) AS occurrence_count,
                 COUNT(DISTINCT place_id) AS place_count
          FROM reviews
          WHERE reviewer_link IN (${placeholders})
          GROUP BY reviewer_link
        `).all(...selectedLinks);
        const order = new Map(selectedLinks.map((link, index) => [link, index]));
        candidateRows.sort((left, right) => order.get(left.reviewer_link) - order.get(right.reviewer_link));
      }
    }

    for (const row of candidateRows) {
      const reviewerId = reviewerIdFromLink(row.reviewer_link);
      if (!reviewerId || reviewers.has(reviewerId)) continue;
      reviewers.set(reviewerId, {
        reviewer_id: reviewerId,
        reviewer_name: row.reviewer_name || null,
        reviewer_link: row.reviewer_link,
        observed_names: new Set(row.reviewer_name ? [row.reviewer_name] : []),
        observed_public_review_count: row.reviewer_review_count ?? null,
        observed_public_photo_count: row.reviewer_photo_count ?? null,
        observed_local_guide: row.is_local_guide === 1,
        source_review_occurrences: row.occurrence_count ?? 1,
        source_place_ids: { size: row.place_count ?? 1 },
      });
    }
    const list = [...reviewers.values()].map(normalizeReviewerRecord);
    return {
      reviewers: list,
      stats: {
        sourceType: 'sqlite',
        reviewRecords: database.prepare('SELECT COUNT(*) AS count FROM reviews').get().count,
        uniqueGoogleReviewers: list.length,
        listLimit,
        listOrder,
        externalOrInvalidLinks: 0,
        recoveredRecords: 0,
      },
    };
  } finally {
    database.close();
  }
}

async function extractReviewerList(reviewsFile, options = {}) {
  if (/\.(?:db|sqlite|sqlite3)$/i.test(reviewsFile)) return extractReviewerListFromDatabase(reviewsFile, options);
  const reviewers = new Map();
  let placeRecords = 0;
  let recoveredRecords = 0;
  let reviewRecords = 0;
  let externalOrInvalidLinks = 0;

  for await (const logical of iterateNdjsonRecords(reviewsFile)) {
    placeRecords += 1;
    if (logical.recovered) recoveredRecords += 1;
    const record = logical.value || {};
    const placeId = record.business?.placeId || record._meta?.placeId || null;
    for (const review of Array.isArray(record.detailedReviews) ? record.detailedReviews : []) {
      reviewRecords += 1;
      const reviewerId = reviewerIdFromLink(review.reviewer_link);
      if (!reviewerId) {
        externalOrInvalidLinks += 1;
        continue;
      }
      let item = reviewers.get(reviewerId);
      if (!item) {
        item = {
          reviewer_id: reviewerId,
          reviewer_name: review.reviewer_name || null,
          reviewer_link: review.reviewer_link,
          observed_names: new Set(),
          observed_public_review_count: null,
          observed_public_photo_count: null,
          observed_local_guide: false,
          source_review_occurrences: 0,
          source_place_ids: new Set(),
        };
        reviewers.set(reviewerId, item);
      }
      if (review.reviewer_name) {
        item.reviewer_name = review.reviewer_name;
        item.observed_names.add(review.reviewer_name);
      }
      if (Number.isFinite(review.reviewer_review_count)) {
        item.observed_public_review_count = Math.max(item.observed_public_review_count ?? 0, review.reviewer_review_count);
      }
      if (Number.isFinite(review.reviewer_photo_count)) {
        item.observed_public_photo_count = Math.max(item.observed_public_photo_count ?? 0, review.reviewer_photo_count);
      }
      item.observed_local_guide ||= review.is_local_guide === true;
      item.source_review_occurrences += 1;
      if (placeId) item.source_place_ids.add(placeId);
    }
  }

  let list = [...reviewers.values()].map(normalizeReviewerRecord);
  if (options.listOrder === 'review-count-desc') {
    list.sort((left, right) => (right.observed_public_review_count || 0) - (left.observed_public_review_count || 0));
  }
  if (options.listLimit != null) list = list.slice(0, options.listLimit);

  return {
    reviewers: list,
    stats: { placeRecords, recoveredRecords, reviewRecords, externalOrInvalidLinks, uniqueGoogleReviewers: list.length },
  };
}

function writeReviewerList(listFile, reviewers, sourceFile) {
  fs.mkdirSync(path.dirname(listFile), { recursive: true });
  const temporary = `${listFile}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, 'w');
  try {
    for (const reviewer of reviewers) {
      fs.writeSync(fd, `${JSON.stringify({ ...reviewer, source_reviews_file: sourceFile })}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, listFile);
}

function doneSidecarPath(outputFile) {
  return `${outputFile}.done`;
}

// Cheap resume signal from a record line without materialising the ~120 KB
// object (service_cap records carry 200 full reviews). Both top-level fields we
// need sit at the very front: profileRecord/errorRecord always emit
// {"extracted_at":..,"reviewer_id":"<digits>","reviewer":{..}|null,..}. Match the
// reviewer_id immediately followed by its terminal(`{`)/error(`null`) marker so a
// nested reviewer_id can never be picked up. Returns null when the front doesn't
// match (schema drift) so the caller can fall back to a full parse.
const RESUME_HEAD_RE = /"reviewer_id":"(\d+)","reviewer":(null|\{)/;
function extractResumeSignal(line) {
  const head = line.length > 600 ? line.slice(0, 600) : line;
  const match = RESUME_HEAD_RE.exec(head);
  if (!match) return null;
  // `match[1]` is a V8 sliced string pointing into `head`, which is itself a
  // slice of `line`. Callers keep the id (buildDoneIndexFromOutput stores
  // millions of them in a Set), and a retained slice pins its whole parent —
  // so every stored id held its entire source record, up to ~120 KB for a
  // service_cap profile carrying 200 reviews. The bootstrap scan then grew
  // with (ids x record size) rather than (ids x id length): a 13.7 GB shard
  // reached 28 GB RSS without finishing, and OOMed under the default heap.
  // Measured: 100153 bytes retained per id before, 81 bytes after. The id is
  // /\d+/, so the latin1 round-trip is lossless and forces a flat copy.
  return { id: Buffer.from(match[1], 'latin1').toString('latin1'), terminal: match[2] === '{' };
}

// Append one completed reviewer id to the sidecar index (terminal records only).
// Append-only and written after the output record, so the sidecar can only ever
// lag the output, never lead it — a crash re-fetches at most the in-flight window
// (harmless duplicate terminal records that downstream dedups), and it can never
// mark a not-done reviewer as done.
function appendDoneId(doneFile, reviewerId) {
  fs.appendFileSync(doneFile, `${reviewerId}\n`);
}

async function buildDoneIndexFromOutput(outputFile, doneFile, log) {
  const done = new Set();
  let fallbacks = 0;
  const reader = readline.createInterface({ input: fs.createReadStream(outputFile), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line) continue;
    const signal = extractResumeSignal(line);
    if (signal) {
      if (signal.terminal) done.add(signal.id);
      continue;
    }
    // Front didn't match: parse this one line fully rather than guess. A torn
    // final line from a killed write simply fails and is skipped (re-fetched).
    fallbacks += 1;
    try {
      const record = JSON.parse(line);
      if (record.reviewer_id && record._status !== 'error') done.add(record.reviewer_id);
    } catch { /* incomplete/last line — the reviewer will be re-attempted */ }
  }
  // Atomically (re)write the sidecar so future resumes read it instead of the
  // multi-GB output.
  const temporary = `${doneFile}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, done.size ? `${[...done].join('\n')}\n` : '');
  fs.renameSync(temporary, doneFile);
  if (log) log(`[REVIEWERS] built done-index for ${path.basename(outputFile)}: ${done.size} ids (full scan${fallbacks ? `, ${fallbacks} line-parse fallbacks` : ''})`);
  return done;
}

function loadDoneIndexSidecar(doneFile) {
  const done = new Set();
  const data = fs.readFileSync(doneFile, 'utf8');
  let start = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data.charCodeAt(i) === 10) {
      if (i > start) done.add(data.slice(start, i));
      start = i + 1;
    }
  }
  if (start < data.length) done.add(data.slice(start));
  return done;
}

// Resume set of reviewer ids that already have a terminal (non-error) record.
// Fast path: read the compact append-only sidecar. Bootstrap/fallback: if the
// sidecar is absent (or --rebuild), scan the output once and (re)build it.
async function completedReviewerIds(outputFile, options = {}) {
  if (!fs.existsSync(outputFile)) return new Set();
  const doneFile = options.doneFile || doneSidecarPath(outputFile);
  const log = options.log;
  if (!options.rebuild && fs.existsSync(doneFile)) {
    const done = loadDoneIndexSidecar(doneFile);
    if (log) log(`[REVIEWERS] resume from done-index sidecar ${path.basename(doneFile)}: ${done.size} ids`);
    return done;
  }
  return buildDoneIndexFromOutput(outputFile, doneFile, log);
}

async function loadReviewerList(listFile) {
  const reviewers = [];
  for await (const logical of iterateNdjsonRecords(listFile)) {
    const reviewer = logical.value || {};
    if (!reviewer.reviewer_id || !reviewer.reviewer_link) continue;
    reviewers.push(reviewer);
  }
  return reviewers;
}

function makeLiveStatusWriter(file) {
  if (!file) return () => {};
  let current = {};
  return (patch) => {
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    current = next;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
    fs.renameSync(temporary, file);
  };
}

async function fetchMasFromPage(page, reviewerId, options = {}) {
  const locale = options.locale || 'en';
  let masUrl = null;
  let masText = null;
  let fallbackMasUrl = null;
  const pendingBodies = [];
  const responseHandler = (response) => {
    if (!REVIEWER_MAS_RE.test(response.url())) return;
    const responseUrl = response.url();
    fallbackMasUrl ||= responseUrl;
    // A profile load can issue multiple MAS requests. Keep the URL paired with
    // the largest response body; using the latest URL with an earlier body can
    // select an unrelated MAS request that has no reviewer count field.
    const body = response.text().then((text) => {
      if (!masText || text.length > masText.length) {
        masText = text;
        masUrl = responseUrl;
      }
    }).catch(() => {});
    pendingBodies.push(body);
  };
  page.on('response', responseHandler);

  const profileUrl = `https://www.google.com/maps/contrib/${reviewerId}/reviews?hl=${encodeURIComponent(locale)}`;
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs || 60000 });
  await page.waitForTimeout(options.initialWaitMs || 2500);
  // Bound the body wait: a single stuck response.text() must not hang the load.
  await withDeadline(Promise.allSettled(pendingBodies), MAS_BODY_TIMEOUT_MS, 'mas-bodies').catch(() => {});
  masUrl ||= fallbackMasUrl;

  if (!masUrl) {
    masUrl = await page.locator('link[rel="preload"][href*="/locationhistory/preview/mas"]')
      .first().getAttribute('href').catch(() => null);
    if (masUrl) masUrl = new URL(masUrl, page.url()).toString();
  }
  if (!masUrl) throw new Error('reviewer MAS preload URL was not captured');

  if (!masText) {
    const fallback = await fetchMasInPage(page, masUrl);
    if (!fallback.ok) throw new Error(`reviewer MAS HTTP ${fallback.status}`);
    masText = fallback.text;
  }
  page.off('response', responseHandler);
  return { profileUrl: page.url(), masUrl, masText };
}

async function fetchExpandedMas(page, masUrl, pageSize) {
  const expandedUrl = setReviewerMasPageSize(masUrl, pageSize);
  const result = await fetchMasInPage(page, expandedUrl);
  if (result.status < 200 || result.status >= 300) throw new Error(`expanded reviewer MAS HTTP ${result.status}`);
  return { url: expandedUrl, text: result.text };
}

function expansionPageSizes(desired, initialCount) {
  if (desired < initialCount) return [desired];
  return [...new Set([desired, 150, 100, 50, 25])]
    .filter((size) => size > initialCount && size <= desired)
    .sort((left, right) => right - left);
}

function completenessFor(profile, requestedLimit, effectiveLimit, options = {}) {
  const visible = profile.public_content.public_review_count;
  const returned = profile.public_content.returned_review_count;
  const total = profile.public_content.total_review_contributions;
  // The review counter is Google's own tally, not a promise that the history is
  // on the page: a profile can report thousands of reviews and still serve an
  // empty list at every page size, which Google's UI words as "hasn't written
  // any reviews yet, or has chosen not to show them on their profile"
  // (108984331081035263485: counter 4,269, zero returned at 200/150/100/50/25).
  // Only call that hidden once the fallback ladder has actually been walked;
  // otherwise a single short reply would masquerade as a terminal state.
  if (returned === 0 && Number.isFinite(total) && total > 0 && (visible === 0 || options.exhaustedFallbacks === true)) {
    return { is_complete: false, stop_reason: 'private_or_hidden', visible_review_count: visible, returned_review_count: returned };
  }
  // Zero reviews without an exhausted ladder is a short reply, not a cap. The
  // old ordering fell through to service_cap, which is terminal, so such a
  // profile was never retried on resume.
  if (returned === 0 && Number.isFinite(visible) && visible > 0) {
    return { is_complete: false, stop_reason: 'response_shortfall', visible_review_count: visible, returned_review_count: returned };
  }
  if (Number.isFinite(visible) && returned >= visible) {
    return { is_complete: true, stop_reason: 'complete', visible_review_count: visible, returned_review_count: returned };
  }
  if (Number.isFinite(visible) && visible > returned && effectiveLimit > 0 && returned >= effectiveLimit) {
    if (requestedLimit < SERVICE_MAX_REVIEWS && effectiveLimit === requestedLimit) {
      return { is_complete: false, stop_reason: 'requested_limit', visible_review_count: visible, returned_review_count: returned };
    }
    return { is_complete: false, stop_reason: 'service_cap', visible_review_count: visible, returned_review_count: returned };
  }
  return { is_complete: false, stop_reason: 'response_shortfall', visible_review_count: visible, returned_review_count: returned };
}

async function scrapeReviewerProfiles(reviewsFile, outputFile, options = {}) {
  const absoluteInput = path.resolve(reviewsFile);
  const absoluteOutput = path.resolve(outputFile);
  const providedListFile = options.reviewerListInput ? path.resolve(options.reviewerListInput) : null;
  const listFile = providedListFile || path.resolve(options.listFile || path.join(path.dirname(absoluteOutput), 'reviewers.list.ndjson'));
  const maxProfileReviews = Math.min(SERVICE_MAX_REVIEWS, options.maxProfileReviews ?? SERVICE_MAX_REVIEWS);
  const includeReviewMedia = options.includeReviewMedia !== false;
  const maxReviewers = options.maxReviewers == null ? Infinity : options.maxReviewers;
  const delayMs = options.delayMs ?? 500;
  const maxFetchRetries = options.maxFetchRetries ?? 2;
  const log = options.log || console.log;
  const writeLiveStatus = makeLiveStatusWriter(options.liveStatusFile ? path.resolve(options.liveStatusFile) : null);

  if (!Number.isInteger(maxProfileReviews) || maxProfileReviews < 1) throw new Error('maxProfileReviews must be a positive integer');
  if (!(maxReviewers === Infinity || (Number.isInteger(maxReviewers) && maxReviewers > 0))) throw new Error('maxReviewers must be a positive integer');
  if (!Number.isInteger(maxFetchRetries) || maxFetchRetries < 0) throw new Error('maxFetchRetries must be a non-negative integer');

  let extracted;
  if (providedListFile) {
    if (!fs.existsSync(providedListFile)) throw new Error(`reviewer list not found: ${providedListFile}`);
    log(`[REVIEWERS] loading prebuilt reviewer list from ${providedListFile}`);
    const reviewers = await loadReviewerList(providedListFile);
    extracted = {
      reviewers,
      stats: { sourceType: 'prebuilt-list', uniqueGoogleReviewers: reviewers.length, externalOrInvalidLinks: 0, recoveredRecords: 0 },
    };
  } else {
    log(`[REVIEWERS] extracting unique Google reviewer IDs from ${absoluteInput}`);
    extracted = await extractReviewerList(absoluteInput, {
      listLimit: options.listLimit,
      listOrder: options.listOrder,
    });
    writeReviewerList(listFile, extracted.reviewers, absoluteInput);
  }
  log(`[REVIEWERS] ${extracted.stats.uniqueGoogleReviewers} unique Google reviewers; ${extracted.stats.externalOrInvalidLinks} external/invalid links skipped`);
  if (extracted.stats.recoveredRecords) log(`[REVIEWERS] recovered ${extracted.stats.recoveredRecords} legacy multiline NDJSON records in memory`);
  if (options.listOnly) {
    log(`[REVIEWERS] list-only complete: ${listFile}`);
    return { processed: 0, errors: 0, completeProfiles: 0, cappedProfiles: 0, hiddenProfiles: 0, elapsedSeconds: 0, listFile, outputFile: absoluteOutput, sourceStats: extracted.stats };
  }

  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  const done = await completedReviewerIds(absoluteOutput, { log });
  const queue = extracted.reviewers.filter((reviewer) => !done.has(reviewer.reviewer_id)).slice(0, maxReviewers);
  log(`[REVIEWERS] resume: ${done.size} complete; queued: ${queue.length}`);

  if (queue.length === 0) {
    writeLiveStatus({ phase: 'complete', total: 0, processed: 0, errors: 0, elapsed_seconds: 0 });
    log(`[REVIEWERS] no pending reviewers; output: ${absoluteOutput}`);
    return { processed: 0, errors: 0, completeProfiles: 0, cappedProfiles: 0, hiddenProfiles: 0, elapsedSeconds: 0, listFile, outputFile: absoluteOutput, sourceStats: extracted.stats };
  }

  const launchOptions = { headless: true, args: stealth.buildLaunchArgs() };
  if (options.browserExecutablePath) launchOptions.executablePath = options.browserExecutablePath;
  let browser = await chromium.launch(launchOptions);
  let stopRequested = false;
  const requestStop = (signal) => {
    stopRequested = true;
    log(`[REVIEWERS] ${signal} received; stopping after the current reviewer boundary`);
  };
  const onSigint = () => requestStop('SIGINT');
  const onSigterm = () => requestStop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  let processed = 0;
  let errors = 0;
  let completeProfiles = 0;
  let cappedProfiles = 0;
  let hiddenProfiles = 0;
  const started = Date.now();

  writeLiveStatus({ phase: 'reviewers', total: queue.length, processed: 0, errors: 0 });
  try {
    for (let index = 0; index < queue.length; index += 1) {
      if (stopRequested) break;
      const sourceReviewer = queue[index];
      if (processed > 0 && processed % 200 === 0) {
        await browser.close().catch(() => {});
        browser = await chromium.launch(launchOptions);
      }

      for (let fetchAttempt = 1; fetchAttempt <= maxFetchRetries + 1; fetchAttempt += 1) {
        let context;
        let page;
        let shouldRetry = false;
        let shouldStop = false;
        try {
        ({ context, page } = await stealth.createStealthContext(browser, {
          geoConfig: { timezone: 'Asia/Singapore', locale: 'en-US', languages: ['en-US', 'en'] },
          blockImages: true,
          blockHeavyResources: false,
        }));
        log(`[REVIEWERS ${index + 1}/${queue.length}] ${sourceReviewer.reviewer_name || sourceReviewer.reviewer_id}`);
        writeLiveStatus({ current_reviewer_id: sourceReviewer.reviewer_id, current_reviewer_name: sourceReviewer.reviewer_name });

        const initialFetch = await fetchMasFromPage(page, sourceReviewer.reviewer_id, options);
        let parsed = parseReviewerMasResponse(initialFetch.masText, {
          reviewerId: sourceReviewer.reviewer_id,
          reviewerName: sourceReviewer.reviewer_name,
        });
        const visible = parsed.public_content.public_review_count;
        const desired = Math.max(1, Math.min(maxProfileReviews, Number.isFinite(visible) ? visible : maxProfileReviews, SERVICE_MAX_REVIEWS));
        const attemptedReviewLimits = [];
        const initialReviewCount = parsed.public_content.returned_review_count;
        let effectiveReviewLimit = initialReviewCount;
        const ladder = visible === 0 ? [] : expansionPageSizes(desired, initialReviewCount);
        let remainingLadder = ladder.length;
        const expandUrl = includeReviewMedia
          ? initialFetch.masUrl
          : setReviewerMasMediaEnabled(initialFetch.masUrl, false);

        for (const pageSize of ladder) {
          remainingLadder -= 1;
          const expanded = await fetchExpandedMas(page, expandUrl, pageSize);
          const expandedParsed = parseReviewerMasResponse(expanded.text, {
            reviewerId: sourceReviewer.reviewer_id,
            reviewerName: sourceReviewer.reviewer_name,
          });
          const expandedCount = expandedParsed.public_content.returned_review_count;
          attemptedReviewLimits.push({ requested: pageSize, returned: expandedCount });
          if (expandedCount > parsed.public_content.returned_review_count || (desired < initialReviewCount && expandedCount > 0)) {
            parsed = expandedParsed;
            effectiveReviewLimit = pageSize;
          }
          if (expandedCount >= Math.min(pageSize, Number.isFinite(visible) ? visible : pageSize)) break;
        }

        const completeness = completenessFor(parsed, maxProfileReviews, effectiveReviewLimit, {
          exhaustedFallbacks: ladder.length > 0 && remainingLadder === 0
            && attemptedReviewLimits.every((attempt) => attempt.returned === 0),
        });
        if (completeness.stop_reason === 'complete') completeProfiles += 1;
        else if (completeness.stop_reason === 'service_cap') cappedProfiles += 1;
        else if (completeness.stop_reason === 'private_or_hidden') hiddenProfiles += 1;
        else if (completeness.stop_reason === 'response_shortfall') errors += 1;

        const record = {
          extracted_at: new Date().toISOString(),
          reviewer_id: parsed.reviewer.reviewer_id || sourceReviewer.reviewer_id,
          reviewer: parsed.reviewer,
          public_content: parsed.public_content,
          activity: parsed.activity,
          completeness,
          source_summary: sourceReviewer,
          _status: {
            complete: 'complete',
            private_or_hidden: 'private_or_hidden',
            requested_limit: 'requested_limit',
            service_cap: 'service_cap',
            response_shortfall: 'error',
          }[completeness.stop_reason],
          _source: 'google_maps_reviewer_mas',
          _meta: {
            source_reviews_file: absoluteInput,
            profile_url: initialFetch.profileUrl,
            requested_review_limit: maxProfileReviews,
            service_review_cap: SERVICE_MAX_REVIEWS,
            effective_review_limit: effectiveReviewLimit,
            attempted_review_limits: attemptedReviewLimits,
            review_media_requested: includeReviewMedia,
            fetch_attempts: fetchAttempt,
          },
        };
        fs.appendFileSync(absoluteOutput, `${JSON.stringify(record)}\n`);
        if (record._status !== 'error') appendDoneId(doneSidecarPath(absoluteOutput), record.reviewer_id);
        processed += 1;
        } catch (error) {
          const message = String(error.message || error).slice(0, 1000);
          if (stopRequested) {
            shouldStop = true;
            log('  STOP: current reviewer left pending for resume');
          } else if (fetchAttempt <= maxFetchRetries) {
            shouldRetry = true;
            log(`  RETRY ${fetchAttempt}/${maxFetchRetries}: ${message}`);
          } else {
            errors += 1;
            const record = {
              extracted_at: new Date().toISOString(),
              reviewer_id: sourceReviewer.reviewer_id,
              reviewer: null,
              public_content: null,
              activity: null,
              completeness: { is_complete: false, stop_reason: 'fetch_error', visible_review_count: null, returned_review_count: 0 },
              source_summary: sourceReviewer,
              _status: 'error',
              _source: 'google_maps_reviewer_mas',
              _error: message,
              _meta: {
                source_reviews_file: absoluteInput,
                requested_review_limit: maxProfileReviews,
                service_review_cap: SERVICE_MAX_REVIEWS,
                fetch_attempts: fetchAttempt,
              },
            };
            fs.appendFileSync(absoluteOutput, `${JSON.stringify(record)}\n`);
            log(`  ERROR after ${fetchAttempt} attempts: ${record._error}`);
          }
        } finally {
          await page?.close().catch(() => {});
          await context?.close().catch(() => {});
        }

        if (shouldStop) break;
        if (!shouldRetry) break;
        await browser.close().catch(() => {});
        browser = await chromium.launch(launchOptions);
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, fetchAttempt * 1000)));
      }

      writeLiveStatus({ processed, errors, complete_profiles: completeProfiles, capped_profiles: cappedProfiles, hidden_profiles: hiddenProfiles });
      if (stopRequested) break;
      if (delayMs > 0 && index + 1 < queue.length) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  } finally {
    await browser.close().catch(() => {});
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }

  const elapsedSeconds = Math.round((Date.now() - started) / 1000);
  writeLiveStatus({ phase: stopRequested ? 'stopped' : 'complete', processed, errors, elapsed_seconds: elapsedSeconds, current_reviewer_id: null, current_reviewer_name: null });
  log(`[REVIEWERS] complete: processed=${processed} errors=${errors} capped=${cappedProfiles} hidden=${hiddenProfiles} elapsed=${elapsedSeconds}s`);
  log(`[REVIEWERS] list: ${listFile}`);
  log(`[REVIEWERS] output: ${absoluteOutput}`);
  return { processed, errors, completeProfiles, cappedProfiles, hiddenProfiles, elapsedSeconds, listFile, outputFile: absoluteOutput, sourceStats: extracted.stats };
}

module.exports = {
  GOOGLE_REVIEWER_RE,
  REVIEWER_MAS_RE,
  SERVICE_MAX_REVIEWS,
  appendDoneId,
  completedReviewerIds,
  completenessFor,
  doneSidecarPath,
  extractResumeSignal,
  expansionPageSizes,
  extractReviewerList,
  extractReviewerListFromDatabase,
  fetchExpandedMas,
  fetchMasFromPage,
  reviewerIdFromLink,
  loadReviewerList,
  scrapeReviewerProfiles,
  writeReviewerList,
};
