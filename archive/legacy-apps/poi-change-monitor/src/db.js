const Database = require('better-sqlite3');
const path = require('path');
const { ensureDir } = require('./utils');

class MonitorDB {
  constructor(dbPath) {
    ensureDir(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS poi_baseline (
        placeId TEXT PRIMARY KEY,
        name TEXT,
        reviewCount INTEGER,
        rating REAL,
        openingHoursHash TEXT,
        popularTimesHash TEXT,
        lastCheckedAt TEXT,
        consecutiveFailures INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        sourceFormat TEXT,
        importedAt TEXT,
        updatedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scanId TEXT NOT NULL,
        placeId TEXT NOT NULL,
        changeType TEXT NOT NULL,
        fields TEXT,
        detectedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scan_history (
        scanId TEXT PRIMARY KEY,
        startedAt TEXT NOT NULL,
        completedAt TEXT,
        totalPois INTEGER,
        scannedCount INTEGER DEFAULT 0,
        changedCount INTEGER DEFAULT 0,
        failedCount INTEGER DEFAULT 0,
        summary TEXT,
        status TEXT DEFAULT 'running'
      );

      CREATE INDEX IF NOT EXISTS idx_change_log_scanId ON change_log(scanId);
      CREATE INDEX IF NOT EXISTS idx_change_log_placeId ON change_log(placeId);
      CREATE INDEX IF NOT EXISTS idx_poi_baseline_status ON poi_baseline(status);
      CREATE INDEX IF NOT EXISTS idx_poi_baseline_lastCheckedAt ON poi_baseline(lastCheckedAt);
    `);

    // Migration: add navigablePlaceId column (ChIJ format for URL navigation)
    try {
      this.db.exec('ALTER TABLE poi_baseline ADD COLUMN navigablePlaceId TEXT');
    } catch (e) {
      // Column already exists, ignore
    }
  }

  _prepareStatements() {
    this._stmts = {
      upsertPoi: this.db.prepare(`
        INSERT INTO poi_baseline (placeId, name, reviewCount, rating, openingHoursHash, popularTimesHash, lastCheckedAt, consecutiveFailures, status, sourceFormat, navigablePlaceId, importedAt, updatedAt)
        VALUES (@placeId, @name, @reviewCount, @rating, @openingHoursHash, @popularTimesHash, @lastCheckedAt, @consecutiveFailures, @status, @sourceFormat, @navigablePlaceId, @importedAt, @updatedAt)
        ON CONFLICT(placeId) DO UPDATE SET
          name = COALESCE(@name, poi_baseline.name),
          reviewCount = COALESCE(@reviewCount, poi_baseline.reviewCount),
          rating = COALESCE(@rating, poi_baseline.rating),
          openingHoursHash = COALESCE(@openingHoursHash, poi_baseline.openingHoursHash),
          popularTimesHash = COALESCE(@popularTimesHash, poi_baseline.popularTimesHash),
          navigablePlaceId = COALESCE(@navigablePlaceId, poi_baseline.navigablePlaceId),
          sourceFormat = @sourceFormat,
          updatedAt = @updatedAt
      `),

      getPoi: this.db.prepare('SELECT * FROM poi_baseline WHERE placeId = ?'),

      getAllActivePois: this.db.prepare("SELECT * FROM poi_baseline WHERE status = 'active' ORDER BY lastCheckedAt ASC NULLS FIRST"),

      getAllActivePlaceIds: this.db.prepare("SELECT placeId, navigablePlaceId FROM poi_baseline WHERE status = 'active' ORDER BY lastCheckedAt ASC NULLS FIRST"),

      getAllPlaceIds: this.db.prepare('SELECT placeId FROM poi_baseline'),

      getPoiCount: this.db.prepare('SELECT COUNT(*) as count FROM poi_baseline'),

      getPoiCountByStatus: this.db.prepare('SELECT status, COUNT(*) as count FROM poi_baseline GROUP BY status'),

      updatePoiAfterScan: this.db.prepare(`
        UPDATE poi_baseline SET
          reviewCount = @reviewCount,
          rating = @rating,
          openingHoursHash = @openingHoursHash,
          popularTimesHash = @popularTimesHash,
          lastCheckedAt = @lastCheckedAt,
          consecutiveFailures = 0,
          updatedAt = @updatedAt
        WHERE placeId = @placeId
      `),

      incrementFailures: this.db.prepare(`
        UPDATE poi_baseline SET
          consecutiveFailures = consecutiveFailures + 1,
          lastCheckedAt = @lastCheckedAt,
          updatedAt = @updatedAt
        WHERE placeId = @placeId
      `),

      markAsGone: this.db.prepare(`
        UPDATE poi_baseline SET
          status = 'gone',
          updatedAt = @updatedAt
        WHERE placeId = @placeId
      `),

      insertChange: this.db.prepare(`
        INSERT INTO change_log (scanId, placeId, changeType, fields, detectedAt)
        VALUES (@scanId, @placeId, @changeType, @fields, @detectedAt)
      `),

      getChangesByScanId: this.db.prepare(`
        SELECT cl.*, pb.navigablePlaceId
        FROM change_log cl
        LEFT JOIN poi_baseline pb ON cl.placeId = pb.placeId
        WHERE cl.scanId = ?
      `),

      createScan: this.db.prepare(`
        INSERT INTO scan_history (scanId, startedAt, totalPois, status)
        VALUES (@scanId, @startedAt, @totalPois, 'running')
      `),

      completeScan: this.db.prepare(`
        UPDATE scan_history SET
          completedAt = @completedAt,
          scannedCount = @scannedCount,
          changedCount = @changedCount,
          failedCount = @failedCount,
          summary = @summary,
          status = @status
        WHERE scanId = @scanId
      `),

      getLastScan: this.db.prepare("SELECT * FROM scan_history ORDER BY startedAt DESC LIMIT 1"),

      getScanById: this.db.prepare('SELECT * FROM scan_history WHERE scanId = ?'),

      getFieldCoverage: this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) as withRating,
          SUM(CASE WHEN reviewCount IS NOT NULL THEN 1 ELSE 0 END) as withReviewCount,
          SUM(CASE WHEN openingHoursHash IS NOT NULL THEN 1 ELSE 0 END) as withOpeningHours,
          SUM(CASE WHEN popularTimesHash IS NOT NULL THEN 1 ELSE 0 END) as withPopularTimes
        FROM poi_baseline
      `),

      getSourceFormatBreakdown: this.db.prepare(`
        SELECT sourceFormat, COUNT(*) as count FROM poi_baseline GROUP BY sourceFormat
      `)
    };
  }

  upsertPoi(poi) {
    const now = new Date().toISOString();
    return this._stmts.upsertPoi.run({
      placeId: poi.placeId,
      name: poi.name || null,
      reviewCount: poi.reviewCount ?? null,
      rating: poi.rating ?? null,
      openingHoursHash: poi.openingHoursHash || null,
      popularTimesHash: poi.popularTimesHash || null,
      lastCheckedAt: poi.lastCheckedAt || null,
      consecutiveFailures: poi.consecutiveFailures || 0,
      status: poi.status || 'active',
      sourceFormat: poi.sourceFormat || null,
      navigablePlaceId: poi.navigablePlaceId || null,
      importedAt: now,
      updatedAt: now
    });
  }

  upsertPoiBatch(pois) {
    const batchInsert = this.db.transaction((items) => {
      for (const poi of items) {
        this.upsertPoi(poi);
      }
    });
    batchInsert(pois);
  }

  getPoi(placeId) {
    return this._stmts.getPoi.get(placeId);
  }

  iterateActivePois() {
    return this._stmts.getAllActivePois.iterate();
  }

  getAllActivePlaceIds() {
    return this._stmts.getAllActivePlaceIds.all().map(row => ({
      placeId: row.placeId,
      navigablePlaceId: row.navigablePlaceId
    }));
  }

  getAllPlaceIds() {
    return new Set(this._stmts.getAllPlaceIds.all().map(row => row.placeId));
  }

  getPoiCount() {
    return this._stmts.getPoiCount.get().count;
  }

  getPoiCountByStatus() {
    return this._stmts.getPoiCountByStatus.all();
  }

  updatePoiAfterScan(placeId, data) {
    const now = new Date().toISOString();
    return this._stmts.updatePoiAfterScan.run({
      placeId,
      reviewCount: data.reviewCount ?? null,
      rating: data.rating ?? null,
      openingHoursHash: data.openingHoursHash || null,
      popularTimesHash: data.popularTimesHash || null,
      lastCheckedAt: data.lastCheckedAt || now,
      updatedAt: now
    });
  }

  incrementFailures(placeId) {
    const now = new Date().toISOString();
    this._stmts.incrementFailures.run({ placeId, lastCheckedAt: now, updatedAt: now });
    return this.getPoi(placeId);
  }

  markAsGone(placeId) {
    const now = new Date().toISOString();
    return this._stmts.markAsGone.run({ placeId, updatedAt: now });
  }

  insertChange(change) {
    return this._stmts.insertChange.run({
      scanId: change.scanId,
      placeId: change.placeId,
      changeType: change.changeType,
      fields: typeof change.fields === 'string' ? change.fields : JSON.stringify(change.fields),
      detectedAt: change.detectedAt || new Date().toISOString()
    });
  }

  insertChangeBatch(changes) {
    const batchInsert = this.db.transaction((items) => {
      for (const change of items) {
        this.insertChange(change);
      }
    });
    batchInsert(changes);
  }

  getChangesByScanId(scanId) {
    return this._stmts.getChangesByScanId.all(scanId);
  }

  createScan(scanId, totalPois = 0) {
    return this._stmts.createScan.run({
      scanId,
      startedAt: new Date().toISOString(),
      totalPois
    });
  }

  completeScan(scanId, stats) {
    return this._stmts.completeScan.run({
      scanId,
      completedAt: new Date().toISOString(),
      scannedCount: stats.scanned || 0,
      changedCount: stats.changed || 0,
      failedCount: stats.failed || 0,
      summary: JSON.stringify(stats),
      status: stats.status || 'completed'
    });
  }

  getLastScan() {
    return this._stmts.getLastScan.get();
  }

  getScanById(scanId) {
    return this._stmts.getScanById.get(scanId);
  }

  getStats() {
    const count = this.getPoiCount();
    const byStatus = this.getPoiCountByStatus();
    const coverage = this._stmts.getFieldCoverage.get();
    const sourceBreakdown = this._stmts.getSourceFormatBreakdown.all();
    const lastScan = this.getLastScan();

    return {
      totalPois: count,
      byStatus,
      fieldCoverage: coverage,
      sourceBreakdown,
      lastScan
    };
  }

  // --- Scan cleanup methods ---

  deleteChangesForScan(scanId) {
    return this.db.prepare('DELETE FROM change_log WHERE scanId = ?').run(scanId);
  }

  deleteScan(scanId) {
    return this.db.prepare('DELETE FROM scan_history WHERE scanId = ?').run(scanId);
  }

  resetLastCheckedSince(since) {
    return this.db.prepare(
      'UPDATE poi_baseline SET lastCheckedAt = NULL WHERE lastCheckedAt >= ?'
    ).run(since);
  }

  restorePoiRating(placeId, rating) {
    const now = new Date().toISOString();
    return this.db.prepare(
      'UPDATE poi_baseline SET rating = ?, updatedAt = ? WHERE placeId = ?'
    ).run(rating, now, placeId);
  }

  restorePoiReviewCount(placeId, reviewCount) {
    const now = new Date().toISOString();
    return this.db.prepare(
      'UPDATE poi_baseline SET reviewCount = ?, updatedAt = ? WHERE placeId = ?'
    ).run(reviewCount, now, placeId);
  }

  close() {
    this.db.close();
  }
}

module.exports = MonitorDB;
