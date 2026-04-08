#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const { loadConfig } = require('../time_scraper/src/monitor/config');
const MonitorDB = require('../time_scraper/src/monitor/db');
const { importBaseline } = require('../time_scraper/src/monitor/baseline-importer');
const ChangeScanner = require('../time_scraper/src/monitor/change-scanner');
const ReportGenerator = require('../time_scraper/src/monitor/report-generator');
const { exportSnapshot } = require('../time_scraper/src/monitor/snapshot-exporter');
const POIDiscovery = require('../time_scraper/src/monitor/poi-discovery');
const { log, formatDuration } = require('../time_scraper/src/monitor/utils');

const program = new Command();

program
  .name('poi-monitor')
  .description('Google Maps POI Change Monitor')
  .version('1.0.0');

program
  .command('import')
  .description('Import baseline data from scraper output')
  .requiredOption('--source <path>', 'Path to source data (directory or .ndjson file)')
  .option('--format <type>', 'Format: auto, old, new', 'auto')
  .action(async (options) => {
    const config = loadConfig();
    const db = new MonitorDB(config.paths.database);

    try {
      const sourcePath = path.resolve(options.source);
      log('info', 'Starting baseline import...');
      const result = await importBaseline(sourcePath, db, options.format);

      console.log('\n=== Import Summary ===');
      if (result.totalFiles !== undefined) {
        console.log(`  Total files scanned: ${result.totalFiles}`);
        console.log(`  Categories: ${result.categories}`);
      }
      if (result.totalLines !== undefined) {
        console.log(`  Total NDJSON lines: ${result.totalLines}`);
      }
      console.log(`  Records imported: ${result.imported}`);
      console.log(`  Skipped: ${result.skipped}`);
      console.log(`  Errors: ${result.errors}`);
      console.log(`  Null ratings: ${result.nullRating}`);
      console.log(`  Null reviewCounts: ${result.nullReviewCount}`);
      if (result.withOpeningHours !== undefined) {
        console.log(`  With openingHours: ${result.withOpeningHours}`);
        console.log(`  With popularTimes: ${result.withPopularTimes}`);
      }
      console.log(`  Unique POIs in DB: ${result.uniquePois}`);
      console.log(`  Duration: ${formatDuration(result.duration)}`);
    } catch (err) {
      log('error', err.message);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('stats')
  .description('Show database statistics')
  .action(async () => {
    const config = loadConfig();
    const db = new MonitorDB(config.paths.database);

    try {
      const stats = db.getStats();

      console.log('\n=== POI Monitor Statistics ===');
      console.log(`  Total POIs: ${stats.totalPois}`);
      console.log('');

      console.log('  Status breakdown:');
      for (const row of stats.byStatus) {
        console.log(`    ${row.status}: ${row.count}`);
      }
      console.log('');

      console.log('  Field coverage:');
      console.log(`    With rating: ${stats.fieldCoverage.withRating} / ${stats.fieldCoverage.total}`);
      console.log(`    With reviewCount: ${stats.fieldCoverage.withReviewCount} / ${stats.fieldCoverage.total}`);
      console.log(`    With openingHoursHash: ${stats.fieldCoverage.withOpeningHours} / ${stats.fieldCoverage.total}`);
      console.log(`    With popularTimesHash: ${stats.fieldCoverage.withPopularTimes} / ${stats.fieldCoverage.total}`);
      console.log('');

      console.log('  Source format breakdown:');
      for (const row of stats.sourceBreakdown) {
        console.log(`    ${row.sourceFormat || 'unknown'}: ${row.count}`);
      }

      if (stats.lastScan) {
        console.log('');
        console.log('  Last scan:');
        console.log(`    Scan ID: ${stats.lastScan.scanId}`);
        console.log(`    Started: ${stats.lastScan.startedAt}`);
        console.log(`    Status: ${stats.lastScan.status}`);
        console.log(`    Scanned: ${stats.lastScan.scannedCount}`);
        console.log(`    Changed: ${stats.lastScan.changedCount}`);
      }

      console.log('');
    } catch (err) {
      log('error', err.message);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('scan')
  .description('Run change scan against baseline')
  .option('--resume', 'Resume from last checkpoint', false)
  .option('--limit <n>', 'Limit number of POIs to scan', parseInt)
  .action(async (options) => {
    const config = loadConfig();
    const db = new MonitorDB(config.paths.database);

    try {
      const scanner = new ChangeScanner(db, config);
      const scanId = await scanner.run({
        resume: options.resume,
        limit: options.limit
      });

      // Generate report
      const reporter = new ReportGenerator(db, config);
      const { reportDir, summary } = reporter.generate(scanId);

      // Export snapshot
      exportSnapshot(db, config.paths.snapshots);

      console.log('\n=== Scan Summary ===');
      console.log(`  Scan ID: ${scanId}`);
      console.log(`  Total scanned: ${summary.totalScanned}`);
      console.log(`  Total changed: ${summary.totalChanged}`);
      console.log(`  New POIs: ${summary.newPois}`);
      console.log(`  Gone POIs: ${summary.gonePois}`);
      console.log(`  Review count changed: ${summary.reviewCountChanged}`);
      console.log(`  Rating changed: ${summary.ratingChanged}`);
      console.log(`  Opening hours changed: ${summary.openingHoursChanged}`);
      console.log(`  Popular times changed: ${summary.popularTimesChanged}`);
      console.log(`  Scan failed: ${summary.scanFailed}`);
      console.log(`  Report: ${reportDir}`);
    } catch (err) {
      log('error', err.message);
      console.error(err.stack);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('report')
  .description('View or regenerate a scan report')
  .requiredOption('--scan-id <id>', 'Scan ID to generate report for')
  .action(async (options) => {
    const config = loadConfig();
    const db = new MonitorDB(config.paths.database);

    try {
      const reporter = new ReportGenerator(db, config);
      const { reportDir, summary, changedCount } = reporter.generate(options.scanId);

      console.log('\n=== Report ===');
      console.log(`  Report directory: ${reportDir}`);
      console.log(`  Changed POIs: ${changedCount}`);
      console.log(`  Summary:`, JSON.stringify(summary, null, 4));
    } catch (err) {
      log('error', err.message);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('discover')
  .description('Discover new POIs by searching Google Maps in a city')
  .option('--city <name>', 'City name', 'Singapore')
  .option('--categories <list>', 'Comma-separated POI categories')
  .option('--cell-size <meters>', 'Sampling cell size in meters', parseInt, 2000)
  .option('--points <n>', 'Number of sampling points', parseInt)
  .option('--boundary <file>', 'Use existing boundary GeoJSON file')
  .option('--limit <n>', 'Max number of searches to perform', parseInt)
  .action(async (options) => {
    const config = loadConfig();
    const db = new MonitorDB(config.paths.database);

    try {
      const discovery = new POIDiscovery(db, config);
      const categories = options.categories
        ? options.categories.split(',').map(c => c.trim())
        : undefined;

      const result = await discovery.run({
        city: options.city,
        categories,
        cellSize: options.cellSize,
        numPoints: options.points,
        boundaryFile: options.boundary,
        limit: options.limit
      });

      console.log('\n=== Discovery Summary ===');
      console.log(`  Discovery ID: ${result.discoveryId}`);
      console.log(`  Total POIs found: ${result.totalFound}`);
      console.log(`  New POIs: ${result.newCount}`);
      console.log(`  Duration: ${formatDuration(result.duration)}`);
      console.log(`  Report: ${result.reportDir}`);

      // Show updated stats
      const stats = db.getStats();
      console.log(`\n  DB total POIs: ${stats.totalPois}`);
    } catch (err) {
      log('error', err.message);
      console.error(err.stack);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('clean-scan')
  .description('Clean a bad scan: restore baseline, delete records, reset checkpoint')
  .requiredOption('--scan-id <id>', 'Scan ID to clean')
  .action(async (options) => {
    const config = loadConfig();
    const db = new MonitorDB(config.paths.database);
    const fs = require('fs');

    try {
      const scan = db.getScanById(options.scanId);
      if (!scan) {
        log('error', `Scan not found: ${options.scanId}`);
        process.exit(1);
      }

      console.log(`\nCleaning scan: ${options.scanId}`);
      console.log(`  Started: ${scan.startedAt}`);

      // Step 1: Restore old baseline values from change_log
      const changes = db.getChangesByScanId(options.scanId);
      let restored = 0;
      for (const change of changes) {
        let fields;
        try {
          fields = typeof change.fields === 'string' ? JSON.parse(change.fields) : change.fields;
        } catch { continue; }
        if (!Array.isArray(fields)) continue;

        for (const f of fields) {
          if (f.field === 'rating' && f.old !== null && f.old !== undefined) {
            db.restorePoiRating(change.placeId, f.old);
            restored++;
          }
          if (f.field === 'reviewCount' && f.old !== null && f.old !== undefined) {
            db.restorePoiReviewCount(change.placeId, f.old);
            restored++;
          }
        }
      }
      console.log(`  Restored ${restored} baseline field(s) from ${changes.length} change records`);

      // Step 2: Reset lastCheckedAt for all POIs scanned during this scan
      const resetResult = db.resetLastCheckedSince(scan.startedAt);
      console.log(`  Reset lastCheckedAt for ${resetResult.changes} POIs`);

      // Step 3: Delete change_log and scan_history records
      const deleteResult = db.deleteChangesForScan(options.scanId);
      db.deleteScan(options.scanId);
      console.log(`  Deleted ${deleteResult.changes} change records + scan record`);

      // Step 4: Delete checkpoint file
      const cpPath = config.paths.checkpoint;
      if (fs.existsSync(cpPath)) {
        fs.unlinkSync(cpPath);
        console.log('  Deleted checkpoint file');
      }

      console.log('\nCleanup complete.');
      console.log('Recommended next steps:');
      console.log('  1. Re-import data to fully restore baseline:');
      console.log('     node cli.js import --source ./data/legacy_import --format old');
      console.log('     node cli.js import --source ./data/pipeline_import --format new');
      console.log('  2. Run fresh scan: node cli.js scan --limit 50');
    } catch (err) {
      log('error', err.message);
      console.error(err.stack);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program.parse();
