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

function filterByBoundary(inputFile, boundaryFile) {
  const contains = loadBoundary(boundaryFile);

  const lines = fs.readFileSync(inputFile, 'utf8').trim().split('\n');
  const kept = [];
  const removed = [];
  let noCoords = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const p = JSON.parse(line);
    const biz = p.business || {};
    const coords = biz.coordinates;

    if (!coords || coords.lat == null || coords.lng == null) {
      // No coordinates — keep (can't determine)
      kept.push(line);
      noCoords++;
      continue;
    }

    if (contains(coords.lat, coords.lng)) {
      kept.push(line);
    } else {
      removed.push(line);
    }
  }

  // Write filtered file (replace original)
  fs.writeFileSync(inputFile, kept.join('\n') + '\n', 'utf8');

  // Write removed places for review
  const removedFile = inputFile.replace(/\.ndjson$/, '_removed.ndjson');
  if (removed.length > 0) {
    fs.writeFileSync(removedFile, removed.join('\n') + '\n', 'utf8');
  }

  console.log(`Filtered: ${inputFile}`);
  console.log(`  Total:     ${lines.length}`);
  console.log(`  Kept:      ${kept.length} (${(kept.length / lines.length * 100).toFixed(1)}%)`);
  console.log(`  Removed:   ${removed.length} → ${removedFile}`);
  console.log(`  No coords: ${noCoords} (kept)`);

  return { total: lines.length, kept: kept.length, removed: removed.length, noCoords };
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

  filterByBoundary(inputFile, boundaryFile);
}

module.exports = { filterByBoundary, pointInPolygon, pointInMultiPolygon, ringContains };
