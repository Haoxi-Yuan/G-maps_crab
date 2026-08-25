#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { iterateNdjsonRecords } = require('../src/ndjson-reader');

const inputFiles = process.argv.slice(2);
if (inputFiles.length === 0) {
  console.error('Usage: extract-reviewer-ids-ndjson.js <reviews.ndjson> [...]');
  process.exit(2);
}

const CONTRIBUTOR_ID = /\/contrib\/(\d{21})(?:[/?]|$)/;
const MAX_BUFFER_BYTES = 1024 * 1024;

async function flush(lines) {
  if (lines.length === 0) return;
  const chunk = `${lines.join('\n')}\n`;
  lines.length = 0;
  if (!process.stdout.write(chunk)) {
    await new Promise((resolve) => process.stdout.once('drain', resolve));
  }
}

(async () => {
  let placeRecords = 0;
  let reviewRows = 0;
  let validReviewerRows = 0;
  let missingReviewerRows = 0;
  let recoveredRecords = 0;
  const lines = [];
  let bufferedBytes = 0;

  for (const inputFile of inputFiles) {
    const before = {
      bytes: fs.statSync(inputFile).size,
      place_records: placeRecords,
      review_rows: reviewRows,
      valid_reviewer_rows: validReviewerRows,
      missing_reviewer_rows: missingReviewerRows,
      recovered_records: recoveredRecords,
    };
    for await (const logical of iterateNdjsonRecords(inputFile)) {
      const record = logical.value;
      if (logical.recovered) recoveredRecords += 1;
      placeRecords += 1;
      for (const review of Array.isArray(record.detailedReviews) ? record.detailedReviews : []) {
        reviewRows += 1;
        const match = typeof review.reviewer_link === 'string'
          ? review.reviewer_link.match(CONTRIBUTOR_ID)
          : null;
        if (!match) {
          missingReviewerRows += 1;
          continue;
        }
        lines.push(match[1]);
        bufferedBytes += 22;
        validReviewerRows += 1;
        if (bufferedBytes >= MAX_BUFFER_BYTES) {
          await flush(lines);
          bufferedBytes = 0;
        }
      }
    }
    await flush(lines);
    bufferedBytes = 0;
    const afterBytes = fs.statSync(inputFile).size;
    console.error(JSON.stringify({
      file: inputFile,
      bytes_at_start: before.bytes,
      bytes_at_end: afterBytes,
      place_records: placeRecords - before.place_records,
      review_rows: reviewRows - before.review_rows,
      valid_reviewer_rows: validReviewerRows - before.valid_reviewer_rows,
      missing_reviewer_rows: missingReviewerRows - before.missing_reviewer_rows,
      recovered_records: recoveredRecords - before.recovered_records,
    }));
  }

  await flush(lines);
  console.error(JSON.stringify({
    total: true,
    sampled_at: new Date().toISOString(),
    files: inputFiles.length,
    place_records: placeRecords,
    review_rows: reviewRows,
    valid_reviewer_rows: validReviewerRows,
    missing_reviewer_rows: missingReviewerRows,
    recovered_records: recoveredRecords,
  }));
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
