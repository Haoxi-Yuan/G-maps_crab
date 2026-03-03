const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { detectChanges } = require('./change-detector');
const { computeHash, normalizeOpeningHours, normalizePopularTimes, generateScanId, formatDuration, ensureDir, log } = require('./utils');

class ChangeScanner {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.scanId = generateScanId();
    this.stats = {
      total: 0,
      scanned: 0,
      changed: 0,
      failed: 0,
      gone: 0,
      newValues: 0
    };
    this.extractScript = fs.readFileSync(
      path.join(__dirname, 'extract-poi-data.js'), 'utf8'
    );
    this.changeBatch = [];
    this.city = null;
    this.previousMilestoneAt = null;
    this.currentMilestoneAt = null;
  }

  /**
   * Run the change scan.
   * @param {Object} options
   * @param {boolean} options.resume - Resume from checkpoint
   * @param {number}  options.limit  - Max POIs to scan
   * @param {string}  options.city   - City filter
   * @param {Function} options.shouldContinue - Async callback checked before each batch.
   *   Returns true to continue, false to stop gracefully. Used by IPC wrapper for pause/stop.
   */
  async run(options = {}) {
    const startTime = Date.now();
    this.city = options.city || null;
    const shouldContinue = options.shouldContinue || (() => true);

    // Get all active POI IDs
    const allPlaceIds = this.db.getAllActivePlaceIds(this.city);
    this.stats.total = options.limit
      ? Math.min(options.limit, allPlaceIds.length)
      : allPlaceIds.length;

    // Handle checkpoint resume
    let startIndex = 0;
    if (options.resume) {
      const checkpoint = this.readCheckpoint();
      if (checkpoint) {
        startIndex = checkpoint.lastIndex + 1;
        this.scanId = checkpoint.scanId || this.scanId;
        this.city = checkpoint.city || this.city;
        this.previousMilestoneAt = checkpoint.previousMilestoneAt || null;
        this.currentMilestoneAt = checkpoint.currentMilestoneAt || null;
        // Restore accumulated stats from checkpoint
        if (checkpoint.stats) {
          this.stats.scanned = checkpoint.stats.scanned || 0;
          this.stats.changed = checkpoint.stats.changed || 0;
          this.stats.failed = checkpoint.stats.failed || 0;
          this.stats.gone = checkpoint.stats.gone || 0;
          this.stats.newValues = checkpoint.stats.newValues || 0;
        }
        log('info', `Resuming scan ${this.scanId} from index ${startIndex} (scanned=${this.stats.scanned}, changed=${this.stats.changed})`);
      }
    }

    const endIndex = options.limit
      ? Math.min(startIndex + options.limit, allPlaceIds.length)
      : allPlaceIds.length;

    const placeIds = allPlaceIds.slice(startIndex, endIndex);

    if (placeIds.length === 0) {
      log('info', 'No POIs to scan');
      return this.scanId;
    }

    // Create scan record
    if (!options.resume || startIndex === 0) {
      this.currentMilestoneAt = new Date().toISOString();
      const previousScan = this.db.getLastCompletedScan(this.city);
      this.previousMilestoneAt = previousScan
        ? (previousScan.completedAt || previousScan.startedAt || null)
        : null;
      this.db.createScan(this.scanId, this.stats.total, {
        city: this.city,
        startedAt: this.currentMilestoneAt,
        baselineMilestoneAt: this.previousMilestoneAt
      });
    } else {
      const existingScan = this.db.getScanById(this.scanId);
      if (existingScan) {
        this.city = existingScan.city || this.city;
        this.previousMilestoneAt = existingScan.baselineMilestoneAt || this.previousMilestoneAt;
        this.currentMilestoneAt = existingScan.startedAt || this.currentMilestoneAt;
      }
    }

    const cityLabel = this.city || 'ALL';
    log('info', `Scan ${this.scanId}: city=${cityLabel}, ${placeIds.length} POIs (index ${startIndex}-${endIndex - 1})`);

    // Launch browser pool
    const { browsers: numBrowsers, tabsPerBrowser } = this.config.concurrency;
    const totalTabs = numBrowsers * tabsPerBrowser;
    log('info', `Launching ${numBrowsers} browser(s) x ${tabsPerBrowser} tab(s) = ${totalTabs} concurrent`);

    const browserInstances = [];
    const tabPool = [];
    let stoppedEarly = false;

    try {
      for (let b = 0; b < numBrowsers; b++) {
        const browser = await chromium.launch({
          headless: this.config.browser.headless,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext({
          userAgent: this.config.browser.userAgent,
          viewport: { width: 1920, height: 1080 },
          locale: 'en-US'
        });

        await this._setupResourceBlocking(context);

        for (let t = 0; t < tabsPerBrowser; t++) {
          const page = await context.newPage();
          page.setDefaultTimeout(this.config.thresholds.poiTimeoutMs);
          page.setDefaultNavigationTimeout(this.config.thresholds.navigationTimeoutMs);
          tabPool.push({ browser, context, page, busy: false, id: `b${b}t${t}` });
        }

        browserInstances.push(browser);
      }

      // Process POIs using tab pool with controlled concurrency
      const batchSize = this.config.scan.batchSize;
      for (let i = 0; i < placeIds.length; i += batchSize) {
        // Check if we should continue before each batch
        if (!(await shouldContinue())) {
          log('info', 'Scan interrupted by shouldContinue callback');
          stoppedEarly = true;
          break;
        }

        const batch = placeIds.slice(i, Math.min(i + batchSize, placeIds.length));
        await this._processBatch(batch, tabPool);

        // Flush pending changes
        if (this.changeBatch.length > 0) {
          this.db.insertChangeBatch(this.changeBatch);
          this.changeBatch = [];
        }

        // Write checkpoint
        this.writeCheckpoint({
          lastIndex: startIndex + i + batch.length - 1,
          scanId: this.scanId,
          city: this.city,
          previousMilestoneAt: this.previousMilestoneAt,
          currentMilestoneAt: this.currentMilestoneAt,
          stats: this.stats
        });

        // Progress
        const processed = i + batch.length;
        const elapsed = Date.now() - startTime;
        const rate = processed / (elapsed / 1000);
        const eta = (placeIds.length - processed) / rate;
        process.stdout.write(
          `\r  Progress: ${processed}/${placeIds.length} | ` +
          `Changed: ${this.stats.changed} | Failed: ${this.stats.failed} | ` +
          `Rate: ${rate.toFixed(1)}/s | ETA: ${formatDuration(eta * 1000)}   `
        );

        // Delay between batches
        if (this.config.scan.delayBetweenBatchesMs > 0 && i + batchSize < placeIds.length) {
          await new Promise(r => setTimeout(r, this.config.scan.delayBetweenBatchesMs));
        }
      }

      console.log('');

    } finally {
      // Cleanup browsers
      for (const browser of browserInstances) {
        await browser.close().catch(() => {});
      }
    }

    // Flush remaining changes
    if (this.changeBatch.length > 0) {
      this.db.insertChangeBatch(this.changeBatch);
      this.changeBatch = [];
    }

    if (stoppedEarly) {
      // Don't delete checkpoint — scan was interrupted, can be resumed later
      const duration = Date.now() - startTime;
      this.stats.duration = duration;
      this.stats.status = 'stopped';
      log('info', `Scan stopped after ${formatDuration(duration)}`);
      log('info', `Progress so far: scanned=${this.stats.scanned}, changed=${this.stats.changed}, failed=${this.stats.failed}, gone=${this.stats.gone}`);
      return this.scanId;
    }

    // Complete scan
    const duration = Date.now() - startTime;
    this.stats.duration = duration;
    this.stats.status = 'completed';
    this.db.completeScan(this.scanId, this.stats);
    this.deleteCheckpoint();

    log('info', `Scan completed in ${formatDuration(duration)}`);
    log('info', `Results: scanned=${this.stats.scanned}, changed=${this.stats.changed}, failed=${this.stats.failed}, gone=${this.stats.gone}`);

    return this.scanId;
  }

  async _processBatch(poiEntries, tabPool) {
    const concurrency = tabPool.length;
    let index = 0;

    const worker = async (tab) => {
      while (index < poiEntries.length) {
        const currentIndex = index++;
        const entry = poiEntries[currentIndex];
        const placeId = entry.placeId;

        try {
          await this._scanSinglePoi(tab.page, placeId, entry.navigablePlaceId);
        } catch (err) {
          this.stats.failed++;
          this._handleScanFailure(placeId, err.message);
        }
      }
    };

    // Launch workers, one per tab, they pull from shared index
    const workers = tabPool
      .slice(0, Math.min(concurrency, poiEntries.length))
      .map(tab => worker(tab));

    await Promise.all(workers);
  }

  async _scanSinglePoi(page, placeId, navigablePlaceId) {
    try {
      // Use ChIJ format (navigablePlaceId) for URL navigation when available,
      // because hex format (0x...) doesn't work with place_id: URL scheme
      const navId = navigablePlaceId || placeId;

      // Two-step loading: Google Maps requires search API warm-up for full data
      // Step 1: Load search API URL to initialize session
      const searchUrl = `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${navId}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1', { timeout: this.config.thresholds.poiTimeoutMs })
        .catch(() => null);

      // Step 2: Load place URL for full data (openingHours, popularTimes, etc.)
      const placeUrl = `https://www.google.com/maps/place/?q=place_id:${navId}&hl=en`;
      await page.goto(placeUrl, { waitUntil: 'domcontentloaded' });

      // Wait for page to load - try multiple signals
      const h1Found = await page.waitForSelector('h1', { timeout: this.config.thresholds.poiTimeoutMs })
        .catch(() => null);

      if (!h1Found) {
        // h1 not found in time, try waiting for other Google Maps elements
        await Promise.race([
          page.waitForSelector('[role="img"][aria-label*="star"]', { timeout: 5000 }),
          page.waitForSelector('button[aria-label*="reviews"]', { timeout: 5000 }),
          page.waitForSelector('.DUwDvf', { timeout: 5000 }),
          new Promise(r => setTimeout(r, 5000))
        ]).catch(() => null);
      }

      // Wait for full data to load
      await page.waitForTimeout(2000);

      // Pass expected placeId to extract script for page verification
      await page.evaluate((id) => { window.__expectedPlaceId = id; }, placeId);

      // Extract data
      const current = await page.evaluate(this.extractScript);

      if (current.pageStatus === 'not_found') {
        this._handleScanFailure(placeId, 'Page not found');
        return;
      }

      if (current.pageStatus === 'error') {
        this._handleScanFailure(placeId, current.error || 'Extraction error');
        return;
      }

      // Normalize and compute hashes for openingHours and popularTimes
      const normalizedOH = normalizeOpeningHours(current.openingHours);
      current.openingHoursHash = normalizedOH ? computeHash(normalizedOH) : null;

      const normalizedPT = normalizePopularTimes(current.popularTimes);
      current.popularTimesHash = normalizedPT ? computeHash(normalizedPT) : null;

      // Compare with baseline
      const baseline = this.db.getPoi(placeId);
      if (!baseline) {
        this.stats.failed++;
        return;
      }

      const detection = detectChanges(current, baseline, this.config);

      if (detection.hasChanges) {
        this.changeBatch.push({
          scanId: this.scanId,
          city: this.city,
          placeId,
          changeType: detection.changeType,
          fields: detection.changes,
          previousMilestoneAt: this.previousMilestoneAt,
          currentMilestoneAt: this.currentMilestoneAt,
          detectedAt: new Date().toISOString()
        });
        this.stats.changed++;
      }

      // Update baseline with current values
      this.db.updatePoiAfterScan(placeId, {
        reviewCount: current.reviewCount,
        rating: current.rating,
        openingHoursHash: current.openingHoursHash,
        popularTimesHash: current.popularTimesHash
      });

      this.stats.scanned++;

    } catch (err) {
      throw err;
    }
  }

  _handleScanFailure(placeId, reason) {
    const poi = this.db.incrementFailures(placeId);
    if (poi && poi.consecutiveFailures >= this.config.thresholds.consecutiveFailuresForGone) {
      this.db.markAsGone(placeId);
      this.changeBatch.push({
        scanId: this.scanId,
        city: this.city,
        placeId,
        changeType: 'POI_GONE',
        fields: { reason, consecutiveFailures: poi.consecutiveFailures },
        previousMilestoneAt: this.previousMilestoneAt,
        currentMilestoneAt: this.currentMilestoneAt,
        detectedAt: new Date().toISOString()
      });
      this.stats.gone++;
    }
  }

  async _setupResourceBlocking(context) {
    const blockTypes = new Set(['image', 'media', 'font']);
    await context.route('**/*', route => {
      const type = route.request().resourceType();
      const url = route.request().url();

      if (blockTypes.has(type)) return route.abort();
      if (url.includes('maps/vt') || url.includes('khms') || url.includes('kh.google.com')) {
        return route.abort();
      }
      return route.continue();
    });
  }

  readCheckpoint() {
    const cpPath = this.config.paths.checkpoint;
    if (!fs.existsSync(cpPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(cpPath, 'utf8'));
    } catch {
      return null;
    }
  }

  writeCheckpoint(data) {
    const cpPath = this.config.paths.checkpoint;
    ensureDir(path.dirname(cpPath));
    fs.writeFileSync(cpPath, JSON.stringify(data, null, 2));
  }

  deleteCheckpoint() {
    const cpPath = this.config.paths.checkpoint;
    if (fs.existsSync(cpPath)) {
      fs.unlinkSync(cpPath);
    }
  }
}

module.exports = ChangeScanner;
