#!/usr/bin/env node
/**
 * Interactive wizard for Stage 1 — boundary + sampling points (+ optional map PNG).
 * Wraps src/city-generator/index.js without modifying it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

// city-generator's index.js doesn't export its class — it's CLI-only — so we
// spawn it as a child process to avoid modifying that file.

const ROOT = path.resolve(__dirname, '..', '..');

function ask(rl, q, def) {
  return new Promise((resolve) => {
    const suffix = def !== undefined && def !== '' ? ` [${def}]` : '';
    rl.question(`${q}${suffix}> `, (ans) => {
      ans = (ans || '').trim();
      resolve(ans === '' ? def : ans);
    });
  });
}

function askYesNo(rl, q, def = 'y') {
  return ask(rl, `${q} (y/n)`, def).then((a) =>
    String(a).toLowerCase().startsWith('y')
  );
}

function sanitizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function runCityGenerator(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'src', 'city-generator', 'index.js'), ...args],
      { stdio: 'inherit', cwd: ROOT }
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`city-generator exited with ${code}`))
    );
  });
}

function banner() {
  console.log('');
  console.log('=========================================');
  console.log('  Stage 1 — City boundary + sampling points');
  console.log('=========================================');
  console.log('');
}

async function listExistingCities() {
  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

async function main() {
  banner();

  const existing = await listExistingCities();
  if (existing.length) {
    console.log('Existing cities in data/:');
    existing.forEach((c) => console.log(`  - ${c}`));
    console.log('');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // --- Boundary source ---
    const modeAns = await ask(
      rl,
      'Boundary source: [1] search OSM by city name (interactive pick)  [2] use existing GeoJSON file',
      '1'
    );
    const mode = String(modeAns).trim();

    let cityName = '';
    let boundaryFile = '';

    if (mode === '2') {
      boundaryFile = await ask(rl, 'Path to boundary GeoJSON', '');
      if (!boundaryFile || !fs.existsSync(boundaryFile)) {
        console.error('File not found:', boundaryFile);
        process.exit(1);
      }
      cityName = await ask(rl, 'City name (for output folder)', '');
    } else {
      cityName = await ask(rl, 'City name (e.g. "Singapore", "Tokyo, Japan")', '');
      if (!cityName) {
        console.error('City name required.');
        process.exit(1);
      }

      // --- Disambiguation: list OSM relations matching the name and let the
      // user pick one. Avoids merging unrelated same-named cities (e.g. the
      // Amsterdam in NL vs a namesake village in Missouri).
      const { listCandidates, fetchRelationGeometry } = require('./boundary-resolver.js');
      const BoundaryGenerator = require('../city-generator/boundary-generator.js');

      console.log('');
      console.log(`Searching OSM for "${cityName}"...`);
      let candidates;
      try {
        candidates = await listCandidates(cityName);
      } catch (e) {
        console.error('Overpass query failed:', e.message);
        process.exit(1);
      }

      if (!candidates.length) {
        console.error(`No administrative boundaries found for "${cityName}".`);
        console.error('Try a different spelling, or use option [2] with a manual GeoJSON.');
        process.exit(1);
      }

      const maxShow = 15;
      const shown = candidates.slice(0, maxShow);

      console.log('');
      console.log(`Found ${candidates.length} candidate(s) — sorted by Nominatim importance:`);
      shown.forEach((c, i) => {
        const [lat, lng] = c.center;
        const area = c.area_km2 >= 1
          ? `${c.area_km2.toFixed(0)} km²`
          : `${(c.area_km2 * 1e6).toFixed(0)} m²`;
        const cc = c.country_code ? `[${c.country_code}]` : '[??]';
        const cname = c.country ? ` ${c.country}` : '';
        const kind = c.type ? ` type=${c.type}` : '';
        console.log(
          `  [${i + 1}] ${c.name} ${cc}${cname} ${kind}  area≈${area}  ` +
          `center=(${lat.toFixed(3)}°, ${lng.toFixed(3)}°)  osm_id=${c.osm_id}`
        );
      });
      if (candidates.length > maxShow) {
        console.log(`  ... (${candidates.length - maxShow} more omitted)`);
      }

      const pickAns = await ask(rl, `Select [1-${shown.length}]`, '1');
      const idx = parseInt(pickAns, 10);
      if (!Number.isFinite(idx) || idx < 1 || idx > shown.length) {
        console.error('Invalid selection.');
        process.exit(1);
      }
      const chosen = shown[idx - 1];
      console.log(`Selected: ${chosen.name}  (osm_id=${chosen.osm_id}, admin_level=${chosen.admin_level})`);

      console.log('Fetching geometry...');
      let overpassData;
      try {
        overpassData = await fetchRelationGeometry(chosen.osm_id);
      } catch (e) {
        console.error('Geometry fetch failed:', e.message);
        process.exit(1);
      }
      const bg = new BoundaryGenerator();
      const geojson = await bg._convertToGeoJSON(overpassData);
      // Force the feature's name to match what the user typed so the rest of
      // the pipeline (output dir slug, file names) stays consistent.
      if (geojson && geojson.features) {
        geojson.features.forEach((f) => {
          f.properties = f.properties || {};
          f.properties.name = cityName;
          f.properties.osm_id = chosen.osm_id;
        });
      }

      const slugNow = sanitizeName(cityName);
      const boundaryDir = path.join(ROOT, 'data', slugNow);
      fs.mkdirSync(boundaryDir, { recursive: true });
      const saved = path.join(boundaryDir, `${slugNow}_boundary.geojson`);
      fs.writeFileSync(saved, JSON.stringify(geojson, null, 2));
      console.log(`Saved boundary: ${path.relative(ROOT, saved)}`);
      boundaryFile = saved;
    }

    const slug = sanitizeName(cityName);
    const outputDir = path.join('data', slug);

    // --- Point-generation params ---
    const cellSize = await ask(
      rl,
      'Cell size in meters (sampling density, smaller = more points)',
      '1000'
    );
    const numPoints = await ask(rl, 'Number of points (empty = auto)', '');
    const iterations = await ask(rl, 'Lloyd relaxation iterations', '10');
    const bbox = await ask(
      rl,
      'Optional bbox clip (minLng,minLat,maxLng,maxLat, empty = none)',
      ''
    );

    // --- Map PNG export ---
    const exportMap = await askYesNo(rl, 'Export boundary map PNG (with basemap tiles)?', 'y');
    let mapOpts = null;
    if (exportMap) {
      const basemap = await ask(
        rl,
        'Basemap: [1] OSM  [2] Carto Light  [3] Carto Dark  [4] ESRI Satellite',
        '1'
      );
      const withPoints = await askYesNo(rl, 'Overlay sampling points on map?', 'y');
      const sizeAns = await ask(rl, 'Map image size WxH', '1600x1200');
      const [w, h] = String(sizeAns).toLowerCase().split('x').map((n) => parseInt(n, 10));
      mapOpts = {
        basemap: { '1': 'osm', '2': 'carto-light', '3': 'carto-dark', '4': 'esri-satellite' }[
          String(basemap).trim()
        ] || 'osm',
        withPoints,
        width: Number.isFinite(w) && w > 0 ? w : 1600,
        height: Number.isFinite(h) && h > 0 ? h : 1200,
      };
    }

    rl.close();

    // --- Build city-generator args ---
    const args = ['--output', outputDir];
    if (cityName) args.push('--city', cityName);
    if (boundaryFile) args.push('--boundary', boundaryFile);
    if (cellSize) args.push('--cell-size', String(cellSize));
    if (numPoints) args.push('--points', String(numPoints));
    if (iterations) args.push('--iterations', String(iterations));
    if (bbox) args.push('--bbox', String(bbox));

    console.log('');
    console.log('Running city-generator with:');
    console.log('  ' + ['node', 'src/city-generator/index.js', ...args].join(' '));
    console.log('');

    await runCityGenerator(args);

    // --- Optional map PNG (Python: geopandas + contextily) ---
    if (mapOpts) {
      console.log('');
      console.log('Rendering boundary map PNG...');
      const boundaryPath = path.join(ROOT, outputDir, `${slug}_boundary.geojson`);
      const pointsPath = path.join(ROOT, outputDir, `${slug}_points.geojson`);
      const outPath = path.join(ROOT, outputDir, `${slug}_map.png`);
      const pyScript = path.join(ROOT, 'src', 'cli', 'render-boundary-map.py');
      const venvPy = path.join(ROOT, '.venv', 'bin', 'python3');
      const pyBin = fs.existsSync(venvPy) ? venvPy : 'python3';

      const pyArgs = [pyScript,
        '--boundary', boundaryPath,
        '--out', outPath,
        '--basemap', mapOpts.basemap,
        '--width', String(mapOpts.width),
        '--height', String(mapOpts.height),
        '--title', cityName,
      ];
      if (mapOpts.withPoints && fs.existsSync(pointsPath)) {
        pyArgs.push('--points', pointsPath);
      }

      try {
        await new Promise((resolve, reject) => {
          const child = spawn(pyBin, pyArgs, { stdio: 'inherit', cwd: ROOT });
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`renderer exited with ${code}`))
          );
        });
        console.log(`Map saved: ${path.relative(ROOT, outPath)}`);
      } catch (e) {
        console.error('Map render failed:', e.message);
        console.error('  (ensure ./bootstrap.sh ran successfully and .venv/ exists)');
      }
    }

    console.log('');
    console.log('Stage 1 complete.');
    console.log(`Next: run Stage 2 (POI search) from the main menu, using city "${slug}".`);
  } catch (e) {
    try { rl.close(); } catch (_) {}
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
