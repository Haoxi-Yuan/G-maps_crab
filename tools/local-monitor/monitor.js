#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, '../../CLI_scraper'),
    interval: 5,
    once: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--once') { options.once = true; continue; }
    if (key === '--root') { options.root = path.resolve(argv[++index]); continue; }
    if (key === '--interval') { options.interval = Number(argv[++index]); continue; }
    if (key === '--help') { options.help = true; continue; }
    throw new Error(`unknown option: ${key}`);
  }
  if (!Number.isFinite(options.interval) || options.interval < 1) throw new Error('--interval must be at least 1 second');
  return options;
}

function usage() {
  console.log(`
Local Scraper Monitor

Usage:
  node tools/local-monitor/monitor.js [--once] [--interval 5] [--root PATH]

This portable monitor reads small *.live.json sidecars only. It does not scan
large NDJSON output files and never connects to Atlas or another remote host.
`);
}

function collect(directory, depth = 0) {
  if (depth > 5 || !fs.existsSync(directory)) return [];
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...collect(target, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.live.json')) results.push(target);
  }
  return results;
}

function render(options) {
  const output = path.join(options.root, 'output');
  const rows = [];
  for (const file of collect(output)) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const completed = value.index ?? value.completed ?? value.categoryIndex ?? value.areaCompleted ?? '-';
      const total = value.total ?? value.categoryTotal ?? value.areaTotal ?? '-';
      rows.push({
        task: value.pipeline || value.taskType || (file.includes('review') ? 'reviews' : 'poi'),
        city: value.city || path.basename(path.dirname(file)),
        phase: value.phase || '-',
        progress: `${completed}/${total}`,
        item: value.name || value.category || value.currentItem || '-',
        updated: value.updatedAt || fs.statSync(file).mtime.toISOString(),
      });
    } catch (error) {
      rows.push({ task: 'invalid', city: path.basename(path.dirname(file)), phase: error.message, progress: '-', item: '-', updated: '-' });
    }
  }

  if (!options.once && process.stdout.isTTY) console.clear();
  console.log(`Local Scraper Monitor · ${new Date().toISOString()} · ${options.root}`);
  if (!rows.length) {
    console.log('No live sidecars found.');
    return;
  }
  console.table(rows);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  render(options);
  if (!options.once) setInterval(() => render(options), options.interval * 1000);
}

try {
  main();
} catch (error) {
  console.error(`Monitor error: ${error.message}`);
  process.exitCode = 1;
}
