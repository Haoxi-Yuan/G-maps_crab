#!/usr/bin/env node
'use strict';

/**
 * Convert Summary.xlsx (with Google Maps short URLs) to place_id input file.
 *
 * Steps:
 * 1. Read xlsx → extract Name, City, url columns
 * 2. Expand short URLs (maps.app.goo.gl/...) → follow redirects to get full Google Maps URL
 * 3. Extract place_id from the expanded URL
 * 4. For entries without URL, generate a search query from Name + City
 * 5. Output JSON array of { placeId, name, city, category, url }
 *
 * Usage:
 *   node src/convert-xlsx-to-input.js --input data/galicia/Summary.xlsx --output data/galicia/places_input.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ============================================
// xlsx reader (minimal, no dependencies)
// Uses the fact that xlsx is a zip of xml files
// ============================================

let readExcel;
try {
  // Try using Python via child_process as xlsx parsing in pure JS without deps is complex
  const { execSync } = require('child_process');
  readExcel = (filePath) => {
    const pythonPaths = [
      '/data/haoxi/miniconda3/bin/python3',
      'python3',
      'python',
    ];
    let pythonBin = null;
    for (const p of pythonPaths) {
      try {
        execSync(`${p} --version`, { stdio: 'ignore' });
        pythonBin = p;
        break;
      } catch (e) { /* try next */ }
    }
    if (!pythonBin) throw new Error('Python not found');

    const script = `
import json, sys
import pandas as pd
df = pd.read_excel(sys.argv[1])
# Convert to list of dicts, handling NaN
records = []
for _, row in df.iterrows():
    record = {}
    for col in df.columns:
        val = row[col]
        if pd.isna(val):
            record[col] = None
        else:
            record[col] = val
    records.append(record)
print(json.dumps(records, ensure_ascii=False))
`;
    const result = execSync(`${pythonBin} -c '${script.replace(/'/g, "\\'")}' "${filePath}"`, {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf8',
    });
    return JSON.parse(result);
  };
} catch (e) {
  readExcel = () => { throw new Error('Cannot read xlsx: Python with pandas+openpyxl required'); };
}

// ============================================
// URL expander — follow redirects to get final URL
// ============================================

function expandUrl(shortUrl, maxRedirects = 5) {
  return new Promise((resolve) => {
    if (!shortUrl || maxRedirects <= 0) {
      resolve(null);
      return;
    }

    const protocol = shortUrl.startsWith('https') ? https : http;
    const req = protocol.get(shortUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const location = res.headers.location;
        // If it's another short URL, follow it
        if (location.includes('goo.gl') || location.includes('maps.app')) {
          expandUrl(location, maxRedirects - 1).then(resolve);
        } else {
          resolve(location);
        }
      } else if (res.statusCode === 200) {
        // Some redirects happen via HTML meta refresh or JS
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          // Check for meta refresh
          const metaMatch = body.match(/url=([^"'>\s]+)/i);
          if (metaMatch) {
            resolve(metaMatch[1]);
          } else {
            resolve(shortUrl); // No redirect found
          }
        });
      } else {
        res.resume();
        resolve(null);
      }
    });

    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// ============================================
// Place ID extractors
// ============================================

function extractPlaceIdFromUrl(url) {
  if (!url) return null;

  // Pattern 1: place_id in URL path — /place/.../<place_id> or data=!...!1s<place_id>
  const dataMatch = url.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
  if (dataMatch) return dataMatch[1];

  // Pattern 2: ChIJ format
  const chijMatch = url.match(/(?:!19s|!1s|place_id[=:])(ChIJ[A-Za-z0-9_-]+)/);
  if (chijMatch) return chijMatch[1];

  // Pattern 3: ftid parameter
  const ftidMatch = url.match(/ftid=(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
  if (ftidMatch) return ftidMatch[1];

  // Pattern 4: place/ path segment with coordinates
  // Can't extract place_id, but we have the URL for browser navigation
  return null;
}

// ============================================
// Main
// ============================================

async function main() {
  const args = process.argv.slice(2);
  let inputFile = null;
  let outputFile = null;
  let expandUrls = true;
  let delay = 500; // ms between URL expansions

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') inputFile = args[++i];
    else if (args[i] === '--output') outputFile = args[++i];
    else if (args[i] === '--no-expand') expandUrls = false;
    else if (args[i] === '--delay') delay = parseInt(args[++i], 10);
  }

  if (!inputFile) {
    // Default
    const projectRoot = path.resolve(__dirname, '..');
    inputFile = path.join(projectRoot, 'data/galicia/Summary.xlsx');
    outputFile = outputFile || path.join(projectRoot, 'data/galicia/places_input.json');
  }

  if (!outputFile) {
    outputFile = inputFile.replace(/\.xlsx$/i, '_places_input.json');
  }

  console.log(`Reading: ${inputFile}`);
  const records = readExcel(inputFile);
  console.log(`Found ${records.length} records`);

  const results = [];
  let expanded = 0;
  let failed = 0;
  let noUrl = 0;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const name = row['Name'] || row['name'] || '';
    const city = row['City/Town'] || row['city'] || '';
    const category = row['Category'] || row['category'] || '';
    const heritage = row['Heritage'] || row['heritage'] || null;
    const shortUrl = row['url'] || row['URL'] || row['Url'] || '';
    const reviews = row['Reviews'] || row['reviews'] || null;
    const rating = row['Rating'] || row['rating'] || null;

    const entry = {
      index: i + 1,
      name: name || null,
      city: city || null,
      category: category || null,
      heritage: heritage,
      existingReviews: reviews,
      existingRating: rating,
      shortUrl: shortUrl || null,
      expandedUrl: null,
      placeId: null,
      searchQuery: null,
    };

    if (shortUrl && expandUrls) {
      process.stdout.write(`[${i + 1}/${records.length}] Expanding: ${name || shortUrl}... `);
      const fullUrl = await expandUrl(shortUrl);
      if (fullUrl) {
        entry.expandedUrl = fullUrl;
        entry.placeId = extractPlaceIdFromUrl(fullUrl);
        if (entry.placeId) {
          console.log(`OK → ${entry.placeId}`);
          expanded++;
        } else {
          // No place_id extractable, but we have the full URL for direct navigation
          console.log(`URL OK (no place_id in URL, will use search)`);
          entry.searchQuery = `${name} ${city}`.trim();
          expanded++;
        }
      } else {
        console.log('FAILED');
        entry.searchQuery = `${name} ${city}`.trim();
        failed++;
      }
      // Rate limiting
      if (i < records.length - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    } else if (!shortUrl) {
      // No URL — generate search query
      entry.searchQuery = `${name} ${city}`.trim();
      noUrl++;
      console.log(`[${i + 1}/${records.length}] No URL: "${entry.searchQuery}" (will search)`);
    }

    results.push(entry);
  }

  // Generate scraper-compatible input formats
  const placeIdEntries = results.filter(r => r.placeId);
  const searchEntries = results.filter(r => !r.placeId && r.searchQuery);
  const urlEntries = results.filter(r => !r.placeId && r.expandedUrl);

  // Save full results
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

  // Save place_id list (for direct scraping)
  if (placeIdEntries.length > 0) {
    const placeIdFile = outputFile.replace('.json', '_place_ids.json');
    const placeIds = placeIdEntries.map(r => r.placeId);
    fs.writeFileSync(placeIdFile, JSON.stringify(placeIds, null, 2));
    console.log(`\nSaved ${placeIds.length} place_ids → ${placeIdFile}`);
  }

  // Save search queries (for POI search mode)
  if (searchEntries.length > 0) {
    const searchFile = outputFile.replace('.json', '_search_queries.json');
    const queries = searchEntries.map(r => ({
      query: r.searchQuery,
      name: r.name,
      city: r.city,
      category: r.category,
    }));
    fs.writeFileSync(searchFile, JSON.stringify(queries, null, 2));
    console.log(`Saved ${queries.length} search queries → ${searchFile}`);
  }

  // Save URL list (for direct navigation fallback)
  if (urlEntries.length > 0) {
    const urlFile = outputFile.replace('.json', '_urls.json');
    const urls = urlEntries.map(r => ({
      url: r.expandedUrl,
      name: r.name,
      city: r.city,
    }));
    fs.writeFileSync(urlFile, JSON.stringify(urls, null, 2));
    console.log(`Saved ${urls.length} direct URLs → ${urlFile}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total records: ${records.length}`);
  console.log(`With place_id: ${placeIdEntries.length}`);
  console.log(`Need search:   ${searchEntries.length + urlEntries.length}`);
  console.log(`URL expand OK: ${expanded}`);
  console.log(`URL expand fail: ${failed}`);
  console.log(`No URL at all: ${noUrl}`);
  console.log(`\nFull results → ${outputFile}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
