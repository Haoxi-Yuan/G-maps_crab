'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lonLatToTile,
  tileToQuadkey,
  quadkeyToTile,
  makeTileId,
  parseTileId,
  childTiles,
  makeTaskKey,
  minimalLongitudeInterval,
  coveringTiles,
  chooseRootZoom,
} = require('../../src/scheduler/tile-id');

test('quadkeys are deterministic and round-trip', () => {
  assert.equal(tileToQuadkey(3, 5, 3), '213');
  assert.deepEqual(quadkeyToTile('213'), { x: 3, y: 5, zoom: 3 });
  const tileId = makeTileId(3, 5, 3);
  assert.equal(tileId, 'qk:3:213');
  assert.deepEqual(parseTileId(tileId), { x: 3, y: 5, zoom: 3 });
});

test('children append the standard 0/1/2/3 quad path exactly once', () => {
  const parent = lonLatToTile(103.85, 1.29, 12);
  const parentKey = tileToQuadkey(parent.x, parent.y, parent.zoom);
  const children = childTiles(parent);
  assert.equal(children.length, 4);
  assert.deepEqual(
    children.map((child) => tileToQuadkey(child.x, child.y, child.zoom).slice(-1)),
    ['0', '1', '2', '3'],
  );
  for (const child of children) {
    assert.ok(tileToQuadkey(child.x, child.y, child.zoom).startsWith(parentKey));
  }
});

test('task key is the deterministic boundary/category/tile identity', () => {
  const a = makeTaskKey('new york', 'food/primary', 'qk:12:132010203001');
  const b = makeTaskKey('new york', 'food/primary', 'qk:12:132010203001');
  assert.equal(a, b);
  assert.equal(a, 'v1/new%20york/food%2Fprimary/qk:12:132010203001');
});

test('dateline boundaries use the short longitude span', () => {
  const interval = minimalLongitudeInterval([170, 179, -179, -170]);
  assert.equal(interval.span, 20);
  const polygon = {
    type: 'Polygon',
    coordinates: [[
      [170, -5], [179.9, -5], [-179.9, -5], [-170, -5],
      [-170, 5], [-179.9, 5], [179.9, 5], [170, 5], [170, -5],
    ]],
  };
  const tiles = coveringTiles(polygon, 3);
  assert.ok(tiles.length > 0);
  assert.ok(tiles.length < 16, `unexpected near-world coverage: ${tiles.length}`);
  assert.equal(new Set(tiles.map((tile) => tile.tileId)).size, tiles.length);
});

test('auto root zoom increases when more initial parallel tasks are requested', () => {
  const low = chooseRootZoom({ areaKm2: 10000, centroidLat: 45, targetTasks: 1 });
  const high = chooseRootZoom({ areaKm2: 10000, centroidLat: 45, targetTasks: 256 });
  assert.ok(high > low, `${high} should be greater than ${low}`);
});
