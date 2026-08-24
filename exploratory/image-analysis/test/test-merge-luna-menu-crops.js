#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { normalizeText, parseArgs } = require('../scripts/merge-luna-menu-crops');

assert.equal(normalizeText('  Cream-Cheese  '), 'cream cheese');
assert.equal(normalizeText('桂花乌龙茶'), '桂花乌龙茶');
assert.equal(normalizeText('$ 2.50'), '2 50');
assert.equal(parseArgs([
  '--crop-db', 'c.db', '--parent-sample-db', 'p.db', '--luna-db', 'l.db',
  '--luna-run-id', 'luna', '--out', 'o.db',
]).runId, 'menu_merged_smoke_v1');
console.log('test-merge-luna-menu-crops: ok');
