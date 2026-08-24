'use strict';
const fs = require('fs');

const fp = process.argv[2];
const d = JSON.parse(fs.readFileSync(fp, 'utf8'));

// Helper to base64-decode the geometry blob fields
function decode(s) { return Buffer.from(s, 'base64'); }

const node = d[1][0][5][0][5];
console.log('Geometry node found.');

// Parse blob1 (plane data)
const blob1 = decode(node[1][2]);
const blob2 = decode(node[3][2]);
console.log(`blob1: ${blob1.length} bytes; blob2: ${blob2.length} bytes`);

// Header (8 bytes)
const headerVer = blob1[0];
const numPlanes = blob1.readUInt16LE(1);
const widthOrHeight1 = blob1.readUInt16LE(3);
const widthOrHeight2 = blob1.readUInt16LE(5);
const offsetByte = blob1[7];
console.log(`Header: ver=${headerVer}, numPlanes=${numPlanes}, dim1=${widthOrHeight1}, dim2=${widthOrHeight2}, offset=${offsetByte}`);
// Actual map dim from blob2 [256, 512]
const mapW = node[3][0][0];
const mapH = node[3][0][1];
console.log(`Index map dims: ${mapW} × ${mapH} = ${mapW * mapH} cells`);

// Layout (corrected): 8-byte header + index map (mapW×mapH bytes) + planes (16 bytes each) at end
const idxMapOffset = 8;
const idxMap = blob1.slice(idxMapOffset, idxMapOffset + mapW * mapH);
console.log(`Index map: starts @${idxMapOffset}, length ${idxMap.length}`);

const planeOffset = idxMapOffset + mapW * mapH;
const planes = [];
for (let i = 0; i < numPlanes; i++) {
  const o = planeOffset + i * 16;
  const nx = blob1.readFloatLE(o);
  const ny = blob1.readFloatLE(o + 4);
  const nz = blob1.readFloatLE(o + 8);
  const d = blob1.readFloatLE(o + 12);
  planes.push({ idx: i, nx, ny, nz, d });
}
console.log(`Planes: start @${planeOffset}, ${numPlanes} planes × 16 bytes = ${numPlanes * 16} bytes (total ends @${planeOffset + numPlanes * 16})`);

// Stats: pixel count per plane index
const planePixelCount = new Array(numPlanes + 5).fill(0);
let unmappedCount = 0;
for (let i = 0; i < idxMap.length; i++) {
  const p = idxMap[i];
  if (p < numPlanes) planePixelCount[p]++;
  else unmappedCount++;
}
console.log(`Pixels with valid plane idx: ${idxMap.length - unmappedCount}/${idxMap.length}`);
console.log(`Unmapped pixels (idx >= numPlanes): ${unmappedCount}`);
console.log();

// Classify planes by normal direction
//   normalize first
function classifyPlane(p) {
  const len = Math.sqrt(p.nx * p.nx + p.ny * p.ny + p.nz * p.nz);
  if (len < 1e-6) return 'invalid (zero normal)';
  const nx = p.nx / len, ny = p.ny / len, nz = p.nz / len;
  // Convention: in pano-local coords, z is typically up
  const tilt = Math.abs(nz);
  if (tilt > 0.85) {
    if (nz > 0) return 'horizontal-up (sky/ceiling)';
    else return 'horizontal-down (ground/road)';
  }
  if (tilt < 0.2) {
    return 'vertical (facade)';
  }
  return 'oblique';
}

// Top 20 planes by pixel coverage
const ranked = planes.map((p, i) => ({ ...p, pixels: planePixelCount[i], cls: classifyPlane(p) }))
  .sort((a, b) => b.pixels - a.pixels);

console.log('=== Top 20 planes by pixel coverage ===');
console.log('idx  pixels  pct   class                       normal=(nx, ny, nz)         d');
for (const p of ranked.slice(0, 20)) {
  const pct = (p.pixels / idxMap.length * 100).toFixed(2);
  console.log(`${String(p.idx).padStart(3)}  ${String(p.pixels).padStart(6)}  ${pct.padStart(5)}%  ${p.cls.padEnd(28)} (${p.nx.toFixed(3)},${p.ny.toFixed(3)},${p.nz.toFixed(3)})  ${p.d.toFixed(3)}`);
}

console.log();
console.log('=== Class summary ===');
const classCount = {};
const classPixels = {};
for (const p of ranked) {
  classCount[p.cls] = (classCount[p.cls] || 0) + 1;
  classPixels[p.cls] = (classPixels[p.cls] || 0) + p.pixels;
}
for (const k of Object.keys(classCount)) {
  const pct = (classPixels[k] / idxMap.length * 100).toFixed(1);
  console.log(`  ${k.padEnd(30)}: ${classCount[k]} planes, ${classPixels[k]} pixels (${pct}%)`);
}

// Save extracted planes
fs.writeFileSync(fp.replace(/\.json$/, '_planes.json'), JSON.stringify({
  panoid: d[1][0][1][1],
  numPlanes,
  mapWidth: mapW,
  mapHeight: mapH,
  planes,
  pixelsPerPlane: planePixelCount.slice(0, numPlanes),
}, null, 2));
console.log();
console.log('Wrote ' + fp.replace(/\.json$/, '_planes.json'));

// Save plane index map as a binary file (256x512)
fs.writeFileSync(fp.replace(/\.json$/, '_indexmap.bin'), idxMap);
console.log('Wrote ' + fp.replace(/\.json$/, '_indexmap.bin'));

// Save depth map (blob2) — first 32 bytes preview
console.log();
console.log('=== Depth map (blob2) ===');
console.log('Size:', blob2.length, '= ' + (blob2.length / mapW / mapH).toFixed(2) + ' bytes per pixel');
let nonZero = 0, dmin = 255, dmax = 0;
for (let i = 0; i < blob2.length; i++) {
  if (blob2[i] !== 0) { nonZero++; if (blob2[i] < dmin) dmin = blob2[i]; if (blob2[i] > dmax) dmax = blob2[i]; }
}
console.log(`Non-zero depth pixels: ${nonZero}/${blob2.length} (${(nonZero / blob2.length * 100).toFixed(1)}%)`);
console.log(`Depth value range (non-zero): ${dmin} - ${dmax}`);
fs.writeFileSync(fp.replace(/\.json$/, '_depthmap.bin'), blob2);
console.log('Wrote ' + fp.replace(/\.json$/, '_depthmap.bin'));
