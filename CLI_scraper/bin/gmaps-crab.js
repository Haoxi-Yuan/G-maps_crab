#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const packageJson = require('../package.json');

fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
fs.mkdirSync(path.join(root, '.playwright-browsers'), { recursive: true });
process.env.TMPDIR = process.env.TMPDIR || path.join(root, '.tmp');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(root, '.playwright-browsers');

const commands = {
  boundary: 'src/cli/boundary-wizard.js',
  poi: 'src/cli/run-poi.js',
  multi: 'src/multi-boundary-orchestrator.js',
  reviews: 'src/cli/run-reviews.js',
  db: 'src/cli/db-wizard.js',
  images: 'scripts/download-db-images.js',
};

function help() {
  console.log(`
G-Maps Crab CLI ${packageJson.version}

Usage:
  node bin/gmaps-crab.js <command> [options]

Commands:
  boundary     Generate a city boundary and sampling points
  poi          Run a single-city POI search
  multi        Run a multi-boundary POI batch
  reviews      Scrape reviews from places.ndjson
  db           Build or inspect a SQLite database
  images       Download selected images from a review SQLite database
  status       Summarize local data/output directories
  help         Show this help

Examples:
  node bin/gmaps-crab.js boundary
  node bin/gmaps-crab.js poi --city singapore
  node bin/gmaps-crab.js reviews --city singapore
  node bin/gmaps-crab.js multi --boundaries areas.geojson --name parks
  node bin/gmaps-crab.js images --help

Run any command with --help for command-specific options.
`);
}

function run(command, args = []) {
  const script = commands[command];
  if (!script) throw new Error(`unknown command: ${command}`);
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
}

async function lineCount(file) {
  if (!fs.existsSync(file)) return '-';
  return new Promise((resolve, reject) => {
    let lines = 0;
    let sawData = false;
    let lastByte = null;
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => {
      sawData = true;
      for (const byte of chunk) if (byte === 10) lines += 1;
      lastByte = chunk[chunk.length - 1];
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(lines + (sawData && lastByte !== 10 ? 1 : 0)));
  });
}

async function status() {
  const dataDirectory = path.join(root, 'data');
  const outputDirectory = path.join(root, 'output');
  console.log('\nLocal pipeline status\n');
  if (fs.existsSync(dataDirectory)) {
    for (const name of fs.readdirSync(dataDirectory).sort()) {
      const directory = path.join(dataDirectory, name);
      if (!fs.statSync(directory).isDirectory()) continue;
      const files = fs.readdirSync(directory);
      const boundary = files.some((file) => file.endsWith('_boundary.geojson')) ? 'yes' : '-';
      const points = files.some((file) => file.endsWith('_points.json')) ? 'yes' : '-';
      console.log(`data/${name}: boundary=${boundary} points=${points}`);
    }
  }
  if (fs.existsSync(outputDirectory)) {
    for (const name of fs.readdirSync(outputDirectory).sort()) {
      const directory = path.join(outputDirectory, name);
      if (!fs.statSync(directory).isDirectory() || name.startsWith('.')) continue;
      const places = await lineCount(path.join(directory, 'places.ndjson'));
      const reviews = await lineCount(path.join(directory, 'reviews.ndjson'));
      if (places !== '-' || reviews !== '-') console.log(`output/${name}: places=${places} reviews=${reviews}`);
    }
  }
  console.log('');
}

async function interactive() {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`
G-Maps Crab CLI ${packageJson.version}

  [1] Boundary and sampling points
  [2] Single-city POI search
  [3] Multi-boundary POI batch
  [4] Review scrape
  [5] SQLite database
  [6] Image downloader
  [s] Status
  [q] Quit
`);
  const answer = await new Promise((resolve) => prompt.question('Select> ', resolve));
  prompt.close();
  const selected = { '1': 'boundary', '2': 'poi', '3': 'multi', '4': 'reviews', '5': 'db', '6': 'images' }[answer.trim()];
  if (answer.trim().toLowerCase() === 'q') return;
  if (answer.trim().toLowerCase() === 's') { await status(); return; }
  if (!selected) throw new Error('invalid selection');
  if (selected === 'poi' || selected === 'multi' || selected === 'reviews' || selected === 'images') {
    console.log(`Run \"node bin/gmaps-crab.js ${selected} --help\" to provide the required input.`);
    return;
  }
  run(selected);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) { await interactive(); return; }
  if (command === 'help' || command === '--help' || command === '-h') { help(); return; }
  if (command === '--version' || command === '-v') { console.log(packageJson.version); return; }
  if (command === 'status') { await status(); return; }
  run(command, args);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
