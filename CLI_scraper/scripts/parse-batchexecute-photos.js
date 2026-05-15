#!/usr/bin/env node
'use strict';

/**
 * Parse all batchexecute /MapsPhotoService.ListEntityPhotos responses
 * captured in discovery/poc_v2/ and report:
 *   - total unique photos across all responses
 *   - photos grouped by their category-key (the trailing [\"Cg0...\"]
 *     marker in each response)
 *   - any pagination token signature
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'discovery', 'poc_v2');

// Find raw .txt responses with batchexecute payloads
const files = fs.readdirSync(DIR).filter(f => f.startsWith('resp_') && f.endsWith('.raw.txt'));
console.log(`Found ${files.length} raw response files`);

const allPhotos = new Map(); // id -> { id, url, w, h, sources: Set<respFile> }
const perCategory = {}; // key -> { count, photoIds: Set }

for (const f of files) {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  if (!text.includes('ListEntityPhotos')) continue;

  // The response is a batchexecute chunked format. Inside it, find the
  // string of the wrb.fr entry — that's a JSON string of arrays.
  // Easier than full parse: grep photo IDs + URLs + active category key.
  const photoEntries = [...text.matchAll(
    /\\"(CI(?:HM|ABIh)[A-Za-z0-9_-]+)\\",10,1[12],null,null,null,\[\\"(https:\/\/lh3\.googleusercontent\.com\/[^"]+?)\\",\\"\\",\[(\d+),(\d+)\]/g
  )];

  // Also capture all "category key" markers in this response. They look
  // like: [\"<base64ish>\",\"0ahUK...\",\"<label>\",[...
  const catMarkers = [...text.matchAll(
    /\[\\?"(Cg[A-Za-z0-9_=+-]{4,30})\\?",\\?"0ahUK[A-Za-z0-9_-]+\\?",\\?"([^"\\]+)\\?",\[/g
  )];
  const cats = catMarkers.map(m => ({ key: m[1], label: m[2] }));
  const activeKey = text.match(/"(Cg[A-Za-z0-9_=+-]{4,30})"\]\]/);

  console.log(`\n${f}  size=${text.length}  photos=${photoEntries.length}  cats_in_response=${cats.length}`);
  if (cats.length > 0) console.log(`  category markers: ${cats.map(c => c.label).slice(0, 10).join(', ')}`);
  if (activeKey) console.log(`  active key (last marker): ${activeKey[1]}`);

  for (const m of photoEntries) {
    const [, id, url, w, h] = m;
    if (!allPhotos.has(id)) {
      allPhotos.set(id, {
        id,
        url: url.replace(/\\u003d/g, '=').replace(/\\\//g, '/'),
        w: parseInt(w, 10),
        h: parseInt(h, 10),
        sources: new Set(),
      });
    }
    allPhotos.get(id).sources.add(f);
  }
  // For per-category breakdown, we'd need to walk the JSON properly —
  // approximate by attributing all photos in this response to its
  // last-mentioned category key.
  if (activeKey) {
    const key = activeKey[1];
    if (!perCategory[key]) perCategory[key] = { count: 0, photoIds: new Set() };
    for (const m of photoEntries) perCategory[key].photoIds.add(m[1]);
    perCategory[key].count += photoEntries.length;
  }
}

console.log('\n=== AGGREGATE ===');
console.log(`Total unique photos across all responses: ${allPhotos.size}`);
console.log(`Categories that appear as "active key":`);
for (const [key, v] of Object.entries(perCategory)) {
  console.log(`  ${key}: ${v.photoIds.size} unique photos (across responses tagged with this key)`);
}

// Dump a sample of unique photo URLs for verification
console.log('\n=== Sample of first 5 unique photos ===');
const arr = [...allPhotos.values()].slice(0, 5);
for (const p of arr) {
  console.log(`  ${p.id}  ${p.w}x${p.h}  ${p.url.slice(0, 100)}`);
}

fs.writeFileSync(
  path.join(DIR, 'parsed_photos.json'),
  JSON.stringify({
    totalUnique: allPhotos.size,
    photos: [...allPhotos.values()].map(p => ({ id: p.id, url: p.url, w: p.w, h: p.h, sourcesCount: p.sources.size })),
    perCategoryByActiveKey: Object.fromEntries(
      Object.entries(perCategory).map(([k, v]) => [k, { count: v.photoIds.size, photoIds: [...v.photoIds].slice(0, 5) }])
    ),
  }, null, 2)
);
console.log(`\nSaved → ${path.join(DIR, 'parsed_photos.json')}`);
