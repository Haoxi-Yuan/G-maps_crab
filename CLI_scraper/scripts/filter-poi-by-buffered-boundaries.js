#!/usr/bin/env node
'use strict';

/**
 * Keep only the POIs that fall inside a boundary set, expanded outward by a
 * buffer in metres.
 *
 * The POI search deliberately runs with a generous buffer so entrances, car
 * parks and adjacent F&B are not missed, which means the harvested set reaches
 * past the boundary. This re-filters that harvest against a tighter buffer
 * using the same outward-expansion semantics as
 * multi-boundary-orchestrator.js: turf.buffer(feature, metres / 1000).
 *
 * Inputs are never modified — matches and non-matches are written to separate
 * files, unlike src/filter-by-boundary.js which overwrites in place.
 *
 * Usage:
 *   node scripts/filter-poi-by-buffered-boundaries.js \
 *     --boundaries data/Park_singapore/473parks.geojson \
 *     --buffer 10 \
 *     --out-inside  inside.ndjson \
 *     --out-outside outside.ndjson \
 *     places.part-0.ndjson [places.part-1.ndjson ...]
 */

const fs = require('fs');
const readline = require('readline');
const turf = require('@turf/turf');

function parseArgs(argv) {
  const args = { buffer: 10, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--boundaries') args.boundaries = argv[++i];
    else if (flag === '--buffer') args.buffer = Number(argv[++i]);
    else if (flag === '--out-inside') args.outInside = argv[++i];
    else if (flag === '--out-outside') args.outOutside = argv[++i];
    else if (flag === '--name-property') args.nameProperty = argv[++i];
    else if (flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`);
    else args.inputs.push(flag);
  }
  if (!args.boundaries || !args.outInside || !args.outOutside || !args.inputs.length) {
    throw new Error('--boundaries, --out-inside, --out-outside and at least one input are required');
  }
  if (!Number.isFinite(args.buffer) || args.buffer < 0) throw new Error('--buffer must be >= 0');
  return args;
}

const nameOf = (props, key) => (key && props[key])
  || props.name || props.NAME || props.Name || props.title || props.id || null;

function boundaryName(props, key, index) {
  return String(nameOf(props || {}, key) || `area_${index + 1}`);
}

// Buffer every boundary once and keep its bbox. The bbox check rejects almost
// every polygon in O(1), so each point runs only a handful of exact tests.
function prepare(boundaries, bufferMeters, nameProperty) {
  const prepared = [];
  let skipped = 0;
  for (const [index, feature] of boundaries.features.entries()) {
    const geometry = feature && feature.geometry;
    if (!geometry || !/Polygon$/.test(geometry.type)) { skipped++; continue; }
    let shape = { type: 'Feature', properties: {}, geometry };
    if (bufferMeters > 0) {
      const buffered = turf.buffer(shape, bufferMeters / 1000, { units: 'kilometers' });
      if (buffered && buffered.geometry) shape = buffered;
    }
    prepared.push({
      name: boundaryName(feature.properties, nameProperty, index),
      shape,
      bbox: turf.bbox(shape),
    });
  }
  return { prepared, skipped };
}

function hits(prepared, lng, lat) {
  const found = [];
  const point = turf.point([lng, lat]);
  for (const area of prepared) {
    const [minX, minY, maxX, maxY] = area.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (turf.booleanPointInPolygon(point, area.shape)) found.push(area.name);
  }
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const boundaries = JSON.parse(fs.readFileSync(args.boundaries, 'utf8'));
  process.stderr.write(`[FILTER] buffering ${boundaries.features.length} boundaries by ${args.buffer} m\n`);
  const { prepared, skipped } = prepare(boundaries, args.buffer, args.nameProperty);
  process.stderr.write(`[FILTER] ${prepared.length} usable boundaries (${skipped} skipped)\n`);

  const inside = fs.createWriteStream(args.outInside);
  const outside = fs.createWriteStream(args.outOutside);
  const areaCounts = new Map();
  let total = 0, kept = 0, dropped = 0, noCoords = 0, unparsed = 0;

  for (const file of args.inputs) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      total++;
      let record;
      try { record = JSON.parse(line); } catch { unparsed++; continue; }
      const business = record.business || {};
      const lat = business.latitude ?? (business.coordinates && business.coordinates.lat);
      const lng = business.longitude ?? (business.coordinates && business.coordinates.lng);
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        noCoords++;
        outside.write(line + '\n');
        continue;
      }
      const matched = hits(prepared, lng, lat);
      if (matched.length) {
        kept++;
        for (const name of matched) areaCounts.set(name, (areaCounts.get(name) || 0) + 1);
        inside.write(line + '\n');
      } else {
        dropped++;
        outside.write(line + '\n');
      }
      if (total % 5000 === 0) process.stderr.write(`[FILTER] ${total} scanned, ${kept} inside\n`);
    }
  }
  await new Promise((r) => inside.end(r));
  await new Promise((r) => outside.end(r));

  console.log(JSON.stringify({
    bufferMeters: args.buffer,
    boundaries: prepared.length,
    total, inside: kept, outside: dropped, noCoordinates: noCoords, unparsed,
    keptRatio: total ? Number((kept / total).toFixed(4)) : null,
    areasWithPois: areaCounts.size,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error); process.exit(1); });
}

module.exports = { prepare, hits };
