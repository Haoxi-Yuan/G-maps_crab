const express = require('express');
const router = express.Router();
const TaskController = require('../controllers/TaskController');

router.get('/', async (req, res) => {
  try {
    const filters = {};
    if (req.query.status) {
      filters.status = req.query.status;
    }
    const tasks = TaskController.getTasks(filters);
    res.json({ success: true, tasks });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- Parallel splitting routes (must be before /:taskId) ---

router.post('/create-parallel', async (req, res) => {
  try {
    const { config, splitCount } = req.body;
    if (!config) {
      return res.status(400).json({ success: false, message: 'Config is required' });
    }
    if (!splitCount || splitCount < 2 || splitCount > 10) {
      return res.status(400).json({ success: false, message: 'splitCount must be between 2 and 10' });
    }
    const result = await TaskController.createParallelTasks(config, splitCount);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/start-parallel', async (req, res) => {
  try {
    const { taskIds } = req.body;
    if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ success: false, message: 'taskIds array is required' });
    }
    const result = await TaskController.startParallelTasks(taskIds);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/group/:groupId', async (req, res) => {
  try {
    const tasks = TaskController.getTasksByGroupId(req.params.groupId);
    res.json({ success: true, tasks });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/group/:groupId/stop', async (req, res) => {
  try {
    const tasks = TaskController.getTasksByGroupId(req.params.groupId);
    const results = [];
    for (const task of tasks) {
      if (['running', 'paused'].includes(task.status)) {
        try {
          await TaskController.stopTask(task.task_id);
          results.push({ taskId: task.task_id, stopped: true });
        } catch (err) {
          results.push({ taskId: task.task_id, stopped: false, error: err.message });
        }
      }
    }
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/group/:groupId', async (req, res) => {
  try {
    const tasks = TaskController.getTasksByGroupId(req.params.groupId);
    const results = [];
    for (const task of tasks) {
      try {
        await TaskController.deleteTask(task.task_id);
        results.push({ taskId: task.task_id, deleted: true });
      } catch (err) {
        results.push({ taskId: task.task_id, deleted: false, error: err.message });
      }
    }
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- End parallel splitting routes ---

router.get('/:taskId', async (req, res) => {
  try {
    const task = TaskController.getTask(req.params.taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    res.json({ success: true, task });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { config } = req.body;
    if (!config) {
      return res.status(400).json({ success: false, message: 'Config is required' });
    }
    const result = await TaskController.createTask(config);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:taskId/start', async (req, res) => {
  try {
    const result = await TaskController.startTask(req.params.taskId);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:taskId/pause', async (req, res) => {
  try {
    const result = await TaskController.pauseTask(req.params.taskId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:taskId/resume', async (req, res) => {
  try {
    const result = await TaskController.resumeTask(req.params.taskId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:taskId/stop', async (req, res) => {
  try {
    const result = await TaskController.stopTask(req.params.taskId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/:taskId', async (req, res) => {
  try {
    const result = await TaskController.deleteTask(req.params.taskId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:taskId/convert-to-json', async (req, res) => {
  try {
    const result = await TaskController.convertToJSON(req.params.taskId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:taskId/resume-from-checkpoint', async (req, res) => {
  try {
    const result = await TaskController.resumeFromCheckpoint(req.params.taskId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
