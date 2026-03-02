const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

router.get('/browse', async (req, res) => {
  try {
    const requestedPath = req.query.path || '';
    const basePath = path.join(__dirname, '../..');
    const fullPath = path.join(basePath, requestedPath);

    if (!fullPath.startsWith(basePath)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const stats = await fs.stat(fullPath);

    if (!stats.isDirectory()) {
      return res.status(400).json({ success: false, message: 'Path is not a directory' });
    }

    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const files = entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      path: path.join(requestedPath, entry.name)
    }));

    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/shared', async (req, res) => {
  try {
    const basePath = path.join(__dirname, '../..');
    const sharedDirs = ['data', 'output', 'config'];

    const files = [];

    for (const dir of sharedDirs) {
      const dirPath = path.join(basePath, dir);
      if (fsSync.existsSync(dirPath)) {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        entries.forEach(entry => {
          if (entry.isFile()) {
            files.push({
              name: entry.name,
              directory: dir,
              path: path.join(dir, entry.name)
            });
          }
        });
      }
    }

    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/preview', async (req, res) => {
  try {
    const requestedPath = req.query.path || '';
    const basePath = path.join(__dirname, '../..');
    const fullPath = path.join(basePath, requestedPath);

    if (!fullPath.startsWith(basePath)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const stats = await fs.stat(fullPath);

    if (!stats.isFile()) {
      return res.status(400).json({ success: false, message: 'Path is not a file' });
    }

    const content = await fs.readFile(fullPath, 'utf8');
    const lines = content.split('\n').slice(0, 100);

    res.json({
      success: true,
      preview: lines.join('\n'),
      size: stats.size,
      totalLines: content.split('\n').length
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Count items in an input file (for parallel splitting preview)
router.post('/count-items', async (req, res) => {
  try {
    const { filePath, mode } = req.body;
    if (!filePath) {
      return res.status(400).json({ success: false, message: 'filePath is required' });
    }

    const basePath = path.join(__dirname, '../..');
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(basePath, filePath);

    if (!fullPath.startsWith(basePath)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (!fsSync.existsSync(fullPath)) {
      return res.status(404).json({ success: false, message: 'File not found: ' + filePath });
    }

    const content = await fs.readFile(fullPath, 'utf8');
    let count = 0;

    if (mode === 'search') {
      // Count sampling points in CSV or JSON
      const ext = path.extname(fullPath).toLowerCase();
      if (ext === '.csv') {
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        // First line is header
        count = Math.max(0, lines.length - 1);
      } else {
        // JSON array of points
        const data = JSON.parse(content);
        count = Array.isArray(data) ? data.length : 0;
      }
    } else {
      // Count place_ids in JSON or text file
      const ext = path.extname(fullPath).toLowerCase();
      if (ext === '.json') {
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          count = data.length;
        } else if (data && typeof data === 'object') {
          count = 1;
        }
      } else {
        // Text file: one place_id per line
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        count = lines.length;
      }
    }

    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
