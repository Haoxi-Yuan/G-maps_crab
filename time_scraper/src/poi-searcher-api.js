#!/usr/bin/env node
'use strict';

/**
 * POI Searcher (API Mode) v3
 *
 * Uses Google Maps' tbm=map endpoint with:
 *   - Pagination: !8i{offset} to get up to ~120 POIs per viewport
 *   - Quadtree subdivision: when pagination maxes out, subdivide and recurse
 *   - Offset grid: second pass with half-step offset to catch edge POIs
 *   - Full place data extraction: name, address, coordinates, rating, etc.
 *
 * Validated improvements over v2:
 *   - Pagination: 20 → 131 POIs per viewport (+555%)
 *   - No more spread-stop bug: always paginate fully before deciding
 *   - Offset grid: +21% additional POIs
 *   - Subdivision after pagination: still needed (+41% in dense areas)
 */

const fs = require('fs');

// ============================================
// Configuration
// ============================================

const CONFIG = {
  maxDepth: 8,
  minCellSizeKm: 0.05,        // 50m minimum cell
  maxPaginationPages: 7,       // ~140 POIs per viewport max
  pageSize: 20,

  requestDelayMs: 150,
  maxRetries: 2,
  retryDelayMs: 5000,

  saveInterval: 20,
  enableOffsetGrid: true,      // Second pass with half-step offset
};

// ============================================
// Altitude / zoom utilities
// ============================================

const EARTH_RADIUS = 6371010;
const TILE_SIZE = 256;
const SCREEN_PIXEL_HEIGHT = 768;
const RADIUS_X_PIXEL_HEIGHT = 27.3611 * EARTH_RADIUS * SCREEN_PIXEL_HEIGHT;

function calculateAltitude(zoom, lat) {
  return (RADIUS_X_PIXEL_HEIGHT * Math.cos(lat * Math.PI / 180)) / (Math.pow(2, zoom) * TILE_SIZE);
}

function cellSizeToZoom(cellSizeKm) {
  if (cellSizeKm >= 10)   return 13;
  if (cellSizeKm >= 5)    return 14;
  if (cellSizeKm >= 2)    return 15;
  if (cellSizeKm >= 1)    return 16;
  if (cellSizeKm >= 0.5)  return 17;
  if (cellSizeKm >= 0.25) return 18;
  if (cellSizeKm >= 0.12) return 19;
  return 20;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================
// Bounding box utilities
// ============================================

const KM_PER_DEGREE_LAT = 111.32;
function kmPerDegreeLng(lat) {
  return 111.32 * Math.cos(lat * Math.PI / 180);
}

function createBBox(centerLat, centerLng, sizeKm) {
  const halfLat = (sizeKm / 2) / KM_PER_DEGREE_LAT;
  const halfLng = (sizeKm / 2) / kmPerDegreeLng(centerLat);
  return { minLat: centerLat - halfLat, maxLat: centerLat + halfLat, minLng: centerLng - halfLng, maxLng: centerLng + halfLng, centerLat, centerLng, sizeKm };
}

function subdivideBBox(bbox) {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;
  const halfSize = bbox.sizeKm / 2;
  return [
    createBBox((bbox.minLat + midLat) / 2, (bbox.minLng + midLng) / 2, halfSize),
    createBBox((bbox.minLat + midLat) / 2, (midLng + bbox.maxLng) / 2, halfSize),
    createBBox((midLat + bbox.maxLat) / 2, (bbox.minLng + midLng) / 2, halfSize),
    createBBox((midLat + bbox.maxLat) / 2, (midLng + bbox.maxLng) / 2, halfSize),
  ];
}

function pointsToBBox(points, paddingKm = 0.5) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const padLat = paddingKm / KM_PER_DEGREE_LAT;
  const padLng = paddingKm / kmPerDegreeLng((minLat + maxLat) / 2);
  minLat -= padLat; maxLat += padLat; minLng -= padLng; maxLng += padLng;
  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;
  const sizeLatKm = (maxLat - minLat) * KM_PER_DEGREE_LAT;
  const sizeLngKm = (maxLng - minLng) * kmPerDegreeLng(centerLat);
  return { minLat, maxLat, minLng, maxLng, centerLat, centerLng, sizeKm: Math.max(sizeLatKm, sizeLngKm) };
}

// ============================================
// pb= template capture
// ============================================

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
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}/@${lat},${lng},14z`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  page.off('request', handler);
  if (!capturedPb) throw new Error('Failed to capture pb= template');
  return capturedPb;
}

// ============================================
// Single page fetch (one offset)
// ============================================

async function fetchPage(page, query, lat, lng, altitude, pbTemplate, offset = 0) {
  let pb = pbTemplate
    .replace(/!1d[\d.]+/, `!1d${altitude}`)
    .replace(/!2d[-\d.]+/, `!2d${lng}`)
    .replace(/!3d[-\d.]+/, `!3d${lat}`);

  // Insert pagination offset
  if (pb.includes('!8i')) {
    pb = pb.replace(/!8i\d+/, `!8i${offset}`);
  } else {
    pb = pb.replace('!10b', `!8i${offset}!10b`);
  }

  const url = `https://www.google.com/search?tbm=map&authuser=0&hl=en&q=${encodeURIComponent(query)}&pb=${encodeURIComponent(pb)}`;

  return await page.evaluate(async (fetchUrl) => {
    try {
      const resp = await fetch(fetchUrl, { credentials: 'include' });
      if (!resp.ok) return { error: resp.status, places: [] };
      const text = await resp.text();
      const idx = text.indexOf('[');
      if (idx < 0) return { error: 'no_json', places: [] };
      const data = JSON.parse(text.substring(idx));
      const rawPlaces = data[64] || [];
      const places = [];
      for (const item of rawPlaces) {
        const p = item && item[1];
        if (!p || !p[10]) continue;
        const phone = p[178] && p[178][0] && p[178][0][0] || null;
        places.push({
          ftid: p[10],
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
        });
      }
      return { places };
    } catch (e) {
      return { error: e.message, places: [] };
    }
  }, url);
}

// ============================================
// Paginated fetch (all pages for one viewport)
// ============================================

async function fetchCellPaginated(page, query, lat, lng, altitude, pbTemplate, globalIds, placeStore, stats, opts = {}) {
  const maxPages = opts.maxPaginationPages ?? CONFIG.maxPaginationPages;
  const delayMs = opts.requestDelayMs ?? CONFIG.requestDelayMs;
  const newIds = [];
  let lastPageFull = false;

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    const offset = pageNum * CONFIG.pageSize;
    stats.requests++;

    let result;
    for (let attempt = 0; attempt <= (opts.maxRetries ?? CONFIG.maxRetries); attempt++) {
      result = await fetchPage(page, query, lat, lng, altitude, pbTemplate, offset);
      if (!result.error) break;
      if (attempt < (opts.maxRetries ?? CONFIG.maxRetries)) {
        await page.waitForTimeout(opts.retryDelayMs ?? CONFIG.retryDelayMs);
      }
    }

    if (result.error) { stats.errors++; break; }
    if (result.places.length === 0) break;

    // Collect new IDs and place data
    let newThisPage = 0;
    for (const place of result.places) {
      if (!globalIds.has(place.ftid)) {
        globalIds.add(place.ftid);
        newIds.push(place.ftid);
        stats.totalIds++;
        newThisPage++;
      }
      if (!placeStore.has(place.ftid)) {
        placeStore.set(place.ftid, place);
      }
    }

    lastPageFull = result.places.length >= CONFIG.pageSize;

    // If this page had zero new IDs, stop paginating (all dupes)
    if (newThisPage === 0) break;
    // If page not full, we've reached the end
    if (!lastPageFull) break;

    if (pageNum < maxPages - 1) await page.waitForTimeout(delayMs);
  }

  return { newIds, lastPageFull };
}

// ============================================
// Quadtree search with pagination
// ============================================

async function searchCell(page, query, bbox, pbTemplate, globalIds, placeStore, stats, depth = 0, opts = {}) {
  const maxDepth = opts.maxDepth ?? CONFIG.maxDepth;
  const minCell = opts.minCellSizeKm ?? CONFIG.minCellSizeKm;
  const delayMs = opts.requestDelayMs ?? CONFIG.requestDelayMs;
  const onProgress = opts.onProgress || null;

  const zoom = cellSizeToZoom(bbox.sizeKm);
  const altitude = calculateAltitude(zoom, bbox.centerLat);

  // Step 1: Paginate this cell fully
  const { newIds, lastPageFull } = await fetchCellPaginated(
    page, query, bbox.centerLat, bbox.centerLng, altitude, pbTemplate,
    globalIds, placeStore, stats, opts
  );

  const indent = '  '.repeat(Math.min(depth, 4));
  const cellLabel = `${indent}[d${depth}] (${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}) ${bbox.sizeKm.toFixed(2)}km z${zoom}`;

  // Step 2: Decide whether to subdivide
  // Subdivide if: pagination hit the limit (last page was full) AND we can go deeper
  const canSubdivide = depth < maxDepth && bbox.sizeKm / 2 >= minCell;
  const shouldSubdivide = lastPageFull && canSubdivide && newIds.length > 0;

  if (shouldSubdivide) {
    if (onProgress && depth <= 3) onProgress(stats, `${cellLabel}: +${newIds.length} (paginated) → subdividing`);

    const quads = subdivideBBox(bbox);
    for (const quad of quads) {
      await page.waitForTimeout(delayMs);
      const subIds = await searchCell(page, query, quad, pbTemplate, globalIds, placeStore, stats, depth + 1, opts);
      newIds.push(...subIds);
    }
  } else {
    const reason = newIds.length === 0 ? 'no_new' : !lastPageFull ? 'complete' : !canSubdivide ? 'min_cell' : 'done';
    if (onProgress && newIds.length > 0) {
      onProgress(stats, `${cellLabel}: +${newIds.length} ✓ [${reason}]`);
    }
  }

  return newIds;
}

// ============================================
// Offset grid pass
// ============================================

async function runOffsetGrid(page, query, bbox, pbTemplate, globalIds, placeStore, stats, opts = {}) {
  const onProgress = opts.onProgress || null;
  const delayMs = opts.requestDelayMs ?? CONFIG.requestDelayMs;

  // Use zoom 15 grid (~4km cells) with half-step offset
  const cellSizeKm = 4;
  const zoom = cellSizeToZoom(cellSizeKm);
  const altitude = calculateAltitude(zoom, bbox.centerLat);

  const stepLat = cellSizeKm / KM_PER_DEGREE_LAT;
  const stepLng = cellSizeKm / kmPerDegreeLng(bbox.centerLat);
  const offsetLat = stepLat / 2;
  const offsetLng = stepLng / 2;

  const startBefore = globalIds.size;
  let cellCount = 0;

  for (let lat = bbox.minLat + offsetLat; lat <= bbox.maxLat; lat += stepLat) {
    for (let lng = bbox.minLng + offsetLng; lng <= bbox.maxLng; lng += stepLng) {
      const { newIds } = await fetchCellPaginated(
        page, query, lat, lng, altitude, pbTemplate,
        globalIds, placeStore, stats, opts
      );
      cellCount++;
      if (newIds.length > 0 && onProgress) {
        onProgress(stats, `  [offset] (${lat.toFixed(4)},${lng.toFixed(4)}): +${newIds.length} new`);
      }
      await page.waitForTimeout(delayMs);
    }
  }

  const found = globalIds.size - startBefore;
  if (onProgress) onProgress(stats, `  [offset] pass done: +${found} new POIs (${cellCount} cells)`);
  return found;
}

// ============================================
// Main batch search
// ============================================

async function batchSearchPOIs(browser, points, categories, options = {}, progressCallback = null) {
  const allPlaceIds = new Set();
  const placeStore = new Map();
  const results = [];

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
      if (resumedIds > 0) console.log(`[QUADTREE] Resuming: ${resumedIds} place_ids, ${completedCategories.size} categories done`);
    } catch (e) {
      console.warn(`[QUADTREE] Resume load failed: ${e.message}`);
    }
  }
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
    } catch (e) {}
  }

  const bbox = pointsToBBox(points);
  console.log(`[QUADTREE] Search area: ${bbox.sizeKm.toFixed(1)}km × ${bbox.sizeKm.toFixed(1)}km`);
  console.log(`[QUADTREE] Center: ${bbox.centerLat.toFixed(4)}, ${bbox.centerLng.toFixed(4)}`);
  console.log(`[QUADTREE] Categories: ${categories.length}`);
  console.log(`[QUADTREE] Strategy: paginate (up to ${CONFIG.maxPaginationPages} pages) → subdivide if full → offset grid pass`);

  // Create browser context
  const stealth = (() => { try { return require('./stealth'); } catch (e) { return null; } })();
  let context, page;
  if (stealth) {
    const result = await stealth.createStealthContext(browser, { blockImages: true });
    context = result.context;
    page = result.page;
  } else {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1024, height: 768 }, locale: 'en-US',
    });
    page = await context.newPage();
  }

  try {
    console.log(`[QUADTREE] Capturing pb template...`);
    const firstCategory = categories[0] || 'Restaurant';
    const pbTemplate = await capturePbTemplate(page, firstCategory, bbox.centerLat, bbox.centerLng);
    console.log(`[QUADTREE] pb template captured (${pbTemplate.length} chars)`);

    let catIndex = 0;
    const totalCategories = categories.length;

    for (const category of categories) {
      catIndex++;
      if (completedCategories.has(category)) {
        console.log(`[QUADTREE] Skipping ${category} (already done)`);
        continue;
      }

      console.log(`\n[QUADTREE] === Category ${catIndex}/${totalCategories}: ${category} ===`);

      const stats = { requests: 0, errors: 0, totalIds: 0 };
      const catStartIds = allPlaceIds.size;
      const startTime = Date.now();

      let lastSaveAt = 0;
      const saveThrottle = options.saveInterval || CONFIG.saveInterval;

      const onProgress = (st, msg) => {
        console.log(`  ${msg} [total: ${allPlaceIds.size}]`);
        if (progressCallback) {
          progressCallback(catIndex, totalCategories, `${category}: ${allPlaceIds.size} POIs (${st.requests} req)`);
        }
        if (incrementalSaveFile && st.requests - lastSaveAt >= saveThrottle) {
          lastSaveAt = st.requests;
          savePOIData(incrementalSaveFile, placesFile, allPlaceIds, placeStore, results, bbox, catIndex, totalCategories, category, st.requests);
        }
      };

      // Phase 1: Quadtree with pagination
      await searchCell(page, category, bbox, pbTemplate, allPlaceIds, placeStore, stats, 0, { ...options, onProgress });

      // Phase 2: Offset grid pass
      if (options.enableOffsetGrid !== false && CONFIG.enableOffsetGrid) {
        console.log(`  [offset] Running offset grid pass...`);
        await runOffsetGrid(page, category, bbox, pbTemplate, allPlaceIds, placeStore, stats, { ...options, onProgress });
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const catNewIds = allPlaceIds.size - catStartIds;

      results.push({ category, newPlaceIds: catNewIds, requests: stats.requests, errors: stats.errors, elapsed });
      console.log(`[QUADTREE] ${category}: +${catNewIds} new POIs (${stats.requests} requests, ${elapsed}s)`);
      console.log(`[QUADTREE] Running total: ${allPlaceIds.size} unique POIs`);

      // Save after each category
      savePOIData(incrementalSaveFile, placesFile, allPlaceIds, placeStore, results, bbox, catIndex, totalCategories);
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
// Save helpers
// ============================================

function savePOIData(incrementalSaveFile, placesFile, allPlaceIds, placeStore, results, bbox, catIndex, totalCategories, currentCategory, requests) {
  // Save poi_search.json
  if (incrementalSaveFile) {
    const saveData = {
      timestamp: new Date().toISOString(),
      progress: { categoriesDone: catIndex, totalCategories, currentCategory, requests },
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

  // Save places.ndjson
  if (placesFile) {
    try {
      const lines = [];
      for (const [ftid, p] of placeStore) {
        const record = {
          extractedAt: new Date().toISOString(),
          sourceUrl: `https://www.google.com/maps/place/?ftid=${ftid}&hl=en`,
          business: {
            name: p.name, address: p.address, fullAddress: p.fullAddress,
            coordinates: (p.lat != null && p.lng != null) ? { lat: p.lat, lng: p.lng } : null,
            latitude: p.lat, longitude: p.lng, placeId: ftid,
            categories: p.categories, mainCategory: p.mainCategory,
            rating: p.rating, reviewCount: p.reviewCount, priceRange: p.priceRange,
            phone: p.phone, website: p.website, plusCode: null,
          },
          _meta: { placeId: ftid, chijId: p.chijId, sourceUrl: `https://www.google.com/maps/place/?ftid=${ftid}&hl=en`, neighborhood: p.neighborhood, timezone: p.timezone },
        };
        lines.push(JSON.stringify(record));
      }
      const tmp = placesFile + '.tmp';
      fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, placesFile);
    } catch (e) {}
  }
}

// ============================================
// File loading utilities
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
    const lat = parseFloat(row[latIdx]), lng = parseFloat(row[lngIdx]);
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
  fetchPage,
  fetchCellPaginated,
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
