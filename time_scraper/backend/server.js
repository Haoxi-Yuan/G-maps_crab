const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');

const db = require('./database');
const WebSocketManager = require('./services/WebSocketManager');
const TaskController = require('./controllers/TaskController');

const tasksRouter = require('./routes/tasks');
const filesRouter = require('./routes/files');
const generatorRouter = require('./routes/generator');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use('/api/tasks', tasksRouter);
app.use('/api/files', filesRouter);
app.use('/api/generator', generatorRouter);

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: Date.now(),
    subscriptions: WebSocketManager.getAllSubscriptions()
  });
});

app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

WebSocketManager.initialize(server);

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log('='.repeat(60));
  console.log('  Google Maps Batch Scraper - Backend Server');
  console.log('='.repeat(60));
  console.log(`  Server running on: http://localhost:${PORT}`);
  console.log(`  API endpoint: http://localhost:${PORT}/api`);
  console.log(`  WebSocket ready for connections`);
  console.log('='.repeat(60));

  console.log('\n[Server] Recovering running tasks...');
  await TaskController.recoverTasks();
  console.log('[Server] Task recovery complete\n');
});

process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down gracefully...');
  db._flushSync();
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[Server] Received SIGTERM, shutting down gracefully...');
  db._flushSync();
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});
