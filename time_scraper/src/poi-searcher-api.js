#!/usr/bin/env node
'use strict';

/**
 * POI Searcher (API Mode)
 *
 * Uses Google Maps' tbm=map endpoint + adaptive quadtree subdivision
 * to discover POIs. ~30x faster than browser scrolling.
 *
 * Flow:
 *   1. Load one Google Maps search page to capture the real pb= template
 *   2. For each category × bounding box:
 *      - HTTP fetch tbm=map with constructed pb= parameter
 *      - If results >= threshold, subdivide into 4 quadrants and recurse
 *      - Collect all unique place_ids
 *   3. Output same format as poi-searcher.js for compatibility
 */

const fs = require('fs');

// ============================================
// Configuration
// ============================================

const CONFIG = {
  // Quadtree settings
  maxDepth: 6,               // Max recursion depth (depth 6 ≈ initial_size / 64)
  subdivideThreshold: 18,    // If results >= this, subdivide (max is ~20)
  minCellSizeKm: 0.05,       // Don't subdivide below 50m

  // Request settings
  requestDelayMs: 200,       // Delay between API requests
  maxRetries: 2,             // Retries per failed request
  retryDelayMs: 5000,        // Delay before retry

  // Concurrency
  maxConcurrent: 1,          // Sequential by default (increase with proxies)

  // Incremental save
  saveInterval: 100,         // Save every N searches
};

// ============================================
// Altitude calculation (zoom → viewport height)
// ============================================

const EARTH_RADIUS = 6371010;
const TILE_SIZE = 256;
const SCREEN_PIXEL_HEIGHT = 768;
const RADIUS_X_PIXEL_HEIGHT = 27.3611 * EARTH_RADIUS * SCREEN_PIXEL_HEIGHT;

function calculateAltitude(zoom, lat) {
  return (RADIUS_X_PIXEL_HEIGHT * Math.cos(lat * Math.PI / 180)) / (Math.pow(2, zoom) * TILE_SIZE);
}

// Map cell size (km) to appropriate zoom level
function cellSizeToZoom(cellSizeKm) {
  if (cellSizeKm >= 10) return 13;
  if (cellSizeKm >= 5)  return 14;
  if (cellSizeKm >= 2)  return 15;
  if (cellSizeKm >= 1)  return 16;
  if (cellSizeKm >= 0.5) return 17;
  if (cellSizeKm >= 0.2) return 18;
  return 19;
}

// ============================================
// Bounding box utilities
// ============================================

const KM_PER_DEGREE_LAT = 111.32;
function kmPerDegreeLng(lat) {
  return 111.32 * Math.cos(lat * Math.PI / 180);
}

/**
 * Create a bounding box from center + size
 */
function createBBox(centerLat, centerLng, sizeKm) {
  const halfLat = (sizeKm / 2) / KM_PER_DEGREE_LAT;
  const halfLng = (sizeKm / 2) / kmPerDegreeLng(centerLat);
  return {
    minLat: centerLat - halfLat,
    maxLat: centerLat + halfLat,
    minLng: centerLng - halfLng,
    maxLng: centerLng + halfLng,
    centerLat,
    centerLng,
    sizeKm,
  };
}

/**
 * Subdivide a bounding box into 4 quadrants
 */
function subdivideBBox(bbox) {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;
  const halfSize = bbox.sizeKm / 2;

  return [
    createBBox((bbox.minLat + midLat) / 2, (bbox.minLng + midLng) / 2, halfSize), // SW
    createBBox((bbox.minLat + midLat) / 2, (midLng + bbox.maxLng) / 2, halfSize), // SE
    createBBox((midLat + bbox.maxLat) / 2, (bbox.minLng + midLng) / 2, halfSize), // NW
    createBBox((midLat + bbox.maxLat) / 2, (midLng + bbox.maxLng) / 2, halfSize), // NE
  ];
}

/**
 * Create initial bounding box from an array of sampling points
 */
function pointsToBBox(points, paddingKm = 0.5) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  // Add padding
  const padLat = paddingKm / KM_PER_DEGREE_LAT;
  const padLng = paddingKm / kmPerDegreeLng((minLat + maxLat) / 2);
  minLat -= padLat;
  maxLat += padLat;
  minLng -= padLng;
  maxLng += padLng;

  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;
  const sizeLatKm = (maxLat - minLat) * KM_PER_DEGREE_LAT;
  const sizeLngKm = (maxLng - minLng) * kmPerDegreeLng(centerLat);
  const sizeKm = Math.max(sizeLatKm, sizeLngKm);

  return { minLat, maxLat, minLng, maxLng, centerLat, centerLng, sizeKm };
}

// ============================================
// tbm=map API fetch
// ============================================

/**
 * Capture the real pb= template from Google Maps' own request.
 * Must be done once per session.
 */
async function capturePbTemplate(page, query, lat, lng) {
  let capturedPb = null;

  const handler = (req) => {
    const url = req.url();
    if (url.includes('tbm=map') && url.includes('pb=')) {
      const m = url.match(/pb=([^&]+)/);
      if (m) capturedPb = decodeURIComponent(m[1]);
    }
  };

  page.on('request', handler);

  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}/@${lat},${lng},14z`;
  await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  page.off('request', handler);

  if (!capturedPb) {
    throw new Error('Failed to capture pb= template from Google Maps');
  }

  return capturedPb;
}

/**
 * Fetch POI place_ids from tbm=map endpoint for a given cell.
 */
async function fetchCellPlaceIds(page, query, lat, lng, altitude, pbTemplate) {
  const pb = pbTemplate
    .replace(/!1d[\d.]+/, `!1d${altitude}`)
    .replace(/!2d[-\d.]+/, `!2d${lng}`)
    .replace(/!3d[-\d.]+/, `!3d${lat}`);

  const url = `https://www.google.com/search?tbm=map&authuser=0&hl=en&q=${encodeURIComponent(query)}&pb=${encodeURIComponent(pb)}`;

  const result = await page.evaluate(async (fetchUrl) => {
    try {
      const resp = await fetch(fetchUrl, { credentials: 'include' });
      if (!resp.ok) return { error: resp.status, ftids: [] };
      const text = await resp.text();
      const ftids = [...new Set((text.match(/0x[0-9a-f]+:0x[0-9a-f]+/g) || []))];
      return { ftids, bytes: text.length };
    } catch (e) {
      return { error: e.message, ftids: [] };
    }
  }, url);

  return result;
}

// ============================================
// Quadtree search
// ============================================

/**
 * Recursively search a bounding box with adaptive quadtree subdivision.
 *
 * @param {Page} page - Playwright page (for fetch context)
 * @param {string} query - Search query (category)
 * @param {Object} bbox - Bounding box {centerLat, centerLng, sizeKm, ...}
 * @param {string} pbTemplate - Captured pb= template
 * @param {Set} globalIds - Global set of seen place_ids (for dedup)
 * @param {Object} stats - Running statistics
 * @param {number} depth - Current recursion depth
 * @param {Object} opts - Config overrides
 * @returns {Promise<string[]>} Array of new place_ids found in this cell
 */
async function searchCell(page, query, bbox, pbTemplate, globalIds, stats, depth = 0, opts = {}) {
  const maxDepth = opts.maxDepth ?? CONFIG.maxDepth;
  const threshold = opts.subdivideThreshold ?? CONFIG.subdivideThreshold;
  const delayMs = opts.requestDelayMs ?? CONFIG.requestDelayMs;
  const onProgress = opts.onProgress || null;

  const zoom = cellSizeToZoom(bbox.sizeKm);
  const altitude = calculateAltitude(zoom, bbox.centerLat);

  // Fetch this cell
  stats.requests++;
  let result;
  for (let attempt = 0; attempt <= (opts.maxRetries ?? CONFIG.maxRetries); attempt++) {
    result = await fetchCellPlaceIds(page, query, bbox.centerLat, bbox.centerLng, altitude, pbTemplate);
    if (!result.error) break;
    if (attempt < (opts.maxRetries ?? CONFIG.maxRetries)) {
      await page.waitForTimeout(opts.retryDelayMs ?? CONFIG.retryDelayMs);
    }
  }

  if (result.error) {
    stats.errors++;
    return [];
  }

  // Collect new IDs
  const newIds = [];
  for (const id of result.ftids) {
    if (!globalIds.has(id)) {
      globalIds.add(id);
      newIds.push(id);
      stats.totalIds++;
    }
  }

  const indent = '  '.repeat(depth);
  const cellLabel = `${indent}[d${depth}] (${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}) ${bbox.sizeKm.toFixed(2)}km z${zoom}`;

  // Decide: subdivide or stop
  const atLimit = result.ftids.length >= threshold;
  const canSubdivide = depth < maxDepth && bbox.sizeKm / 2 >= (opts.minCellSizeKm ?? CONFIG.minCellSizeKm);

  if (atLimit && canSubdivide && newIds.length > 0) {
    // Results at capacity AND found new IDs — subdivide
    if (onProgress) onProgress(stats, `${cellLabel}: ${result.ftids.length} results (${newIds.length} new) → subdividing`);

    const quads = subdivideBBox(bbox);
    for (const quad of quads) {
      await page.waitForTimeout(delayMs);
      const subIds = await searchCell(page, query, quad, pbTemplate, globalIds, stats, depth + 1, opts);
      newIds.push(...subIds);
    }
  } else {
    // Under threshold or max depth — this cell is complete
    if (onProgress) onProgress(stats, `${cellLabel}: ${result.ftids.length} results (${newIds.length} new) ✓`);
  }

  return newIds;
}

// ============================================
// Main batch search function
// ============================================

/**
 * Search POIs across a geographic area using quadtree subdivision.
 *
 * @param {Browser} browser - Playwright browser
 * @param {Array} points - Sampling points [{lat, lng}, ...] (used to determine search area)
 * @param {Array} categories - Category strings ["Restaurant", ...]
 * @param {Object} options - Configuration
 * @param {Function} progressCallback - (current, total, message) progress reporter
 * @returns {Promise<Object>} { uniquePlaceIds, totalPlaceIds, results, stats }
 */
async function batchSearchPOIs(browser, points, categories, options = {}, progressCallback = null) {
  const allPlaceIds = new Set();
  const results = [];

  // Resume support
  const incrementalSaveFile = options.incrementalSaveFile;
  const completedCategories = new Set();
  let resumedIds = 0;

  if (incrementalSaveFile && fs.existsSync(incrementalSaveFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(incrementalSaveFile, 'utf8'));
      if (existing.uniquePlaceIds) {
        existing.uniquePlaceIds.forEach(id => allPlaceIds.add(id));
        resumedIds = allPlaceIds.size;
      }
      if (existing.results) {
        for (const r of existing.results) {
          results.push(r);
          completedCategories.add(r.category);
        }
      }
      if (resumedIds > 0) {
        console.log(`[QUADTREE] Resuming: ${resumedIds} place_ids, ${completedCategories.size} categories done`);
      }
    } catch (e) {
      console.warn(`[QUADTREE] Resume load failed: ${e.message}`);
    }
  }

  // Determine search area from points
  const bbox = pointsToBBox(points);
  console.log(`[QUADTREE] Search area: ${bbox.sizeKm.toFixed(1)}km × ${bbox.sizeKm.toFixed(1)}km`);
  console.log(`[QUADTREE] Center: ${bbox.centerLat.toFixed(4)}, ${bbox.centerLng.toFixed(4)}`);
  console.log(`[QUADTREE] Categories: ${categories.length}`);

  // Create browser context
  const stealth = (() => { try { return require('./stealth'); } catch (e) { return null; } })();
  let context, page;
  if (stealth) {
    const { createStealthContext } = stealth;
    const result = await createStealthContext(browser, { blockImages: true });
    context = result.context;
    page = result.page;
  } else {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1024, height: 768 },
      locale: 'en-US',
    });
    page = await context.newPage();
  }

  try {
    // Step 1: Capture pb template (once per session)
    console.log(`[QUADTREE] Capturing pb template...`);
    const firstCategory = categories[0] || 'Restaurant';
    const pbTemplate = await capturePbTemplate(page, firstCategory, bbox.centerLat, bbox.centerLng);
    console.log(`[QUADTREE] pb template captured (${pbTemplate.length} chars)`);

    // Step 2: Search each category with quadtree
    let catIndex = 0;
    const totalCategories = categories.length;

    for (const category of categories) {
      catIndex++;

      // Skip completed categories (resume)
      if (completedCategories.has(category)) {
        console.log(`[QUADTREE] Skipping ${category} (already done)`);
        continue;
      }

      console.log(`\n[QUADTREE] === Category ${catIndex}/${totalCategories}: ${category} ===`);

      const stats = { requests: 0, errors: 0, totalIds: 0, subdivisions: 0 };
      const catStartIds = allPlaceIds.size;
      const startTime = Date.now();

      const onProgress = (st, msg) => {
        console.log(`  ${msg} [total: ${allPlaceIds.size}]`);
        if (progressCallback) {
          progressCallback(
            catIndex,
            totalCategories,
            `${category}: ${allPlaceIds.size} POIs (${st.requests} requests)`
          );
        }
      };

      await searchCell(page, category, bbox, pbTemplate, allPlaceIds, stats, 0, {
        ...options,
        onProgress,
      });

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const catNewIds = allPlaceIds.size - catStartIds;

      results.push({
        category,
        newPlaceIds: catNewIds,
        requests: stats.requests,
        errors: stats.errors,
        elapsed,
      });

      console.log(`[QUADTREE] ${category}: +${catNewIds} new POIs (${stats.requests} requests, ${elapsed}s)`);
      console.log(`[QUADTREE] Running total: ${allPlaceIds.size} unique POIs`);

      // Incremental save
      if (incrementalSaveFile) {
        const saveData = {
          timestamp: new Date().toISOString(),
          progress: { categoriesDone: catIndex, totalCategories },
          totalPlaceIds: allPlaceIds.size,
          uniquePlaceIds: Array.from(allPlaceIds),
          results,
          searchArea: { ...bbox },
        };
        try {
          const tmp = incrementalSaveFile + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(saveData, null, 2), 'utf8');
          fs.renameSync(tmp, incrementalSaveFile);
        } catch (e) {
          console.warn(`[QUADTREE] Save failed: ${e.message}`);
        }
      }
    }

  } finally {
    await page.close();
    await context.close();
  }

  return {
    totalPlaceIds: allPlaceIds.size,
    uniquePlaceIds: Array.from(allPlaceIds),
    results,
    searchArea: { ...bbox },
  };
}

// ============================================
// File loading utilities (same as poi-searcher.js)
// ============================================

function loadPointsFromCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV must have header + data');

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const latIdx = header.findIndex(h => h === 'lat' || h === 'latitude');
  const lngIdx = header.findIndex(h => h === 'lng' || h === 'longitude' || h === 'lon');
  if (latIdx === -1 || lngIdx === -1) throw new Error('CSV must contain lat and lng columns');

  const points = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    const lat = parseFloat(row[latIdx]);
    const lng = parseFloat(row[lngIdx]);
    if (!isNaN(lat) && !isNaN(lng)) points.push({ lat, lng });
  }
  return points;
}

function loadPointsFromJSON(jsonPath) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (Array.isArray(data)) return data.filter(p => p.lat != null && p.lng != null);
  throw new Error('JSON must be an array of {lat, lng}');
}

function loadCategories(configPath) {
  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (data.categories && Array.isArray(data.categories)) return data.categories;
  if (Array.isArray(data)) return data;
  throw new Error('Invalid categories config');
}

// ============================================
// Exports
// ============================================

module.exports = {
  batchSearchPOIs,
  searchCell,
  capturePbTemplate,
  fetchCellPlaceIds,
  calculateAltitude,
  cellSizeToZoom,
  pointsToBBox,
  createBBox,
  subdivideBBox,
  loadPointsFromCSV,
  loadPointsFromJSON,
  loadCategories,
  CONFIG,
};
