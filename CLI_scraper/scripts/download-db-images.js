#!/usr/bin/env node
/**
 * Stream image references directly from a review SQLite database and download
 * only the requested subset.  The SQLite iterator and bounded promise pool
 * keep memory use independent of database size.
 *
 * Examples:
 *   node scripts/download-db-images.js \
 *     --db city_reviews.db --output menu-images \
 *     --source photo-categories --category menu \
 *     --poi-category restaurant,cafe,bakery \
 *     --max-pois 10 --max-images-per-poi 2 --concurrency 4
 *
 *   node scripts/download-db-images.js \
 *     --db city_reviews.db --output review-images \
 *     --source review-images --max-pois 10 --max-images-per-poi 2 --dry-run
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');
const Database = require('better-sqlite3');
const {
  stripSizeSuffix,
  appendSizeSuffix,
  sha256,
  safePathSegment,
} = require('../src/image-fetcher');
const { makeProxyAgent } = require('../src/proxy-fetch');
const { openPhotoUrlCache, preparePhotoUrlLookup } = require('../src/photo-url-cache');

const DEFAULT_SIZE = 's1024-w1024-h1024-k-no';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;

function usage() {
  console.log(`Usage:
  node scripts/download-db-images.js --db FILE --output DIR --source SOURCE [options]

Required:
  --db FILE                  Review SQLite database
  --output DIR               Download root (also contains manifest.ndjson)
  --source SOURCE            photo-categories | review-images

Selection:
  --category VALUE[,VALUE]   photo category key or label (case-insensitive)
                             Required for --source photo-categories
  --poi-category KW[,KW]     Optional case-insensitive POI category keywords;
                             searches main_category/categories/scraped_categories
  --include-video            Include photo-category video thumbnails (default: no)
  --max-pois N               Maximum matching POIs (default: unlimited)
  --max-images-per-poi N     Maximum images per POI (default: unlimited)
  --max-images N             Global image limit (default: unlimited)
  --sample-strategy MODE     first | even (default: first). even requires
                             review-images and --max-images
  --url-cache FILE           Optional refreshed-URL SQLite sidecar, keyed by
                             photo_id (photo-categories only)

Download:
  --concurrency N            Concurrent requests (default: 4)
  --size-suffix SUFFIX       Google image suffix (default: ${DEFAULT_SIZE}; raw keeps URL)
  --size SUFFIX              Alias for --size-suffix
  --timeout-ms N             Request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --retries N                Total attempts per image (default: ${DEFAULT_RETRIES})
  --proxy URL                HTTPS proxy (or HTTPS_PROXY / ALL_PROXY)
  --bind IP                  Bind requests to a source IP
  --dry-run                  Stream the selection and write manifest; do not download
  --help                     Show this help

Output is stored under by-poi/. Existing non-empty files are skipped, making
the command safe to resume. Every planned, downloaded, skipped, or failed item
is appended to manifest.ndjson.`);
}

function positiveInt(value, flag, { allowZero = false } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return n;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    db: null,
    output: null,
    source: null,
    categories: [],
    poiCategories: [],
    maxPois: null,
    maxImagesPerPoi: null,
    maxImages: null,
    sampleStrategy: 'first',
    includeVideo: false,
    concurrency: 4,
    size: DEFAULT_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
    proxy: null,
    bind: null,
    dryRun: false,
    urlCache: null,
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
      case '--output': args.output = valueFor(i, flag); i++; break;
      case '--source': args.source = valueFor(i, flag); i++; break;
      case '--category': args.categories.push(...splitList(valueFor(i, flag))); i++; break;
      case '--poi-category': args.poiCategories.push(...splitList(valueFor(i, flag))); i++; break;
      case '--max-pois': args.maxPois = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--max-images-per-poi':
        args.maxImagesPerPoi = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--max-images': args.maxImages = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--sample-strategy': args.sampleStrategy = valueFor(i, flag).toLowerCase(); i++; break;
      case '--include-video': args.includeVideo = true; break;
      case '--concurrency': args.concurrency = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--size':
      case '--size-suffix': args.size = valueFor(i, flag); i++; break;
      case '--timeout-ms': args.timeoutMs = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--retries': args.retries = positiveInt(valueFor(i, flag), flag); i++; break;
      case '--proxy': args.proxy = valueFor(i, flag); i++; break;
      case '--bind': args.bind = valueFor(i, flag); i++; break;
      case '--dry-run': args.dryRun = true; break;
      case '--url-cache': args.urlCache = valueFor(i, flag); i++; break;
      case '--help': args.help = true; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }

  if (args.help) return args;
  if (!args.db) throw new Error('--db is required');
  if (!args.output) throw new Error('--output is required');
  if (!args.source) throw new Error('--source is required');
  args.source = args.source.toLowerCase().replace(/_/g, '-');
  if (!['photo-categories', 'review-images'].includes(args.source)) {
    throw new Error('--source must be photo-categories or review-images');
  }
  if (args.source === 'photo-categories' && args.categories.length === 0) {
    throw new Error('--category is required for --source photo-categories');
  }
  if (args.source === 'review-images' && args.categories.length > 0) {
    throw new Error('--category applies only to --source photo-categories');
  }
  if (args.source !== 'photo-categories' && args.urlCache) {
    throw new Error('--url-cache applies only to --source photo-categories');
  }
  if (!['first', 'even'].includes(args.sampleStrategy)) {
    throw new Error('--sample-strategy must be first or even');
  }
  if (args.sampleStrategy === 'even') {
    if (args.source !== 'review-images') {
      throw new Error('--sample-strategy even is supported only for review-images');
    }
    if (args.maxImages === null) throw new Error('--sample-strategy even requires --max-images');
    if (args.maxImages > 10_000) {
      throw new Error('--sample-strategy even supports at most 10000 samples per run');
    }
  }
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

function categoryPredicate(args, params, categoryAlias = 'c') {
  const names = placeholders('category', args.categories, params);
  return `(
    lower(coalesce(json_extract(${categoryAlias}.value, '$.key'), '')) IN (${names.join(', ')}) OR
    lower(coalesce(json_extract(${categoryAlias}.value, '$.label'), '')) IN (${names.join(', ')})
  )`;
}

function photoCategoryQuery(args) {
  const params = {};
  const poi = poiPredicate(args, params);
  const category = categoryPredicate(args, params);
  const media = args.includeVideo
    ? '1'
    : "lower(coalesce(json_extract(p.value, '$.mediaType'), 'photo')) <> 'video'";
  if (args.maxPois === null) {
    return {
      params,
      sql: `
        SELECT b.place_id, b.name AS place_name, b.main_category,
               json_extract(c.value, '$.key') AS category_key,
               json_extract(c.value, '$.label') AS category_label,
               CAST(p.key AS INTEGER) AS image_index,
               json_extract(p.value, '$.id') AS photo_id,
               coalesce(json_extract(p.value, '$.mediaType'), 'photo') AS media_type,
               json_extract(p.value, '$.url') AS url
          FROM businesses AS b,
               json_each(b.photo_categories) AS c,
               json_each(json_extract(c.value, '$.photos')) AS p
         WHERE (${poi})
           AND b.photo_categories IS NOT NULL
           AND json_valid(b.photo_categories)
           AND ${category}
           AND ${media}
           AND json_extract(p.value, '$.url') IS NOT NULL
           AND json_extract(p.value, '$.url') <> ''
         ORDER BY b.place_id, c.key, p.key
      `,
    };
  }
  params.maxPois = args.maxPois;
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
                AND json_extract(p.value, '$.url') IS NOT NULL
                AND json_extract(p.value, '$.url') <> ''
                AND ${media}
           )
         ORDER BY b.place_id
         LIMIT @maxPois
      )
      SELECT b.place_id, b.name AS place_name, b.main_category,
             json_extract(c.value, '$.key') AS category_key,
             json_extract(c.value, '$.label') AS category_label,
             CAST(p.key AS INTEGER) AS image_index,
             json_extract(p.value, '$.id') AS photo_id,
             coalesce(json_extract(p.value, '$.mediaType'), 'photo') AS media_type,
             json_extract(p.value, '$.url') AS url
        FROM selected_pois AS b,
             json_each(b.photo_categories) AS c,
             json_each(json_extract(c.value, '$.photos')) AS p
       WHERE ${category}
         AND ${media}
         AND json_extract(p.value, '$.url') IS NOT NULL
         AND json_extract(p.value, '$.url') <> ''
       ORDER BY b.place_id, c.key, p.key
    `,
  };
}

function reviewSelectedPoisCte(args, params) {
  const poi = poiPredicate(args, params);
  return `
    selected_pois AS MATERIALIZED (
      SELECT b.place_id, b.name, b.main_category
        FROM businesses AS b
       WHERE (${poi})
         AND EXISTS (
           SELECT 1 FROM review_images AS candidate
            WHERE candidate.place_id = b.place_id
              AND candidate.url IS NOT NULL AND candidate.url <> ''
         )
       ORDER BY b.place_id
       LIMIT @maxPois
    )
  `;
}

function reviewImageBounds(db, args) {
  const params = {};
  if (args.maxPois !== null) {
    params.maxPois = args.maxPois;
    const cte = reviewSelectedPoisCte(args, params);
    return db.prepare(`
      WITH ${cte}
      SELECT MIN(ri.id) AS min_id, MAX(ri.id) AS max_id
        FROM review_images AS ri
        JOIN selected_pois AS b ON b.place_id = ri.place_id
       WHERE ri.url IS NOT NULL AND ri.url <> ''
    `).get(params);
  }

  const poi = poiPredicate(args, params);
  return db.prepare(`
    SELECT MIN(ri.id) AS min_id, MAX(ri.id) AS max_id
      FROM review_images AS ri
      JOIN businesses AS b ON b.place_id = ri.place_id
     WHERE (${poi}) AND ri.url IS NOT NULL AND ri.url <> ''
  `).get(params);
}

function evenTargets(bounds, count) {
  if (bounds.min_id == null || bounds.max_id == null || count <= 0) return [];
  if (count === 1 || bounds.min_id === bounds.max_id) return [bounds.min_id];
  const range = bounds.max_id - bounds.min_id;
  return Array.from({ length: count }, (_, i) => (
    Math.round(bounds.min_id + (range * i) / (count - 1))
  ));
}

function reviewImageQuery(args, bounds = null) {
  const params = {};
  const ctes = [];
  let outerFrom;
  let outerPoi = '1';
  let candidateFrom;
  let candidatePoi = '1';
  let samplingJoin = '';

  if (args.maxPois !== null) {
    params.maxPois = args.maxPois;
    ctes.push(reviewSelectedPoisCte(args, params));
    outerFrom = `selected_pois AS b
        JOIN review_images AS ri ON ri.place_id = b.place_id`;
    candidateFrom = `review_images AS candidate
            JOIN selected_pois AS selected ON selected.place_id = candidate.place_id`;
  } else {
    outerFrom = `review_images AS ri
        JOIN businesses AS b ON b.place_id = ri.place_id`;
    outerPoi = poiPredicate(args, params, 'b');
    candidateFrom = `review_images AS candidate
            JOIN businesses AS eligible ON eligible.place_id = candidate.place_id`;
    candidatePoi = poiPredicate(args, params, 'eligible');
  }

  if (args.sampleStrategy === 'even') {
    const targets = evenTargets(bounds || {}, args.maxImages);
    if (targets.length === 0) {
      return { params: {}, sql: 'SELECT NULL WHERE 0' };
    }
    const values = targets.map((target, i) => {
      params[`target${i}`] = target;
      return `(@target${i})`;
    }).join(', ');
    ctes.push(`sample_targets(target_id) AS (VALUES ${values})`);
    ctes.push(`
      sample_ids(id) AS MATERIALIZED (
        SELECT DISTINCT (
          SELECT candidate.id
            FROM ${candidateFrom}
           WHERE candidate.id >= sample_targets.target_id
             AND (${candidatePoi})
             AND candidate.url IS NOT NULL AND candidate.url <> ''
           ORDER BY candidate.id
           LIMIT 1
        ) AS id
          FROM sample_targets
      )
    `);
    samplingJoin = 'JOIN sample_ids AS sampled ON sampled.id = ri.id';
  }

  const withClause = ctes.length > 0 ? `WITH ${ctes.join(',\n')}` : '';
  return {
    params,
    sql: `
      ${withClause}
      SELECT b.place_id, b.name AS place_name, b.main_category,
             ri.review_id, ri.image_index, ri.source AS image_source, ri.url,
             'photo' AS media_type
        FROM ${outerFrom}
        ${samplingJoin}
       WHERE (${outerPoi}) AND ri.url IS NOT NULL AND ri.url <> ''
       ORDER BY ${args.sampleStrategy === 'even' ? 'ri.id' : 'ri.place_id, ri.id'}
    `,
  };
}

function validateSchema(db, source) {
  const tables = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type IN ('table', 'view')
  `).pluck().all());
  if (!tables.has('businesses')) throw new Error('database has no businesses table');
  if (source === 'review-images' && !tables.has('review_images')) {
    throw new Error('database has no review_images table');
  }
  if (source === 'photo-categories') {
    const columns = new Set(db.prepare('PRAGMA table_info(businesses)').all().map((r) => r.name));
    if (!columns.has('photo_categories')) {
      throw new Error('businesses table has no photo_categories column');
    }
  }
}

function safePlaceDirectory(row) {
  const placeId = safePathSegment(row.place_id, 100) || sha256(String(row.place_id)).slice(0, 24);
  const name = safePathSegment(row.place_name, 50);
  return name ? `${placeId}--${name}` : placeId;
}

function planOutput(args, row) {
  const { base } = stripSizeSuffix(row.url);
  const stablePhotoId = args.source === 'photo-categories' && row.photo_id
    ? String(row.photo_id)
    : null;
  const identitySource = stablePhotoId ? 'photo-id' : 'url-base';
  const identity = stablePhotoId || base;
  const hash = sha256(identity);
  const placeDir = safePlaceDirectory(row);
  let leaf;
  if (args.source === 'photo-categories') {
    const category = safePathSegment(row.category_label || row.category_key || 'unknown', 60)
      || sha256(String(row.category_key || row.category_label || 'unknown')).slice(0, 16);
    leaf = path.join('photo-categories', category);
  } else {
    leaf = 'review-images';
  }
  const relativePath = path.join('by-poi', placeDir, leaf, `${hash}.jpg`);
  return {
    hash,
    identitySource,
    urlBaseHash: sha256(base),
    urlBase: base,
    requestUrl: appendSizeSuffix(row.url, args.size),
    relativePath,
    absolutePath: path.join(args.output, relativePath),
  };
}

class NdjsonWriter {
  constructor(filePath) {
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.chain = Promise.resolve();
    this.error = null;
    this.stream.on('error', (error) => { this.error = error; });
  }

  write(row) {
    const line = `${JSON.stringify(row)}\n`;
    this.chain = this.chain.then(() => new Promise((resolve, reject) => {
      if (this.error) return reject(this.error);
      this.stream.write(line, (error) => error ? reject(error) : resolve());
    }));
    return this.chain;
  }

  async close() {
    await this.chain;
    await new Promise((resolve, reject) => {
      this.stream.end((error) => error ? reject(error) : resolve());
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function imageMetadata(buffer, contentType = null) {
  const result = {
    mime: contentType ? String(contentType).split(';', 1)[0].trim() : null,
    width: null,
    height: null,
  };
  if (!buffer || buffer.length < 10) return result;

  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) {
    result.mime ||= 'image/png';
    result.width = buffer.readUInt32BE(16);
    result.height = buffer.readUInt32BE(20);
    return result;
  }
  const gif = buffer.subarray(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    result.mime ||= 'image/gif';
    result.width = buffer.readUInt16LE(6);
    result.height = buffer.readUInt16LE(8);
    return result;
  }
  if (buffer.length >= 30 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    result.mime ||= 'image/webp';
    const kind = buffer.subarray(12, 16).toString('ascii');
    if (kind === 'VP8X') {
      result.width = 1 + buffer.readUIntLE(24, 3);
      result.height = 1 + buffer.readUIntLE(27, 3);
    } else if (kind === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      result.width = buffer.readUInt16LE(26) & 0x3fff;
      result.height = buffer.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && buffer[20] === 0x2f) {
      result.width = 1 + buffer[21] + ((buffer[22] & 0x3f) << 8);
      result.height = 1 + ((buffer[22] & 0xc0) >> 6) + (buffer[23] << 2)
        + ((buffer[24] & 0x0f) << 10);
    }
    return result;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    result.mime ||= 'image/jpeg';
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      while (offset < buffer.length && buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xd8 || marker === 0x01) continue;
      if (marker === 0xd9 || marker === 0xda || offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (sof.has(marker) && length >= 7) {
        result.height = buffer.readUInt16BE(offset + 3);
        result.width = buffer.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  }
  return result;
}

function requestToFile(url, tempPath, args, redirects = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (error) { reject(error); return; }
    if (parsed.protocol !== 'https:') {
      reject(new Error(`unsupported URL protocol: ${parsed.protocol}`));
      return;
    }
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: args.timeoutMs,
    };
    if (args.bind) options.localAddress = args.bind;

    const req = https.get(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error('too many redirects'));
          return;
        }
        if (!res.headers.location) {
          reject(new Error('redirect with no Location'));
          return;
        }
        const redirectUrl = new URL(res.headers.location, url).toString();
        requestToFile(redirectUrl, tempPath, args, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        const error = new Error(`HTTP ${res.statusCode}`);
        error.statusCode = res.statusCode;
        error.retryable = res.statusCode === 429 || res.statusCode === 503 || res.statusCode >= 500;
        const retryAfter = Number.parseInt(res.headers['retry-after'] || '', 10);
        if (Number.isFinite(retryAfter)) error.retryAfterMs = retryAfter * 1000;
        reject(error);
        return;
      }

      let bytes = 0;
      let prefixBytes = 0;
      const prefixChunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (prefixBytes < 65_536) {
          const part = chunk.subarray(0, Math.min(chunk.length, 65_536 - prefixBytes));
          prefixChunks.push(part);
          prefixBytes += part.length;
        }
      });
      const output = fs.createWriteStream(tempPath, { flags: 'wx' });
      pipeline(res, output).then(() => {
        const metadata = imageMetadata(Buffer.concat(prefixChunks, prefixBytes), res.headers['content-type']);
        resolve({ bytes, ...metadata });
      }, reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

async function existingFileInfo(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const handle = await fsp.open(filePath, 'r');
    try {
      const prefix = Buffer.allocUnsafe(Math.min(65_536, stat.size));
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      return { bytes: stat.size, ...imageMetadata(prefix.subarray(0, bytesRead)) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function downloadWithRetries(plan, args) {
  await fsp.mkdir(path.dirname(plan.absolutePath), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= args.retries; attempt++) {
    const tempPath = `${plan.absolutePath}.part-${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}`;
    try {
      const result = await requestToFile(plan.requestUrl, tempPath, args);
      if (result.bytes < 1024) throw new Error(`payload too small (${result.bytes} bytes)`);
      await fsp.rename(tempPath, plan.absolutePath);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      await fsp.unlink(tempPath).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      if (attempt >= args.retries || error.retryable === false) break;
      const delay = error.retryAfterMs || Math.min(10_000, 500 * (2 ** (attempt - 1)));
      await sleep(delay);
    }
  }
  lastError.attempts = args.retries;
  throw lastError;
}

function manifestBase(runId, args, row, plan) {
  const databaseUrl = row._database_url || row.url;
  const cacheHit = Boolean(row._url_cache_hit);
  return {
    type: 'image',
    run_id: runId,
    timestamp: new Date().toISOString(),
    source: args.source,
    place_id: row.place_id,
    place_name: row.place_name || null,
    poi_category: row.main_category || null,
    category_key: row.category_key || null,
    category_label: row.category_label || null,
    review_id: row.review_id || null,
    image_index: row.image_index ?? null,
    media_type: row.media_type || 'photo',
    photo_id: row.photo_id || null,
    sha256_identity: plan.hash,
    identity_source: plan.identitySource,
    sha256_url_base: plan.urlBaseHash,
    original_url: databaseUrl,
    database_url: databaseUrl,
    db_original_url: databaseUrl,
    resolved_url: row.url,
    cache_url: cacheHit ? row.url : null,
    cache_hit: cacheHit,
    url_source: cacheHit ? 'photo-url-cache' : 'database',
    url_cache_refreshed_at: row._url_cache_refreshed_at || null,
    url_cache_source: row._url_cache_source || null,
    fetch_url: plan.requestUrl,
    relative_path: plan.relativePath,
  };
}

async function processRow(runId, args, row, writer, stats) {
  const started = Date.now();
  const plan = planOutput(args, row);
  const base = manifestBase(runId, args, row, plan);
  stats.planned++;

  if (args.dryRun) {
    stats.dryRun++;
    await writer.write({ ...base, status: 'dry-run', elapsed_ms: Date.now() - started });
    return;
  }

  const existing = await existingFileInfo(plan.absolutePath);
  if (existing !== null) {
    stats.skipped++;
    stats.bytesExisting += existing.bytes;
    await writer.write({
      ...base, status: 'skipped-existing', ...existing, elapsed_ms: Date.now() - started,
    });
    return;
  }

  try {
    const result = await downloadWithRetries(plan, args);
    stats.downloaded++;
    stats.bytesDownloaded += result.bytes;
    await writer.write({
      ...base,
      status: 'downloaded',
      bytes: result.bytes,
      mime: result.mime,
      width: result.width,
      height: result.height,
      attempts: result.attempts,
      elapsed_ms: Date.now() - started,
    });
  } catch (error) {
    stats.failed++;
    await writer.write({
      ...base,
      status: 'failed',
      attempts: error.attempts || args.retries,
      http_status: error.statusCode || null,
      error: String(error.message || error).slice(0, 500),
      elapsed_ms: Date.now() - started,
    });
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
  args.output = path.resolve(args.output);
  if (args.urlCache) args.urlCache = path.resolve(args.urlCache);
  if (!fs.existsSync(args.db)) throw new Error(`database not found: ${args.db}`);
  if (args.urlCache && !fs.existsSync(args.urlCache)) {
    throw new Error(`URL cache not found: ${args.urlCache}`);
  }
  await fsp.mkdir(args.output, { recursive: true });

  const proxyUrl = args.proxy || process.env.HTTPS_PROXY || process.env.ALL_PROXY || null;
  if (proxyUrl) https.globalAgent = makeProxyAgent(proxyUrl);

  const runId = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const manifestPath = path.join(args.output, 'manifest.ndjson');
  const writer = new NdjsonWriter(manifestPath);
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  validateSchema(db, args.source);
  const urlCacheDb = args.urlCache
    ? openPhotoUrlCache(args.urlCache, { readonly: true, fileMustExist: true })
    : null;
  const lookupCachedUrl = urlCacheDb ? preparePhotoUrlLookup(urlCacheDb) : null;

  const bounds = args.source === 'review-images' && args.sampleStrategy === 'even'
    ? reviewImageBounds(db, args)
    : null;
  const query = args.source === 'photo-categories'
    ? photoCategoryQuery(args)
    : reviewImageQuery(args, bounds);
  const stats = {
    planned: 0,
    dryRun: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    bytesDownloaded: 0,
    bytesExisting: 0,
    pois: 0,
    urlCacheHits: 0,
    urlCacheMisses: 0,
  };
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  await writer.write({
    type: 'run-start', run_id: runId, timestamp: startedAt,
    db: args.db, source: args.source, categories: args.categories,
    poi_categories: args.poiCategories, max_pois: args.maxPois,
    max_images_per_poi: args.maxImagesPerPoi, max_images: args.maxImages,
    sample_strategy: args.sampleStrategy, size_suffix: args.size,
    include_video: args.includeVideo,
    url_cache: args.urlCache,
    concurrency: args.concurrency, dry_run: args.dryRun,
  });

  console.log(`Database: ${args.db}`);
  console.log(`Source:   ${args.source}`);
  console.log(`Output:   ${args.output}`);
  if (args.dryRun) console.log('Mode:     dry-run');

  const active = new Set();
  let currentPlace = null;
  let imagesForPlace = 0;
  let selectedRows = 0;
  const sampledPerPlace = args.sampleStrategy === 'even' ? new Map() : null;

  try {
    for (const selectedRow of db.prepare(query.sql).iterate(query.params)) {
      if (args.maxImages !== null && selectedRows >= args.maxImages) break;

      let row = selectedRow;

      if (sampledPerPlace) {
        const seen = sampledPerPlace.get(row.place_id) || 0;
        if (args.maxImagesPerPoi !== null && seen >= args.maxImagesPerPoi) continue;
        if (seen === 0) stats.pois++;
        sampledPerPlace.set(row.place_id, seen + 1);
      } else {
        if (row.place_id !== currentPlace) {
          currentPlace = row.place_id;
          imagesForPlace = 0;
          stats.pois++;
        }
        if (args.maxImagesPerPoi !== null && imagesForPlace >= args.maxImagesPerPoi) continue;
        imagesForPlace++;
      }
      selectedRows++;

      if (lookupCachedUrl) {
        const cached = lookupCachedUrl(selectedRow.photo_id);
        if (cached && cached.url) {
          row = {
            ...selectedRow,
            url: cached.url,
            _database_url: selectedRow.url,
            _url_cache_hit: true,
            _url_cache_refreshed_at: cached.refreshed_at,
            _url_cache_source: cached.source,
          };
          stats.urlCacheHits++;
        } else {
          stats.urlCacheMisses++;
        }
      }

      const promise = processRow(runId, args, row, writer, stats)
        .finally(() => active.delete(promise));
      active.add(promise);
      if (active.size >= args.concurrency) await Promise.race(active);

      if (stats.planned > 0 && stats.planned % 100 === 0) {
        console.log(`Progress: POIs=${stats.pois} planned=${stats.planned} downloaded=${stats.downloaded} failed=${stats.failed}`);
      }
    }
    await Promise.all(active);
    const elapsedSeconds = (Date.now() - startedMs) / 1000;
    await writer.write({
      type: 'run-end', run_id: runId, timestamp: new Date().toISOString(),
      status: 'completed', ...stats,
      success: stats.downloaded, failure: stats.failed, skip: stats.skipped,
      total_bytes: stats.bytesDownloaded + stats.bytesExisting,
      elapsed_seconds: elapsedSeconds,
    });
  } catch (error) {
    await Promise.allSettled(active);
    const elapsedSeconds = (Date.now() - startedMs) / 1000;
    await writer.write({
      type: 'run-end', run_id: runId, timestamp: new Date().toISOString(),
      status: 'aborted', error: String(error.message || error).slice(0, 500), ...stats,
      success: stats.downloaded, failure: stats.failed, skip: stats.skipped,
      total_bytes: stats.bytesDownloaded + stats.bytesExisting,
      elapsed_seconds: elapsedSeconds,
    });
    throw error;
  } finally {
    db.close();
    if (urlCacheDb) urlCacheDb.close();
    await writer.close();
  }

  const elapsedSeconds = (Date.now() - startedMs) / 1000;
  const totalBytes = stats.bytesDownloaded + stats.bytesExisting;
  console.log(`Done: POIs=${stats.pois} planned=${stats.planned} success=${stats.downloaded} failed=${stats.failed} skipped=${stats.skipped}`);
  console.log(`Bytes: downloaded=${stats.bytesDownloaded} existing=${stats.bytesExisting} total=${totalBytes}`);
  console.log(`Elapsed: ${elapsedSeconds.toFixed(3)}s`);
  if (stats.bytesDownloaded > 0 && elapsedSeconds > 0) {
    console.log(`Throughput: ${(stats.bytesDownloaded / elapsedSeconds).toFixed(0)} bytes/s`);
  }
  console.log(`Manifest: ${manifestPath}`);
  if (stats.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`FATAL: ${error.stack || error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  photoCategoryQuery,
  reviewImageQuery,
  planOutput,
};
