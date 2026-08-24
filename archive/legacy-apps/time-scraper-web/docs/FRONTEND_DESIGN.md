# 前端UI系统设计文档

## 一、系统架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (Frontend)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Instance #1 │  │ Instance #2 │  │ Instance #N │         │
│  │ Port 3001   │  │ Port 3002   │  │ Port 300N   │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
└─────────┼─────────────────┼─────────────────┼───────────────┘
          │                 │                 │
          │   WebSocket     │   WebSocket     │   WebSocket
          │   HTTP/REST     │   HTTP/REST     │   HTTP/REST
          │                 │                 │
┌─────────┼─────────────────┼─────────────────┼───────────────┐
│         ▼                 ▼                 ▼               │
│              Backend Server (Express.js)                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │            Task Manager (TaskController)            │   │
│  │  - Create Task   - Start/Pause/Stop                 │   │
│  │  - Monitor Task  - Resume Task                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  Scraper    │  │  Scraper    │  │  Scraper    │        │
│  │  Process #1 │  │  Process #2 │  │  Process #N │        │
│  │  (Child)    │  │  (Child)    │  │  (Child)    │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │       SQLite Database (Task Persistence)            │   │
│  │  - Tasks Table     - Logs Table                     │   │
│  │  - Progress Table  - Config Table                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 二、前端架构

### 2.1 目录结构

```
frontend/
├── src/
│   ├── components/
│   │   ├── shared/          # 共享组件
│   │   │   ├── Card.jsx
│   │   │   ├── Button.jsx
│   │   │   ├── Input.jsx
│   │   │   └── Toggle.jsx
│   │   ├── DataPrep/        # 数据准备模块
│   │   │   ├── CityGenerator.jsx
│   │   │   └── MapPreview.jsx
│   │   ├── Scraper/         # 抓取配置模块
│   │   │   ├── ModeSelector.jsx
│   │   │   ├── GeneralConfig.jsx
│   │   │   ├── ReviewConfig.jsx
│   │   │   └── OutputConfig.jsx
│   │   ├── Monitor/         # 监控模块
│   │   │   ├── TaskHeader.jsx
│   │   │   ├── StatsCards.jsx
│   │   │   ├── ProgressBar.jsx
│   │   │   └── LogConsole.jsx
│   │   └── TaskManager/     # 任务管理
│   │       ├── TaskList.jsx
│   │       └── InstanceSwitcher.jsx
│   ├── hooks/
│   │   ├── useWebSocket.js  # WebSocket连接管理
│   │   ├── useTask.js       # 任务状态管理
│   │   └── useConfig.js     # 配置管理
│   ├── services/
│   │   ├── api.js           # HTTP API调用
│   │   └── websocket.js     # WebSocket封装
│   ├── store/
│   │   ├── taskStore.js     # Zustand任务状态
│   │   └── configStore.js   # 配置状态
│   ├── utils/
│   │   ├── validators.js    # 参数验证
│   │   └── formatters.js    # 数据格式化
│   └── App.jsx
├── package.json
└── vite.config.js
```

### 2.2 核心Hook设计

#### useTask Hook
```javascript
// hooks/useTask.js
import { useEffect, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import api from '../services/api';

export function useTask(taskId) {
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const { connect, disconnect, subscribe } = useWebSocket();

  useEffect(() => {
    if (!taskId) return;

    // 1. 获取任务初始状态
    api.getTask(taskId).then(data => {
      setTask(data);
      setLoading(false);
    });

    // 2. 建立WebSocket连接接收实时更新
    connect(taskId);

    subscribe('progress', (data) => {
      setTask(prev => ({ ...prev, progress: data }));
    });

    subscribe('log', (data) => {
      setTask(prev => ({
        ...prev,
        logs: [...(prev.logs || []), data]
      }));
    });

    subscribe('status', (data) => {
      setTask(prev => ({ ...prev, status: data.status }));
    });

    return () => disconnect();
  }, [taskId]);

  const start = () => api.startTask(taskId);
  const pause = () => api.pauseTask(taskId);
  const stop = () => api.stopTask(taskId);

  return { task, loading, start, pause, stop };
}
```

#### useWebSocket Hook
```javascript
// hooks/useWebSocket.js
import { useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';

export function useWebSocket() {
  const socket = useRef(null);
  const listeners = useRef({});

  const connect = useCallback((taskId) => {
    if (socket.current?.connected) return;

    socket.current = io('http://localhost:3000', {
      query: { taskId },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10
    });

    socket.current.on('connect', () => {
      console.log('[WS] Connected to task:', taskId);
    });

    socket.current.on('disconnect', () => {
      console.log('[WS] Disconnected');
    });

    // 分发事件到订阅者
    socket.current.onAny((event, data) => {
      listeners.current[event]?.forEach(callback => callback(data));
    });
  }, []);

  const disconnect = useCallback(() => {
    socket.current?.disconnect();
    listeners.current = {};
  }, []);

  const subscribe = useCallback((event, callback) => {
    if (!listeners.current[event]) {
      listeners.current[event] = [];
    }
    listeners.current[event].push(callback);
  }, []);

  const emit = useCallback((event, data) => {
    socket.current?.emit(event, data);
  }, []);

  return { connect, disconnect, subscribe, emit };
}
```

### 2.3 关键功能实现

#### 任务列表与实例切换

```javascript
// components/TaskManager/InstanceSwitcher.jsx
import { useState, useEffect } from 'react';
import api from '../../services/api';

export function InstanceSwitcher({ onSwitch }) {
  const [instances, setInstances] = useState([]);
  const [currentInstance, setCurrentInstance] = useState(null);

  useEffect(() => {
    // 获取所有运行中的实例
    api.getRunningInstances().then(data => {
      setInstances(data);
      if (data.length > 0) {
        setCurrentInstance(data[0]);
      }
    });

    // 每5秒刷新实例列表
    const interval = setInterval(() => {
      api.getRunningInstances().then(setInstances);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const switchInstance = (instance) => {
    setCurrentInstance(instance);
    onSwitch(instance);
  };

  return (
    <div className="flex gap-2 overflow-x-auto">
      {instances.map(inst => (
        <button
          key={inst.taskId}
          onClick={() => switchInstance(inst)}
          className={`px-4 py-2 text-sm border ${
            currentInstance?.taskId === inst.taskId
              ? 'bg-zinc-100 text-zinc-950 border-zinc-100'
              : 'bg-zinc-900 text-zinc-400 border-zinc-800'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${
              inst.status === 'running' ? 'bg-green-500' : 'bg-yellow-500'
            }`} />
            <span className="font-mono">#{inst.taskId}</span>
          </div>
          <div className="text-xs mt-1">
            {inst.progress.current}/{inst.progress.total}
          </div>
        </button>
      ))}
    </div>
  );
}
```

#### 前端关闭时的后台运行提示

```javascript
// App.jsx
import { useEffect, useState } from 'react';

function App() {
  const [hasRunningTasks, setHasRunningTasks] = useState(false);
  const [showExitModal, setShowExitModal] = useState(false);

  useEffect(() => {
    // 检查是否有运行中的任务
    api.getRunningTasks().then(tasks => {
      setHasRunningTasks(tasks.length > 0);
    });

    // 监听页面关闭事件
    const handleBeforeUnload = (e) => {
      if (hasRunningTasks) {
        e.preventDefault();
        e.returnValue = '您有正在运行的任务,关闭页面后任务将继续在后台运行。';
        setShowExitModal(true);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasRunningTasks]);

  return (
    <div>
      {/* 主界面 */}

      {/* 退出确认模态框 */}
      {showExitModal && (
        <ExitConfirmModal
          onConfirm={() => {
            setShowExitModal(false);
            // 不做任何操作,任务继续后台运行
          }}
          onCancel={() => {
            setShowExitModal(false);
          }}
          taskCount={runningTasks.length}
        />
      )}
    </div>
  );
}

function ExitConfirmModal({ onConfirm, onCancel, taskCount }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-800 p-6 max-w-md">
        <h2 className="text-zinc-100 text-lg font-bold mb-4">
          检测到运行中的任务
        </h2>
        <p className="text-zinc-400 mb-6">
          您有 <span className="text-zinc-100 font-bold">{taskCount}</span> 个任务正在运行。
          关闭页面后,这些任务将继续在后台运行。
        </p>
        <div className="flex gap-4">
          <button
            onClick={onCancel}
            className="flex-1 bg-zinc-800 text-zinc-300 py-3 px-6"
          >
            留在页面
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 bg-zinc-100 text-zinc-950 py-3 px-6"
          >
            转后台运行
          </button>
        </div>
      </div>
    </div>
  );
}
```

## 三、后端架构

### 3.1 技术栈

- **Express.js** - HTTP服务器
- **Socket.IO** - WebSocket实时通信
- **SQLite** - 任务持久化存储
- **child_process** - 运行爬虫子进程

### 3.2 数据库Schema

```sql
-- tasks表 - 存储任务信息
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- 'pending', 'running', 'paused', 'completed', 'failed'
  config TEXT NOT NULL,          -- JSON配置
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  progress_current INTEGER DEFAULT 0,
  progress_total INTEGER DEFAULT 0,
  stats TEXT,                    -- JSON统计数据 {success, failed, reviews, images}
  error TEXT,
  pid INTEGER                    -- 子进程PID
);

-- logs表 - 存储任务日志
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  level TEXT NOT NULL,           -- 'info', 'error', 'warn', 'success'
  message TEXT NOT NULL,
  data TEXT,                     -- 额外JSON数据
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

-- checkpoints表 - 存储断点续传数据
CREATE TABLE checkpoints (
  task_id TEXT PRIMARY KEY,
  last_processed_index INTEGER NOT NULL,
  last_place_id TEXT,
  resume_data TEXT,              -- JSON恢复数据
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

-- shared_files表 - 共享文件索引
CREATE TABLE shared_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_type TEXT NOT NULL,       -- 'points', 'categories', 'input'
  file_path TEXT NOT NULL UNIQUE,
  file_hash TEXT,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
```

### 3.3 API接口设计

#### 3.3.1 任务管理

```javascript
// POST /api/tasks - 创建新任务
{
  "config": {
    "mode": "search",          // 'search' | 'traditional'
    "points": "data/hk/points.csv",
    "categories": "config/categories.json",
    "output": "output/results.ndjson",
    "maxReviews": 50,
    "downloadImages": true,
    // ... 其他配置
  }
}
Response: {
  "taskId": "task-20260124-143022",
  "status": "pending"
}

// GET /api/tasks - 获取所有任务
Response: [
  {
    "taskId": "task-20260124-143022",
    "status": "running",
    "progress": { "current": 325, "total": 500 },
    "createdAt": 1737712200000
  }
]

// GET /api/tasks/:taskId - 获取任务详情
Response: {
  "taskId": "task-20260124-143022",
  "status": "running",
  "config": { ... },
  "progress": {
    "current": 325,
    "total": 500,
    "percentage": 65
  },
  "stats": {
    "success": 312,
    "failed": 13,
    "reviews": 15600,
    "images": 2340
  },
  "currentPlace": "Starbucks Coffee - Marina Bay Sands",
  "logs": [...],
  "createdAt": 1737712200000,
  "startedAt": 1737712205000
}

// POST /api/tasks/:taskId/start - 启动任务
Response: { "success": true }

// POST /api/tasks/:taskId/pause - 暂停任务
Response: { "success": true }

// POST /api/tasks/:taskId/stop - 停止任务
Response: { "success": true }

// POST /api/tasks/:taskId/resume - 恢复任务
Response: { "success": true }

// DELETE /api/tasks/:taskId - 删除任务
Response: { "success": true }
```

#### 3.3.2 数据准备

```javascript
// POST /api/city-generator/generate - 生成城市数据
{
  "city": "Singapore",
  "output": "data/singapore",
  "cellSize": 1000,
  "iterations": 10,
  "bbox": null
}
Response: {
  "success": true,
  "files": {
    "boundary": "data/singapore/singapore_boundary.geojson",
    "points": "data/singapore/singapore_points.csv"
  },
  "stats": {
    "area": 725,
    "pointCount": 725
  }
}
```

#### 3.3.3 文件管理

```javascript
// GET /api/files/browse?path=data - 浏览文件
Response: {
  "currentPath": "data",
  "files": [
    { "name": "singapore", "type": "directory", "size": null },
    { "name": "hongkong", "type": "directory", "size": null }
  ]
}

// GET /api/files/shared - 获取共享文件列表
Response: [
  {
    "id": 1,
    "type": "points",
    "path": "data/hongkong/points.csv",
    "lastUsed": 1737712200000
  }
]

// GET /api/files/preview?path=... - 预览文件内容
Response: {
  "content": "...",
  "lines": 100
}
```

#### 3.3.4 实例管理

```javascript
// GET /api/instances - 获取所有运行实例
Response: [
  {
    "taskId": "task-001",
    "status": "running",
    "progress": { "current": 100, "total": 500 },
    "pid": 12345
  }
]
```

### 3.4 WebSocket事件

```javascript
// 客户端 -> 服务器
socket.emit('subscribe', { taskId: 'task-001' });
socket.emit('unsubscribe', { taskId: 'task-001' });

// 服务器 -> 客户端
socket.emit('progress', {
  current: 325,
  total: 500,
  percentage: 65,
  currentPlace: "Starbucks Coffee"
});

socket.emit('log', {
  timestamp: 1737712200000,
  level: 'info',
  message: 'Processing place...',
  data: { placeId: 'ChIJ...' }
});

socket.emit('status', {
  status: 'running' | 'paused' | 'completed' | 'failed'
});

socket.emit('stats', {
  success: 312,
  failed: 13,
  reviews: 15600,
  images: 2340
});
```

## 四、核心服务实现

### 4.1 TaskController

```javascript
// backend/controllers/TaskController.js
const { spawn } = require('child_process');
const db = require('../database');
const WebSocketManager = require('../services/WebSocketManager');

class TaskController {
  constructor() {
    this.runningProcesses = new Map(); // taskId -> childProcess
  }

  async createTask(config) {
    const taskId = `task-${Date.now()}`;

    await db.run(
      `INSERT INTO tasks (task_id, status, config, created_at)
       VALUES (?, ?, ?, ?)`,
      [taskId, 'pending', JSON.stringify(config), Date.now()]
    );

    return { taskId, status: 'pending' };
  }

  async startTask(taskId) {
    const task = await db.get('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
    if (!task) throw new Error('Task not found');

    const config = JSON.parse(task.config);

    // 构建命令行参数
    const args = this._buildCommandArgs(config);

    // 启动子进程
    const child = spawn('node', [
      'src/gmaps_batch_scrape_with_reviews.js',
      ...args
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.runningProcesses.set(taskId, child);

    // 监听输出
    child.stdout.on('data', (data) => {
      this._handleProcessOutput(taskId, data.toString());
    });

    child.stderr.on('data', (data) => {
      this._handleProcessError(taskId, data.toString());
    });

    child.on('exit', (code) => {
      this._handleProcessExit(taskId, code);
    });

    // 更新数据库
    await db.run(
      `UPDATE tasks SET status = ?, started_at = ?, pid = ?
       WHERE task_id = ?`,
      ['running', Date.now(), child.pid, taskId]
    );

    return { success: true };
  }

  async pauseTask(taskId) {
    const child = this.runningProcesses.get(taskId);
    if (child) {
      child.kill('SIGSTOP');
      await db.run(
        'UPDATE tasks SET status = ? WHERE task_id = ?',
        ['paused', taskId]
      );
      WebSocketManager.emit(taskId, 'status', { status: 'paused' });
    }
    return { success: true };
  }

  async stopTask(taskId) {
    const child = this.runningProcesses.get(taskId);
    if (child) {
      child.kill('SIGTERM');
      this.runningProcesses.delete(taskId);
      await db.run(
        'UPDATE tasks SET status = ?, completed_at = ? WHERE task_id = ?',
        ['stopped', Date.now(), taskId]
      );
      WebSocketManager.emit(taskId, 'status', { status: 'stopped' });
    }
    return { success: true };
  }

  _buildCommandArgs(config) {
    const args = [];

    if (config.mode === 'search') {
      args.push('--search-mode');
      args.push('--points', config.points);
      args.push('--categories', config.categories);
    } else {
      args.push('--input', config.input);
    }

    args.push('--output', config.output);

    if (config.limit) args.push('--limit', config.limit);
    if (config.headless) args.push('--headless');
    if (config.maxReviews) args.push('--max-reviews', config.maxReviews);
    if (config.downloadImages) args.push('--download-images');

    // ... 添加其他参数

    return args;
  }

  _handleProcessOutput(taskId, data) {
    // 解析进度信息
    const progressMatch = data.match(/Processing (\d+)\/(\d+)/);
    if (progressMatch) {
      const current = parseInt(progressMatch[1]);
      const total = parseInt(progressMatch[2]);

      db.run(
        'UPDATE tasks SET progress_current = ?, progress_total = ? WHERE task_id = ?',
        [current, total, taskId]
      );

      WebSocketManager.emit(taskId, 'progress', {
        current,
        total,
        percentage: Math.round((current / total) * 100)
      });
    }

    // 记录日志
    db.run(
      'INSERT INTO logs (task_id, timestamp, level, message) VALUES (?, ?, ?, ?)',
      [taskId, Date.now(), 'info', data]
    );

    WebSocketManager.emit(taskId, 'log', {
      timestamp: Date.now(),
      level: 'info',
      message: data
    });
  }

  _handleProcessError(taskId, data) {
    db.run(
      'INSERT INTO logs (task_id, timestamp, level, message) VALUES (?, ?, ?, ?)',
      [taskId, Date.now(), 'error', data]
    );

    WebSocketManager.emit(taskId, 'log', {
      timestamp: Date.now(),
      level: 'error',
      message: data
    });
  }

  _handleProcessExit(taskId, code) {
    this.runningProcesses.delete(taskId);

    const status = code === 0 ? 'completed' : 'failed';

    db.run(
      'UPDATE tasks SET status = ?, completed_at = ? WHERE task_id = ?',
      [status, Date.now(), taskId]
    );

    WebSocketManager.emit(taskId, 'status', { status });
  }
}

module.exports = new TaskController();
```

### 4.2 WebSocketManager

```javascript
// backend/services/WebSocketManager.js
class WebSocketManager {
  constructor() {
    this.io = null;
    this.taskSubscriptions = new Map(); // taskId -> Set<socketId>
  }

  initialize(io) {
    this.io = io;

    io.on('connection', (socket) => {
      console.log('Client connected:', socket.id);

      socket.on('subscribe', ({ taskId }) => {
        if (!this.taskSubscriptions.has(taskId)) {
          this.taskSubscriptions.set(taskId, new Set());
        }
        this.taskSubscriptions.get(taskId).add(socket.id);
        socket.join(`task-${taskId}`);
        console.log(`Socket ${socket.id} subscribed to task ${taskId}`);
      });

      socket.on('unsubscribe', ({ taskId }) => {
        const subs = this.taskSubscriptions.get(taskId);
        if (subs) {
          subs.delete(socket.id);
        }
        socket.leave(`task-${taskId}`);
      });

      socket.on('disconnect', () => {
        // 清理订阅
        for (const [taskId, subs] of this.taskSubscriptions.entries()) {
          subs.delete(socket.id);
        }
        console.log('Client disconnected:', socket.id);
      });
    });
  }

  emit(taskId, event, data) {
    if (this.io) {
      this.io.to(`task-${taskId}`).emit(event, data);
    }
  }

  broadcast(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }
}

module.exports = new WebSocketManager();
```

## 五、部署方案

### 5.1 Docker Compose配置

```yaml
version: '3.8'

services:
  backend:
    build: ./backend
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./output:/app/output
      - ./config:/app/config
      - ./db:/app/db
    environment:
      - NODE_ENV=production
      - DATABASE_PATH=/app/db/tasks.db

  frontend:
    build: ./frontend
    ports:
      - "5173:5173"
    depends_on:
      - backend
    environment:
      - VITE_API_URL=http://localhost:3000
      - VITE_WS_URL=ws://localhost:3000
```

### 5.2 进程管理 (PM2)

```json
{
  "apps": [
    {
      "name": "scraper-backend",
      "script": "backend/server.js",
      "instances": 1,
      "exec_mode": "fork",
      "env": {
        "NODE_ENV": "production",
        "PORT": 3000
      }
    }
  ]
}
```

## 六、关键特性实现细节

### 6.1 任务恢复机制

```javascript
// backend/services/TaskRecovery.js
class TaskRecovery {
  async recoverRunningTasks() {
    // 系统启动时恢复所有"运行中"的任务
    const runningTasks = await db.all(
      "SELECT * FROM tasks WHERE status = 'running'"
    );

    for (const task of runningTasks) {
      // 检查进程是否还在运行
      const isAlive = await this._checkProcessAlive(task.pid);

      if (isAlive) {
        // 重新建立监控
        TaskController._reattachToProcess(task.task_id, task.pid);
      } else {
        // 标记为失败
        await db.run(
          "UPDATE tasks SET status = 'failed' WHERE task_id = ?",
          [task.task_id]
        );
      }
    }
  }

  async _checkProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
```

### 6.2 多实例并行执行

前端支持同时监控多个任务实例,后端通过child_process管理多个独立的爬虫进程:

```javascript
// 用户可以在UI中启动多个任务
// 每个任务在独立的子进程中运行
// 通过taskId区分不同实例
// WebSocket房间机制确保消息正确路由

TaskController.runningProcesses:
  Map {
    'task-001' => ChildProcess,
    'task-002' => ChildProcess,
    'task-003' => ChildProcess
  }
```

### 6.3 配置持久化与共享

```javascript
// 保存配置模版
POST /api/config/save
{
  "name": "Singapore Full Scan",
  "config": { ... }
}

// 加载配置模版
GET /api/config/templates

// 不同任务可以引用相同的输入文件
// shared_files表记录文件使用情况
```

## 七、性能优化

1. **日志分页加载** - 避免加载所有日志
2. **WebSocket节流** - 限制日志推送频率(200ms)
3. **数据库索引** - task_id, status字段
4. **连接池** - SQLite连接复用
5. **前端虚拟滚动** - 日志列表使用react-window

## 八、安全考虑

1. **路径验证** - 防止目录遍历攻击
2. **参数校验** - 验证所有用户输入
3. **进程隔离** - 限制子进程权限
4. **WebSocket认证** - 实现基于token的认证
5. **文件访问控制** - 限制可访问目录

## 九、开发路线图

### Phase 1: 核心功能 (Week 1)
- ✅ 后端API框架
- ✅ 数据库设计
- ✅ 任务创建/启动/停止
- ✅ WebSocket实时通信

### Phase 2: 前端界面 (Week 2)
- ✅ 基础UI组件
- ✅ 配置表单
- ✅ 监控面板
- ✅ 实时日志

### Phase 3: 高级功能 (Week 3)
- ✅ 多实例管理
- ✅ 任务恢复
- ✅ 配置模版
- ✅ 文件浏览器

### Phase 4: 优化与测试 (Week 4)
- ✅ 性能优化
- ✅ 错误处理
- ✅ 集成测试
- ✅ 文档完善
