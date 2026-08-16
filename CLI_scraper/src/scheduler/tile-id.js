'use strict';

const MAX_MERCATOR_LAT = 85.0511287798066;

function clampLatitude(lat) {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, Number(lat)));
}

function normalizeLongitude(lng) {
  const value = Number(lng);
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function assertZoom(zoom) {
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) {
    throw new Error(`zoom must be an integer between 0 and 22, got ${zoom}`);
  }
}

function lonLatToTile(lng, lat, zoom) {
  assertZoom(zoom);
  const n = 2 ** zoom;
  const x = Math.min(n - 1, Math.max(0, Math.floor((normalizeLongitude(lng) + 180) / 360 * n)));
  const latRad = clampLatitude(lat) * Math.PI / 180;
  const yFloat = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n;
  const y = Math.min(n - 1, Math.max(0, Math.floor(yFloat)));
  return { x, y, zoom };
}

function tileToQuadkey(x, y, zoom) {
  assertZoom(zoom);
  const n = 2 ** zoom;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
    throw new Error(`invalid tile ${zoom}/${x}/${y}`);
  }
  let key = '';
  for (let level = zoom; level > 0; level--) {
    const mask = 1 << (level - 1);
    let digit = 0;
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    key += String(digit);
  }
  return key;
}

function quadkeyToTile(quadkey) {
  if (typeof quadkey !== 'string' || !/^[0-3]*$/.test(quadkey) || quadkey.length > 22) {
    throw new Error(`invalid quadkey: ${quadkey}`);
  }
  let x = 0;
  let y = 0;
  for (let i = 0; i < quadkey.length; i++) {
    const mask = 1 << (quadkey.length - i - 1);
    const digit = Number(quadkey[i]);
    if (digit & 1) x |= mask;
    if (digit & 2) y |= mask;
  }
  return { x, y, zoom: quadkey.length };
}

function makeTileId(x, y, zoom) {
  return `qk:${zoom}:${tileToQuadkey(x, y, zoom)}`;
}

function parseTileId(tileId) {
  const match = /^qk:(\d{1,2}):([0-3]*)$/.exec(String(tileId));
  if (!match) throw new Error(`invalid tile_id: ${tileId}`);
  const zoom = Number(match[1]);
  const tile = quadkeyToTile(match[2]);
  if (tile.zoom !== zoom) throw new Error(`tile_id zoom/quadkey mismatch: ${tileId}`);
  return tile;
}

function tileBounds(x, y, zoom) {
  assertZoom(zoom);
  const n = 2 ** zoom;
  const longitude = (tileX) => tileX / n * 360 - 180;
  const latitude = (tileY) => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;
  const west = longitude(x);
  const east = longitude(x + 1);
  const north = latitude(y);
  const south = latitude(y + 1);
  return {
    minLat: south,
    maxLat: north,
    minLng: west,
    maxLng: east,
    centerLat: (south + north) / 2,
    centerLng: (west + east) / 2,
  };
}

function childTiles(tile) {
  const { x, y, zoom } = typeof tile === 'string' ? parseTileId(tile) : tile;
  if (zoom >= 22) return [];
  return [
    { x: x * 2, y: y * 2, zoom: zoom + 1 },
    { x: x * 2 + 1, y: y * 2, zoom: zoom + 1 },
    { x: x * 2, y: y * 2 + 1, zoom: zoom + 1 },
    { x: x * 2 + 1, y: y * 2 + 1, zoom: zoom + 1 },
  ].map((child) => ({ ...child, tileId: makeTileId(child.x, child.y, child.zoom), bbox: tileBounds(child.x, child.y, child.zoom) }));
}

function makeTaskKey(boundaryId, categoryGroup, tileId) {
  for (const [name, value] of Object.entries({ boundaryId, categoryGroup, tileId })) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  }
  return `v1/${encodeURIComponent(boundaryId)}/${encodeURIComponent(categoryGroup)}/${tileId}`;
}

function collectCoordinates(value, output = []) {
  if (!value) return output;
  if (value.type === 'FeatureCollection') {
    for (const feature of value.features || []) collectCoordinates(feature, output);
  } else if (value.type === 'Feature') {
    collectCoordinates(value.geometry, output);
  } else if (value.type === 'GeometryCollection') {
    for (const geometry of value.geometries || []) collectCoordinates(geometry, output);
  } else if (Array.isArray(value.coordinates)) {
    const visit = (node) => {
      if (Array.isArray(node) && node.length >= 2 && Number.isFinite(node[0]) && Number.isFinite(node[1])) {
        output.push([Number(node[0]), Number(node[1])]);
      } else if (Array.isArray(node)) {
        for (const child of node) visit(child);
      }
    };
    visit(value.coordinates);
  }
  return output;
}

// Return the shortest longitude interval that covers all vertices. The end can
// exceed 180; callers normalize tile x values modulo the world width. This
// avoids turning a dateline-crossing country into an almost-worldwide bbox.
function minimalLongitudeInterval(longitudes) {
  if (!longitudes.length) throw new Error('geometry has no coordinates');
  const values = longitudes.map((lng) => ((Number(lng) % 360) + 360) % 360).sort((a, b) => a - b);
  if (values.length === 1) return { start: values[0], end: values[0], span: 0 };
  let largestGap = -1;
  let largestIndex = -1;
  for (let i = 0; i < values.length; i++) {
    const next = i === values.length - 1 ? values[0] + 360 : values[i + 1];
    const gap = next - values[i];
    if (gap > largestGap) {
      largestGap = gap;
      largestIndex = i;
    }
  }
  const start = values[(largestIndex + 1) % values.length];
  let end = values[largestIndex];
  if (end < start) end += 360;
  return { start, end, span: end - start };
}

function coveringTiles(geojson, zoom, intersects = null) {
  assertZoom(zoom);
  const coords = collectCoordinates(geojson);
  if (!coords.length) throw new Error('boundary has no coordinates');
  const minLat = Math.min(...coords.map((point) => point[1]));
  const maxLat = Math.max(...coords.map((point) => point[1]));
  const interval = minimalLongitudeInterval(coords.map((point) => point[0]));
  const n = 2 ** zoom;
  const continuousX = (lng0to360) => (lng0to360 + 180) / 360 * n;
  const xStart = Math.floor(continuousX(interval.start));
  const xEnd = Math.floor(continuousX(interval.end - Number.EPSILON));
  const northTile = lonLatToTile(0, maxLat, zoom).y;
  const southTile = lonLatToTile(0, minLat, zoom).y;
  const tiles = [];
  const seen = new Set();
  for (let rawX = xStart; rawX <= xEnd; rawX++) {
    const x = ((rawX % n) + n) % n;
    for (let y = northTile; y <= southTile; y++) {
      const tile = { x, y, zoom, tileId: makeTileId(x, y, zoom), bbox: tileBounds(x, y, zoom) };
      if (seen.has(tile.tileId)) continue;
      if (intersects && !intersects(tile)) continue;
      seen.add(tile.tileId);
      tiles.push(tile);
    }
  }
  return tiles.sort((a, b) => a.tileId.localeCompare(b.tileId));
}

function chooseRootZoom({ areaKm2, centroidLat = 0, targetTasks = 1, minZoom = 0, maxZoom = 16 }) {
  if (!(areaKm2 > 0) || !(targetTasks > 0)) throw new Error('areaKm2 and targetTasks must be positive');
  const targetWidthKm = Math.sqrt(areaKm2 / targetTasks);
  const worldWidthAtLatKm = 40075.016686 * Math.max(0.01, Math.cos(clampLatitude(centroidLat) * Math.PI / 180));
  const raw = Math.round(Math.log2(worldWidthAtLatKm / Math.max(0.01, targetWidthKm)));
  return Math.max(minZoom, Math.min(maxZoom, raw));
}

module.exports = {
  MAX_MERCATOR_LAT,
  clampLatitude,
  normalizeLongitude,
  lonLatToTile,
  tileToQuadkey,
  quadkeyToTile,
  makeTileId,
  parseTileId,
  tileBounds,
  childTiles,
  makeTaskKey,
  collectCoordinates,
  minimalLongitudeInterval,
  coveringTiles,
  chooseRootZoom,
};
