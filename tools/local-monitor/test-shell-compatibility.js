#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourcePath = path.join(__dirname, 'ScraperMonitor.swift');
const source = fs.readFileSync(sourcePath, 'utf8');
const match = source.match(/        emit_row\(\) \{([\s\S]*?)\n        \}/);
assert(match, 'unable to locate emit_row in ScraperMonitor.swift');

// Swift turns each doubled backslash in the multiline string into one
// backslash before passing the script to the local or remote login shell.
const emitRow = `emit_row() {${match[1]}\n}`.replaceAll('\\\\', '\\');
const script = `
b64text() { printf '%s' "$1" | base64 | tr -d '\\r\\n'; }
${emitRow}
emit_row reviews 42 singapore /tmp/reviews.ndjson 123 D 7 payload reviews command 9 10 reviews
`;

for (const shell of ['/bin/bash', '/bin/zsh']) {
  const result = spawnSync(shell, ['-fc', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${shell} failed: ${result.stderr}`);
  const fields = result.stdout.trim().split('\t');
  assert.equal(fields.length, 16, `${shell} emitted ${fields.length} TSV fields`);
  assert.equal(fields[0], 'reviews');
  assert.equal(fields[1], '42');
  assert.equal(Buffer.from(fields[3], 'base64').toString(), '/tmp/reviews.ndjson');
  assert.equal(fields[7], 'payload');
}

console.log('Scraper Monitor probe shell compatibility: ok (bash, zsh)');
