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
  minCellSizeKm: 0.12,       // Don't subdivide below 120m (zoom 19)

  // Request settings
  requestDelayMs: 200,       // Delay between API requests
  maxRetries: 2,             // Retries per failed request
  retryDelayMs: 5000,        // Delay before retry

  // Concurrency
  maxConcurrent: 1,          // Sequential by default (increase with proxies)

  // Incremental save
  saveInterval: 20,          // Save every N requests
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
  if (cellSizeKm >= 0.25) return 18;
  if (cellSizeKm >= 0.12) return 19;
  return 20;
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
 * Haversine distance in meters between two lat/lng points.
 */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Fetch POI place_ids from tbm=map endpoint for a given cell.
 * Returns ftids, place coordinates, and distance ratio for adaptive subdivision.
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
      if (!resp.ok) return { error: resp.status, ftids: [], places: [] };
      const text = await resp.text();
      const idx = text.indexOf('[');
      if (idx < 0) return { error: 'no_json', ftids: [], places: [] };
      const data = JSON.parse(text.substring(idx));
      const rawPlaces = data[64] || [];
      const places = [];
      const ftids = [];
      for (const item of rawPlaces) {
        const p = item && item[1];
        if (!p || !p[10]) continue;
        const ftid = p[10];
        ftids.push(ftid);

        // Extract full place info from tbm=map response
        const phone = p[178] && p[178][0] && p[178][0][0] || null;
        places.push({
          ftid,
          chijId: p[78] || null,
          lat: p[9] ? p[9][2] : null,
          lng: p[9] ? p[9][3] : null,
          name: p[11] || null,
          address: p[2] || null,
          fullAddress: p[18] || null,
          rating: p[4] ? p[4][7] : null,
          reviewCount: p[4] ? p[4][8] : null,
          priceRange: p[4] ? p[4][2] : null,
          categories: p[13] || null,
          mainCategory: p[13] && p[13][0] || null,
          neighborhood: p[14] || null,
          website: p[7] && p[7][1] || null,
          phone,
          timezone: p[30] || null,
          plusCode: null, // not in tbm=map
        });
      }
      return { ftids: [...new Set(ftids)], places, bytes: text.length };
    } catch (e) {
      return { error: e.message, ftids: [], places: [] };
    }
  }, url);

  // Compute distance ratio: farthest result distance / viewport radius
  if (!result.error && result.places.length > 0) {
    const viewportRadius = altitude * 0.5; // approximate
    let farthest = 0;
    for (const p of result.places) {
      if (p.lat == null) continue;
      const dist = haversine(lat, lng, p.lat, p.lng);
      if (dist > farthest) farthest = dist;
    }
    result.farthestDist = Math.round(farthest);
    result.viewportRadius = Math.round(viewportRadius);
    result.distRatio = viewportRadius > 0 ? farthest / viewportRadius : 1;
  }

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
 * @param {Map} placeStore - Global map of ftid → place data (for collecting full info)
 * @param {Object} stats - Running statistics
 * @param {number} depth - Current recursion depth
 * @param {Object} opts - Config overrides
 * @returns {Promise<string[]>} Array of new place_ids found in this cell
 */
async function searchCell(page, query, bbox, pbTemplate, globalIds, placeStore, stats, depth = 0, opts = {}) {
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

  // Collect new IDs and place data
  const newIds = [];
  for (const id of result.ftids) {
    if (!globalIds.has(id)) {
      globalIds.add(id);
      newIds.push(id);
      stats.totalIds++;
    }
  }
  // Store full place data (first seen wins — closest to search center)
  for (const place of result.places) {
    if (place.ftid && !placeStore.has(place.ftid)) {
      placeStore.set(place.ftid, place);
    }
  }

  const indent = '  '.repeat(depth);
  const cellLabel = `${indent}[d${depth}] (${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}) ${bbox.sizeKm.toFixed(2)}km z${zoom}`;

  // Decide: subdivide or stop
  // Based on two signals:
  //   1. Result count: < 20 means all POIs returned, no need to subdivide
  //   2. Distance ratio: farthest result / viewport radius
  //      - ratio < 0.7 → results clustered near center, many POIs truncated (6-22% coverage)
  //      - ratio 0.7-1.0 → moderate truncation
  //      - ratio >= 1.0 → results spread beyond viewport, area likely covered
  //
  // Adaptive minCell: dense areas (low ratio) get finer subdivision
  //   - truncated (r < 0.7): minCell = 0.12km (zoom 19)
  //   - moderate (r 0.7-1.0): minCell = 0.25km (zoom 18)
  //   - spread (r >= 1.0): stop immediately
  const isEmpty = result.ftids.length === 0;
  const hitLimit = result.ftids.length >= threshold;
  const distRatio = result.distRatio ?? 1;

  // Adaptive minCell based on density signal (distance ratio)
  //   r < 0.5  → extreme density → subdivide to 0.06km (zoom 20)
  //   r 0.5-0.7 → dense → subdivide to 0.12km (zoom 19)
  //   r 0.7-1.0 → moderate → subdivide to 0.25km (zoom 18)
  //   r >= 1.0  → sparse → stop
  const adaptiveMinCell = distRatio < 0.5 ? 0.06 : distRatio < 0.7 ? 0.12 : 0.25;
  const canSubdivide = depth < maxDepth && bbox.sizeKm / 2 >= adaptiveMinCell;

  let shouldSubdivide = false;
  let reason = '';

  if (isEmpty) {
    reason = 'empty';
  } else if (!hitLimit) {
    reason = 'complete';
  } else if (distRatio >= 1.0) {
    reason = 'spread';
  } else if (!canSubdivide) {
    reason = depth >= maxDepth ? 'max_depth' : 'min_cell';
  } else if (distRatio < 0.7) {
    shouldSubdivide = true;
    reason = distRatio < 0.5 ? 'extreme' : 'truncated';
  } else {
    shouldSubdivide = true;
    reason = 'moderate';
  }

  const ratioStr = distRatio < 10 ? ` r=${distRatio.toFixed(2)}` : '';

  if (shouldSubdivide) {
    if (onProgress && depth <= 3) onProgress(stats, `${cellLabel}: ${result.ftids.length} results (${newIds.length} new)${ratioStr} → subdividing [${reason}]`);

    const quads = subdivideBBox(bbox);
    for (const quad of quads) {
      await page.waitForTimeout(delayMs);
      const subIds = await searchCell(page, query, quad, pbTemplate, globalIds, placeStore, stats, depth + 1, opts);
      newIds.push(...subIds);
    }
  } else {
    if (onProgress && newIds.length > 0) {
      onProgress(stats, `${cellLabel}: +${newIds.length} new${ratioStr} ✓ [${reason}]`);
    }
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
  const placeStore = new Map(); // ftid → full place data
  const results = [];

  // Places file: same directory as incrementalSaveFile, named places.ndjson
  const incrementalSaveFile = options.incrementalSaveFile;
  const placesFile = incrementalSaveFile
    ? incrementalSaveFile.replace(/[^/]+$/, 'places.ndjson')
    : null;

  // Resume support
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
  // Resume placeStore from places.ndjson
  if (placesFile && fs.existsSync(placesFile)) {
    try {
      const lines = fs.readFileSync(placesFile, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        const p = JSON.parse(line);
        if (p._meta && p._meta.placeId) {
          placeStore.set(p._meta.placeId, p);
          allPlaceIds.add(p._meta.placeId);
        }
      }
      console.log(`[QUADTREE] Resumed ${placeStore.size} places from ${placesFile}`);
    } catch (e) {
      console.warn(`[QUADTREE] Places resume failed: ${e.message}`);
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

      let lastSaveAt = 0;
      const saveThrottle = options.saveInterval || CONFIG.saveInterval; // every N requests

      const onProgress = (st, msg) => {
        console.log(`  ${msg} [total: ${allPlaceIds.size}]`);
        if (progressCallback) {
          progressCallback(
            catIndex,
            totalCategories,
            `${category}: ${allPlaceIds.size} POIs (${st.requests} requests)`
          );
        }
        // Real-time incremental save (throttled)
        if (incrementalSaveFile && st.requests - lastSaveAt >= saveThrottle) {
          lastSaveAt = st.requests;
          const saveData = {
            timestamp: new Date().toISOString(),
            progress: { categoriesDone: catIndex - 1, totalCategories, currentCategory: category, requests: st.requests },
            totalPlaceIds: allPlaceIds.size,
            uniquePlaceIds: Array.from(allPlaceIds),
            results,
            searchArea: { ...bbox },
          };
          try {
            const tmp = incrementalSaveFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(saveData, null, 2), 'utf8');
            fs.renameSync(tmp, incrementalSaveFile);
          } catch (e) {}
        }
      };

      await searchCell(page, category, bbox, pbTemplate, allPlaceIds, placeStore, stats, 0, {
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

      // Incremental save — poi_search.json (metadata)
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

      // Incremental save — places.ndjson (full place data, one line per place)
      // This file is the input for review scraping — same format as scraper output
      if (placesFile) {
        try {
          const lines = [];
          for (const [ftid, p] of placeStore) {
            const record = {
              extractedAt: new Date().toISOString(),
              sourceUrl: `https://www.google.com/maps/place/?ftid=${ftid}&hl=en`,
              business: {
                name: p.name,
                address: p.address,
                fullAddress: p.fullAddress,
                coordinates: (p.lat != null && p.lng != null) ? { lat: p.lat, lng: p.lng } : null,
                latitude: p.lat,
                longitude: p.lng,
                placeId: ftid,
                categories: p.categories,
                mainCategory: p.mainCategory,
                rating: p.rating,
                reviewCount: p.reviewCount,
                priceRange: p.priceRange,
                phone: p.phone,
                website: p.website,
                plusCode: p.plusCode,
              },
              _meta: {
                placeId: ftid,
                chijId: p.chijId,
                sourceUrl: `https://www.google.com/maps/place/?ftid=${ftid}&hl=en`,
                neighborhood: p.neighborhood,
                timezone: p.timezone,
              },
            };
            lines.push(JSON.stringify(record));
          }
          const tmp = placesFile + '.tmp';
          fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
          fs.renameSync(tmp, placesFile);
          console.log(`[QUADTREE] Saved ${placeStore.size} places to ${placesFile}`);
        } catch (e) {
          console.warn(`[QUADTREE] Places save failed: ${e.message}`);
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
    placesFile: placesFile || null,
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
