#!/usr/bin/env node
/**
 * repair-progress.js
 *
 * Repair script to synchronize checkpoint files and DB (tasks.json) progress
 * with actual NDJSON output data.
 *
 * This fixes the issue where progress_current in the DB is far behind the
 * actual number of records scraped, due to the --start/checkpoint resume bug.
 *
 * IMPORTANT: Stop all running tasks before running this script.
 *
 * Usage:
 *   node scripts/repair-progress.js              # Dry run (show what would change)
 *   node scripts/repair-progress.js --apply       # Apply changes
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = !process.argv.includes('--apply');

const PROJECT_ROOT = path.join(__dirname, '..');
const TASKS_DB = path.join(PROJECT_ROOT, 'db/tasks.json');

function log(msg) {
  console.log(msg);
}

function warn(msg) {
  console.warn(`[WARN] ${msg}`);
}

/**
 * Count lines in a file (each line = one NDJSON record)
 */
function countLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return 0;
  return content.split('\n').length;
}

/**
 * Extract all placeIds from an NDJSON file.
 * Success records: placeId is at _meta.placeId
 * Error records: placeId is at .placeId
 */
function extractPlaceIds(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  const ids = [];
  for (const line of content.split('\n')) {
    try {
      const record = JSON.parse(line);
      const pid = (record._meta && record._meta.placeId) || record.placeId;
      if (pid) ids.push(pid);
    } catch (e) {
      // skip malformed lines
    }
  }
  return ids;
}

/**
 * Build a placeId → indices map from the input coordinates file.
 * Since placeIds can be duplicated, we store an array of all indices.
 */
function buildPlaceIdIndex(inputPath) {
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const map = new Map();
  for (let i = 0; i < data.length; i++) {
    const pid = data[i].place_id;
    if (!map.has(pid)) {
      map.set(pid, []);
    }
    map.get(pid).push(i);
  }
  return { map, total: data.length };
}

function main() {
  if (DRY_RUN) {
    log('=== DRY RUN MODE (pass --apply to make changes) ===\n');
  } else {
    log('=== APPLYING CHANGES ===\n');
  }

  // Read tasks DB
  const tasksData = JSON.parse(fs.readFileSync(TASKS_DB, 'utf8'));
  const tasks = tasksData.tasks;

  if (!tasks || tasks.length === 0) {
    log('No tasks found.');
    return;
  }

  // Check for running tasks
  const runningTasks = tasks.filter(t => t.status === 'running');
  if (runningTasks.length > 0 && !DRY_RUN) {
    warn(`${runningTasks.length} tasks are still running! Stop them before applying repairs.`);
    warn('Running in dry-run mode instead.');
  }

  // Cache for input file placeId maps
  const inputCaches = new Map();

  for (const task of tasks) {
    log(`--- Task: ${task.task_id} (status: ${task.status}) ---`);

    const config = JSON.parse(task.config);
    const outputPath = path.join(PROJECT_ROOT, config.output);
    const errorsPath = outputPath.replace('.ndjson', '.errors.ndjson');
    const checkpointPath = task.state_file.replace('.state.json', '.checkpoint.json');

    // Count actual records
    const successCount = countLines(outputPath);
    const failedCount = countLines(errorsPath);
    const totalProcessed = successCount + failedCount;

    log(`  Output file: ${config.output}`);
    log(`  Records: ${successCount} success, ${failedCount} failed, ${totalProcessed} total`);
    log(`  DB progress: ${task.progress_current}/${task.progress_total}`);

    // Parse current stats
    let currentStats = { success: 0, failed: 0, reviews: 0, images: 0 };
    if (task.stats) {
      try { currentStats = JSON.parse(task.stats); } catch (e) {}
    }
    log(`  DB stats: success=${currentStats.success}, failed=${currentStats.failed}`);

    // Build placeId index for the input file (cached)
    if (!inputCaches.has(config.input)) {
      log(`  Loading input file: ${config.input}`);
      inputCaches.set(config.input, buildPlaceIdIndex(config.input));
    }
    const { map: placeIdMap, total: inputTotal } = inputCaches.get(config.input);

    // Determine chunk range first (needed for index lookup)
    const chunkStart = config.start || 0;

    // Extract placeIds from output files and find max index within chunk range
    const successIds = extractPlaceIds(outputPath);
    const errorIds = extractPlaceIds(errorsPath);
    const allIds = [...successIds, ...errorIds];
    const chunkLimit = config.limit;
    const chunkEnd = chunkLimit ? Math.min(inputTotal, chunkStart + chunkLimit) : inputTotal;
    const chunkTotal = chunkEnd - chunkStart;

    log(`  Chunk: start=${chunkStart}, end=${chunkEnd}, total=${chunkTotal}`);

    // Find max index within this task's chunk range [chunkStart, chunkEnd)
    let maxIndex = -1;
    let lastPlaceId = null;
    for (const pid of allIds) {
      const indices = placeIdMap.get(pid);
      if (!indices) continue;
      // Find the index that falls within this task's chunk range
      for (const idx of indices) {
        if (idx >= chunkStart && idx < chunkEnd && idx > maxIndex) {
          maxIndex = idx;
          lastPlaceId = pid;
        }
      }
    }

    // Read current checkpoint
    let currentCheckpoint = null;
    if (fs.existsSync(checkpointPath)) {
      try {
        currentCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      } catch (e) {}
    }

    log(`  Current checkpoint: lastIndex=${currentCheckpoint?.lastIndex}, placeId=${currentCheckpoint?.placeId}`);
    log(`  Computed: maxIndex=${maxIndex}, lastPlaceId=${lastPlaceId}`);

    // Validate: maxIndex should be within the task's chunk range
    if (maxIndex >= 0 && (maxIndex < chunkStart || maxIndex >= chunkEnd)) {
      warn(`  maxIndex ${maxIndex} is outside chunk range [${chunkStart}, ${chunkEnd})! Skipping.`);
      continue;
    }

    if (maxIndex < 0 && totalProcessed === 0) {
      log(`  No records found, nothing to repair.`);
      continue;
    }

    // Calculate new values
    const newProgressCurrent = totalProcessed;
    const newCheckpointIndex = maxIndex >= 0 ? maxIndex : (currentCheckpoint?.lastIndex || 0);

    const needsProgressUpdate = task.progress_current !== newProgressCurrent;
    const needsCheckpointUpdate = currentCheckpoint && currentCheckpoint.lastIndex !== newCheckpointIndex;
    const needsStatsUpdate = currentStats.success !== successCount || currentStats.failed !== failedCount;

    if (!needsProgressUpdate && !needsCheckpointUpdate && !needsStatsUpdate) {
      log(`  Already in sync, no repair needed.\n`);
      continue;
    }

    // Show changes
    if (needsProgressUpdate) {
      log(`  [FIX] progress_current: ${task.progress_current} → ${newProgressCurrent}`);
    }
    if (needsCheckpointUpdate) {
      log(`  [FIX] checkpoint.lastIndex: ${currentCheckpoint?.lastIndex} → ${newCheckpointIndex}`);
      log(`  [FIX] checkpoint.placeId: ${currentCheckpoint?.placeId} → ${lastPlaceId}`);
    }
    if (needsStatsUpdate) {
      log(`  [FIX] stats.success: ${currentStats.success} → ${successCount}`);
      log(`  [FIX] stats.failed: ${currentStats.failed} → ${failedCount}`);
    }

    // Apply changes
    if (!DRY_RUN) {
      // Update checkpoint file
      if (needsCheckpointUpdate && maxIndex >= 0) {
        const newCheckpoint = {
          lastIndex: newCheckpointIndex,
          placeId: lastPlaceId,
          lastStatus: 'ok',
          updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(checkpointPath, JSON.stringify(newCheckpoint, null, 2));
        log(`  ✓ Checkpoint updated`);
      }

      // Update task in tasks array
      task.progress_current = newProgressCurrent;

      // Update stats (preserve reviews/images counts, update success/failed)
      const newStats = { ...currentStats };
      newStats.success = successCount;
      newStats.failed = failedCount;
      newStats.timestamp = Date.now();
      task.stats = JSON.stringify(newStats);

      log(`  ✓ Task DB entry updated`);
    }

    log('');
  }

  // Write updated tasks.json
  if (!DRY_RUN) {
    fs.writeFileSync(TASKS_DB, JSON.stringify(tasksData, null, 2));
    log('=== All repairs applied and saved to tasks.json ===');
  } else {
    log('=== Dry run complete. Pass --apply to make changes. ===');
  }
}

main();
