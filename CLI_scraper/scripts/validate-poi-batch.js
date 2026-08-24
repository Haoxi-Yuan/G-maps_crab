#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { splitAreas, areaOutputDir } = require('../src/multi-boundary-orchestrator');

function parseArgs(argv) {
  const opts = { expected: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--boundaries') opts.boundaries = argv[++i];
    else if (argv[i] === '--name') opts.name = argv[++i];
    else if (argv[i] === '--expected') opts.expected = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!opts.boundaries || !opts.name) throw new Error('--boundaries and --name are required');
  return opts;
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const boundaries = path.resolve(opts.boundaries);
  const areas = splitAreas(boundaries, opts.name);
  const categories = readJSON(path.resolve(__dirname, '..', 'config/categories.json')).categories;
  const failures = [];

  if (opts.expected != null && areas.length !== opts.expected) {
    failures.push(`boundary_count=${areas.length}, expected=${opts.expected}`);
  }

  for (const area of areas) {
    const dir = areaOutputDir(area);
    try {
      const marker = readJSON(path.join(dir, '_area_complete.json'));
      const checkpoint = readJSON(path.join(dir, 'poi_search.json'));
      const done = new Set((checkpoint.results || []).map((entry) => entry.category));
      const missing = categories.filter((category) => !done.has(category));
      const places = fs.statSync(path.join(dir, 'places.ndjson'));
      if (marker.area !== area.slug) throw new Error(`marker area=${marker.area}`);
      if (done.size !== categories.length || missing.length) {
        throw new Error(`categories=${done.size}/${categories.length}`);
      }
      if (places.size === 0) throw new Error('places.ndjson is empty');
    } catch (error) {
      failures.push(`${area.slug}: ${error.message}`);
    }
  }

  console.log(`POI batch validation: ${areas.length - failures.length}/${areas.length} areas valid`);
  for (const failure of failures) console.error(`  ${failure}`);
  if (failures.length) process.exit(1);
}

main();
