const express = require('express');
const router = express.Router();
const TaskController = require('../controllers/TaskController');
const MonitorDB = require('../services/MonitorDBService');

// GET /api/monitor/stats — Database statistics
router.get('/stats', (req, res) => {
  try {
    const stats = MonitorDB.getStats();
    if (!stats) {
      return res.json({ success: true, stats: null, message: 'Monitor database not initialized' });
    }
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/monitor/scans — Scan history list
router.get('/scans', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const scans = MonitorDB.getScans(limit);
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
    const result = MonitorDB.getChanges(page, limit);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/monitor/scan — Start change scan
router.post('/scan', async (req, res) => {
  try {
    const { limit, resume } = req.body || {};
    const config = {
      taskType: 'monitor-scan',
      limit: limit || undefined,
      resume: resume || false
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
    const { source, format } = req.body || {};
    if (!source) {
      return res.status(400).json({ success: false, message: 'source path is required' });
    }
    const config = {
      taskType: 'monitor-import',
      source,
      format: format || 'auto'
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
