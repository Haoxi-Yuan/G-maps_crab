#!/usr/bin/env node
'use strict';

/**
 * Boundary Filter (Post-processing)
 *
 * Filters places.ndjson by a GeoJSON boundary polygon.
 * Moves out-of-boundary places to a separate file for review.
 * Original file is replaced with filtered version.
 *
 * Usage:
 *   node src/filter-by-boundary.js --input output/city/places.ndjson --boundary data/city/boundary.geojson
 *
 * Output:
 *   - places.ndjson (overwritten with only in-boundary places)
 *   - places_removed.ndjson (out-of-boundary places for review)
 */

const fs = require('fs');
const path = require('path');

// ============================================
// Point-in-polygon (ray casting with holes)
// ============================================

function ringContains(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][1], yi = ring[i][0]; // GeoJSON is [lng, lat]
    const xj = ring[j][1], yj = ring[j][0];
    if (((yi > lng) !== (yj > lng)) &&
        (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(lat, lng, polygon) {
  // polygon = [outerRing, hole1, hole2, ...]
  // Outer ring must contain the point
  if (!ringContains(lat, lng, polygon[0])) return false;
  // Any hole containing the point → exclude
  for (let i = 1; i < polygon.length; i++) {
    if (ringContains(lat, lng, polygon[i])) return false;
  }
  return true;
}

function pointInMultiPolygon(lat, lng, multiPolygon) {
  for (const polygon of multiPolygon) {
    if (pointInPolygon(lat, lng, polygon)) return true;
  }
  return false;
}

function loadBoundary(boundaryFile) {
  const data = JSON.parse(fs.readFileSync(boundaryFile, 'utf8'));
  let geom;
  if (data.type === 'FeatureCollection') geom = data.features[0].geometry;
  else if (data.type === 'Feature') geom = data.geometry;
  else geom = data;

  if (geom.type === 'MultiPolygon') {
    return (lat, lng) => pointInMultiPolygon(lat, lng, geom.coordinates);
  } else if (geom.type === 'Polygon') {
    return (lat, lng) => pointInPolygon(lat, lng, geom.coordinates);
  }
  throw new Error(`Unsupported geometry type: ${geom.type}`);
}

// ============================================
// Main
// ============================================

async function filterByBoundary(inputFile, boundaryFile) {
  const readline = require('readline');
  const contains = loadBoundary(boundaryFile);

  // Stream-read source, stream-write kept/removed to NEW files. Once both
  // streams flush successfully, atomic-rename the kept-tmp over the original.
  // This avoids:
  //   * V8's ~512 MB string limit (readFileSync + split + join blows up at
  //     that size — Singapore places.ndjson is 518 MB)
  //   * partial-overwrite corruption if the process dies mid-write
  const tmpKept = inputFile + '.filter-tmp';
  const removedFile = inputFile.replace(/\.ndjson$/, '_removed.ndjson');
  // Clean any stale tmp from a previous failed run.
  try { fs.unlinkSync(tmpKept); } catch (_) {}
  const keptStream = fs.createWriteStream(tmpKept);
  const removedStream = fs.createWriteStream(removedFile);

  let total = 0, keptN = 0, removedN = 0, noCoords = 0, parseErrors = 0;

  async function writeLine(stream, line) {
    if (!stream.write(line + '\n')) {
      await new Promise((r) => stream.once('drain', r));
    }
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(inputFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    total++;
    let p;
    try { p = JSON.parse(line); }
    catch (e) {
      // Defensive: keep unparseable lines in the kept set so we don't drop
      // possibly-valuable data on a JSON glitch.
      parseErrors++;
      await writeLine(keptStream, line);
      keptN++;
      continue;
    }
    const biz = p.business || {};
    const coords = biz.coordinates;

    if (!coords || coords.lat == null || coords.lng == null) {
      await writeLine(keptStream, line);
      keptN++; noCoords++;
    } else if (contains(coords.lat, coords.lng)) {
      await writeLine(keptStream, line);
      keptN++;
    } else {
      await writeLine(removedStream, line);
      removedN++;
    }
  }

  await new Promise((r) => keptStream.end(r));
  await new Promise((r) => removedStream.end(r));

  // Atomic-rename tmp over the original. Same filesystem, so this is one
  // POSIX rename(2) — either the new file is in place or the old one is.
  fs.renameSync(tmpKept, inputFile);

  // Drop the removed file if nothing was filtered out (cleaner output dir).
  if (removedN === 0) {
    try { fs.unlinkSync(removedFile); } catch (_) {}
  }

  console.log(`Filtered: ${inputFile}`);
  console.log(`  Total:        ${total}`);
  console.log(`  Kept:         ${keptN} (${total ? (keptN / total * 100).toFixed(1) : 0}%)`);
  console.log(`  Removed:      ${removedN}${removedN ? ` → ${removedFile}` : ''}`);
  console.log(`  No coords:    ${noCoords} (kept)`);
  if (parseErrors) console.log(`  Parse errors: ${parseErrors} (kept as-is)`);

  return { total, kept: keptN, removed: removedN, noCoords, parseErrors };
}

// ============================================
// CLI
// ============================================

if (require.main === module) {
  const args = process.argv.slice(2);
  let inputFile = null;
  let boundaryFile = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input': inputFile = args[++i]; break;
      case '--boundary': boundaryFile = args[++i]; break;
      case '--help':
        console.log(`
Boundary Filter — remove out-of-boundary places

Usage:
  node src/filter-by-boundary.js --input <places.ndjson> --boundary <boundary.geojson>

The input file is overwritten with filtered results.
Removed places are saved to places_removed.ndjson for review.
`);
        process.exit(0);
    }
  }

  if (!inputFile || !boundaryFile) {
    console.error('ERROR: --input and --boundary are required');
    process.exit(1);
  }

  filterByBoundary(inputFile, boundaryFile).catch((err) => {
    console.error('Fatal:', err && err.stack || err);
    process.exit(1);
  });
}

module.exports = { filterByBoundary, pointInPolygon, pointInMultiPolygon, ringContains };
