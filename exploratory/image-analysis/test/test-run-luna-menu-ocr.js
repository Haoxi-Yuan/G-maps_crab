#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  OUTPUT_SCHEMA,
  extractOutputText,
  mimeType,
  parseArgs,
  selectSmoke,
} = require('../scripts/run-luna-menu-ocr');

assert.equal(OUTPUT_SCHEMA.additionalProperties, false);
assert.equal(extractOutputText({ output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }] }), '{"ok":true}');
assert.equal(mimeType('test.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
assert.equal(parseArgs(['--sample-db', 'a.db', '--out', 'b.db']).limit, 8);

const rows = [
  { sample_id: 'a', cohort: 'single_stratified', orientation: 'portrait', resolution_bin: '12MP+' },
  { sample_id: 'b', cohort: 'multi_poi', orientation: 'portrait', resolution_bin: '12MP+' },
  { sample_id: 'c', cohort: 'single_stratified', orientation: 'landscape', resolution_bin: '4-12MP' },
];
assert.deepEqual(selectSmoke(rows, 2).map((row) => row.sample_id), ['b', 'a']);
console.log('test-run-luna-menu-ocr: ok');
