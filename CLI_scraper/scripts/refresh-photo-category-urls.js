#!/usr/bin/env node
/**
 * Refresh expiring photo-category image URLs by their permanent photo ids.
 *
 * Selected POIs are opened in Google Maps, then the existing
 * ListEntityPhotos RPC implementation is used to retrieve current URLs.  The
 * source review database remains read-only; results are incrementally UPSERTed
 * into a separate SQLite sidecar keyed by photo_id.
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const Database = require('better-sqlite3');
const {
  openPhotoUrlCache,
  upsertPhotoUrls,
  startRefreshRun,
  finishRefreshRun,
} = require('../src/photo-url-cache');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MAX_POIS = 10;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PHOTOS = 5000;
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_TIMEOUT_MS = 45_000;

function usage() {
  console.log(`Usage:
  node scripts/refresh-photo-category-urls.js --db FILE --cache FILE \\
    --category VALUE[,VALUE] [options]

Required:
  --db FILE                  Review SQLite database (opened read-only)
  --cache FILE               URL-cache SQLite sidecar (created if absent)
  --category VALUE[,VALUE]   Exact category key or label, case-insensitive

Selection:
  --poi-category KW[,KW]     Search main_category/categories/scraped_categories
  --max-pois N               Maximum POIs to open (default: ${DEFAULT_MAX_POIS})
  --max-images-per-poi N     Refresh only the first N stored photo ids per POI

RPC/browser:
  --page-size N              ListEntityPhotos page size (default: ${DEFAULT_PAGE_SIZE})
  --max-photos-per-category N  Pagination safety cap (default: ${DEFAULT_MAX_PHOTOS})
  --max-pages N              Pagination safety cap (default: ${DEFAULT_MAX_PAGES})
  --timeout-ms N             Navigation timeout (default: ${DEFAULT_TIMEOUT_MS})
  --delay-ms N               Delay between POIs (default: 500; 0 allowed)
  --proxy URL                Playwright proxy URL
  --headful                  Show Chromium instead of headless mode

Testing:
  --fixture FILE             Offline JSON results keyed by place_id; no browser/network
  --help                     Show help

The cache is committed once per category, so an interrupted run keeps every
successfully refreshed URL. Re-running performs explicit UPSERTs by photo_id.`);
}

function positiveInt(value, flag, { allowZero = false } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return n;
}

function splitList(value) {
  return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    db: null,
    cache: null,
    categories: [],
    poiCategories: [],
    maxPois: DEFAULT_MAX_POIS,
    maxImagesPerPoi: null,
    pageSize: DEFAULT_PAGE_SIZE,
    maxPhotosPerCategory: DEFAULT_MAX_PHOTOS,
    maxPages: DEFAULT_MAX_PAGES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    delayMs: 500,
    proxy: null,
    headful: false,
    fixture: null,
  };
  const valueFor = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--db': args.db = valueFor(i, flag); i++; break;
      case '--cache': args.cache = valueFor(i, flag); i++; break;
      case '--category': args.categories.push(...splitList(valueFor(i, flag))); i++; break;
      case '--poi-category': args.poiCategories.push(...splitList(valueFor(i, flag))); i++; break;
      case '--max-pois': args.maxPois = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--max-images-per-poi':
        args.maxImagesPerPoi = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--page-size': args.pageSize = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--max-photos-per-category':
        args.maxPhotosPerCategory = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--max-pages': args.maxPages = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--timeout-ms': args.timeoutMs = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--delay-ms': args.delayMs = positiveInt(valueFor(i, flag), flag, { allowZero: true }); i++; break;
      case '--proxy': args.proxy = valueFor(i, flag); i++; break;
      case '--headful': args.headful = true; break;
      case '--fixture': args.fixture = valueFor(i, flag); i++; break;
      case '--help': args.help = true; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  if (args.help) return args;
  if (!args.db) throw new Error('--db is required');
  if (!args.cache) throw new Error('--cache is required');
  if (args.categories.length === 0) throw new Error('--category is required');
  return args;
}

function placeholders(prefix, values, params) {
  return values.map((value, i) => {
    const name = `${prefix}${i}`;
    params[name] = value.toLowerCase();
    return `@${name}`;
  });
}

function poiPredicate(args, params, alias = 'b') {
  if (args.poiCategories.length === 0) return '1';
  return args.poiCategories.map((keyword, i) => {
    const name = `poi${i}`;
    params[name] = keyword.toLowerCase();
    return `(
      instr(lower(coalesce(${alias}.main_category, '')), @${name}) > 0 OR
      instr(lower(coalesce(${alias}.categories, '')), @${name}) > 0 OR
      instr(lower(coalesce(${alias}.scraped_categories, '')), @${name}) > 0
    )`;
  }).join(' OR ');
}

function selectionQuery(args) {
  const params = { maxPois: args.maxPois };
  const categoryNames = placeholders('category', args.categories, params);
  const poi = poiPredicate(args, params);
  const category = `(
    lower(coalesce(json_extract(c.value, '$.key'), '')) IN (${categoryNames.join(', ')}) OR
    lower(coalesce(json_extract(c.value, '$.label'), '')) IN (${categoryNames.join(', ')})
  )`;
  return {
    params,
    sql: `
      WITH selected_pois AS MATERIALIZED (
        SELECT b.place_id, b.name, b.main_category, b.categories,
               b.scraped_categories, b.photo_categories
          FROM businesses AS b
         WHERE (${poi})
           AND b.photo_categories IS NOT NULL
           AND json_valid(b.photo_categories)
           AND EXISTS (
             SELECT 1
               FROM json_each(b.photo_categories) AS c,
                    json_each(json_extract(c.value, '$.photos')) AS p
              WHERE ${category}
                AND json_extract(p.value, '$.id') IS NOT NULL
                AND json_extract(p.value, '$.id') <> ''
           )
         ORDER BY b.place_id
         LIMIT @maxPois
      )
      SELECT b.place_id, b.name AS place_name, b.main_category,
             json_extract(c.value, '$.key') AS category_key,
             json_extract(c.value, '$.label') AS category_label,
             json_extract(c.value, '$.photos') AS photos_json
        FROM selected_pois AS b,
             json_each(b.photo_categories) AS c
       WHERE ${category}
       ORDER BY b.place_id, c.key
    `,
  };
}

function validateSourceSchema(db) {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'businesses'
  `).get();
  if (!table) throw new Error('database has no businesses table');
  const columns = new Set(db.prepare('PRAGMA table_info(businesses)').all().map((r) => r.name));
  if (!columns.has('photo_categories')) {
    throw new Error('businesses table has no photo_categories column');
  }
}

function loadTargets(db, args) {
  const query = selectionQuery(args);
  const targets = [];
  let current = null;
  let keptForPoi = 0;
  for (const row of db.prepare(query.sql).iterate(query.params)) {
    if (!current || current.place_id !== row.place_id) {
      current = {
        place_id: row.place_id,
        place_name: row.place_name || null,
        main_category: row.main_category || null,
        categories: [],
      };
      targets.push(current);
      keptForPoi = 0;
    }
    let photos;
    try { photos = JSON.parse(row.photos_json || '[]'); } catch (_) { photos = []; }
    const ids = [];
    for (const photo of Array.isArray(photos) ? photos : []) {
      const id = photo && typeof photo.id === 'string' ? photo.id.trim() : '';
      if (!id) continue;
      if (args.maxImagesPerPoi !== null && keptForPoi >= args.maxImagesPerPoi) break;
      ids.push(id);
      keptForPoi++;
    }
    if (ids.length > 0) {
      current.categories.push({
        key: row.category_key || null,
        label: row.category_label || null,
        targetPhotoIds: ids,
      });
    }
  }
  return targets.filter((target) => target.categories.length > 0);
}

function matchFreshCategory(targetCategory, freshCategories) {
  const fresh = Array.isArray(freshCategories) ? freshCategories : [];
  const key = String(targetCategory.key || '').toLowerCase();
  const label = String(targetCategory.label || '').toLowerCase();
  return fresh.find((category) => key && String(category.key || '').toLowerCase() === key)
    || fresh.find((category) => label && String(category.label || '').toLowerCase() === label)
    || null;
}

function cacheFetchedCategory(cacheDb, target, category, photos, refreshedAt) {
  const rows = (Array.isArray(photos) ? photos : []).filter((photo) => (
    photo && photo.id && photo.url
  )).map((photo) => ({
    photo_id: photo.id,
    url: photo.url,
    place_id: target.place_id,
    category_key: category.key || null,
    category_label: category.label || null,
    media_type: photo.mediaType || 'photo',
    width: photo.w || null,
    height: photo.h || null,
    refreshed_at: refreshedAt,
    source: 'ListEntityPhotos',
  }));
  const targetIds = new Set(category.targetPhotoIds || []);
  const matched = rows.reduce((count, row) => count + (targetIds.has(row.photo_id) ? 1 : 0), 0);
  return { upserted: upsertPhotoUrls(cacheDb, rows, { refreshedAt }), matched, fetched: rows.length };
}

function fixtureCategoriesForPlace(fixture, placeId) {
  const entry = fixture && fixture[placeId];
  if (Array.isArray(entry)) return entry;
  return entry && Array.isArray(entry.categories) ? entry.categories : [];
}

async function processFixtureTarget(cacheDb, target, fixture, stats) {
  const freshCategories = fixtureCategoriesForPlace(fixture, target.place_id);
  for (const targetCategory of target.categories) {
    stats.categoriesAttempted++;
    const fresh = matchFreshCategory(targetCategory, freshCategories);
    if (!fresh) {
      stats.categoriesMissing++;
      continue;
    }
    const category = { ...targetCategory, key: fresh.key, label: fresh.label };
    const result = cacheFetchedCategory(
      cacheDb, target, category, fresh.photos || [], new Date().toISOString(),
    );
    stats.urlsFetched += result.fetched;
    stats.urlsUpserted += result.upserted;
    stats.targetIdsMatched += result.matched;
  }
  stats.poisSucceeded++;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processLiveTarget(cacheDb, target, args, browser, stats) {
  const stealth = require('../src/stealth');
  const photoFetcher = require('../src/photo-category-fetcher');
  const proxy = args.proxy ? { server: args.proxy } : null;
  const { context, page } = await stealth.createStealthContext(browser, { proxy });
  let previewText = null;
  const previewHandler = async (response) => {
    if (!response.url().includes('/maps/preview/place')) return;
    try {
      const text = await response.text();
      if (!previewText || text.length > previewText.length) previewText = text;
    } catch (_) {}
  };
  page.on('response', previewHandler);
  const session = photoFetcher.makeSessionCapturer(page);
  try {
    const placeId = target.place_id;
    await page.goto(
      `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(placeId)}`,
      { waitUntil: 'domcontentloaded', timeout: args.timeoutMs },
    );
    await page.waitForTimeout(1500);
    const placeUrl = placeId.startsWith('0x')
      ? `https://www.google.com/maps/place/?ftid=${encodeURIComponent(placeId)}&hl=en`
      : `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}&hl=en`;
    await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: args.timeoutMs });
    await page.waitForSelector('h1', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await session.wait(Math.min(15_000, args.timeoutMs));
    if (!previewText) throw new Error('preview/place response was not captured');
    if (!session.captured.sessionToken) throw new Error('batchexecute session token was not captured');

    const placeMeta = photoFetcher.extractPlaceMeta(previewText);
    if (!placeMeta.ftid || !placeMeta.kgId) throw new Error('preview/place has no ftid or kgId');
    const freshCategories = photoFetcher.extractPhotoCategoriesFromPreview(previewText);

    for (const targetCategory of target.categories) {
      stats.categoriesAttempted++;
      const fresh = matchFreshCategory(targetCategory, freshCategories);
      // Category keys such as Menu/CgIYIQ are stable.  Falling back to the
      // stored key also handles a preview response that omits a category tile.
      const requestCategory = fresh || targetCategory;
      if (!requestCategory.key) {
        stats.categoriesMissing++;
        continue;
      }
      const result = await photoFetcher.fetchPhotosForCategory(
        page,
        placeMeta,
        requestCategory,
        session.captured,
        {
          pageSize: args.pageSize,
          maxPhotos: args.maxPhotosPerCategory,
          maxPages: args.maxPages,
          stopWhenPhotoIds: targetCategory.targetPhotoIds,
        },
      );
      const categoryWithTargets = {
        ...targetCategory,
        key: requestCategory.key,
        label: requestCategory.label || targetCategory.label,
      };
      const cached = cacheFetchedCategory(
        cacheDb, target, categoryWithTargets, result.photos, new Date().toISOString(),
      );
      stats.urlsFetched += cached.fetched;
      stats.urlsUpserted += cached.upserted;
      stats.targetIdsMatched += cached.matched;
      console.log(
        `  ${categoryWithTargets.label || categoryWithTargets.key}: fetched=${cached.fetched}`
        + ` target-matches=${cached.matched}/${targetCategory.targetPhotoIds.length}`,
      );
    }
    stats.poisSucceeded++;
  } finally {
    page.off('response', previewHandler);
    session.detach();
    await context.close().catch(() => {});
  }
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(`Error: ${error.message}\n`);
    usage();
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }

  args.db = path.resolve(args.db);
  args.cache = path.resolve(args.cache);
  if (args.fixture) args.fixture = path.resolve(args.fixture);
  if (!fs.existsSync(args.db)) throw new Error(`database not found: ${args.db}`);
  if (args.fixture && !fs.existsSync(args.fixture)) throw new Error(`fixture not found: ${args.fixture}`);
  await fsp.mkdir(path.dirname(args.cache), { recursive: true });

  const sourceDb = new Database(args.db, { readonly: true, fileMustExist: true });
  sourceDb.pragma('query_only = ON');
  validateSourceSchema(sourceDb);
  const cacheDb = openPhotoUrlCache(args.cache);
  const targets = loadTargets(sourceDb, args);
  const targetIdsSelected = targets.reduce(
    (sum, target) => sum + target.categories.reduce((n, category) => n + category.targetPhotoIds.length, 0),
    0,
  );
  const runId = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const stats = {
    poisSelected: targets.length,
    poisAttempted: 0,
    poisSucceeded: 0,
    poisFailed: 0,
    categoriesAttempted: 0,
    categoriesMissing: 0,
    targetIdsSelected,
    targetIdsMatched: 0,
    urlsFetched: 0,
    urlsUpserted: 0,
  };
  startRefreshRun(cacheDb, {
    run_id: runId,
    started_at: new Date().toISOString(),
    source_db: args.db,
    selection: {
      categories: args.categories,
      poi_categories: args.poiCategories,
      max_pois: args.maxPois,
      max_images_per_poi: args.maxImagesPerPoi,
      fixture: args.fixture,
    },
  });

  console.log(`Source:   ${args.db}`);
  console.log(`Cache:    ${args.cache}`);
  console.log(`Selected: ${targets.length} POIs, ${targetIdsSelected} permanent photo ids`);

  let browser = null;
  let fatalError = null;
  try {
    let fixture = null;
    if (args.fixture) {
      fixture = JSON.parse(await fsp.readFile(args.fixture, 'utf8'));
      console.log(`Mode:     offline fixture (${args.fixture})`);
    } else {
      if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
        const localBrowsers = path.join(ROOT, '.playwright-browsers');
        if (fs.existsSync(localBrowsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
      }
      const { chromium } = require('playwright');
      const stealth = require('../src/stealth');
      browser = await chromium.launch({ headless: !args.headful, args: stealth.buildLaunchArgs() });
    }

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      stats.poisAttempted++;
      console.log(`[${i + 1}/${targets.length}] ${target.place_name || target.place_id} (${target.place_id})`);
      try {
        if (fixture) await processFixtureTarget(cacheDb, target, fixture, stats);
        else await processLiveTarget(cacheDb, target, args, browser, stats);
      } catch (error) {
        stats.poisFailed++;
        console.error(`  failed: ${error.message}`);
      }
      if (!fixture && args.delayMs > 0 && i + 1 < targets.length) await sleep(args.delayMs);
    }
    finishRefreshRun(cacheDb, runId, { status: 'completed', stats });
  } catch (error) {
    fatalError = error;
    finishRefreshRun(cacheDb, runId, { status: 'aborted', stats, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
    sourceDb.close();
    cacheDb.close();
  }

  console.log(
    `Done: POIs=${stats.poisSucceeded}/${stats.poisAttempted}`
    + ` target-matches=${stats.targetIdsMatched}/${stats.targetIdsSelected}`
    + ` cache-upserts=${stats.urlsUpserted}`,
  );
  if (fatalError) throw fatalError;
  if (stats.poisFailed > 0 || stats.targetIdsMatched < stats.targetIdsSelected) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`FATAL: ${error.stack || error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  selectionQuery,
  loadTargets,
  matchFreshCategory,
  cacheFetchedCategory,
  fixtureCategoriesForPlace,
};
