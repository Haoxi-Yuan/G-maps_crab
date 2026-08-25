'use strict';

const fs = require('fs');
const readline = require('readline');

/**
 * Stream logical JSON records from an NDJSON file.
 *
 * Besides normal one-record-per-line input, this reader recovers the legacy
 * reviews files that contain literal physical newlines inside JSON strings.
 * Continuation lines are joined as an escaped `\\n`; the source file is never
 * rewritten.
 */
async function* iterateNdjsonRecords(file) {
  const reader = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  let physicalLine = 0;
  let pending = null;
  let pendingStart = null;

  for await (const line of reader) {
    physicalLine += 1;
    if (pending !== null) {
      pending += `\\n${line}`;
      try {
        yield { value: JSON.parse(pending), startLine: pendingStart, endLine: physicalLine, recovered: true };
        pending = null;
        pendingStart = null;
      } catch (_) {
        // The logical record still has additional physical continuation lines.
      }
      continue;
    }

    if (!line.trim()) continue;
    try {
      yield { value: JSON.parse(line), startLine: physicalLine, endLine: physicalLine, recovered: false };
    } catch (error) {
      if (/^\s*[\[{]/.test(line)) {
        pending = line;
        pendingStart = physicalLine;
      } else {
        throw new Error(`invalid NDJSON at physical line ${physicalLine}: ${error.message}`);
      }
    }
  }

  if (pending !== null) {
    throw new Error(`unterminated NDJSON record beginning at physical line ${pendingStart}`);
  }
}

module.exports = { iterateNdjsonRecords };
