#!/usr/bin/env node
'use strict';

const fs = require('fs');
const readline = require('readline');

async function inspect(file) {
  const summary = {
    file,
    rows: 0,
    invalidJSON: 0,
    openingHours: 0,
    weeklyHours: 0,
    currentStatus: 0,
    popularTimes: 0,
    otherHourPaths: {},
    samples: [],
  };
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { summary.invalidJSON += 1; continue; }
    summary.rows += 1;
    const hours = value.openingHours;
    if (hours && typeof hours === 'object') {
      summary.openingHours += 1;
      if (Array.isArray(hours.weeklyHours) && hours.weeklyHours.length) summary.weeklyHours += 1;
      if (hours.currentStatus != null && hours.currentStatus !== '') summary.currentStatus += 1;
      if (summary.samples.length < 3) {
        summary.samples.push({
          placeId: value.placeId || value.business?.placeId || null,
          name: value.name || value.business?.name || null,
          openingHours: hours,
        });
      }
    }
    if (value.popularTimes && typeof value.popularTimes === 'object') summary.popularTimes += 1;
    const visit = (candidate, path, depth) => {
      if (!candidate || typeof candidate !== 'object' || depth > 3) return;
      for (const [key, child] of Object.entries(candidate)) {
        const childPath = path ? `${path}.${key}` : key;
        if (/hour|opening|open_now|openNow/i.test(key) && childPath !== 'openingHours') {
          summary.otherHourPaths[childPath] = (summary.otherHourPaths[childPath] || 0) + 1;
        }
        if (!Array.isArray(child)) visit(child, childPath, depth + 1);
      }
    };
    visit(value, '', 0);
  }
  return summary;
}

(async () => {
  if (process.argv.length < 3) {
    console.error('Usage: inspect-ndjson-hours.js FILE [FILE...]');
    process.exit(64);
  }
  for (const file of process.argv.slice(2)) {
    console.log(JSON.stringify(await inspect(file)));
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
