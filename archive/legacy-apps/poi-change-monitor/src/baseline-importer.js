const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { computeHash, normalizeOpeningHours, normalizePopularTimes, log, formatDuration } = require('./utils');

function detectFormat(sourcePath) {
  const stat = fs.statSync(sourcePath);

  if (stat.isFile() && sourcePath.endsWith('.ndjson')) {
    return 'new';
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

async function importOldFormat(sourcePath, db) {
  const startTime = Date.now();
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
    uniquePois: db.getPoiCount(),
    duration
  };
}

async function importNewFormat(sourcePath, db) {
  const startTime = Date.now();
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
        // Fall back to detailedReviews array length when reviewCount is missing
        const reviewCount = data.business?.reviewCount
          ?? (Array.isArray(data.detailedReviews) && data.detailedReviews.length > 0
            ? data.detailedReviews.length
            : null);

        // Extract ChIJ format placeId from _meta for URL navigation
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
    uniquePois: db.getPoiCount(),
    duration
  };
}

async function importBaseline(sourcePath, db, format = 'auto') {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source path does not exist: ${sourcePath}`);
  }

  const detectedFormat = format === 'auto' ? detectFormat(sourcePath) : format;
  if (!detectedFormat) {
    throw new Error(`Cannot detect data format for: ${sourcePath}. Use --format old|new to specify.`);
  }

  log('info', `Detected format: ${detectedFormat}`);
  log('info', `Source: ${sourcePath}`);

  let result;
  if (detectedFormat === 'old') {
    result = await importOldFormat(sourcePath, db);
  } else if (detectedFormat === 'new') {
    result = await importNewFormat(sourcePath, db);
  } else {
    throw new Error(`Unknown format: ${detectedFormat}`);
  }

  return result;
}

module.exports = { importBaseline, detectFormat };
