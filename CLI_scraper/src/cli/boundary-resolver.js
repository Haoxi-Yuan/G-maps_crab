'use strict';

/**
 * Disambiguation helper for Stage 1.
 *
 * Overpass returns every administrative relation matching the given name —
 * "Amsterdam" pulls up the one in the Netherlands, the tiny one in Missouri,
 * etc. This module lists them with stats (admin_level, bbox area, center)
 * so the wizard can present a picker, then fetches exactly one relation's
 * geometry by its OSM id.
 */

const https = require('https');

const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const UA = 'gmaps-crab/1.0 (boundary-resolver)';
const MIN_GAP_MS = 1000;

let _lastQueryAt = 0;

function _postOnce(query, overpassUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(overpassUrl);
    const body = `data=${encodeURIComponent(query)}`;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      timeout: 90000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': UA,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(buf)); }
          catch (e) { reject(new Error('Failed to parse Overpass response')); }
        } else {
          reject(new Error(`Overpass API returned status ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

async function overpassPost(query) {
  let lastErr = null;
  for (const url of OVERPASS_URLS) {
    const gap = MIN_GAP_MS - (Date.now() - _lastQueryAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    _lastQueryAt = Date.now();
    try { return await _postOnce(query, url); }
    catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '');
      const transient = /status (429|502|503|504)|timeout|ECONN|ETIMEDOUT|ENOTFOUND/i.test(msg);
      if (!transient) throw e;
    }
  }
  throw lastErr || new Error('All Overpass mirrors failed');
}

/**
 * Search Nominatim for administrative-boundary relations matching the query,
 * ranked by Nominatim's `importance`. Returns enough info to both disambiguate
 * (country, bbox, coords) and subsequently fetch geometry via Overpass (osm_id).
 *
 * Nominatim handles disambiguation, case-folding, localization, and typos in
 * a single fast call — way more practical than regex-scanning Overpass for
 * common names like "London" or "Paris".
 */
async function listCandidates(cityName) {
  const path = `/search?q=${encodeURIComponent(cityName)}&format=json&addressdetails=1&limit=10`;
  const data = await _nominatimGet(path);

  const list = [];
  for (const r of (data || [])) {
    // We need a relation to fetch full geometry from Overpass. Ways/nodes have
    // no meaningful administrative polygon.
    if (r.osm_type !== 'relation') continue;
    const bb = r.boundingbox;
    if (!bb || bb.length < 4) continue;
    const [minLat, maxLat, minLon, maxLon] = bb.map(parseFloat);
    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLon + maxLon) / 2;
    const dLat = maxLat - minLat;
    const dLng = (maxLon - minLon) * Math.cos(centerLat * Math.PI / 180);
    const areaKm2 = dLat * dLng * 111 * 111;
    const a = r.address || {};
    // Prefer a short local name, fall back to the first piece of display_name.
    const shortName = a.city || a.town || a.village || a.municipality || a.suburb
      || r.name || (r.display_name || '').split(',')[0];
    list.push({
      osm_id: parseInt(r.osm_id, 10),
      name: shortName,
      display_name: r.display_name || '',
      type: r.type || '',          // e.g. "administrative", "city"
      class: r.class || '',         // e.g. "boundary", "place"
      place_rank: r.place_rank,
      importance: typeof r.importance === 'number' ? r.importance : 0,
      country: a.country || null,
      country_code: (a.country_code || '').toUpperCase() || null,
      area_km2: areaKm2,
      bbox: [minLon, minLat, maxLon, maxLat],
      center: [centerLat, centerLng],
    });
  }
  // Nominatim already returns best matches first (by importance). Keep that order.
  return list;
}

/**
 * Fetch the full geometry of a single OSM relation by id. Returns raw
 * Overpass JSON; caller converts to GeoJSON using BoundaryGenerator._convertToGeoJSON.
 */
async function fetchRelationGeometry(osmId) {
  const query = `[out:json][timeout:90];relation(${osmId});out geom;`;
  return overpassPost(query);
}

// --- Nominatim helper --------------------------------------------------------
// Usage policy: ≤1 request/second, meaningful UA required.
const NOMINATIM_HOST = 'nominatim.openstreetmap.org';
const NOMINATIM_MIN_GAP_MS = 1100;
let _lastNominatimAt = 0;

async function _nominatimGet(path) {
  const gap = NOMINATIM_MIN_GAP_MS - (Date.now() - _lastNominatimAt);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  _lastNominatimAt = Date.now();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: NOMINATIM_HOST,
      path,
      method: 'GET',
      timeout: 20000,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Nominatim returned status ${res.statusCode}`));
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('Failed to parse Nominatim response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Nominatim request timeout')); });
    req.end();
  });
}

module.exports = { listCandidates, fetchRelationGeometry };
