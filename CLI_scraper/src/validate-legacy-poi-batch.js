#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { splitAreas } = require('./multi-boundary-orchestrator');

function parseArgs(argv) {
  const options = { root: path.resolve(__dirname, '..'), boundaries: null, batch: null, expected: null };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--root') options.root = path.resolve(argv[++index]);
    else if (argv[index] === '--boundaries') options.boundaries = argv[++index];
    else if (argv[index] === '--batch') options.batch = argv[++index];
    else if (argv[index] === '--expected') options.expected = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.boundaries || !options.batch || !options.expected) {
    throw new Error('--boundaries, --batch and --expected are required');
  }
  return options;
}

function validate(options) {
  const root = options.root || path.resolve(__dirname, '..');
  const boundaries = path.resolve(root, options.boundaries);
  const areas = splitAreas(boundaries, options.batch);
  const categories = require('../config/categories.json').categories;
  if (areas.length !== options.expected) {
    throw new Error(`input areas=${areas.length}, expected=${options.expected}`);
  }

  const failures = [];
  for (const area of areas) {
    const dir = path.join(root, 'output', area.relDir);
    const markerFile = path.join(dir, '_area_complete.json');
    const checkpointFile = path.join(dir, 'poi_search.json');
    try {
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
      const got = new Set((checkpoint.results || []).map((row) => row.category));
      const missing = categories.filter((category) => !got.has(category));
      if (!marker.completedAt || missing.length) {
        failures.push({
          area: area.slug,
          marker: Boolean(marker.completedAt),
          missingCategories: missing.length,
        });
      }
    } catch (error) {
      failures.push({ area: area.slug, error: error.message });
    }
  }
  if (failures.length) {
    const error = new Error(`${failures.length} area(s) failed strict POI validation`);
    error.failures = failures;
    throw error;
  }

  const outputRoot = path.join(root, 'output', '_batches', options.batch);
  const marker = {
    batch: options.batch,
    completedAt: new Date().toISOString(),
    expectedAreas: options.expected,
    completedAreas: areas.length,
    categoriesPerArea: categories.length,
    reviewBarrier: 'validated_before_release',
  };
  const target = path.join(outputRoot, '_poi_batch_complete.json');
  fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(marker, null, 2)}\n`);
  fs.renameSync(`${target}.tmp`, target);
  return marker;
}

if (require.main === module) {
  try {
    const marker = validate(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ event: 'poi_batch_validated', ...marker }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'poi_batch_incomplete',
      error: error.message,
      failures: error.failures || [],
    }, null, 2));
    process.exit(1);
  }
}

module.exports = { parseArgs, validate };
