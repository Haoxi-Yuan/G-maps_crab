const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');
const { computeHash, normalizeOpeningHours, normalizePopularTimes, log, formatDuration } = require('./utils');

const SQLITE_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];

function normalizeCity(city) {
  if (city === undefined || city === null) return null;
  const value = String(city).trim();
  if (!value || value.toUpperCase() === 'ALL') return null;
  return value || null;
}

function detectFormat(sourcePath) {
  const stat = fs.statSync(sourcePath);

  if (stat.isFile()) {
    const ext = path.extname(sourcePath).toLowerCase();
    if (sourcePath.endsWith('.ndjson')) return 'new';
    if (SQLITE_EXTENSIONS.includes(ext)) return 'sqlite';
  }

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(sourcePath);
    const hasNdjson = entries.some(f => f.endsWith('.ndjson'));
    if (hasNdjson) return 'new';

    const hasPoiDirs = entries.some(dir => {
      const dirPath = path.join(sourcePath, dir);
      if (!fs.statSync(dirPath).isDirectory()) return false;
      const subEntries = fs.readdirSync(dirPath);
      return subEntries.some(f => f.startsWith('ChIJ') || f.startsWith('0x'));
    });
    if (hasPoiDirs) return 'old';
  }

  return null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseMaybeJSON(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (!(raw.startsWith('{') || raw.startsWith('['))) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function inferCityFromAddress(address) {
  if (!address) return null;
  if (Array.isArray(address)) {
    return inferCityFromAddress(address.join(', '));
  }
  if (typeof address !== 'string') return null;
  const parts = address
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const singaporeHit = parts.find(p => /singapore/i.test(p));
  if (singaporeHit) return 'Singapore';

  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[parts.length - 1];
}

function computeOptionalHash(value, normalizer) {
  const parsed = parseMaybeJSON(value) ?? value;
  const normalized = normalizer(parsed);
  return normalized ? computeHash(normalized) : null;
}

function resolveColumn(columns, candidates) {
  const lowered = new Map(columns.map(c => [c.toLowerCase(), c]));
  for (const candidate of candidates) {
    const hit = lowered.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function escapeIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function importOldFormat(sourcePath, db, options = {}) {
  const startTime = Date.now();
  const forcedCity = normalizeCity(options.city);
  const stats = {
    totalFiles: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
    nullRating: 0,
    nullReviewCount: 0,
    categories: new Set()
  };

  const categories = fs.readdirSync(sourcePath).filter(entry => {
    const fullPath = path.join(sourcePath, entry);
    return fs.statSync(fullPath).isDirectory();
  });

  log('info', `Found ${categories.length} category directories`);

  let batch = [];
  const BATCH_SIZE = 1000;

  for (const category of categories) {
    stats.categories.add(category);
    const categoryPath = path.join(sourcePath, category);
    const poiDirs = fs.readdirSync(categoryPath).filter(entry => {
      const fullPath = path.join(categoryPath, entry);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const poiDir of poiDirs) {
      stats.totalFiles++;

      try {
        const revDataPath = path.join(categoryPath, poiDir, 'rev_data');
        let dataFile = path.join(revDataPath, 'reviews.json');
        if (!fs.existsSync(dataFile)) {
          dataFile = path.join(revDataPath, 'reviews_enriched.json');
        }
        if (!fs.existsSync(dataFile)) {
          stats.skipped++;
          continue;
        }

        const raw = fs.readFileSync(dataFile, 'utf8');
        const data = JSON.parse(raw);

        const placeId = data.place?.place_id || poiDir;
        const name = data.place?.name || null;
        const rating = data.place?.rating ?? null;
        const reviewCount = data.place?.reviews ?? data.scrape_info?.review_count ?? null;

        if (rating === null) stats.nullRating++;
        if (reviewCount === null) stats.nullReviewCount++;

        batch.push({
          placeId,
          name,
          city: forcedCity || inferCityFromAddress(data.place?.address || data.place?.full_address),
          reviewCount,
          rating,
          openingHoursHash: null,
          popularTimesHash: null,
          status: 'active',
          sourceFormat: 'old'
        });

        if (batch.length >= BATCH_SIZE) {
          db.upsertPoiBatch(batch);
          stats.imported += batch.length;
          batch = [];
          process.stdout.write(`\r  Imported: ${stats.imported} POIs...`);
        }
      } catch (err) {
        stats.errors++;
        if (stats.errors <= 5) {
          log('warn', `Error reading ${poiDir}: ${err.message}`);
        }
      }
    }
  }

  if (batch.length > 0) {
    db.upsertPoiBatch(batch);
    stats.imported += batch.length;
  }

  const duration = Date.now() - startTime;
  console.log('');
  log('info', `Old format import completed in ${formatDuration(duration)}`);

  return {
    totalFiles: stats.totalFiles,
    imported: stats.imported,
    skipped: stats.skipped,
    errors: stats.errors,
    nullRating: stats.nullRating,
    nullReviewCount: stats.nullReviewCount,
    categories: stats.categories.size,
    city: forcedCity || null,
    uniquePois: db.getPoiCount(),
    duration
  };
}

async function importNewFormat(sourcePath, db, options = {}) {
  const startTime = Date.now();
  const forcedCity = normalizeCity(options.city);
  const stats = {
    totalLines: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
    nullRating: 0,
    nullReviewCount: 0,
    withOpeningHours: 0,
    withPopularTimes: 0
  };

  const ndjsonFiles = [];
  const stat = fs.statSync(sourcePath);

  if (stat.isFile()) {
    ndjsonFiles.push(sourcePath);
  } else if (stat.isDirectory()) {
    const entries = fs.readdirSync(sourcePath);
    for (const entry of entries) {
      if (entry.endsWith('.ndjson')) {
        ndjsonFiles.push(path.join(sourcePath, entry));
      }
    }
  }

  log('info', `Found ${ndjsonFiles.length} NDJSON file(s) to import`);

  for (const filePath of ndjsonFiles) {
    log('info', `Processing: ${path.basename(filePath)}`);

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let batch = [];
    const BATCH_SIZE = 1000;

    for await (const line of rl) {
      if (!line.trim()) continue;
      stats.totalLines++;

      try {
        const data = JSON.parse(line);

        const placeId = data.business?.placeId;
        if (!placeId) {
          stats.skipped++;
          continue;
        }

        const name = data.business?.name || null;
        const rating = data.business?.rating ?? null;
        const reviewCount = data.business?.reviewCount
          ?? (Array.isArray(data.detailedReviews) && data.detailedReviews.length > 0
            ? data.detailedReviews.length
            : null);

        const navigablePlaceId = data._meta?.placeId || null;

        if (rating === null) stats.nullRating++;
        if (reviewCount === null) stats.nullReviewCount++;

        let openingHoursHash = null;
        const normalizedOH = normalizeOpeningHours(data.openingHours);
        if (normalizedOH) {
          openingHoursHash = computeHash(normalizedOH);
          stats.withOpeningHours++;
        }

        let popularTimesHash = null;
        const normalizedPT = normalizePopularTimes(data.popularTimes);
        if (normalizedPT) {
          popularTimesHash = computeHash(normalizedPT);
          stats.withPopularTimes++;
        }

        batch.push({
          placeId,
          name,
          city: forcedCity || inferCityFromAddress(data.business?.fullAddress || data.business?.address),
          reviewCount,
          rating,
          openingHoursHash,
          popularTimesHash,
          navigablePlaceId,
          status: 'active',
          sourceFormat: 'new'
        });

        if (batch.length >= BATCH_SIZE) {
          db.upsertPoiBatch(batch);
          stats.imported += batch.length;
          batch = [];
          process.stdout.write(`\r  Imported: ${stats.imported} POIs...`);
        }
      } catch (err) {
        stats.errors++;
        if (stats.errors <= 5) {
          log('warn', `Error parsing line ${stats.totalLines}: ${err.message}`);
        }
      }
    }

    if (batch.length > 0) {
      db.upsertPoiBatch(batch);
      stats.imported += batch.length;
    }
  }

  const duration = Date.now() - startTime;
  console.log('');
  log('info', `New format import completed in ${formatDuration(duration)}`);

  return {
    totalLines: stats.totalLines,
    imported: stats.imported,
    skipped: stats.skipped,
    errors: stats.errors,
    nullRating: stats.nullRating,
    nullReviewCount: stats.nullReviewCount,
    withOpeningHours: stats.withOpeningHours,
    withPopularTimes: stats.withPopularTimes,
    city: forcedCity || null,
    uniquePois: db.getPoiCount(),
    duration
  };
}

function pickSQLiteTable(sourceDb) {
  const tables = sourceDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();

  const candidates = [];
  for (const { name } of tables) {
    const columns = sourceDb.prepare(`PRAGMA table_info(${escapeIdent(name)})`).all().map(c => c.name);
    if (columns.length === 0) continue;

    const placeIdCol = resolveColumn(columns, [
      'placeId', 'place_id', 'googlePlaceId', 'google_place_id', 'gmaps_place_id'
    ]);
    const jsonCol = resolveColumn(columns, ['raw_json', 'rawJson', 'payload', 'json', 'data', 'record', 'result']);
    if (!placeIdCol && !jsonCol) continue;

    let score = 0;
    if (placeIdCol) score += 10;
    if (resolveColumn(columns, ['name', 'business_name', 'title'])) score += 3;
    if (resolveColumn(columns, ['reviewCount', 'review_count', 'reviews'])) score += 3;
    if (resolveColumn(columns, ['rating', 'avg_rating', 'score'])) score += 3;
    if (resolveColumn(columns, ['city', 'city_name', 'locality'])) score += 2;
    if (jsonCol) score += 1;

    candidates.push({ name, columns, placeIdCol, jsonCol, score });
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return candidates[0] || null;
}

async function importSQLiteFormat(sourcePath, db, options = {}) {
  const startTime = Date.now();
  const forcedCity = normalizeCity(options.city);
  const stats = {
    scannedRows: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
    nullRating: 0,
    nullReviewCount: 0,
    withOpeningHours: 0,
    withPopularTimes: 0
  };

  const sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let tableName = null;
  try {
    const table = pickSQLiteTable(sourceDb);
    if (!table) {
      throw new Error('No importable table found in sqlite source');
    }
    tableName = table.name;
    log('info', `Using sqlite table: ${tableName}`);

    const columns = table.columns;
    const col = {
      placeId: table.placeIdCol,
      json: table.jsonCol,
      navigablePlaceId: resolveColumn(columns, ['navigablePlaceId', 'navigable_place_id', 'chijPlaceId', 'chij_place_id']),
      name: resolveColumn(columns, ['name', 'business_name', 'title']),
      reviewCount: resolveColumn(columns, ['reviewCount', 'review_count', 'reviews', 'total_reviews']),
      rating: resolveColumn(columns, ['rating', 'avg_rating', 'score']),
      openingHoursHash: resolveColumn(columns, ['openingHoursHash', 'opening_hours_hash']),
      popularTimesHash: resolveColumn(columns, ['popularTimesHash', 'popular_times_hash']),
      openingHours: resolveColumn(columns, ['openingHours', 'opening_hours', 'hours']),
      popularTimes: resolveColumn(columns, ['popularTimes', 'popular_times']),
      city: resolveColumn(columns, ['city', 'city_name', 'locality']),
      address: resolveColumn(columns, ['fullAddress', 'full_address', 'address'])
    };

    const rows = sourceDb.prepare(`SELECT * FROM ${escapeIdent(tableName)}`).iterate();
    let batch = [];
    const BATCH_SIZE = 1000;

    for (const row of rows) {
      stats.scannedRows++;
      try {
        const payload = col.json ? parseMaybeJSON(row[col.json]) : null;
        const payloadBusiness = payload?.business || payload?.place || null;

        const placeId = firstNonEmpty(
          col.placeId ? row[col.placeId] : null,
          payloadBusiness?.placeId,
          payloadBusiness?.place_id,
          payload?.placeId,
          payload?._meta?.placeId
        );
        if (!placeId) {
          stats.skipped++;
          continue;
        }

        const rating = toNullableNumber(firstNonEmpty(
          col.rating ? row[col.rating] : null,
          payloadBusiness?.rating
        ));
        const reviewCount = toNullableNumber(firstNonEmpty(
          col.reviewCount ? row[col.reviewCount] : null,
          payloadBusiness?.reviewCount,
          payloadBusiness?.reviews
        ));

        if (rating === null) stats.nullRating++;
        if (reviewCount === null) stats.nullReviewCount++;

        const openingHoursHash = firstNonEmpty(
          col.openingHoursHash ? row[col.openingHoursHash] : null,
          computeOptionalHash(
            firstNonEmpty(
              col.openingHours ? row[col.openingHours] : null,
              payload?.openingHours,
              payloadBusiness?.openingHours
            ),
            normalizeOpeningHours
          )
        );

        const popularTimesHash = firstNonEmpty(
          col.popularTimesHash ? row[col.popularTimesHash] : null,
          computeOptionalHash(
            firstNonEmpty(
              col.popularTimes ? row[col.popularTimes] : null,
              payload?.popularTimes,
              payloadBusiness?.popularTimes
            ),
            normalizePopularTimes
          )
        );

        if (openingHoursHash) stats.withOpeningHours++;
        if (popularTimesHash) stats.withPopularTimes++;

        const navigablePlaceId = firstNonEmpty(
          col.navigablePlaceId ? row[col.navigablePlaceId] : null,
          payload?._meta?.placeId,
          String(placeId).startsWith('ChIJ') ? placeId : null
        );

        const resolvedCity = forcedCity || normalizeCity(firstNonEmpty(
          col.city ? row[col.city] : null,
          payloadBusiness?.city,
          inferCityFromAddress(
            firstNonEmpty(
              col.address ? row[col.address] : null,
              payloadBusiness?.fullAddress,
              payloadBusiness?.address
            )
          )
        ));

        batch.push({
          placeId: String(placeId),
          name: firstNonEmpty(col.name ? row[col.name] : null, payloadBusiness?.name) || null,
          city: resolvedCity,
          reviewCount,
          rating,
          openingHoursHash: openingHoursHash || null,
          popularTimesHash: popularTimesHash || null,
          navigablePlaceId: navigablePlaceId || null,
          status: 'active',
          sourceFormat: 'sqlite'
        });

        if (batch.length >= BATCH_SIZE) {
          db.upsertPoiBatch(batch);
          stats.imported += batch.length;
          batch = [];
          process.stdout.write(`\r  Imported: ${stats.imported} POIs...`);
        }
      } catch (err) {
        stats.errors++;
        if (stats.errors <= 5) {
          log('warn', `Error reading sqlite row ${stats.scannedRows}: ${err.message}`);
        }
      }
    }

    if (batch.length > 0) {
      db.upsertPoiBatch(batch);
      stats.imported += batch.length;
    }
  } finally {
    sourceDb.close();
  }

  const duration = Date.now() - startTime;
  console.log('');
  log('info', `SQLite format import completed in ${formatDuration(duration)}`);

  return {
    table: tableName,
    scannedRows: stats.scannedRows,
    imported: stats.imported,
    skipped: stats.skipped,
    errors: stats.errors,
    nullRating: stats.nullRating,
    nullReviewCount: stats.nullReviewCount,
    withOpeningHours: stats.withOpeningHours,
    withPopularTimes: stats.withPopularTimes,
    city: forcedCity || null,
    uniquePois: db.getPoiCount(),
    duration
  };
}

async function importBaseline(sourcePath, db, format = 'auto', options = {}) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source path does not exist: ${sourcePath}`);
  }

  const detectedFormat = format === 'auto' ? detectFormat(sourcePath) : format;
  if (!detectedFormat) {
    throw new Error(`Cannot detect data format for: ${sourcePath}. Use --format old|new|sqlite to specify.`);
  }

  log('info', `Detected format: ${detectedFormat}`);
  log('info', `Source: ${sourcePath}`);
  if (options.city) {
    log('info', `Import city scope: ${options.city}`);
  }

  let result;
  if (detectedFormat === 'old') {
    result = await importOldFormat(sourcePath, db, options);
  } else if (detectedFormat === 'new') {
    result = await importNewFormat(sourcePath, db, options);
  } else if (detectedFormat === 'sqlite') {
    result = await importSQLiteFormat(sourcePath, db, options);
  } else {
    throw new Error(`Unknown format: ${detectedFormat}`);
  }

  return result;
}

module.exports = { importBaseline, detectFormat };
