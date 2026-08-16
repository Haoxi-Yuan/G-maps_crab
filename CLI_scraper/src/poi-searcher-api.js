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
const readline = require('readline');
const { buildContainsCheck } = require('./filter-by-boundary');

// ============================================
// Boundary pre-filter (skip cells outside boundary)
// ============================================

function loadBoundaryCheck(boundaryFile) {
  if (!boundaryFile || !fs.existsSync(boundaryFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(boundaryFile, 'utf8'));
    return buildContainsCheck(data);
  } catch (e) {}
  return null;
}

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
  requestTimeoutMs: 45000,

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

async function fetchPage(page, query, lat, lng, altitude, pbTemplate, offset = 0, options = {}) {
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

  // page.evaluate throws if the browser/context/page is closed (Chromium
  // sometimes dies after long runs). Catch those throws here so the retry
  // loop in fetchCellPaginated can decide what to do — and so a single
  // browser death doesn't crash the whole scrape.
  let result;
  try {
    result = await page.evaluate(async ({ fetchUrl, timeoutMs }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(fetchUrl, { credentials: 'include', signal: controller.signal });
      if (!resp.ok) return { error: `http_${resp.status}`, httpStatus: resp.status, structureComplete: false, places: [] };
      const text = await resp.text();
      const idx = text.indexOf('[');
      if (idx < 0) return { error: 'no_json', httpStatus: resp.status, structureComplete: false, places: [] };
      const data = JSON.parse(text.substring(idx));
      // Keep "an empty result" distinct from a damaged/throttled response.
      // A missing/non-array result slot is not accepted as an empty tile.
      const structureComplete = Array.isArray(data) && Array.isArray(data[64]);
      if (!structureComplete) {
        return { error: 'incomplete_response_structure', httpStatus: resp.status, structureComplete: false, places: [] };
      }
      const rawPlaces = data[64];
      const places = [];
      for (const item of rawPlaces) {
        const p = item && item[1];
        if (!p || !p[10]) continue;
        const phone = p[178] && p[178][0] && p[178][0][0] || null;

        // Opening hours from [203]
        let openingHours = null;
        try {
          const rawHours = p[203];
          if (rawHours && Array.isArray(rawHours[0])) {
            const currentStatus = (rawHours[1] && rawHours[1][4] && rawHours[1][4][0]) || null;
            const weeklyHours = [];
            for (const day of rawHours[0]) {
              if (!Array.isArray(day)) continue;
              const dayName = day[0];
              const hours = day[3] ? day[3].map(h => h[0]).join(', ') : 'Closed';
              const openHour = day[3] && day[3][0] && day[3][0][1] && day[3][0][1][0] ? day[3][0][1][0][0] : null;
              const closeHour = day[3] && day[3][0] && day[3][0][1] && day[3][0][1][1] ? day[3][0][1][1][0] : null;
              weeklyHours.push({ day: dayName, hours, openHour, closeHour });
            }
            openingHours = { currentStatus, weeklyHours };
          }
        } catch (e) {}

        // About/attributes from [100]
        let about = null;
        try {
          const rawAbout = p[100];
          if (rawAbout && Array.isArray(rawAbout)) {
            about = {};
            for (const section of rawAbout) {
              if (!Array.isArray(section)) continue;
              // Each section is either:
              //   [key, label, items] — a flat attribute
              //   [[subSection1], [subSection2], ...] — grouped sections
              if (section[0] && Array.isArray(section[0]) && typeof section[0][0] === 'string' && section[0][0].startsWith('/geo/')) {
                // Single flat attribute: ["/geo/...", "Label", ...]
                const label = section[0][1] || '';
                if (label) {
                  if (!about['Highlights']) about['Highlights'] = [];
                  about['Highlights'].push(label);
                }
              } else {
                // Grouped: iterate sub-sections
                for (const sub of section) {
                  if (!Array.isArray(sub)) continue;
                  const groupKey = sub[0];
                  const groupLabel = sub[1];
                  if (typeof groupKey === 'string' && typeof groupLabel === 'string' && Array.isArray(sub[2])) {
                    // [key, label, [[attr], [attr], ...]]
                    const items = [];
                    for (const attr of sub[2]) {
                      if (Array.isArray(attr) && attr[1]) items.push(attr[1]);
                    }
                    if (items.length > 0) about[groupLabel] = items;
                  } else if (typeof groupKey === 'string' && groupKey.startsWith('/geo/') && sub[1]) {
                    // Flat attr inside group
                    if (!about['Highlights']) about['Highlights'] = [];
                    about['Highlights'].push(sub[1]);
                  }
                }
              }
            }
            if (Object.keys(about).length === 0) about = null;
          }
        } catch (e) {}

        // Description from [32]
        let description = null;
        try {
          if (p[32] && Array.isArray(p[32])) {
            // [32][0][1] = short description, [32][1][1] = long description
            description = (p[32][1] && p[32][1][1]) || (p[32][0] && p[32][0][1]) || null;
          }
        } catch (e) {}

        // Popular times from [24] (numeric format)
        let popularTimes = null;
        try {
          const rawPop = p[245];
          if (rawPop && Array.isArray(rawPop[0])) {
            popularTimes = { weeklyData: [] };
            const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            const popData = rawPop[0];
            if (Array.isArray(popData)) {
              for (const dayData of popData) {
                if (!Array.isArray(dayData) || !Array.isArray(dayData[1])) continue;
                const dayIdx = dayData[0];
                const hourlyData = [];
                for (const hourEntry of dayData[1]) {
                  if (Array.isArray(hourEntry)) {
                    hourlyData.push({
                      hour: hourEntry[0],
                      popularity: hourEntry[1] || 0,
                    });
                  }
                }
                if (hourlyData.length > 0) {
                  popularTimes.weeklyData.push({
                    day: dayNames[dayIdx] || `Day${dayIdx}`,
                    hourlyData,
                  });
                }
              }
            }
            if (popularTimes.weeklyData.length === 0) popularTimes = null;
          }
        } catch (e) {}

        // Photos from [37] (primary) and [105] (gallery)
        let photos = null;
        try {
          const extractPhotoUrls = (arr) => {
            const urls = [];
            const str = JSON.stringify(arr);
            const matches = str.match(/https:\/\/lh[0-9]\.googleusercontent\.com\/[^"]+/g);
            if (matches) {
              for (const url of matches) {
                if (!url.includes('/s44-') && !url.includes('-k-no-ns-nd')) { // skip tiny thumbnails/avatars
                  urls.push(url);
                }
              }
            }
            return [...new Set(urls)];
          };
          const primaryPhotos = p[37] ? extractPhotoUrls(p[37]) : [];
          const galleryPhotos = p[105] ? extractPhotoUrls(p[105]) : [];
          const allPhotos = [...new Set([...primaryPhotos, ...galleryPhotos])];
          if (allPhotos.length > 0) photos = allPhotos;
        } catch (e) {}

        // Owner info from [57]
        let ownerInfo = null;
        try {
          if (p[57] && p[57][1]) {
            ownerInfo = { name: p[57][1], id: p[57][2] || null };
          }
        } catch (e) {}

        // Category IDs (machine-readable) from [76]
        let categoryIds = null;
        try {
          if (p[76] && Array.isArray(p[76])) {
            categoryIds = p[76].map(c => Array.isArray(c) ? { id: c[0], label: c[1] } : null).filter(Boolean);
          }
        } catch (e) {}

        // Google short link from [89]
        const googleId = p[89] || null;

        // Identity badges from [196] (LGBTQ+ friendly, Women-owned, etc.)
        let identityBadges = null;
        try {
          if (p[196] && Array.isArray(p[196][1])) {
            identityBadges = p[196][1].map(b => Array.isArray(b) && b[1] ? b[1][0] : null).filter(Boolean);
            if (identityBadges.length === 0) identityBadges = null;
          }
        } catch (e) {}

        // Service options: extract from about's "Service options" group (more complete than [142])
        let serviceOptions = null;
        if (about && about['Service options']) {
          serviceOptions = about['Service options'];
        }
        // Fallback to [142] if about didn't have it
        if (!serviceOptions) {
          try {
            const raw142 = p[142];
            if (raw142 && raw142[1] && raw142[1][0] && raw142[1][0][6]) {
              const opts = raw142[1][0][6][0];
              if (Array.isArray(opts)) {
                serviceOptions = opts.map(o => Array.isArray(o) && o[0] ? o[0][0] : null).filter(Boolean);
                if (serviceOptions.length === 0) serviceOptions = null;
              }
            }
          } catch (e) {}
        }

        places.push({
          ftid: p[10],
          chijId: p[78] || null,
          googleId,
          lat: p[9] ? p[9][2] : null,
          lng: p[9] ? p[9][3] : null,
          name: p[11] || null,
          address: p[2] || null,
          fullAddress: p[18] || null,
          rating: p[4] ? p[4][7] : null,
          reviewCount: p[4] ? p[4][8] : null,
          priceRange: p[4] ? p[4][2] : null,
          categories: p[13] || null,
          categoryIds,
          mainCategory: p[13] && p[13][0] || null,
          neighborhood: p[14] || null,
          website: p[7] && p[7][1] || null,
          phone,
          timezone: p[30] || null,
          description,
          openingHours,
          about,
          popularTimes,
          photos,
          ownerInfo,
          identityBadges,
          serviceOptions,
          plusCode: null,
        });
      }
      return { places, httpStatus: resp.status, structureComplete: true };
    } catch (e) {
      const code = e && e.name === 'AbortError' ? 'request_timeout' : `fetch_failed:${e && e.message || e}`;
      return { error: code, structureComplete: false, places: [] };
    } finally {
      clearTimeout(timeout);
    }
    }, { fetchUrl: url, timeoutMs: options.requestTimeoutMs ?? CONFIG.requestTimeoutMs });
  } catch (e) {
    const msg = String(e && e.message || '');
    if (/Target page, context or browser has been closed|Browser has been closed|Execution context was destroyed|page has been closed/i.test(msg)) {
      return { error: 'browser_closed', structureComplete: false, places: [] };
    }
    return { error: 'evaluate_failed:' + msg.substring(0, 80), structureComplete: false, places: [] };
  }
  return result;
}

// ============================================
// Paginated fetch (all pages for one viewport)
// ============================================

async function fetchCellPaginated(page, query, lat, lng, altitude, pbTemplate, globalIds, stats, opts = {}) {
  const maxPages = opts.maxPaginationPages ?? CONFIG.maxPaginationPages;
  const delayMs = opts.requestDelayMs ?? CONFIG.requestDelayMs;
  const placeWriter = opts._placeWriter || null;
  const newIds = [];
  let lastPageFull = false;
  let paginationComplete = true;
  let responseStructureComplete = true;
  let fetchError = null;
  let pagesFetched = 0;

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    const offset = pageNum * CONFIG.pageSize;
    stats.requests++;

    let result;
    for (let attempt = 0; attempt <= (opts.maxRetries ?? CONFIG.maxRetries); attempt++) {
      result = await fetchPage(page, query, lat, lng, altitude, pbTemplate, offset, opts);
      if (!result.error) break;
      if (attempt < (opts.maxRetries ?? CONFIG.maxRetries)) {
        await page.waitForTimeout(opts.retryDelayMs ?? CONFIG.retryDelayMs);
      }
    }

    if (result.error) {
      stats.errors++;
      paginationComplete = false;
      responseStructureComplete = false;
      fetchError = result.error;
      break;
    }
    pagesFetched++;
    responseStructureComplete = responseStructureComplete && result.structureComplete === true;
    if (result.places.length === 0) break;

    // Collect new IDs and stream-write fresh records (first occurrence wins,
    // matching prior placeStore semantics — duplicates within a run are dropped).
    let newThisPage = 0;
    for (const place of result.places) {
      // In-boundary test (uses the same buffered boundary as the post-filter).
      // With no boundary loaded (whole-city runs) every place counts as in.
      const inBoundary = (place.lat != null && place.lng != null)
        && (!opts._boundaryCheck || opts._boundaryCheck(place.lat, place.lng));
      // Self-adapt discovery: only LEARN types from in-boundary POIs. Otherwise
      // spread pulls the whole neighbourhood's vocabulary in and the closure
      // never converges on a small area (fires for dup POIs too — a dup still
      // confirms its type is relevant here).
      if (opts._onCategory && place.mainCategory && inBoundary) opts._onCategory(place.mainCategory);
      if (!globalIds.has(place.ftid)) {
        globalIds.add(place.ftid);
        newIds.push(place.ftid);
        stats.totalIds++;
        newThisPage++;
        if (inBoundary && opts._inBoundaryCounter) opts._inBoundaryCounter.count++;
        if (placeWriter) placeWriter.writeRecord(place, place.ftid);
      }
    }

    lastPageFull = result.places.length >= CONFIG.pageSize;

    // If this page had zero new IDs, stop paginating (all dupes)
    if (newThisPage === 0) break;
    // If page not full, we've reached the end
    if (!lastPageFull) break;

    if (pageNum < maxPages - 1) await page.waitForTimeout(delayMs);
  }

  return {
    newIds,
    lastPageFull,
    paginationComplete,
    responseStructureComplete,
    fetchError,
    pagesFetched,
  };
}

class PaginationIncompleteError extends Error {
  constructor(query, bbox, fetchError) {
    super(`Pagination incomplete for "${query}" at ${bbox.centerLat},${bbox.centerLng}: ${fetchError}`);
    this.name = 'PaginationIncompleteError';
    this.code = 'PAGINATION_INCOMPLETE';
    this.query = query;
    this.bbox = bbox;
    this.fetchError = fetchError;
  }
}

// ============================================
// Quadtree search with pagination
// ============================================

async function searchCell(page, query, bbox, pbTemplate, globalIds, stats, depth = 0, opts = {}) {
  const maxDepth = opts.maxDepth ?? CONFIG.maxDepth;
  const minCell = opts.minCellSizeKm ?? CONFIG.minCellSizeKm;
  const delayMs = opts.requestDelayMs ?? CONFIG.requestDelayMs;
  const onProgress = opts.onProgress || null;
  const boundaryCheck = opts._boundaryCheck || null;

  // Skip cells whose center is outside the boundary (saves ~30% requests for border cities).
  // Center-only testing is wrong for concave or disjoint boundaries: a coarse
  // cell can have its center in a gap while still containing whole boundary
  // pieces. Sampling points are guaranteed in-boundary at ~cellSize density,
  // so a cell holding any seed point must not be pruned.
  if (boundaryCheck && !boundaryCheck(bbox.centerLat, bbox.centerLng)) {
    const seeds = opts._seedPoints;
    const cellHasSeed = Array.isArray(seeds) && seeds.some((p) =>
      p.lat >= bbox.minLat && p.lat <= bbox.maxLat &&
      p.lng >= bbox.minLng && p.lng <= bbox.maxLng
    );
    if (!cellHasSeed) {
      stats.skippedOutside = (stats.skippedOutside || 0) + 1;
      return [];
    }
  }

  const zoom = cellSizeToZoom(bbox.sizeKm);
  const altitude = calculateAltitude(zoom, bbox.centerLat);

  // Step 1: Paginate this cell fully
  const { newIds, lastPageFull, paginationComplete, fetchError } = await fetchCellPaginated(
    page, query, bbox.centerLat, bbox.centerLng, altitude, pbTemplate,
    globalIds, stats, opts
  );
  if (!paginationComplete) throw new PaginationIncompleteError(query, bbox, fetchError);

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
      const subIds = await searchCell(page, query, quad, pbTemplate, globalIds, stats, depth + 1, opts);
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

async function runOffsetGrid(page, query, bbox, pbTemplate, globalIds, stats, opts = {}) {
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

  const boundaryCheck = opts._boundaryCheck || null;

  const seeds = opts._seedPoints;

  for (let lat = bbox.minLat + offsetLat; lat <= bbox.maxLat; lat += stepLat) {
    for (let lng = bbox.minLng + offsetLng; lng <= bbox.maxLng; lng += stepLng) {
      // Skip cells outside boundary — same seed-point guard as searchCell:
      // a 4km cell whose center is out may still contain a small boundary piece.
      if (boundaryCheck && !boundaryCheck(lat, lng)) {
        const cellHasSeed = Array.isArray(seeds) && seeds.some((p) =>
          p.lat >= lat - offsetLat && p.lat <= lat + offsetLat &&
          p.lng >= lng - offsetLng && p.lng <= lng + offsetLng
        );
        if (!cellHasSeed) continue;
      }

      const pageResult = await fetchCellPaginated(
        page, query, lat, lng, altitude, pbTemplate,
        globalIds, stats, opts
      );
      if (!pageResult.paginationComplete) {
        throw new PaginationIncompleteError(query, {
          centerLat: lat,
          centerLng: lng,
          sizeKm: cellSizeKm,
        }, pageResult.fetchError);
      }
      const { newIds } = pageResult;
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
  const results = [];

  const incrementalSaveFile = options.incrementalSaveFile;
  const placesFile = incrementalSaveFile
    ? incrementalSaveFile.replace(/[^/]+$/, 'places.ndjson')
    : null;

  // Resume support: only the per-category progress comes from poi_search.json;
  // place IDs are streamed from places.ndjson (single source of truth, avoids
  // loading 360k records into memory at startup).
  const completedCategories = new Set();

  if (incrementalSaveFile && fs.existsSync(incrementalSaveFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(incrementalSaveFile, 'utf8'));
      if (existing.results) {
        for (const r of existing.results) {
          results.push(r);
          completedCategories.add(r.category);
        }
      }
    } catch (e) {
      console.warn(`[QUADTREE] Resume load failed: ${e.message}`);
    }
  }

  const allPlaceIds = await streamLoadPlaceIds(placesFile);
  if (allPlaceIds.size > 0 || completedCategories.size > 0) {
    console.log(`[QUADTREE] Resuming: ${allPlaceIds.size} place_ids (from ndjson), ${completedCategories.size} categories done`);
  }

  const placeWriter = createPlaceWriter(placesFile);

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

    // Load boundary for pre-filtering cells
    const boundaryFile = options.boundaryFile || null;
    const boundaryCheck = loadBoundaryCheck(boundaryFile);
    if (boundaryCheck) {
      console.log(`[QUADTREE] Boundary pre-filter loaded from ${boundaryFile}`);
    }

    // One search query (a category or a self-adapt-discovered type): full
    // quadtree + offset-grid pass, streaming new POIs and bookkeeping. Shared by
    // the fixed-category loop and the self-adapt closure. `onCategory` (optional)
    // is the discovery hook that feeds returned mainCategories back to the closure.
    const runOneQuery = async (query, catIndex, totalCategories, onCategory) => {
      console.log(`\n[QUADTREE] === Query ${catIndex}/${totalCategories}: ${query} ===`);

      const stats = { requests: 0, errors: 0, totalIds: 0 };
      const catStartIds = allPlaceIds.size;
      const startTime = Date.now();

      let lastSaveAt = 0;
      const saveThrottle = options.saveInterval || CONFIG.saveInterval;

      const onProgress = (st, msg) => {
        console.log(`  ${msg} [total: ${allPlaceIds.size}]`);
        if (progressCallback) {
          progressCallback(catIndex, totalCategories, `${query}: ${allPlaceIds.size} POIs (${st.requests} req)`);
        }
        if (incrementalSaveFile && st.requests - lastSaveAt >= saveThrottle) {
          lastSaveAt = st.requests;
          savePOIData(incrementalSaveFile, allPlaceIds, results, bbox, catIndex, totalCategories, query, st.requests);
        }
      };

      // Per-query in-boundary counter — the meaningful yield signal for bounded
      // areas (raw yield stays high from spread and never converges).
      const inBoundaryCounter = { count: 0 };
      const cellOpts = { ...options, onProgress, _boundaryCheck: boundaryCheck, _placeWriter: placeWriter, _seedPoints: points, _onCategory: onCategory || null, _inBoundaryCounter: inBoundaryCounter };

      // Phase 1: Quadtree with pagination
      await searchCell(page, query, bbox, pbTemplate, allPlaceIds, stats, 0, cellOpts);

      // Phase 2: Offset grid pass
      if (options.enableOffsetGrid !== false && CONFIG.enableOffsetGrid) {
        console.log(`  [offset] Running offset grid pass...`);
        await runOffsetGrid(page, query, bbox, pbTemplate, allPlaceIds, stats, cellOpts);
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const catNewIds = allPlaceIds.size - catStartIds;
      const inBoundaryNew = boundaryCheck ? inBoundaryCounter.count : catNewIds;

      results.push({ category: query, newPlaceIds: catNewIds, inBoundaryNew, requests: stats.requests, errors: stats.errors, elapsed });
      console.log(`[QUADTREE] ${query}: +${catNewIds} new POIs (${inBoundaryNew} in-boundary) (${stats.requests} requests, ${elapsed}s)`);
      console.log(`[QUADTREE] Running total: ${allPlaceIds.size} unique POIs`);

      // Save after each query
      savePOIData(incrementalSaveFile, allPlaceIds, results, bbox, catIndex, totalCategories);
      // Self-adapt uses in-boundary yield for convergence + vocab ranking; the
      // fixed-category loop ignores the return value.
      return inBoundaryNew;
    };

    if (options.selfAdapt) {
      // Category-free enumeration: generic seeds -> search -> harvest Google's own
      // mainCategory labels off the results -> enqueue unseen types -> fixpoint.
      await runSelfAdaptClosure(runOneQuery, allPlaceIds, completedCategories, options);
    } else {
      let catIndex = 0;
      const totalCategories = categories.length;
      for (const category of categories) {
        catIndex++;
        if (completedCategories.has(category)) {
          console.log(`[QUADTREE] Skipping ${category} (already done)`);
          continue;
        }
        await runOneQuery(category, catIndex, totalCategories);
      }
    }

  } finally {
    try { await page.close(); } catch (_) {}
    try { await context.close(); } catch (_) {}
    try { await placeWriter.close(); } catch (_) {}
  }

  return {
    totalPlaceIds: allPlaceIds.size,
    placesFile: placesFile || null,
    results,
    searchArea: { ...bbox },
  };
}

// ============================================
// Save helpers
// ============================================

function formatPlaceRecord(p, ftid) {
  return {
    extractedAt: new Date().toISOString(),
    sourceUrl: `https://www.google.com/maps/place/?ftid=${ftid}&hl=en`,
    business: {
      name: p.name, address: p.address, fullAddress: p.fullAddress,
      coordinates: (p.lat != null && p.lng != null) ? { lat: p.lat, lng: p.lng } : null,
      latitude: p.lat, longitude: p.lng, placeId: ftid,
      categories: p.categories, categoryIds: p.categoryIds || null,
      mainCategory: p.mainCategory,
      rating: p.rating, reviewCount: p.reviewCount, priceRange: p.priceRange,
      phone: p.phone, website: p.website, plusCode: p.plusCode || null,
      photos: p.photos || null,
      ownerInfo: p.ownerInfo || null,
      serviceOptions: p.serviceOptions || null,
      identityBadges: p.identityBadges || null,
    },
    openingHours: p.openingHours || null,
    popularTimes: p.popularTimes || null,
    about: p.about || null,
    metadata: { description: p.description || null },
    _meta: {
      placeId: ftid, chijId: p.chijId, googleId: p.googleId || null,
      sourceUrl: `https://www.google.com/maps/place/?ftid=${ftid}&hl=en`,
      neighborhood: p.neighborhood, timezone: p.timezone,
    },
  };
}

// Append-mode writer for places.ndjson. One long-lived fd, single writer per
// process — no atomic-replace, no in-memory buffering of the full corpus.
// Resume tolerates a torn final line via streamLoadPlaceIds.
function createPlaceWriter(placesFile) {
  if (!placesFile) {
    return { writeRecord: () => {}, close: async () => {}, error: () => null };
  }
  const stream = fs.createWriteStream(placesFile, { flags: 'a', encoding: 'utf8' });
  let writeError = null;
  stream.on('error', (err) => {
    writeError = err;
    console.error(`[QUADTREE] places.ndjson stream error: ${err.message}`);
  });
  return {
    writeRecord(p, ftid) {
      if (writeError) throw writeError;
      stream.write(JSON.stringify(formatPlaceRecord(p, ftid)) + '\n');
    },
    async close() {
      await new Promise((res) => stream.end(res));
    },
    error: () => writeError,
  };
}

// Stream-read existing places.ndjson into a Set of placeIds. Tolerates a torn
// final line (skips and warns) so resume after a crash mid-write doesn't fail.
async function streamLoadPlaceIds(placesFile) {
  const ids = new Set();
  if (!placesFile || !fs.existsSync(placesFile)) return ids;
  const rl = readline.createInterface({
    input: fs.createReadStream(placesFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let bad = 0;
  for await (const line of rl) {
    if (!line) continue;
    try {
      const p = JSON.parse(line);
      if (p && p._meta && p._meta.placeId) ids.add(p._meta.placeId);
    } catch (e) {
      bad++;
    }
  }
  if (bad > 0) {
    console.warn(`[QUADTREE] Skipped ${bad} unparseable line(s) in ${placesFile} (likely torn from prior crash)`);
  }
  return ids;
}

function savePOIData(incrementalSaveFile, allPlaceIds, results, bbox, catIndex, totalCategories, currentCategory, requests) {
  if (!incrementalSaveFile) return;
  const saveData = {
    timestamp: new Date().toISOString(),
    progress: { categoriesDone: catIndex, totalCategories, currentCategory, requests },
    totalPlaceIds: allPlaceIds.size,
    results,
    searchArea: { ...bbox },
  };
  try {
    const tmp = incrementalSaveFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(saveData, null, 2), 'utf8');
    fs.renameSync(tmp, incrementalSaveFile);
  } catch (e) {}
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
// Self-adapting category discovery
// ============================================

const SA_DEFAULT_SEEDS = [
  'restaurant', 'cafe', 'shop', 'store', 'supermarket', 'service', 'clinic',
  'hospital', 'pharmacy', 'office', 'salon', 'hotel', 'school', 'bank', 'gym',
  'market', 'park', 'church', 'car repair', 'bakery',
];
const saNorm = (c) => String(c || '').toLowerCase().trim();

// Cross-area vocabulary: {ranked:[display...], byCat:{norm:{display,yield}}}.
// `ranked` is yield-ordered so later areas search the highest-yield types first
// (priority) and can truncate early — the "discover-once, harvest-everywhere" win.
function loadVocab(file) {
  if (!file) return { ranked: [], byCat: {} };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ranked: Array.isArray(v.ranked) ? v.ranked : [], byCat: v.byCat || {} };
  } catch (e) { return { ranked: [], byCat: {} }; }
}

function saveVocab(file, catYield) {
  if (!file) return;
  const v = loadVocab(file);
  const byCat = v.byCat || {};
  for (const [c, y] of Object.entries(catYield)) {
    const n = saNorm(c);
    if (!n) continue;
    if (!byCat[n]) byCat[n] = { display: c, yield: 0 };
    byCat[n].yield += y;
  }
  const ranked = Object.values(byCat).sort((a, b) => b.yield - a.yield).map((e) => e.display);
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ranked, byCat }, null, 0));
    fs.renameSync(tmp, file);
  } catch (e) { console.warn(`[SELF-ADAPT] vocab save failed: ${e.message}`); }
}

// Drive the closure: seed queue with (shared vocab, ranked) then generic seeds;
// every returned POI's mainCategory that hasn't been searched is enqueued; run
// until the queue drains, a query budget is hit, or K consecutive low-yield
// queries signal convergence. Reuses runOneQuery (full quadtree + dedup + save).
async function runSelfAdaptClosure(runOneQuery, allPlaceIds, completedCategories, options) {
  const seeds = (options.saSeeds && options.saSeeds.length) ? options.saSeeds : SA_DEFAULT_SEEDS;
  const maxQueries = options.saMaxQueries || 300;
  const stopAfterDry = options.saStopAfterDry || 0;   // 0 = disabled
  const minYield = options.saMinYield ?? 1;

  const searched = new Set([...completedCategories].map(saNorm));
  const queued = new Set();
  const queue = [];
  const catYield = {};
  const enqueue = (c) => {
    const n = saNorm(c);
    if (!n || n === 'unknown' || searched.has(n) || queued.has(n)) return;
    queued.add(n);
    queue.push(String(c));
  };

  const vocab = loadVocab(options.saVocabFile);
  for (const c of vocab.ranked) enqueue(c);   // priority: prior-area yield order
  for (const s of seeds) enqueue(s);           // guarantee bootstrap even on a cold vocab

  const onCategory = (mc) => enqueue(mc);
  // Try the whole generic-seed set (+ primed vocab head) before allowing
  // convergence, so an area isn't abandoned just because the first few seeds
  // happen to have no in-boundary hits.
  const minBeforeConverge = Math.min(seeds.length, 12);
  let qIdx = completedCategories.size;
  let ran = 0, dry = 0;
  console.log(`[SELF-ADAPT] seeds=${seeds.length}, primed-from-vocab=${vocab.ranked.length}, budget=${maxQueries} queries, stopAfterDry=${stopAfterDry || 'off'} (on in-boundary yield)`);

  while (queue.length && ran < maxQueries) {
    const query = queue.shift();
    const nq = saNorm(query);
    if (searched.has(nq)) continue;
    searched.add(nq);
    const totalLabel = `~${searched.size + queue.length}`;
    const y = await runOneQuery(query, ++qIdx, totalLabel, onCategory);
    catYield[query] = (catYield[query] || 0) + y;   // y = in-boundary new POIs
    ran++;
    if (y < minYield) dry++; else dry = 0;
    if (stopAfterDry && ran >= minBeforeConverge && dry >= stopAfterDry) {
      console.log(`[SELF-ADAPT] Converged: ${dry} consecutive queries with <${minYield} in-boundary new POIs`);
      break;
    }
  }
  console.log(`[SELF-ADAPT] Done: ${ran} queries this run, ${searched.size} distinct searched, ${queue.length} still queued`);
  saveVocab(options.saVocabFile, catYield);
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
  formatPlaceRecord,
  PaginationIncompleteError,
  CONFIG,
};
