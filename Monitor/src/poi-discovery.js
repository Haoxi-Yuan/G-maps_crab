const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const CityDataGenerator = require('./lib/city-generator');
const { searchPOIsForPoint, extractPlaceIdFromUrl, SEARCH_CONFIG } = require('./lib/poi-searcher');
const { generateScanId, formatDuration, ensureDir, log } = require('./utils');

const DEFAULT_CATEGORIES = [
  'Restaurant',
  'Cafe',
  'Supermarket',
  'Hotel',
  'Bank',
  'Hospital',
  'Clinic',
  'Pharmacy',
  'Shopping Mall',
  'School',
  'Gym',
  'Gas Station',
  'Convenience Store',
  'Bakery',
  'Bar'
];

class POIDiscovery {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.discoveryId = generateScanId().replace('scan-', 'disc-');
  }

  async run(options = {}) {
    const startTime = Date.now();
    const cityName = options.city || 'Singapore';
    const categories = options.categories || DEFAULT_CATEGORIES;
    const cellSize = options.cellSize || 2000;
    const numPoints = options.numPoints || null;
    const maxSearches = options.limit || Infinity;

    log('info', `Discovery ${this.discoveryId}: city=${cityName}, categories=${categories.length}`);

    // Step 1: Generate sampling points
    log('info', 'Step 1: Generating sampling points...');
    const points = await this._generatePoints(cityName, {
      cellSize,
      numPoints,
      boundaryFile: options.boundaryFile
    });
    log('info', `Generated ${points.length} sampling points`);

    // Step 2: Search POIs at each point
    log('info', 'Step 2: Searching for POIs...');
    const foundPlaceIds = await this._searchPOIs(points, categories, {
      maxSearches,
      headless: this.config.browser.headless
    });
    log('info', `Found ${foundPlaceIds.size} unique place IDs`);

    // Step 3: Compare with DB
    log('info', 'Step 3: Comparing with database...');
    const existingIds = this.db.getAllPlaceIds();
    const newIds = [];
    for (const id of foundPlaceIds) {
      if (!existingIds.has(id)) {
        newIds.push(id);
      }
    }
    log('info', `New POIs not in DB: ${newIds.length} (out of ${foundPlaceIds.size} found)`);

    // Step 4: Insert new POIs into DB
    if (newIds.length > 0) {
      log('info', 'Step 4: Inserting new POIs...');
      const batch = newIds.map(placeId => ({
        placeId,
        name: null,
        reviewCount: null,
        rating: null,
        openingHoursHash: null,
        popularTimesHash: null,
        navigablePlaceId: placeId.startsWith('ChIJ') ? placeId : null,
        status: 'active',
        sourceFormat: 'discovered'
      }));
      this.db.upsertPoiBatch(batch);
    }

    // Step 5: Generate report
    const duration = Date.now() - startTime;
    const reportDir = this._generateReport({
      discoveryId: this.discoveryId,
      cityName,
      categories,
      pointsCount: points.length,
      totalFound: foundPlaceIds.size,
      newCount: newIds.length,
      existingCount: foundPlaceIds.size - newIds.length,
      newPlaceIds: newIds,
      duration
    });

    log('info', `Discovery completed in ${formatDuration(duration)}`);
    log('info', `Results: found=${foundPlaceIds.size}, new=${newIds.length}, existing=${foundPlaceIds.size - newIds.length}`);

    return {
      discoveryId: this.discoveryId,
      totalFound: foundPlaceIds.size,
      newCount: newIds.length,
      reportDir,
      duration
    };
  }

  async _generatePoints(cityName, options) {
    const outputDir = path.join(this.config.paths.output, 'discovery', this.discoveryId);
    ensureDir(outputDir);

    const generator = new CityDataGenerator({
      cityName: options.boundaryFile ? null : cityName,
      boundaryFile: options.boundaryFile || null,
      cellSize: options.cellSize,
      numPoints: options.numPoints,
      lloydIterations: 5,
      outputDir
    });

    // Check for cached boundary
    const cachePath = path.join(this.config.paths.output, 'discovery', `${cityName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_boundary.geojson`);

    let boundary;
    if (fs.existsSync(cachePath) && !options.boundaryFile) {
      log('info', `Loading cached boundary: ${cachePath}`);
      boundary = await generator.loadBoundary(cachePath);
    } else if (options.boundaryFile) {
      boundary = await generator.loadBoundary(options.boundaryFile);
    } else {
      boundary = await generator.generateBoundary(cityName);
      // Cache the boundary for future runs
      ensureDir(path.dirname(cachePath));
      fs.writeFileSync(cachePath, JSON.stringify(boundary, null, 2));
      log('info', `Boundary cached: ${cachePath}`);
    }

    return await generator.generatePoints(boundary);
  }

  async _searchPOIs(points, categories, options) {
    const allPlaceIds = new Set();
    const maxSearches = options.maxSearches || Infinity;
    let searchCount = 0;

    const browser = await chromium.launch({
      headless: options.headless !== false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const context = await browser.newContext({
      userAgent: this.config.browser.userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US'
    });

    // Block heavy resources
    await context.route('**/*', route => {
      const type = route.request().resourceType();
      const url = route.request().url();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      if (url.includes('maps/vt') || url.includes('khms') || url.includes('kh.google.com')) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    try {
      for (let i = 0; i < points.length && searchCount < maxSearches; i++) {
        const point = points[i];

        for (let j = 0; j < categories.length && searchCount < maxSearches; j++) {
          const category = categories[j];
          searchCount++;

          process.stdout.write(
            `\r  Search ${searchCount}: ${category} @ (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}) | Found: ${allPlaceIds.size}   `
          );

          try {
            const result = await searchPOIsForPoint(page, point, category, {
              zoom: SEARCH_CONFIG.defaultZoom,
              extractPlaceIdFromPage: false,
              maxScrolls: 10,
              scrollDelay: 600
            });

            for (const id of result.placeIds) {
              allPlaceIds.add(id);
            }

            // Also extract from links directly in case placeId extraction missed some
            for (const link of result.placeLinks) {
              const id = extractPlaceIdFromUrl(link);
              if (id) allPlaceIds.add(id);
            }
          } catch (err) {
            // Skip failed searches silently
          }

          // Delay between searches
          await page.waitForTimeout(1500);
        }
      }

      console.log('');
    } finally {
      await browser.close();
    }

    return allPlaceIds;
  }

  _generateReport(data) {
    const reportDir = path.join(this.config.paths.reports, data.discoveryId);
    ensureDir(reportDir);

    // New place IDs list
    const idsPath = path.join(reportDir, 'new_placeids.txt');
    fs.writeFileSync(idsPath, data.newPlaceIds.join('\n') + '\n');

    // Full report
    const reportPath = path.join(reportDir, 'discovery_report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      discoveryId: data.discoveryId,
      cityName: data.cityName,
      timestamp: new Date().toISOString(),
      categories: data.categories,
      samplingPoints: data.pointsCount,
      totalFound: data.totalFound,
      newPois: data.newCount,
      existingPois: data.existingCount,
      duration: formatDuration(data.duration)
    }, null, 2));

    log('info', `Report: ${reportDir}`);
    log('info', `  New POIs list: ${idsPath}`);

    return reportDir;
  }
}

module.exports = POIDiscovery;
