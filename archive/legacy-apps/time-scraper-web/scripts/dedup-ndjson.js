#!/usr/bin/env node
/**
 * dedup-ndjson.js
 *
 * Deduplicate NDJSON output files by business.placeId.
 * Keeps the LAST occurrence of each placeId (most recent/complete data).
 * Creates a .bak backup of each file before writing.
 *
 * Usage:
 *   node scripts/dedup-ndjson.js output/file.ndjson              # Dry run (single file)
 *   node scripts/dedup-ndjson.js output/places_*.ndjson           # Dry run (multiple files)
 *   node scripts/dedup-ndjson.js --apply output/file.ndjson       # Apply in-place with backup
 *   node scripts/dedup-ndjson.js --merge output/places_*.ndjson   # Cross-file dedup (merge all, write to first file)
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const MERGE = args.includes('--merge');
const files = args.filter(a => !a.startsWith('--'));

if (files.length === 0) {
  console.log('Usage: node scripts/dedup-ndjson.js [--apply] [--merge] <file1.ndjson> [file2.ndjson ...]');
  console.log('');
  console.log('  --apply   Write deduplicated output (default: dry run)');
  console.log('  --merge   Cross-file dedup: merge all files, write unique records to first file');
  console.log('');
  console.log('Without --merge: each file is deduplicated independently.');
  console.log('With --merge: records across all files are deduplicated together.');
  process.exit(1);
}

function readNdjsonRecords(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch (e) {
      console.error(`  Skipping malformed line ${i + 1} in ${filePath}`);
    }
  }
  return records;
}

function getPlaceId(record) {
  return record?.business?.placeId || record?.placeId || null;
}

function dedupRecords(records) {
  // Keep LAST occurrence of each placeId (most recent/complete data)
  const seen = new Map(); // placeId -> index in deduped array
  for (const record of records) {
    const id = getPlaceId(record);
    if (!id) {
      // No placeId — keep the record as-is (append)
      seen.set(`__no_id_${seen.size}`, record);
      continue;
    }
    seen.set(id, record); // Overwrites previous occurrence
  }
  return Array.from(seen.values());
}

function writeNdjson(filePath, records) {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
}

// --- Main ---
let totalOriginal = 0;
let totalDeduped = 0;

if (MERGE) {
  // Cross-file dedup: load all records from all files, dedup globally
  console.log(`[merge mode] Loading ${files.length} files...`);
  const allRecords = [];
  for (const file of files) {
    const abs = path.resolve(file);
    const records = readNdjsonRecords(abs);
    console.log(`  ${path.basename(abs)}: ${records.length} records`);
    allRecords.push(...records);
  }
  totalOriginal = allRecords.length;

  const deduped = dedupRecords(allRecords);
  totalDeduped = deduped.length;
  const removed = totalOriginal - totalDeduped;

  console.log(`\nTotal: ${totalOriginal} records -> ${totalDeduped} unique (${removed} duplicates)`);

  if (APPLY && removed > 0) {
    const outFile = path.resolve(files[0]);
    const backupFile = outFile + '.bak';
    if (fs.existsSync(outFile)) {
      fs.copyFileSync(outFile, backupFile);
      console.log(`  Backup: ${backupFile}`);
    }
    writeNdjson(outFile, deduped);
    console.log(`  Written: ${outFile} (${deduped.length} records)`);
  } else if (!APPLY && removed > 0) {
    console.log('\nDry run — use --apply to write changes.');
  } else {
    console.log('\nNo duplicates found.');
  }
} else {
  // Per-file dedup
  for (const file of files) {
    const abs = path.resolve(file);
    console.log(`\nProcessing: ${path.basename(abs)}`);

    const records = readNdjsonRecords(abs);
    if (records.length === 0) {
      console.log('  Empty file, skipping.');
      continue;
    }

    const deduped = dedupRecords(records);
    const removed = records.length - deduped.length;
    totalOriginal += records.length;
    totalDeduped += deduped.length;

    console.log(`  ${records.length} records -> ${deduped.length} unique (${removed} duplicates removed)`);

    if (APPLY && removed > 0) {
      const backupFile = abs + '.bak';
      fs.copyFileSync(abs, backupFile);
      console.log(`  Backup: ${backupFile}`);
      writeNdjson(abs, deduped);
      console.log(`  Written: ${abs}`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Total: ${totalOriginal} records -> ${totalDeduped} unique (${totalOriginal - totalDeduped} duplicates)`);

  if (!APPLY && totalOriginal > totalDeduped) {
    console.log('Dry run — use --apply to write changes.');
  }
}
