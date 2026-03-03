const Database = require('better-sqlite3');
const path = require('path');
const { ensureDir } = require('./utils');

const ALL_CITIES = 'ALL';

function normalizeCity(city) {
  if (city === undefined || city === null) return null;
  const normalized = String(city).trim();
  if (!normalized || normalized.toUpperCase() === ALL_CITIES) return null;
  return normalized;
}

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
        city TEXT,
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
        city TEXT,
        placeId TEXT NOT NULL,
        changeType TEXT NOT NULL,
        fields TEXT,
        previousMilestoneAt TEXT,
        currentMilestoneAt TEXT,
        detectedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scan_history (
        scanId TEXT PRIMARY KEY,
        city TEXT,
        startedAt TEXT NOT NULL,
        baselineMilestoneAt TEXT,
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

    // Migration: city + milestone fields
    for (const sql of [
      'ALTER TABLE poi_baseline ADD COLUMN city TEXT',
      'ALTER TABLE scan_history ADD COLUMN city TEXT',
      'ALTER TABLE scan_history ADD COLUMN baselineMilestoneAt TEXT',
      'ALTER TABLE change_log ADD COLUMN city TEXT',
      'ALTER TABLE change_log ADD COLUMN previousMilestoneAt TEXT',
      'ALTER TABLE change_log ADD COLUMN currentMilestoneAt TEXT'
    ]) {
      try {
        this.db.exec(sql);
      } catch (e) {
        // Column already exists, ignore
      }
    }

    for (const sql of [
      'CREATE INDEX IF NOT EXISTS idx_change_log_city ON change_log(city)',
      'CREATE INDEX IF NOT EXISTS idx_poi_baseline_city ON poi_baseline(city)',
      'CREATE INDEX IF NOT EXISTS idx_scan_history_city ON scan_history(city)'
    ]) {
      try {
        this.db.exec(sql);
      } catch (e) {
        // Ignore index creation failures on older sqlite builds
      }
    }
  }

  _prepareStatements() {
    this._stmts = {
      upsertPoi: this.db.prepare(`
        INSERT INTO poi_baseline (placeId, name, city, reviewCount, rating, openingHoursHash, popularTimesHash, lastCheckedAt, consecutiveFailures, status, sourceFormat, navigablePlaceId, importedAt, updatedAt)
        VALUES (@placeId, @name, @city, @reviewCount, @rating, @openingHoursHash, @popularTimesHash, @lastCheckedAt, @consecutiveFailures, @status, @sourceFormat, @navigablePlaceId, @importedAt, @updatedAt)
        ON CONFLICT(placeId) DO UPDATE SET
          name = COALESCE(@name, poi_baseline.name),
          city = COALESCE(@city, poi_baseline.city),
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
      getAllActivePlaceIdsByCity: this.db.prepare("SELECT placeId, navigablePlaceId FROM poi_baseline WHERE status = 'active' AND city = ? ORDER BY lastCheckedAt ASC NULLS FIRST"),

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
        INSERT INTO change_log (scanId, city, placeId, changeType, fields, previousMilestoneAt, currentMilestoneAt, detectedAt)
        VALUES (@scanId, @city, @placeId, @changeType, @fields, @previousMilestoneAt, @currentMilestoneAt, @detectedAt)
      `),

      getChangesByScanId: this.db.prepare(`
        SELECT cl.*, pb.navigablePlaceId
        FROM change_log cl
        LEFT JOIN poi_baseline pb ON cl.placeId = pb.placeId
        WHERE cl.scanId = ?
      `),

      createScan: this.db.prepare(`
        INSERT INTO scan_history (scanId, city, startedAt, baselineMilestoneAt, totalPois, status)
        VALUES (@scanId, @city, @startedAt, @baselineMilestoneAt, @totalPois, 'running')
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
      `),

      getCities: this.db.prepare(`
        SELECT city FROM (
          SELECT DISTINCT city FROM poi_baseline WHERE city IS NOT NULL AND TRIM(city) != ''
          UNION
          SELECT DISTINCT city FROM scan_history WHERE city IS NOT NULL AND TRIM(city) != ''
        ) ORDER BY city COLLATE NOCASE ASC
      `)
    };
  }

  upsertPoi(poi) {
    const now = new Date().toISOString();
    return this._stmts.upsertPoi.run({
      placeId: poi.placeId,
      name: poi.name || null,
      city: normalizeCity(poi.city),
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

  iterateActivePois(city = null) {
    const normalizedCity = normalizeCity(city);
    if (!normalizedCity) return this._stmts.getAllActivePois.iterate();
    return this.db.prepare(
      "SELECT * FROM poi_baseline WHERE status = 'active' AND city = ? ORDER BY lastCheckedAt ASC NULLS FIRST"
    ).iterate(normalizedCity);
  }

  getAllActivePlaceIds(city = null) {
    const normalizedCity = normalizeCity(city);
    const rows = normalizedCity
      ? this._stmts.getAllActivePlaceIdsByCity.all(normalizedCity)
      : this._stmts.getAllActivePlaceIds.all();
    return rows.map(row => ({
      placeId: row.placeId,
      navigablePlaceId: row.navigablePlaceId
    }));
  }

  getAllPlaceIds() {
    return new Set(this._stmts.getAllPlaceIds.all().map(row => row.placeId));
  }

  getPoiCount(city = null) {
    const normalizedCity = normalizeCity(city);
    if (!normalizedCity) return this._stmts.getPoiCount.get().count;
    return this.db.prepare('SELECT COUNT(*) as count FROM poi_baseline WHERE city = ?').get(normalizedCity).count;
  }

  getPoiCountByStatus(city = null) {
    const normalizedCity = normalizeCity(city);
    if (!normalizedCity) return this._stmts.getPoiCountByStatus.all();
    return this.db.prepare('SELECT status, COUNT(*) as count FROM poi_baseline WHERE city = ? GROUP BY status').all(normalizedCity);
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
      city: normalizeCity(change.city),
      placeId: change.placeId,
      changeType: change.changeType,
      fields: typeof change.fields === 'string' ? change.fields : JSON.stringify(change.fields),
      previousMilestoneAt: change.previousMilestoneAt || null,
      currentMilestoneAt: change.currentMilestoneAt || null,
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

  createScan(scanId, totalPois = 0, options = {}) {
    return this._stmts.createScan.run({
      scanId,
      city: normalizeCity(options.city),
      startedAt: options.startedAt || new Date().toISOString(),
      baselineMilestoneAt: options.baselineMilestoneAt || null,
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

  getLastScan(city = null) {
    const normalizedCity = normalizeCity(city);
    if (!normalizedCity) return this._stmts.getLastScan.get();
    return this.db.prepare(
      'SELECT * FROM scan_history WHERE city = ? ORDER BY startedAt DESC LIMIT 1'
    ).get(normalizedCity);
  }

  getLastCompletedScan(city = null) {
    const normalizedCity = normalizeCity(city);
    if (!normalizedCity) {
      return this.db.prepare(
        "SELECT * FROM scan_history WHERE status = 'completed' ORDER BY startedAt DESC LIMIT 1"
      ).get();
    }
    return this.db.prepare(
      "SELECT * FROM scan_history WHERE city = ? AND status = 'completed' ORDER BY startedAt DESC LIMIT 1"
    ).get(normalizedCity);
  }

  getScanById(scanId) {
    return this._stmts.getScanById.get(scanId);
  }

  getCities() {
    return this._stmts.getCities.all().map(row => row.city);
  }

  getStats(city = null) {
    const normalizedCity = normalizeCity(city);
    const count = this.getPoiCount(normalizedCity);
    const byStatus = this.getPoiCountByStatus(normalizedCity);
    const coverage = normalizedCity
      ? this.db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) as withRating,
            SUM(CASE WHEN reviewCount IS NOT NULL THEN 1 ELSE 0 END) as withReviewCount,
            SUM(CASE WHEN openingHoursHash IS NOT NULL THEN 1 ELSE 0 END) as withOpeningHours,
            SUM(CASE WHEN popularTimesHash IS NOT NULL THEN 1 ELSE 0 END) as withPopularTimes
          FROM poi_baseline
          WHERE city = ?
        `).get(normalizedCity)
      : this._stmts.getFieldCoverage.get();
    const sourceBreakdown = normalizedCity
      ? this.db.prepare(
          'SELECT sourceFormat, COUNT(*) as count FROM poi_baseline WHERE city = ? GROUP BY sourceFormat'
        ).all(normalizedCity)
      : this._stmts.getSourceFormatBreakdown.all();
    const lastScan = this.getLastScan(normalizedCity);
    const lastCompletedScan = this.getLastCompletedScan(normalizedCity);

    return {
      totalPois: count,
      byStatus,
      fieldCoverage: coverage,
      sourceBreakdown,
      lastScan,
      lastCompletedScan,
      scopeCity: normalizedCity || ALL_CITIES,
      availableCities: this.getCities()
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
