const express = require('express');
const router = express.Router();
const TaskController = require('../controllers/TaskController');
const MonitorDB = require('../services/MonitorDBService');

// GET /api/monitor/stats — Database statistics
router.get('/stats', (req, res) => {
  try {
    const stats = MonitorDB.getStats(req.query.city);
    if (!stats) {
      return res.json({ success: true, stats: null, message: 'Monitor database not initialized' });
    }
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/meta — Monitor defaults and available cities
router.get('/meta', (req, res) => {
  try {
    const meta = MonitorDB.getMeta();
    res.json({ success: true, ...meta });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/scans — Scan history list
router.get('/scans', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const scans = MonitorDB.getScans(limit, req.query.city);
    res.json({ success: true, scans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/scans/:scanId — Scan detail + changes
router.get('/scans/:scanId', (req, res) => {
  try {
    const detail = MonitorDB.getScanDetail(req.params.scanId);
    if (!detail) {
      return res.status(404).json({ success: false, message: 'Scan not found' });
    }
    res.json({ success: true, scan: detail });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/changes — Recent changes (paginated)
router.get('/changes', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const result = MonitorDB.getChanges(page, limit, req.query.city);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/monitor/scan — Start change scan
router.post('/scan', async (req, res) => {
  try {
    const { limit, resume, city } = req.body || {};
    const config = {
      taskType: 'monitor-scan',
      limit: limit || undefined,
      resume: resume || false,
      city: city || undefined
    };
    const { taskId } = await TaskController.createTask(config);
    await TaskController.startTask(taskId);
    res.json({ success: true, taskId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/monitor/import — Start baseline import
router.post('/import', async (req, res) => {
  try {
    const { source, format, city } = req.body || {};
    if (!source) {
      return res.status(400).json({ success: false, message: 'source path is required' });
    }
    const config = {
      taskType: 'monitor-import',
      source,
      format: format || 'auto',
      city: city || undefined
    };
    const { taskId } = await TaskController.createTask(config);
    await TaskController.startTask(taskId);
    res.json({ success: true, taskId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/monitor/discover — Start POI discovery
router.post('/discover', async (req, res) => {
  try {
    const { city, categories, cellSize, limit } = req.body || {};
    const config = {
      taskType: 'monitor-discover',
      city: city || 'Singapore',
      categories: categories || undefined,
      cellSize: cellSize || 2000,
      limit: limit || undefined
    };
    const { taskId } = await TaskController.createTask(config);
    await TaskController.startTask(taskId);
    res.json({ success: true, taskId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/checkpoint — Get all available checkpoints from output directory
// Returns sorted by lastIndex descending (highest progress first)
router.get('/checkpoint', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const outputDir = path.join(__dirname, '../../output');
    if (!fs.existsSync(outputDir)) {
      return res.json({ success: true, checkpoint: null, checkpoints: [] });
    }

    const checkpoints = [];
    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.checkpoint.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf8'));
        if (typeof data.lastIndex === 'number') {
          checkpoints.push({ ...data, file });
        }
      } catch { /* skip */ }
    }

    // Sort by lastIndex descending (highest progress first)
    checkpoints.sort((a, b) => b.lastIndex - a.lastIndex);
    const best = checkpoints.length > 0 ? checkpoints[0] : null;

    res.json({ success: true, checkpoint: best, checkpoints });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/tasks — List monitor tasks with optional status filter
// Returns tasks whose config.taskType starts with 'monitor-', newest first.
router.get('/tasks', (req, res) => {
  try {
    const statusFilter = req.query.status ? req.query.status.split(',') : null;
    const limit = parseInt(req.query.limit) || 20;
    const db = require('../database');
    const allTasks = db.prepare("SELECT * FROM tasks").all();
    const monitorTasks = allTasks
      .filter(t => {
        try {
          const config = typeof t.config === 'string' ? JSON.parse(t.config) : t.config;
          if (!config.taskType || !config.taskType.startsWith('monitor-')) return false;
          if (statusFilter && !statusFilter.includes(t.status)) return false;
          return true;
        } catch { return false; }
      })
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, limit);
    res.json({ success: true, tasks: monitorTasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/monitor/tasks/:taskId/resume — Resume a stopped/failed monitor task from checkpoint
router.post('/tasks/:taskId/resume', async (req, res) => {
  try {
    const result = await TaskController.resumeFromCheckpoint(req.params.taskId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/monitor/tasks/:taskId/stop — Stop a running monitor task
router.post('/tasks/:taskId/stop', async (req, res) => {
  try {
    const result = await TaskController.stopTask(req.params.taskId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/report/:scanId — Get scan report JSON
router.get('/report/:scanId', (req, res) => {
  try {
    const report = MonitorDB.getReport(req.params.scanId);
    if (!report) {
      return res.status(404).json({ success: false, message: 'Scan not found' });
    }
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/report/:scanId/download — Download report as JSON file
router.get('/report/:scanId/download', (req, res) => {
  try {
    const report = MonitorDB.getReport(req.params.scanId);
    if (!report) {
      return res.status(404).json({ success: false, message: 'Scan not found' });
    }
    const filename = `change_report_${req.params.scanId}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(report, null, 2));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/report/:scanId/placeids — Download changed place IDs as text
router.get('/report/:scanId/placeids', (req, res) => {
  try {
    const placeIds = MonitorDB.getChangedPlaceIds(req.params.scanId);
    const filename = `changed_placeids_${req.params.scanId}.txt`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/plain');
    res.send(placeIds.join('\n') + (placeIds.length ? '\n' : ''));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
