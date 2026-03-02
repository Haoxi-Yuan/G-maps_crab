/**
 * MonitorDB Backend Service - Read-only singleton wrapper
 *
 * Wraps the core src/monitor/db.js for API route consumption.
 * The IPC child process does all writes; this service only reads.
 * SQLite WAL mode allows concurrent read access.
 */

const path = require('path');
const { loadConfig } = require('../../src/monitor/config');

let instance = null;
let MonitorDBClass = null;

function getDB() {
  if (instance) return instance;

  try {
    MonitorDBClass = require('../../src/monitor/db');
    const config = loadConfig();
    instance = new MonitorDBClass(config.paths.database);
    return instance;
  } catch (err) {
    console.error('[MonitorDBService] Failed to initialize:', err.message);
    return null;
  }
}

function close() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// --- Read methods exposed to routes ---

function getStats() {
  const db = getDB();
  if (!db) return null;
  return db.getStats();
}

function getScans(limit = 50) {
  const db = getDB();
  if (!db) return [];
  // Query scan_history directly for listing
  return db.db.prepare(
    'SELECT * FROM scan_history ORDER BY startedAt DESC LIMIT ?'
  ).all(limit);
}

function getScanDetail(scanId) {
  const db = getDB();
  if (!db) return null;
  const scan = db.getScanById(scanId);
  if (!scan) return null;
  const changes = db.getChangesByScanId(scanId);
  return {
    ...scan,
    summary: scan.summary ? JSON.parse(scan.summary) : null,
    changes: changes.map(c => ({
      ...c,
      fields: c.fields ? JSON.parse(c.fields) : null
    }))
  };
}

function getChanges(page = 1, limit = 50) {
  const db = getDB();
  if (!db) return { changes: [], total: 0 };
  const offset = (page - 1) * limit;
  const total = db.db.prepare('SELECT COUNT(*) as count FROM change_log').get().count;
  const changes = db.db.prepare(
    `SELECT cl.*, pb.name, pb.navigablePlaceId
     FROM change_log cl
     LEFT JOIN poi_baseline pb ON cl.placeId = pb.placeId
     ORDER BY cl.detectedAt DESC
     LIMIT ? OFFSET ?`
  ).all(limit, offset);
  return {
    changes: changes.map(c => ({
      ...c,
      fields: c.fields ? JSON.parse(c.fields) : null
    })),
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
}

function getReport(scanId) {
  const db = getDB();
  if (!db) return null;
  const scan = db.getScanById(scanId);
  if (!scan) return null;

  // Use ReportGenerator to build report data
  const changes = db.getChangesByScanId(scanId);
  return {
    scanId: scan.scanId,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    summary: scan.summary ? JSON.parse(scan.summary) : null,
    changes: changes.map(c => {
      const navId = c.navigablePlaceId || c.placeId;
      return {
        placeId: c.placeId,
        url: `https://www.google.com/maps/place/?q=place_id:${navId}`,
        changeType: c.changeType,
        detectedAt: c.detectedAt,
        fields: c.fields ? JSON.parse(c.fields) : null
      };
    })
  };
}

function getChangedPlaceIds(scanId) {
  const db = getDB();
  if (!db) return [];
  const changes = db.getChangesByScanId(scanId);
  return changes
    .filter(c => c.changeType !== 'POI_GONE')
    .map(c => c.placeId);
}

module.exports = {
  getDB,
  close,
  getStats,
  getScans,
  getScanDetail,
  getChanges,
  getReport,
  getChangedPlaceIds
};
