const fs = require('fs');
const path = require('path');
const { ensureDir, log } = require('./utils');

class ReportGenerator {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  generate(scanId) {
    const scan = this.db.getScanById(scanId);
    if (!scan) {
      throw new Error(`Scan not found: ${scanId}`);
    }

    const changes = this.db.getChangesByScanId(scanId);

    // Create report directory: output/reports/YYYY-MM-DD-HHMMSS/
    const dateStr = (scan.startedAt || new Date().toISOString())
      .replace(/T/, '-')
      .replace(/:/g, '')
      .slice(0, 15);
    const reportDir = path.join(this.config.paths.reports, dateStr);
    ensureDir(reportDir);

    // 1. Generate changed_placeids.txt
    const changedIds = changes
      .filter(c => c.changeType !== 'POI_GONE')
      .map(c => c.placeId);
    const idsFilePath = path.join(reportDir, 'changed_placeids.txt');
    fs.writeFileSync(idsFilePath, changedIds.join('\n') + (changedIds.length ? '\n' : ''));

    // 2. Generate change_report.json
    const summary = this._buildSummary(scan, changes);
    const report = {
      scanId: scan.scanId,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
      summary,
      changes: changes.map(c => {
        const navId = c.navigablePlaceId || c.placeId;
        const entry = {
          placeId: c.placeId,
          url: `https://www.google.com/maps/place/?q=place_id:${navId}`,
          changeType: c.changeType,
          detectedAt: c.detectedAt
        };
        if (c.fields) {
          try {
            entry.fields = typeof c.fields === 'string' ? JSON.parse(c.fields) : c.fields;
          } catch {
            entry.fields = c.fields;
          }
        }
        return entry;
      })
    };

    const reportFilePath = path.join(reportDir, 'change_report.json');
    fs.writeFileSync(reportFilePath, JSON.stringify(report, null, 2));

    log('info', `Report generated: ${reportDir}`);
    log('info', `  Changed POIs: ${changedIds.length}`);
    log('info', `  Total changes: ${changes.length}`);

    return { reportDir, summary, changedCount: changedIds.length };
  }

  _buildSummary(scan, changes) {
    const fieldChanges = { reviewCount: 0, rating: 0, openingHoursHash: 0, popularTimesHash: 0 };

    for (const c of changes) {
      if (c.changeType === 'NEW_POI' || c.changeType === 'POI_GONE') continue;
      let fields;
      try {
        fields = typeof c.fields === 'string' ? JSON.parse(c.fields) : c.fields;
      } catch {
        continue;
      }
      if (!Array.isArray(fields)) continue;
      for (const f of fields) {
        if (f.field && fieldChanges.hasOwnProperty(f.field)) {
          fieldChanges[f.field]++;
        }
      }
    }

    return {
      totalScanned: scan.scannedCount || 0,
      totalChanged: changes.filter(c => !['NEW_POI', 'POI_GONE'].includes(c.changeType)).length,
      newPois: changes.filter(c => c.changeType === 'NEW_POI').length,
      gonePois: changes.filter(c => c.changeType === 'POI_GONE').length,
      reviewCountChanged: fieldChanges.reviewCount,
      ratingChanged: fieldChanges.rating,
      openingHoursChanged: fieldChanges.openingHoursHash,
      popularTimesChanged: fieldChanges.popularTimesHash,
      scanFailed: scan.failedCount || 0
    };
  }
}

module.exports = ReportGenerator;
