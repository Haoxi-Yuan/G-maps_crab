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

// Order matters: tried top-to-bottom. overpass-api.de is the canonical
// upstream and historically the most reliable; the community mirrors are
// kept as fallbacks for when upstream is rate-limiting.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'gmaps-crab/1.0 (boundary-resolver)';
const MIN_GAP_MS = 1000;

let _lastQueryAt = 0;

function _postOnce(query, overpassUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(overpassUrl);
    const body = `data=${encodeURIComponent(query)}`;
    // Guard against double-settle: req.destroy() on timeout can synchronously
    // emit an 'error' event with an empty message that would otherwise
    // overwrite the real 'Request timeout' reason.
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
    };
    const tagError = (err) => {
      if (err && typeof err === 'object') {
        err.url = overpassUrl;
      }
      return err;
    };
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      timeout: 90000,
      // Force Happy Eyeballs even on Node versions where it's not the default.
      // Some Overpass mirrors advertise IPv6 AAAA records that route to dead
      // hosts; without this, the request silently waits ~90s per attempt
      // before falling back. 500ms is enough for v6 to win when it's healthy.
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 500,
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
          try { finish(null, JSON.parse(buf)); }
          catch (e) { finish(tagError(new Error('Failed to parse Overpass response'))); }
        } else {
          const err = new Error(`Overpass API returned status ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.bodySnippet = buf.slice(0, 200);
          finish(tagError(err));
        }
      });
    });
    req.on('error', (err) => finish(tagError(err)));
    req.on('timeout', () => {
      finish(tagError(new Error('Request timeout')));
      req.destroy();
    });
    req.write(body);
    req.end();
  });
}

async function overpassPost(query) {
  const attempts = [];
  for (const url of OVERPASS_URLS) {
    const gap = MIN_GAP_MS - (Date.now() - _lastQueryAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    _lastQueryAt = Date.now();
    try { return await _postOnce(query, url); }
    catch (e) {
      attempts.push({ url, error: e });
      const msg = String(e && e.message || '');
      const code = String(e && e.code || '');
      const transient = /status (429|502|503|504)|timeout|ECONN|ETIMEDOUT|ENOTFOUND/i.test(msg)
        || /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(code);
      if (!transient) {
        e.attempts = attempts;
        throw e;
      }
    }
  }
  const agg = new Error('All Overpass mirrors failed');
  agg.attempts = attempts;
  throw agg;
}

function _candidateFromNominatim(r, fallbackCountry = null, fallbackCC = null) {
  if (r.osm_type !== 'relation') return null;
  const bb = r.boundingbox;
  if (!bb || bb.length < 4) return null;
  const [minLat, maxLat, minLon, maxLon] = bb.map(parseFloat);
  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLon + maxLon) / 2;
  const dLat = maxLat - minLat;
  const dLng = (maxLon - minLon) * Math.cos(centerLat * Math.PI / 180);
  const areaKm2 = dLat * dLng * 111 * 111;
  const a = r.address || {};
  const shortName = a.city || a.town || a.village || a.municipality || a.suburb
    || r.name || (r.display_name || '').split(',')[0];
  // Nominatim's `lat`/`lon` is the FEATURE's representative point (the
  // city's urban centroid), not the bbox midpoint. For places like Tokyo
  // whose bbox includes Pacific islands, this distinction is critical
  // for downstream is_in queries.
  const featureLat = parseFloat(r.lat);
  const featureLng = parseFloat(r.lon);
  const point = (Number.isFinite(featureLat) && Number.isFinite(featureLng))
    ? [featureLat, featureLng] : null;
  return {
    osm_id: parseInt(r.osm_id, 10),
    name: shortName,
    name_en: null,
    display_name: r.display_name || '',
    type: r.type || '',
    class: r.class || '',
    place_rank: r.place_rank,
    importance: typeof r.importance === 'number' ? r.importance : 0,
    country: a.country || fallbackCountry,
    country_code: (a.country_code || '').toUpperCase() || fallbackCC || null,
    admin_level: r.extratags && r.extratags.admin_level
      ? parseInt(r.extratags.admin_level, 10) : null,
    area_km2: areaKm2,
    bbox: [minLon, minLat, maxLon, maxLat],
    center: [centerLat, centerLng],
    point,
    source: 'nominatim',
  };
}

function _candidateFromOverpassRelation(el, fallbackCountry, fallbackCC) {
  const tags = el.tags || {};
  const b = el.bounds;
  if (!b) return null;
  const minLat = b.minlat, maxLat = b.maxlat, minLon = b.minlon, maxLon = b.maxlon;
  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLon + maxLon) / 2;
  const dLat = maxLat - minLat;
  const dLng = (maxLon - minLon) * Math.cos(centerLat * Math.PI / 180);
  const areaKm2 = dLat * dLng * 111 * 111;
  return {
    osm_id: el.id,
    name: tags.name || tags['name:en'] || '?',
    name_en: tags['name:en'] || null,
    display_name: tags['name:en'] || tags.name || '',
    type: tags.boundary || '',
    class: tags.boundary === 'administrative' ? 'boundary' : '',
    place_rank: null,
    importance: 0,  // Overpass children sort below Nominatim primary
    country: fallbackCountry,
    country_code: fallbackCC,
    admin_level: tags.admin_level ? parseInt(tags.admin_level, 10) : null,
    area_km2: areaKm2,
    bbox: [minLon, minLat, maxLon, maxLat],
    center: [centerLat, centerLng],
    source: 'overpass-child',
  };
}

/**
 * Enumerate administrative subdivisions inside a given OSM relation via
 * Overpass. Used as a generic drill-down when the user-typed name only
 * matched a high-level admin entity (state/prefecture) and they want to
 * pick a more specific child (e.g. Tokyo → 23 wards / individual ward;
 * Greater London → boroughs; Île-de-France → Paris arrondissements).
 *
 * Returns at most `limit` children whose admin_level is HIGHER (more
 * specific) than the parent's. The parent itself is excluded.
 */
async function fetchChildAdmins(parentOsmId, parentAdminLevel, fallbackCountry, fallbackCC, limit = 30) {
  const minChildLevel = Math.max((parentAdminLevel || 4) + 1, 5);
  const query =
    `[out:json][timeout:60];\n` +
    `relation(${parentOsmId});\n` +
    `map_to_area;\n` +
    `relation(area)["boundary"="administrative"]["admin_level"~"^([${minChildLevel}-9]|10|11|12)$"];\n` +
    `out tags bb;`;
  let data;
  try { data = await overpassPost(query); }
  catch (_) { return []; }
  const out = [];
  for (const el of (data.elements || [])) {
    if (el.type !== 'relation' || el.id === parentOsmId) continue;
    const c = _candidateFromOverpassRelation(el, fallbackCountry, fallbackCC);
    if (c) out.push(c);
  }
  // Sort children by admin_level asc (broader first) then area desc, take top N
  out.sort((a, b) => {
    const al = a.admin_level || 99, bl = b.admin_level || 99;
    if (al !== bl) return al - bl;
    return b.area_km2 - a.area_km2;
  });
  return out.slice(0, limit);
}

/**
 * List ALL administrative-boundary relations whose polygon contains the given
 * lat/lng. Catches "city-proper" / urban-core collective relations that are
 * NOT structural children of the country/state hierarchy and therefore
 * miss the `area`-based drill-down (e.g. Tokyo 23 Wards osm 19631009 sits
 * parallel to the prefecture in OSM, not inside).
 */
async function fetchAdminsContainingPoint(lat, lng) {
  const query = `[out:json][timeout:30];is_in(${lat},${lng});area._;rel(pivot);out tags bb;`;
  let data;
  try { data = await overpassPost(query); }
  catch (_) { return []; }
  const out = [];
  for (const el of (data.elements || [])) {
    if (el.type !== 'relation') continue;
    const tags = el.tags || {};
    if (tags.boundary !== 'administrative') continue; // skip historic / military / timezone
    const lvl = tags.admin_level ? parseInt(tags.admin_level, 10) : null;
    // Skip very-broad (country/region) and very-granular (sub-block) levels.
    // Keep null admin_level — that's where collective "city proper" relations live.
    if (lvl !== null && (lvl < 3 || lvl > 11)) continue;
    const c = _candidateFromOverpassRelation(el, null, null);
    if (c) {
      c.source = 'overpass-pointin';
      out.push(c);
    }
  }
  return out;
}

/**
 * Search Nominatim for boundary relations matching `cityName`. If the
 * primary result is a broad admin entity (admin_level ≤ 4 or single result
 * covering a huge area), automatically drill down via TWO Overpass queries:
 *  1. children inside the parent's area (admin_level hierarchy walk)
 *  2. relations whose polygon contains the primary's centroid point
 *     (catches city-proper collectives outside the parent-child tree)
 * Entirely generic — no region-specific keywords.
 */
async function listCandidates(cityName) {
  // extratags=1 so we get admin_level on the primary results
  const path = `/search?q=${encodeURIComponent(cityName)}&format=json&addressdetails=1&extratags=1&limit=10`;
  const data = await _nominatimGet(path);

  const sink = new Map();
  let primaryTop = null;
  for (const r of (data || [])) {
    const c = _candidateFromNominatim(r);
    if (!c) continue;
    if (!sink.has(c.osm_id)) sink.set(c.osm_id, c);
    if (!primaryTop) primaryTop = c;
  }

  // If the only / top match is a high-level admin (admin_level ≤ 4) OR
  // covers a really big bbox area (> 5000 km²), enumerate its admin children
  // so the user can pick a sub-division. Generic: works for any country
  // because the OSM admin_level hierarchy is global.
  const shouldDrill = primaryTop && (
    sink.size <= 2 ||
    (primaryTop.admin_level != null && primaryTop.admin_level <= 4) ||
    primaryTop.area_km2 > 5000
  );
  if (shouldDrill) {
    const children = await fetchChildAdmins(
      primaryTop.osm_id, primaryTop.admin_level,
      primaryTop.country, primaryTop.country_code,
    );
    for (const c of children) {
      if (!sink.has(c.osm_id)) {
        c.country = c.country || primaryTop.country;
        c.country_code = c.country_code || primaryTop.country_code;
        sink.set(c.osm_id, c);
      }
    }

    // Also surface "parallel" admin relations that contain the primary's
    // urban centroid but aren't reachable via the parent-child hierarchy.
    // E.g. Tokyo 23 Wards (osm 19631009) is a separate boundary that
    // overlaps Tokyo prefecture but sits outside its hierarchy.
    if (primaryTop.point) {
      const containing = await fetchAdminsContainingPoint(
        primaryTop.point[0], primaryTop.point[1],
      );
      for (const c of containing) {
        if (!sink.has(c.osm_id)) {
          c.country = c.country || primaryTop.country;
          c.country_code = c.country_code || primaryTop.country_code;
          sink.set(c.osm_id, c);
        }
      }
    }
  }

  // Sort: Nominatim importance desc; Overpass-children come after (importance=0)
  // so the primary match stays at the top of the list.
  return [...sink.values()].sort((a, b) => b.importance - a.importance);
}

/**
 * Fetch the full geometry of a single OSM relation by id. Returns raw
 * Overpass JSON; caller converts to GeoJSON using BoundaryGenerator._convertToGeoJSON.
 */
async function fetchRelationGeometry(osmId) {
  const query = `[out:json][timeout:90];relation(${osmId});out geom;`;
  return overpassPost(query);
}

/**
 * Score how well a candidate matches "the city administrative boundary".
 *
 * Globally most cities sit at admin_level 8 (US, FR, DE, NL, ...) or 7
 * (Japan special wards / Korean cities), with city-states at 2-4 (Singapore,
 * Hong Kong) and a few outliers at 6 (London boroughs, Paris commune).
 * We bias for those levels, prefer city-sized areas, and reward exact
 * name matches.
 */
function scoreCityCandidate(c, queryName) {
  if (!c) return -Infinity;
  let s = 0;

  // Boundary relations only — place nodes / non-admin shapes are not what we want
  if (c.class === 'boundary' && c.type === 'administrative') s += 100;
  else if (c.class === 'place') s += 20;

  // admin_level: city-typical levels get top score
  const lvl = c.admin_level;
  if (lvl == null) {
    s += 0;
  } else if (lvl === 8) s += 80;
  else if (lvl === 7) s += 70;
  else if (lvl === 6) s += 50;
  else if (lvl === 9 || lvl === 10) s += 20;        // sub-city neighbourhoods
  else if (lvl === 5) s += 30;                       // metropolitan groupings
  else if (lvl === 4) {
    // prefecture / state — good for city-state-likes (HK, Beijing 直辖市)
    s += (c.area_km2 < 5000) ? 60 : -50;
  } else if (lvl === 2 || lvl === 3) {
    // country / region — only good for city-states (Singapore, Vatican...)
    s += (c.area_km2 < 5000) ? 60 : -100;
  }

  // "City proper" / collective relations frequently lack admin_level but
  // ARE the analytical unit users want (Tokyo 23 Wards osm 19631009 is
  // the canonical case — boundary=administrative, no admin_level, sits
  // parallel to the prefecture). Promote them when their area is in a
  // reasonable city range.
  if (c.class === 'boundary' && c.admin_level == null
      && c.area_km2 >= 50 && c.area_km2 <= 5000) {
    s += 80;
  }

  // Area sweet spot for cities: 10–3000 km² in bbox terms
  const km2 = c.area_km2 || 0;
  if (km2 >= 10 && km2 <= 3000) s += 30;
  else if (km2 > 3000 && km2 <= 8000) s += 0;
  else if (km2 > 8000) s -= 30;
  else if (km2 < 1) s -= 30;                          // probably a tiny shape

  // Name match against all known name variants — local name, English name,
  // and the first piece of Nominatim's display_name. Exact match is a STRONG
  // signal that this is the entity the user meant, even when geographic
  // shape is unusual (e.g. Tokyo prefecture officially named "Tokyo" but
  // includes Pacific islands).
  if (queryName) {
    const q = queryName.toLowerCase();
    const variants = [c.name, c.name_en, (c.display_name || '').split(',')[0]]
      .filter(Boolean).map((n) => String(n).toLowerCase());
    const exact = variants.some((n) => n === q);
    const sub = variants.some((n) => n.includes(q) || q.includes(n));
    if (exact) s += 200;
    else if (sub) s += 50;
  }

  // Nominatim importance bonus (caps ~+30)
  if (typeof c.importance === 'number') s += Math.min(c.importance * 30, 30);

  return s;
}

/**
 * Returns { best, alternatives } where best is the highest-scoring "city"
 * candidate and alternatives are the next ~5 candidates ordered by score.
 */
function pickBestCity(candidates, queryName) {
  if (!candidates || candidates.length === 0) return { best: null, alternatives: [] };
  const scored = candidates.map((c) => ({ c, s: scoreCityCandidate(c, queryName) }));
  scored.sort((a, b) => b.s - a.s);
  return {
    best: scored[0].c,
    bestScore: scored[0].s,
    alternatives: scored.slice(1, 6).map((x) => x.c),
    allRanked: scored.map((x) => x.c),
  };
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
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 500,
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

module.exports = { listCandidates, fetchRelationGeometry, fetchChildAdmins, pickBestCity, scoreCityCandidate };
