const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const WebSocketManager = require('../services/WebSocketManager');

// Watchdog constants
const WATCHDOG_POLL_INTERVAL = 30000;           // 30 seconds
const WATCHDOG_STUCK_THRESHOLD = 15 * 60 * 1000; // 15 minutes
const WATCHDOG_MAX_AUTO_RECOVERIES = 3;
const MAX_BROWSER_TASKS = 3; // Max concurrent browser tasks (search + scrape)

class TaskController {
  constructor() {
    this.runningProcesses = new Map();
    this.statsBaselines = new Map(); // Store baseline stats for resumed tasks
    this.progressBaselines = new Map(); // Store baseline progress for resumed tasks
    this.logBuffers = new Map();     // Per-task log write buffers
    this.watchdogRecoveryCount = new Map(); // Per-task auto-recovery count
    this.lastKnownActivity = new Map();     // Per-task last known activity tracking

    // Flush log buffers every 3 seconds
    this._flushTimer = setInterval(() => this._flushAllLogBuffers(), 3000);

    // Watchdog timer - monitors for stuck processes
    this._watchdogTimer = setInterval(() => this._watchdogCheck(), WATCHDOG_POLL_INTERVAL);
  }

  async createTask(config) {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stateFile = path.join(__dirname, `../../output/${taskId}.state.json`);

    const outputDir = path.dirname(stateFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    db.prepare(`
      INSERT INTO tasks (task_id, status, config, created_at, state_file)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, 'pending', JSON.stringify(config), Date.now(), stateFile);

    return { taskId, status: 'pending' };
  }

  _getBrowserTaskCount() {
    let count = 0;
    for (const [, proc] of this.runningProcesses) {
      // monitor-import doesn't use a browser; generate doesn't either
      if (proc.taskType === 'generate' || proc.taskType === 'monitor-import') continue;
      count++;
    }
    return count;
  }

  async startTask(taskId) {
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) throw new Error('Task not found');

    if (this.runningProcesses.has(taskId)) {
      throw new Error('Task is already running');
    }

    const config = JSON.parse(task.config);
    const stateFile = task.state_file;

    // Determine task type and select script
    const taskType = config.taskType || (config.mode === 'search' ? 'search+scrape' : 'scrape');
    let scriptPath;
    if (taskType === 'search') {
      scriptPath = path.join(__dirname, '../../src/poi_search_ipc.js');
    } else if (taskType.startsWith('monitor-')) {
      scriptPath = path.join(__dirname, '../../src/monitor/monitor-scan-ipc.js');
    } else {
      scriptPath = path.join(__dirname, '../../src/gmaps_batch_scrape_ipc.js');
    }

    // Browser concurrency check
    const browserCount = this._getBrowserTaskCount();
    if (browserCount >= MAX_BROWSER_TASKS) {
      throw new Error(
        `Cannot start task: ${browserCount} browser tasks already running (max ${MAX_BROWSER_TASKS}). Stop a running task first.`
      );
    }

    const args = this._buildCommandArgs(config, taskId, stateFile);

    // For monitor-scan tasks with resume, ensure a checkpoint file exists
    if (taskType === 'monitor-scan' && config.resume) {
      const checkpointFile = stateFile.replace('.state.json', '.checkpoint.json');
      if (!fs.existsSync(checkpointFile)) {
        const best = this._findBestMonitorCheckpoint(checkpointFile);
        if (best) {
          fs.copyFileSync(best, checkpointFile);
          console.log(`[TaskController] Copied checkpoint ${path.basename(best)} → ${path.basename(checkpointFile)}`);
        }
      }
    }

    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.join(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true  // Start new process group so we can kill Node + Chromium together
    });

    this.runningProcesses.set(taskId, { child, stateFile, taskType });

    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('__IPC__')) {
          try {
            const message = JSON.parse(line.slice(7));
            this._handleIPCMessage(taskId, message);
          } catch (e) {
            console.error('[TaskController] Failed to parse IPC message:', e);
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      const message = data.toString();
      this._saveLog(taskId, 'error', message);
      WebSocketManager.emit(taskId, 'log', {
        timestamp: Date.now(),
        level: 'error',
        message
      });
    });

    child.on('exit', (code) => {
      this._handleProcessExit(taskId, code);
    });

    db.prepare(`
      UPDATE tasks SET status = ?, started_at = ?, pid = ?
      WHERE task_id = ?
    `).run('running', Date.now(), child.pid, taskId);

    WebSocketManager.emit(taskId, 'status', {
      status: 'running',
      pid: child.pid
    });

    return { success: true, pid: child.pid };
  }

  async pauseTask(taskId) {
    const proc = this.runningProcesses.get(taskId);
    if (!proc) {
      const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
      if (task && (task.status === 'running' || task.status === 'paused')) {
        db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?')
          .run('stopped', taskId);
        throw new Error('Task process has terminated. Status updated to stopped. Please refresh the page.');
      }
      throw new Error('Task is not running');
    }

    try {
      // Try child.kill first, fallback to PID-based signal for recovered tasks
      if (proc.child) {
        proc.child.kill('SIGUSR1');
      } else if (proc.pid) {
        process.kill(proc.pid, 'SIGUSR1');
      } else {
        throw new Error('No process handle available');
      }
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to pause task: ${error.message}`);
    }
  }

  async resumeTask(taskId) {
    return this.pauseTask(taskId);
  }

  async stopTask(taskId) {
    const proc = this.runningProcesses.get(taskId);
    if (!proc) {
      const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
      if (task && (task.status === 'running' || task.status === 'paused')) {
        // Try PID-based kill from database record (process group + fallback)
        if (task.pid) {
          try { process.kill(-task.pid, 'SIGTERM'); } catch (e) {
            try { process.kill(task.pid, 'SIGTERM'); } catch (e2) { /* already dead */ }
          }
        }
        db.prepare(`
          UPDATE tasks SET status = ?, completed_at = ?, error = ?
          WHERE task_id = ?
        `).run('stopped', Date.now(), null, taskId);
        return { success: true, message: 'Task process stopped. Status updated.' };
      }
      throw new Error('Task is not running');
    }

    try {
      this._forceKillTask(taskId);
      // Update DB status immediately — don't rely on the child process to report 'stopped'
      db.prepare(`
        UPDATE tasks SET status = ?, completed_at = ?, error = ?
        WHERE task_id = ?
      `).run('stopped', Date.now(), null, taskId);
      this.runningProcesses.delete(taskId);
      WebSocketManager.emit(taskId, 'status', { status: 'stopped' });
      return { success: true, message: 'Task stopped.' };
    } catch (error) {
      throw new Error(`Failed to stop task: ${error.message}`);
    }
  }

  getTasks(filters = {}) {
    let query = 'SELECT * FROM tasks';
    const conditions = [];
    const params = [];

    if (filters.status) {
      const statuses = filters.status.split(',');
      conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    const tasks = db.prepare(query).all(...params);

    return tasks.map(task => ({
      ...task,
      config: JSON.parse(task.config),
      stats: task.stats ? JSON.parse(task.stats) : { success: 0, failed: 0, reviews: 0, images: 0 },
      progress: {
        current: task.progress_current || 0,
        total: task.progress_total || 0,
        percentage: task.progress_total > 0
          ? Math.round((task.progress_current / task.progress_total) * 100)
          : 0
      }
    }));
  }

  getTask(taskId) {
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) return null;

    const proc = this.runningProcesses.get(taskId);
    if (proc && proc.stateFile && fs.existsSync(proc.stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(proc.stateFile, 'utf8'));
        task.progress_current = state.progress?.current || task.progress_current;
        task.progress_total = state.progress?.total || task.progress_total;
        task.stats = JSON.stringify(state.stats || {});
        task.current_place = state.currentPlace || task.current_place;
      } catch (e) {
        console.error('[TaskController] Failed to read state file:', e);
      }
    }

    const logs = db.prepare(
      'SELECT * FROM logs WHERE task_id = ? ORDER BY timestamp DESC LIMIT 200'
    ).all(taskId);

    return {
      ...task,
      config: JSON.parse(task.config),
      stats: task.stats ? JSON.parse(task.stats) : { success: 0, failed: 0, reviews: 0, images: 0 },
      progress: {
        current: task.progress_current || 0,
        total: task.progress_total || 0,
        percentage: task.progress_total > 0
          ? Math.round((task.progress_current / task.progress_total) * 100)
          : 0
      },
      logs: logs.map(log => ({
        timestamp: log.timestamp,
        level: log.level,
        message: log.message,
        data: log.data ? JSON.parse(log.data) : null
      }))
    };
  }

  async deleteTask(taskId) {
    const proc = this.runningProcesses.get(taskId);
    if (proc) {
      throw new Error('Cannot delete running task. Stop it first.');
    }

    // Discard any buffered logs for this task
    this.logBuffers.delete(taskId);

    db.prepare('DELETE FROM logs WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);

    return { success: true };
  }

  async convertToJSON(taskId) {
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) {
      throw new Error('Task not found');
    }

    const config = JSON.parse(task.config);
    const projectRoot = path.join(__dirname, '../..');
    const ndjsonPath = path.isAbsolute(config.output)
      ? config.output
      : path.join(projectRoot, config.output);

    // Check if task was created with JSON format
    if (config.format === 'json') {
      throw new Error('This task was created with JSON format. The data is stored in memory and will be written when the task completes. Please stop the task first to save the data, then restart with NDJSON format.');
    }

    if (!ndjsonPath || !ndjsonPath.endsWith('.ndjson')) {
      throw new Error('Task output is not in NDJSON format');
    }

    if (!fs.existsSync(ndjsonPath)) {
      throw new Error('Output file does not exist. Please ensure the task has processed at least one record.');
    }

    const stats = fs.statSync(ndjsonPath);
    if (stats.size === 0) {
      throw new Error('NDJSON file is empty. Please ensure the task has successfully processed at least one record before converting.');
    }

    const jsonPath = ndjsonPath.replace(/\.ndjson$/i, '.json');

    try {
      const lines = fs.readFileSync(ndjsonPath, 'utf8')
        .split('\n')
        .filter(line => line.trim().length > 0);

      if (lines.length === 0) {
        throw new Error('No valid records found in NDJSON file');
      }

      const results = lines.map(line => JSON.parse(line));

      fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

      return {
        success: true,
        outputPath: jsonPath,
        recordCount: results.length
      };
    } catch (error) {
      throw new Error(`Failed to convert to JSON: ${error.message}`);
    }
  }

  async resumeFromCheckpoint(taskId) {
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);

    if (!task) {
      throw new Error('Task not found');
    }

    // Check if task is in a resumable state
    if (!['paused', 'stopped', 'failed'].includes(task.status)) {
      throw new Error(`Cannot resume task with status: ${task.status}. Only paused, stopped, or failed tasks can be resumed.`);
    }

    // Check if task is already running
    if (this.runningProcesses.has(taskId)) {
      throw new Error('Task is already running');
    }

    const config = JSON.parse(task.config);
    const taskType = config.taskType || 'scrape';

    // Monitor tasks don't use output-as-truth; set resume flag and restart
    if (taskType.startsWith('monitor-')) {
      config.resume = true;
      db.prepare(`
        UPDATE tasks SET status = ?, completed_at = ?, error = ?, config = ?
        WHERE task_id = ?
      `).run('pending', null, null, JSON.stringify(config), taskId);

      WebSocketManager.emit(taskId, 'status', { status: 'pending' });

      const result = await this.startTask(taskId);
      return {
        success: true,
        message: `Resuming monitor task ${taskType} from checkpoint`,
        ...result
      };
    }

    // ========== OUTPUT-AS-TRUTH: Count actual output records ==========
    // IPC script will scan output files itself to determine what to skip.
    // We just need to get initial counts for UI display.
    const projectRoot = path.join(__dirname, '../..');
    const outputPath = path.isAbsolute(config.output)
      ? config.output
      : path.join(projectRoot, config.output);
    const errorsPath = outputPath.replace(/\.ndjson$/i, '.errors.ndjson');

    let actualSuccess = 0;
    let actualFailed = 0;
    try {
      if (fs.existsSync(outputPath)) {
        const content = fs.readFileSync(outputPath, 'utf8').trim();
        actualSuccess = content ? content.split('\n').length : 0;
      }
      if (fs.existsSync(errorsPath)) {
        const errContent = fs.readFileSync(errorsPath, 'utf8').trim();
        actualFailed = errContent ? errContent.split('\n').length : 0;
      }
    } catch (err) {
      console.error('[TaskController] Failed to count output files:', err);
    }
    const actualProcessed = actualSuccess + actualFailed;
    const totalItems = task.progress_total || config.limit || 0;

    console.log(`[TaskController] Resume (output-as-truth) for ${taskId}:`);
    console.log(`  - Output files: ${actualSuccess} success + ${actualFailed} failed = ${actualProcessed}`);
    console.log(`  - Total items: ${totalItems}`);

    // Update DB with actual counts from output files
    const stats = { success: actualSuccess, failed: actualFailed, reviews: 0, images: 0 };
    db.prepare(`
      UPDATE tasks SET progress_current = ?, stats = ?
      WHERE task_id = ?
    `).run(actualProcessed, JSON.stringify(stats), taskId);

    // Clear baselines - IPC script will handle everything from output files
    this.statsBaselines.delete(taskId);
    this.progressBaselines.delete(taskId);
    db.prepare(`
      UPDATE tasks SET stats_baseline = NULL, progress_baseline = NULL
      WHERE task_id = ?
    `).run(taskId);

    // Update task status
    db.prepare(`
      UPDATE tasks SET status = ?, completed_at = ?, error = ?
      WHERE task_id = ?
    `).run('pending', null, null, taskId);

    WebSocketManager.emit(taskId, 'status', { status: 'pending' });

    // Emit current progress from output files
    WebSocketManager.emit(taskId, 'progress', {
      current: actualProcessed,
      total: totalItems,
      percentage: totalItems > 0 ? Math.round((actualProcessed / totalItems) * 100) : 0
    });

    // Start the task — IPC script uses output-as-truth, no checkpoint needed
    const result = await this.startTask(taskId);

    return {
      success: true,
      outputRecords: actualProcessed,
      totalItems: totalItems,
      message: `Resuming with output-as-truth: ${actualProcessed}/${totalItems} already processed`,
      ...result
    };
  }

  _handleIPCMessage(taskId, message) {
    const { type, ...data } = message;

    // Track last activity for watchdog
    this.lastKnownActivity.set(taskId, Date.now());

    switch (type) {
      case 'progress':
        // OUTPUT-AS-TRUTH: IPC script sends correct progress (includes already-done count)
        // No baseline accumulation needed - just pass through
        const progressCurrent = data.current;
        const progressTotal = data.total;

        db.prepare(`
          UPDATE tasks SET progress_current = ?, progress_total = ?, current_place = ?
          WHERE task_id = ?
        `).run(progressCurrent, progressTotal, data.currentPlace, taskId);

        WebSocketManager.emit(taskId, 'progress', {
          ...data,
          current: progressCurrent,
          total: progressTotal,
          percentage: progressTotal > 0 ? Math.round((progressCurrent / progressTotal) * 100) : 0
        });
        break;

      case 'status':
        // Track IPC completion signal so _handleProcessExit can trust it
        if (data.status === 'completed') {
          const proc = this.runningProcesses.get(taskId);
          if (proc) proc.ipcCompleted = true;
        }

        db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?')
          .run(data.status, taskId);

        WebSocketManager.emit(taskId, 'status', data);
        break;

      case 'stats':
        // OUTPUT-AS-TRUTH: IPC script sends correct stats (includes already-done count)
        // No baseline accumulation needed - just pass through
        db.prepare('UPDATE tasks SET stats = ? WHERE task_id = ?')
          .run(JSON.stringify(data), taskId);

        WebSocketManager.emit(taskId, 'stats', data);
        break;

      case 'log':
        this._saveLog(taskId, data.level, data.message, data.data);
        WebSocketManager.emit(taskId, 'log', data);
        break;
    }
  }

  _handleProcessExit(taskId, code) {
    // Flush remaining buffered logs before cleanup
    this._flushLogBuffer(taskId);
    this.logBuffers.delete(taskId);

    // Read proc BEFORE deleting — need ipcCompleted flag
    const proc = this.runningProcesses.get(taskId);
    this.runningProcesses.delete(taskId);
    this.lastKnownActivity.delete(taskId);

    let status = code === 0 ? 'completed' : 'failed';
    let error = code !== 0 ? `Process exited with code ${code}` : null;

    // Verify completion using IPC signal first, then progress as fallback
    if (status === 'completed') {
      if (proc && proc.ipcCompleted) {
        // IPC script confirmed completion — trust it regardless of progress numbers
        console.log(`[TaskController] Task ${taskId} completed (confirmed by IPC completion signal)`);
      } else {
        // No IPC completion signal — verify via progress
        const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
        if (task && task.progress_total > 0 && task.progress_current < task.progress_total) {
          status = 'stopped';
          error = `Process exited early (${task.progress_current}/${task.progress_total} completed)`;
          console.log(`[TaskController] Task ${taskId} exited with code 0 but progress incomplete (${task.progress_current}/${task.progress_total}), marking as stopped`);
        }
      }
    }

    // Only clean up baselines on successful completion
    // Keep them for failed/stopped tasks so they can resume and continue accumulating
    if (status === 'completed') {
      this.statsBaselines.delete(taskId);
      this.progressBaselines.delete(taskId);
      this.watchdogRecoveryCount.delete(taskId);
      // Clear persisted baselines in DB
      db.prepare(`
        UPDATE tasks SET stats_baseline = ?, progress_baseline = ?
        WHERE task_id = ?
      `).run(null, null, taskId);
    }

    db.prepare(`
      UPDATE tasks SET status = ?, completed_at = ?, error = ?
      WHERE task_id = ?
    `).run(status, Date.now(), error, taskId);

    WebSocketManager.emit(taskId, 'status', { status, error });

    console.log(`[TaskController] Task ${taskId} exited with code ${code}, status: ${status}`);
  }

  // Count items in an input file for parallel splitting
  _countItems(filePath, mode) {
    const projectRoot = path.join(__dirname, '../..');
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error('File not found: ' + filePath);
    }

    const content = fs.readFileSync(fullPath, 'utf8');

    if (mode === 'search') {
      const ext = path.extname(fullPath).toLowerCase();
      if (ext === '.csv') {
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        return Math.max(0, lines.length - 1); // subtract header
      } else {
        const data = JSON.parse(content);
        return Array.isArray(data) ? data.length : 0;
      }
    } else {
      const ext = path.extname(fullPath).toLowerCase();
      if (ext === '.json') {
        const data = JSON.parse(content);
        if (Array.isArray(data)) return data.length;
        if (data && typeof data === 'object') return 1;
        return 0;
      } else {
        return content.split('\n').filter(l => l.trim().length > 0).length;
      }
    }
  }

  async createParallelTasks(baseConfig, splitCount) {
    // Determine input file and mode
    const mode = baseConfig.mode || 'traditional';
    const inputFile = mode === 'search' ? baseConfig.points : baseConfig.input;

    if (!inputFile) {
      throw new Error('No input file specified');
    }

    // Count total items
    const totalItems = this._countItems(inputFile, mode);
    if (totalItems === 0) {
      throw new Error('Input file contains no items');
    }

    if (splitCount < 2 || splitCount > 10) {
      throw new Error('Split count must be between 2 and 10');
    }

    if (splitCount > totalItems) {
      throw new Error(`Split count (${splitCount}) exceeds total items (${totalItems})`);
    }

    // Generate group ID and extract base name from input filename
    const groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = path.basename(inputFile);
    const baseName = fileName.replace(/\.[^.]+$/, '');

    // Calculate chunk sizes
    const chunkSize = Math.ceil(totalItems / splitCount);
    const taskIds = [];

    for (let i = 0; i < splitCount; i++) {
      const start = i * chunkSize;
      const limit = Math.min(chunkSize, totalItems - start);
      if (limit <= 0) break;

      const suffix = String(i + 1).padStart(3, '0');
      const splitOutput = `output/${baseName}_${suffix}.ndjson`;
      const splitImageOutput = baseConfig.downloadImages
        ? `output/images/${baseName}/${suffix}`
        : undefined;

      const splitConfig = {
        ...baseConfig,
        start,
        limit,
        output: splitOutput,
        imageOutput: splitImageOutput || baseConfig.imageOutput,
        groupId,
        groupIndex: i,
        groupTotal: splitCount,
        groupLabel: baseName
      };

      const result = await this.createTask(splitConfig);
      taskIds.push(result.taskId);
    }

    return { groupId, taskIds, baseName, totalItems, chunkSize };
  }

  async startParallelTasks(taskIds) {
    const results = await Promise.all(
      taskIds.map(taskId => this.startTask(taskId).catch(err => ({
        taskId,
        success: false,
        error: err.message
      })))
    );
    return { results };
  }

  // Get all tasks belonging to a group
  getTasksByGroupId(groupId) {
    const allTasks = this.getTasks();
    return allTasks.filter(t => t.config && t.config.groupId === groupId);
  }

  _forceKillTask(taskId, signal = 'SIGTERM') {
    const proc = this.runningProcesses.get(taskId);
    if (!proc) return false;

    const pid = proc.pid || (proc.child && proc.child.pid);
    if (!pid) return false;

    try {
      // Kill entire process group (negative PID) to include Chromium subprocesses
      // This works because child was spawned with detached: true
      process.kill(-pid, signal);
      return true;
    } catch (e) {
      // Fallback: try killing just the process
      try {
        process.kill(pid, signal);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  /**
   * Kill a process and wait until it is confirmed dead.
   * Sends SIGTERM first, polls for death, then SIGKILL if needed.
   */
  async _killProcessAndWait(pid, timeoutMs = 10000) {
    // Send SIGTERM to the process group
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (e) {
      // Fallback to single process
      try { process.kill(pid, 'SIGTERM'); } catch (e2) { return; } // already dead
    }

    // Poll every 500ms until process is dead or timeout
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 500));
      try {
        process.kill(pid, 0); // Check if alive
      } catch (e) {
        return; // Process is dead
      }
    }

    // Still alive after timeout — send SIGKILL
    console.log(`[TaskController] Process ${pid} did not die after ${timeoutMs}ms SIGTERM, sending SIGKILL`);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (e) {
      try { process.kill(pid, 'SIGKILL'); } catch (e2) { /* already dead */ }
    }

    // Wait up to 3s more for SIGKILL to take effect
    const killStart = Date.now();
    while (Date.now() - killStart < 3000) {
      await new Promise(r => setTimeout(r, 500));
      try {
        process.kill(pid, 0);
      } catch (e) {
        return; // Dead
      }
    }
    console.log(`[TaskController] Warning: Process ${pid} may still be alive after SIGKILL`);
  }

  /**
   * Find the checkpoint file with the highest lastIndex in the output directory.
   * Skips the excludePath file itself.
   */
  _findBestMonitorCheckpoint(excludePath) {
    const outputDir = path.join(__dirname, '../../output');
    if (!fs.existsSync(outputDir)) return null;

    let bestPath = null;
    let bestIndex = -1;

    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.checkpoint.json'));
    for (const file of files) {
      const fullPath = path.join(outputDir, file);
      if (fullPath === excludePath) continue;
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (typeof data.lastIndex === 'number' && data.lastIndex > bestIndex) {
          bestIndex = data.lastIndex;
          bestPath = fullPath;
        }
      } catch {
        // Skip invalid checkpoint files
      }
    }

    return bestPath;
  }

  _buildCommandArgs(config, taskId, stateFile) {
    const taskType = config.taskType || (config.mode === 'search' ? 'search+scrape' : 'scrape');
    const args = ['--ipc-mode', '--state-file', stateFile];

    // Use task-specific checkpoint file to avoid conflicts between tasks
    const checkpointFile = stateFile.replace('.state.json', '.checkpoint.json');
    args.push('--checkpoint', checkpointFile);

    // Monitor task types
    if (taskType.startsWith('monitor-')) {
      const scanType = taskType.replace('monitor-', ''); // scan, discover, import
      args.push('--scan-type', scanType);
      if (config.limit) args.push('--limit', String(config.limit));
      if (config.resume) args.push('--resume');
      if (config.source) args.push('--source', config.source);
      if (config.format) args.push('--format', config.format);
      if (config.city) args.push('--city', config.city);
      if (config.categories) args.push('--categories', config.categories);
      if (config.cellSize) args.push('--cell-size', String(config.cellSize));
      if (config.headless === false) args.push('--no-headless');
      return args;
    }

    if (taskType === 'search') {
      // Search-only: poi_search_ipc.js args
      args.push('--points', config.points);
      args.push('--categories', config.categories || 'config/categories.json');
      args.push('--output', config.output);
      if (config.searchZoom) args.push('--search-zoom', config.searchZoom);
      if (config.headless) args.push('--headless');
      if (config.start !== undefined && config.start !== null) {
        args.push('--start', String(config.start));
      }
      if (config.limit) args.push('--limit', String(config.limit));
      if (config.lang) args.push('--lang', config.lang);
      return args;
    }

    // scrape or search+scrape: gmaps_batch_scrape_ipc.js args
    if (taskType === 'search+scrape') {
      args.push('--search-mode');
      args.push('--points', config.points);
      args.push('--categories', config.categories || 'config/categories.json');
      if (config.searchZoom) args.push('--search-zoom', config.searchZoom);
    } else {
      args.push('--input', config.input);
    }

    args.push('--output', config.output);

    if (config.start !== undefined && config.start !== null) {
      args.push('--start', String(config.start));
    }
    if (config.limit) args.push('--limit', String(config.limit));
    if (config.headless) args.push('--headless');
    if (config.maxReviews) args.push('--max-reviews', String(config.maxReviews));
    if (config.maxScrolls) args.push('--max-scrolls', String(config.maxScrolls));
    if (config.noReviews) args.push('--no-reviews');
    if (config.reviewSort && config.reviewSort !== 'relevant') {
      args.push('--review-sort', config.reviewSort);
    }
    if (config.downloadImages) args.push('--download-images');
    if (config.imageOutput) args.push('--image-output', config.imageOutput);
    if (config.format) args.push('--format', config.format);
    if (config.useProxy) args.push('--use-proxy');
    if (config.proxyConfig) args.push('--proxy-config', config.proxyConfig);
    if (config.randomDelay) args.push('--random-delay');
    if (config.placeTimeout) args.push('--place-timeout', String(config.placeTimeout));

    return args;
  }

  _saveLog(taskId, level, message, data = null) {
    const entry = {
      task_id: taskId,
      timestamp: Date.now(),
      level,
      message,
      data: data ? JSON.stringify(data) : null
    };

    if (!this.logBuffers.has(taskId)) {
      this.logBuffers.set(taskId, []);
    }
    const buffer = this.logBuffers.get(taskId);
    buffer.push(entry);

    // Flush when buffer reaches 50 entries
    if (buffer.length >= 50) {
      this._flushLogBuffer(taskId);
    }
  }

  _flushLogBuffer(taskId) {
    const buffer = this.logBuffers.get(taskId);
    if (!buffer || buffer.length === 0) return;

    db.batchAppendLogs(taskId, buffer);
    this.logBuffers.set(taskId, []);
  }

  _flushAllLogBuffers() {
    for (const [taskId, buffer] of this.logBuffers) {
      if (buffer.length > 0) {
        this._flushLogBuffer(taskId);
      }
    }
  }

  async _watchdogCheck() {
    for (const [taskId, proc] of this.runningProcesses) {
      if (!proc.stateFile || !fs.existsSync(proc.stateFile)) continue;

      try {
        const state = JSON.parse(fs.readFileSync(proc.stateFile, 'utf8'));

        // Skip paused tasks
        if (state.status === 'paused') continue;

        const lastActivity = state.lastActivityAt || state.updatedAt || 0;
        const now = Date.now();
        const timeSinceActivity = now - lastActivity;
        const progressCurrent = state.progress?.current || 0;

        const lastKnown = this.lastKnownActivity.get(taskId);

        if (lastKnown && lastKnown.activityAt === lastActivity && lastKnown.current === progressCurrent) {
          // No progress since last check
          if (timeSinceActivity > WATCHDOG_STUCK_THRESHOLD) {
            const recoveryCount = this.watchdogRecoveryCount.get(taskId) || 0;

            if (recoveryCount >= WATCHDOG_MAX_AUTO_RECOVERIES) {
              console.log(`[Watchdog] Task ${taskId} stuck after ${recoveryCount} auto-recoveries, marking as failed`);
              this._forceKillTask(taskId);
              this.runningProcesses.delete(taskId);
              this.lastKnownActivity.delete(taskId);
              this.watchdogRecoveryCount.delete(taskId);

              db.prepare(`
                UPDATE tasks SET status = ?, completed_at = ?, error = ?
                WHERE task_id = ?
              `).run('failed', Date.now(), `Auto-recovery exhausted after ${recoveryCount} attempts (stuck for ${Math.round(timeSinceActivity / 60000)}m)`, taskId);
              WebSocketManager.emit(taskId, 'status', {
                status: 'failed',
                error: `Auto-recovery exhausted after ${recoveryCount} attempts`
              });
              continue;
            }

            const stuckMinutes = Math.round(timeSinceActivity / 60000);
            console.log(`[Watchdog] Task ${taskId} stuck for ${stuckMinutes}m, auto-recovering (attempt ${recoveryCount + 1}/${WATCHDOG_MAX_AUTO_RECOVERIES})`);
            this.watchdogRecoveryCount.set(taskId, recoveryCount + 1);

            // Kill the stuck process and wait for confirmed death
            const killPid = proc.pid || (proc.child && proc.child.pid);
            if (killPid) {
              await this._killProcessAndWait(killPid);
            }
            this.runningProcesses.delete(taskId);
            this.lastKnownActivity.delete(taskId);

            // Update status so resumeFromCheckpoint can proceed
            db.prepare(`
              UPDATE tasks SET status = ?, completed_at = ?, error = ?
              WHERE task_id = ?
            `).run('stopped', Date.now(), `Watchdog auto-recovery (stuck for ${stuckMinutes}m)`, taskId);

            // Resume from checkpoint
            try {
              await this.resumeFromCheckpoint(taskId);
              console.log(`[Watchdog] Successfully resumed task ${taskId}`);
              WebSocketManager.emit(taskId, 'log', {
                timestamp: Date.now(),
                level: 'warn',
                message: `Watchdog auto-recovery: process was stuck for ${stuckMinutes}m, resumed from checkpoint (attempt ${recoveryCount + 1}/${WATCHDOG_MAX_AUTO_RECOVERIES})`
              });
            } catch (err) {
              console.error(`[Watchdog] Failed to resume task ${taskId}:`, err.message);
              db.prepare(`
                UPDATE tasks SET status = ?, completed_at = ?, error = ?
                WHERE task_id = ?
              `).run('failed', Date.now(), `Watchdog resume failed: ${err.message}`, taskId);
              WebSocketManager.emit(taskId, 'status', {
                status: 'failed',
                error: `Watchdog resume failed: ${err.message}`
              });
            }
          }
        } else {
          // Progress is advancing - update tracking
          const prevKnown = this.lastKnownActivity.get(taskId);
          this.lastKnownActivity.set(taskId, {
            activityAt: lastActivity,
            current: progressCurrent
          });

          // Reset recovery count if progress actually advanced (not just activity timestamp)
          if (prevKnown && progressCurrent > prevKnown.current && this.watchdogRecoveryCount.has(taskId)) {
            this.watchdogRecoveryCount.set(taskId, 0);
          }
        }
      } catch (e) {
        // Ignore state file read errors
      }
    }
  }

  async recoverTasks() {
    const runningTasks = db.prepare(
      "SELECT * FROM tasks WHERE status IN ('running', 'paused')"
    ).all();

    for (const task of runningTasks) {
      let isAlive = false;
      if (task.pid) {
        try {
          process.kill(task.pid, 0);
          isAlive = true;
        } catch (e) {
          isAlive = false;
        }
      }

      if (isAlive) {
        this.runningProcesses.set(task.task_id, {
          child: null,
          stateFile: task.state_file,
          pid: task.pid
        });

        // Clear legacy baselines - output-as-truth should not use baseline accumulation
        if (task.progress_baseline || task.stats_baseline) {
          db.prepare(`
            UPDATE tasks SET stats_baseline = ?, progress_baseline = ?
            WHERE task_id = ?
          `).run(null, null, task.task_id);
        }

        this._startStateFilePolling(task.task_id, task.state_file, task.pid);
        console.log(`[TaskController] Recovered task ${task.task_id} (pid: ${task.pid})`);
      } else {
        db.prepare(`
          UPDATE tasks SET status = ?, completed_at = ?, error = ?
          WHERE task_id = ?
        `).run('failed', Date.now(), 'Process terminated unexpectedly', task.task_id);
        console.log(`[TaskController] Marked task ${task.task_id} as failed`);
      }
    }
  }

  _startStateFilePolling(taskId, stateFile, pid = null) {
    let pidCheckFailCount = 0;
    let lastLogTimestamp = 0; // Track last forwarded log to avoid duplicates
    const pollInterval = setInterval(() => {
      if (!fs.existsSync(stateFile)) {
        clearInterval(pollInterval);
        return;
      }

      // Check if the child process is still alive
      if (pid) {
        try {
          process.kill(pid, 0);
          pidCheckFailCount = 0; // Reset on success
        } catch (e) {
          pidCheckFailCount++;
          // Wait for 2 consecutive failures (4s) to avoid race conditions
          if (pidCheckFailCount >= 2) {
            clearInterval(pollInterval);
            this.runningProcesses.delete(taskId);
            // Read final state from file
            try {
              const finalState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
              const progress = finalState.progress || {};
              const isComplete = progress.total > 0 && progress.current >= progress.total;
              const status = isComplete ? 'completed' : 'stopped';
              const error = isComplete ? null : `Process died (${progress.current || 0}/${progress.total || '?'} completed)`;
              db.prepare(`
                UPDATE tasks SET status = ?, completed_at = ?, error = ?
                WHERE task_id = ?
              `).run(status, Date.now(), error, taskId);
              WebSocketManager.emit(taskId, 'status', { status, error });
              console.log(`[TaskController] Detected dead process for ${taskId} (pid: ${pid}), marked as ${status}`);
            } catch (readErr) {
              db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?')
                .run('failed', taskId);
              console.log(`[TaskController] Detected dead process for ${taskId}, marked as failed`);
            }
            return;
          }
        }
      }

      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

        // Update database with progress and stats (needed for Group API / task list)
        if (state.progress) {
          const pCurrent = state.progress.current || 0;
          const pTotal = state.progress.total || 0;

          db.prepare(`
            UPDATE tasks SET progress_current = ?, progress_total = ?, current_place = ?
            WHERE task_id = ?
          `).run(pCurrent, pTotal, state.currentPlace || null, taskId);

          WebSocketManager.emit(taskId, 'progress', {
            current: pCurrent,
            total: pTotal,
            percentage: pTotal > 0 ? Math.round((pCurrent / pTotal) * 100) : 0,
            currentPlace: state.currentPlace
          });
        }
        if (state.stats) {
          const accStats = { ...state.stats };

          db.prepare('UPDATE tasks SET stats = ? WHERE task_id = ?')
            .run(JSON.stringify(accStats), taskId);

          WebSocketManager.emit(taskId, 'stats', accStats);
        }

        // Forward new log entries from state file recentLogs
        if (Array.isArray(state.recentLogs)) {
          const newLogs = state.recentLogs.filter(l => l.timestamp > lastLogTimestamp);
          for (const log of newLogs) {
            this._saveLog(taskId, log.level, log.message, log.data);
            WebSocketManager.emit(taskId, 'log', log);
          }
          if (newLogs.length > 0) {
            lastLogTimestamp = newLogs[newLogs.length - 1].timestamp;
          }
        }

        if (['completed', 'failed', 'stopped'].includes(state.status)) {
          clearInterval(pollInterval);
          this.runningProcesses.delete(taskId);

          db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?')
            .run(state.status, taskId);
        }
      } catch (e) {
        console.error(`[TaskController] Failed to poll state file for ${taskId}:`, e);
      }
    }, 2000);
  }
}

module.exports = new TaskController();
