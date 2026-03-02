const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../db/tasks.json');
const logsDir = path.join(__dirname, '../db/logs');
const dbDir = path.dirname(dbPath);

// Legacy logs.json path (for migration)
const legacyLogsPath = path.join(__dirname, '../db/logs.json');

// --- Log rotation config ---
const LOG_MAX_LINES = 2000;
const LOG_KEEP_LINES = 1000;

// Ensure directories exist
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify({ tasks: [] }, null, 2));
}

// --- Migrate old logs.json to per-task NDJSON files ---
function migrateOldLogs() {
  if (!fs.existsSync(legacyLogsPath)) return;
  try {
    const raw = fs.readFileSync(legacyLogsPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data.logs || data.logs.length === 0) {
      fs.renameSync(legacyLogsPath, legacyLogsPath + '.bak');
      return;
    }

    // Group logs by task_id
    const grouped = {};
    for (const log of data.logs) {
      const tid = log.task_id;
      if (!tid) continue;
      if (!grouped[tid]) grouped[tid] = [];
      grouped[tid].push(log);
    }

    // Write per-task NDJSON files
    for (const [taskId, logs] of Object.entries(grouped)) {
      const logFile = path.join(logsDir, `${taskId}.ndjson`);
      const content = logs.map(l => JSON.stringify(l)).join('\n') + '\n';
      fs.writeFileSync(logFile, content);
    }

    // Rename old file as backup
    fs.renameSync(legacyLogsPath, legacyLogsPath + '.bak');
    console.log(`[Database] Migrated ${data.logs.length} logs from logs.json to ${Object.keys(grouped).length} per-task NDJSON files`);
  } catch (e) {
    console.error('[Database] Failed to migrate old logs.json:', e.message);
  }
}

migrateOldLogs();

// --- In-memory cache to prevent race conditions with concurrent reads/writes ---
let _dbCache = null;
let _dbDirty = false;
let _flushScheduled = false;

function readDB() {
  if (_dbCache) return _dbCache;
  const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  _dbCache = data;
  return data;
}

function writeDB(data) {
  _dbCache = data;
  _dbDirty = true;
  if (!_flushScheduled) {
    _flushScheduled = true;
    setImmediate(_flushDB);
  }
}

function _flushDB() {
  _flushScheduled = false;
  if (!_dbDirty || !_dbCache) return;
  try {
    fs.writeFileSync(dbPath, JSON.stringify(_dbCache, null, 2));
    _dbDirty = false;
  } catch (err) {
    console.error('[Database] Failed to flush DB to disk:', err.message);
  }
}

// Periodic flush every 5 seconds for durability
const _periodicFlushTimer = setInterval(_flushDB, 5000);
// Prevent timer from keeping process alive
_periodicFlushTimer.unref();

// Synchronous flush for graceful shutdown
function _flushSync() {
  clearInterval(_periodicFlushTimer);
  _flushDB();
}

// Invalidate cache if external process modifies the file
fs.watchFile(dbPath, { interval: 10000 }, () => {
  // Only invalidate if we have no pending writes
  if (!_dbDirty) {
    _dbCache = null;
  }
});

// --- Per-task NDJSON log helpers ---
function getLogFilePath(taskId) {
  return path.join(logsDir, `${taskId}.ndjson`);
}

function appendLog(taskId, entry) {
  const logFile = getLogFilePath(taskId);
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

function batchAppendLogs(taskId, entries) {
  if (!entries || entries.length === 0) return;
  const logFile = getLogFilePath(taskId);
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(logFile, content);

  // Check if rotation needed after batch write
  rotateLogFile(taskId);
}

function readTaskLogs(taskId, limit = 200) {
  const logFile = getLogFilePath(taskId);
  if (!fs.existsSync(logFile)) return [];

  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  // Return last `limit` entries in DESC order (newest first)
  const entries = [];
  const startIdx = Math.max(0, lines.length - limit);
  for (let i = lines.length - 1; i >= startIdx; i--) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch (e) {
      // skip malformed lines
    }
  }
  return entries;
}

function deleteTaskLogs(taskId) {
  const logFile = getLogFilePath(taskId);
  if (fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }
}

function rotateLogFile(taskId) {
  const logFile = getLogFilePath(taskId);
  if (!fs.existsSync(logFile)) return;

  try {
    const stat = fs.statSync(logFile);
    // Quick size check: skip rotation if file is small
    // Average NDJSON line ~150 bytes, so 2000 lines ~ 300KB
    if (stat.size < LOG_MAX_LINES * 80) return;

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > LOG_MAX_LINES) {
      const trimmed = lines.slice(-LOG_KEEP_LINES);
      fs.writeFileSync(logFile, trimmed.join('\n') + '\n');
      console.log(`[Database] Rotated log for ${taskId}: ${lines.length} -> ${trimmed.length} lines`);
    }
  } catch (e) {
    console.error(`[Database] Failed to rotate log for ${taskId}:`, e.message);
  }
}

// --- db.prepare() interface (keeps backward compatibility) ---
const db = {
  prepare: (sql) => {
    return {
      run: (...params) => {
        const data = readDB();

        if (sql.includes('INSERT INTO tasks')) {
          const [task_id, status, config, created_at, state_file] = params;
          data.tasks.push({
            task_id,
            status,
            config,
            state_file,
            pid: null,
            progress_current: 0,
            progress_total: 0,
            current_place: null,
            stats: null,
            stats_baseline: null,
            progress_baseline: null,
            error: null,
            created_at,
            started_at: null,
            completed_at: null
          });
          writeDB(data);
        } else if (sql.includes('UPDATE tasks SET status = ?, started_at = ?, pid = ?')) {
          const [status, started_at, pid, task_id] = params;
          const task = data.tasks.find(t => t.task_id === task_id);
          if (task) {
            task.status = status;
            task.started_at = started_at;
            task.pid = pid;
            writeDB(data);
          }
        } else if (sql.includes('UPDATE tasks SET progress_current')) {
          const [progress_current, progress_total, current_place, task_id] = params;
          const task = data.tasks.find(t => t.task_id === task_id);
          if (task) {
            task.progress_current = progress_current;
            task.progress_total = progress_total;
            task.current_place = current_place;
            writeDB(data);
          }
        } else if (sql.includes('UPDATE tasks SET status = ?') && params.length === 2) {
          const [status, task_id] = params;
          const task = data.tasks.find(t => t.task_id === task_id);
          if (task) {
            task.status = status;
            writeDB(data);
          }
        } else if (sql.includes('UPDATE tasks SET stats = ?') && !sql.includes('stats_baseline')) {
          const [stats, task_id] = params;
          const task = data.tasks.find(t => t.task_id === task_id);
          if (task) {
            task.stats = stats;
            writeDB(data);
          }
        } else if (sql.includes('UPDATE tasks SET stats_baseline')) {
          const [stats_baseline, progress_baseline, task_id] = params;
          const task = data.tasks.find(t => t.task_id === task_id);
          if (task) {
            task.stats_baseline = stats_baseline;
            task.progress_baseline = progress_baseline;
            writeDB(data);
          }
        } else if (sql.includes('UPDATE tasks SET status = ?, completed_at = ?, error = ?')) {
          const [status, completed_at, error, task_id] = params;
          const task = data.tasks.find(t => t.task_id === task_id);
          if (task) {
            task.status = status;
            task.completed_at = completed_at;
            task.error = error;
            writeDB(data);
          }
        } else if (sql.includes('DELETE FROM logs')) {
          const [task_id] = params;
          deleteTaskLogs(task_id);
        } else if (sql.includes('DELETE FROM tasks')) {
          const [task_id] = params;
          data.tasks = data.tasks.filter(t => t.task_id !== task_id);
          writeDB(data);
        } else if (sql.includes('INSERT INTO logs')) {
          const [task_id, timestamp, level, message, dataStr] = params;
          appendLog(task_id, { task_id, timestamp, level, message, data: dataStr });
        }
      },

      get: (task_id) => {
        const data = readDB();
        return data.tasks.find(t => t.task_id === task_id) || null;
      },

      all: function(...params) {
        const sqlQuery = arguments[0];
        if (typeof sqlQuery === 'string' && sqlQuery.includes('SELECT * FROM tasks WHERE status IN')) {
          const data = readDB();
          return data.tasks.filter(t => params.includes(t.status));
        } else if (typeof sqlQuery === 'string' && sqlQuery.includes('SELECT * FROM logs WHERE task_id = ?')) {
          const [task_id] = params;
          return readTaskLogs(task_id, 200);
        }

        const data = readDB();
        return data.tasks;
      }
    };
  },

  // Direct method for batch log writes (used by TaskController buffer)
  batchAppendLogs
};

// Expose flush for graceful shutdown
db._flushSync = _flushSync;

console.log('[Database] JSON file database initialized at:', dbPath);
console.log('[Database] Per-task log files directory:', logsDir);
console.log(`[Database] Log rotation: max ${LOG_MAX_LINES} lines, keep ${LOG_KEEP_LINES} after trim`);
console.log('[Database] In-memory write cache enabled (debounced flush + 5s periodic)');

module.exports = db;
