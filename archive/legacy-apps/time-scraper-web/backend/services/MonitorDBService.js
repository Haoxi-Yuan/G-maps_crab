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

function normalizeCity(city) {
  if (city === undefined || city === null) return null;
  const value = String(city).trim();
  if (!value || value.toUpperCase() === 'ALL') return null;
  return value;
}

function parseJSONSafe(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getDB() {
  if (instance) return instance;

  try {
    MonitorDBClass = require('../../src/monitor/db');
    const config = loadConfig();
    instance = new MonitorDBClass(config.paths.database);
    return instance;
  } catch (err) {
    console.error('[MonitorDBService] Failed to initialize:', err.message, err.stack);
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

function getStats(city = null) {
  const db = getDB();
  if (!db) return null;
  return db.getStats(normalizeCity(city));
}

function getScans(limit = 50, city = null) {
  const db = getDB();
  if (!db) return [];
  const normalizedCity = normalizeCity(city);
  if (normalizedCity) {
    return db.db.prepare(
      'SELECT * FROM scan_history WHERE city = ? ORDER BY startedAt DESC LIMIT ?'
    ).all(normalizedCity, limit);
  }
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
    summary: parseJSONSafe(scan.summary),
    changes: changes.map(c => ({
      ...c,
      fields: parseJSONSafe(c.fields)
    }))
  };
}

function getChanges(page = 1, limit = 50, city = null) {
  const db = getDB();
  if (!db) return { changes: [], total: 0 };
  const normalizedCity = normalizeCity(city);
  const offset = (page - 1) * limit;
  const total = normalizedCity
    ? db.db.prepare('SELECT COUNT(*) as count FROM change_log WHERE city = ?').get(normalizedCity).count
    : db.db.prepare('SELECT COUNT(*) as count FROM change_log').get().count;

  const changes = normalizedCity
    ? db.db.prepare(
      `SELECT cl.*, pb.name, pb.navigablePlaceId
       FROM change_log cl
       LEFT JOIN poi_baseline pb ON cl.placeId = pb.placeId
       WHERE cl.city = ?
       ORDER BY cl.detectedAt DESC
       LIMIT ? OFFSET ?`
    ).all(normalizedCity, limit, offset)
    : db.db.prepare(
      `SELECT cl.*, pb.name, pb.navigablePlaceId
       FROM change_log cl
       LEFT JOIN poi_baseline pb ON cl.placeId = pb.placeId
       ORDER BY cl.detectedAt DESC
       LIMIT ? OFFSET ?`
    ).all(limit, offset);

  return {
    changes: changes.map(c => ({
      ...c,
      fields: parseJSONSafe(c.fields)
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
    city: scan.city || null,
    startedAt: scan.startedAt,
    baselineMilestoneAt: scan.baselineMilestoneAt || null,
    completedAt: scan.completedAt,
    summary: parseJSONSafe(scan.summary),
    changes: changes.map(c => {
      const navId = c.navigablePlaceId || c.placeId;
      return {
        placeId: c.placeId,
        url: `https://www.google.com/maps/place/?q=place_id:${navId}`,
        changeType: c.changeType,
        previousMilestoneAt: c.previousMilestoneAt || scan.baselineMilestoneAt || null,
        currentMilestoneAt: c.currentMilestoneAt || scan.startedAt || null,
        detectedAt: c.detectedAt,
        fields: parseJSONSafe(c.fields)
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

function getMeta() {
  const db = getDB();
  const config = loadConfig();
  const monitorConfig = config.monitor || {};
  return {
    defaultCity: monitorConfig.defaultCity || 'Singapore',
    defaultBaselineSource: monitorConfig.defaultBaselineSource || '',
    autoBootstrapOnEmpty: !!monitorConfig.autoBootstrapOnEmpty,
    availableCities: db ? db.getCities() : []
  };
}

module.exports = {
  getDB,
  close,
  getStats,
  getScans,
  getScanDetail,
  getChanges,
  getReport,
  getChangedPlaceIds,
  getMeta
};
