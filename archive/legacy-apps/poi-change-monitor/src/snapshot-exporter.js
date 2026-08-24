const fs = require('fs');
const path = require('path');
const { ensureDir, log } = require('./utils');

function exportSnapshot(db, outputDir) {
  ensureDir(outputDir);

  const dateStr = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(outputDir, `baseline_${dateStr}.json`);

  const writeStream = fs.createWriteStream(outputPath);
  const iterator = db.iterateActivePois();

  let count = 0;
  writeStream.write('[\n');

  for (const poi of iterator) {
    if (count > 0) writeStream.write(',\n');
    writeStream.write('  ' + JSON.stringify(poi));
    count++;
  }

  writeStream.write('\n]\n');
  writeStream.end();

  log('info', `Snapshot exported: ${outputPath} (${count} POIs)`);
  return { outputPath, count };
}

module.exports = { exportSnapshot };
