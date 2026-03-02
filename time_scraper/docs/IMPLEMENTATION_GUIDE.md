# Google Maps Batch Scraper - 完整文档

**快速导航**: [用户使用指南](#用户使用指南) | [技术实现细节](#技术实现细节)

---

# 用户使用指南

## 快速开始

### 系统要求
- Node.js 16+
- 已安装依赖的爬虫脚本 `gmaps_batch_scrape_ipc.js`

### 方式一：使用启动脚本（推荐）

**一键启动所有服务**
```bash
./start.sh
```

该脚本会自动：
- 检查Node.js版本
- 安装后端和前端依赖（如果未安装）
- 检查端口占用情况
- 启动后端服务（端口3000）
- 启动前端服务（端口5173）
- 在后台运行并保存日志

**安全关闭服务**
```bash
./stop.sh
```

该脚本提供交互式选项：
- 停止所有服务（后端+前端+爬虫任务）
- 仅停止服务器（保留爬虫任务运行）
- 仅停止爬虫任务（保留服务器运行）

### 方式二：手动启动

**1. 安装后端依赖**
```bash
cd backend
npm install
```

**2. 安装前端依赖**
```bash
cd frontend
npm install
```

**3. 启动后端服务器**
```bash
cd backend
npm run dev
# 后端将在 http://localhost:3000 启动
```

**4. 启动前端界面**
```bash
cd frontend
npm run dev
# 前端将在 http://localhost:5173 启动
```

### 访问Web界面

打开浏览器访问: **http://localhost:5173**

---

## 功能概览

系统提供两个主要页面:

### Scraper Config (爬虫配置)
配置并启动新的爬取任务，支持并行分割模式

### Task Monitor (任务监控)
实时监控运行中的任务,查看进度和日志，支持并行任务组的聚合视图

---

## 使用教程

### 配置并启动任务

**1. 选择运行模式**

**Traditional Mode (传统模式)**
- 使用场景: 已知具体Place ID列表
- 输入文件: 文本文件,每行一个Place ID
- 示例: `data/places.txt`

**POI Search Mode (POI搜索模式)**
- 使用场景: 区域内全面搜索某类POI
- 需要文件:
  - 采样点文件 (CSV格式)
  - 类别配置文件 (JSON格式)
- 示例: `data/singapore_points.csv` + `config/categories.json`

**2. 基础配置**
- **Output File**: 结果输出路径 (如 `output/results.ndjson`)
- **Parallel Split**: 并行分割模式 (详见下方独立章节)
- **Limit**: 处理数量限制 (留空=处理全部)
- **Headless Mode**: 推荐开启,无头浏览器模式

**3. 内容提取选项**
- **Extract Reviews**: 提取评论
  - Max Reviews: 每个地点最多提取评论数 (默认 1000)
  - Max Scrolls: 最大滚动次数 (默认 1000)
- **Extract Images**: 提取图片URL
- **Download to Disk**: 下载图片到本地
  - Image Directory: 图片保存目录 (如 `output/images`)

**4. 输出格式**

系统使用 **NDJSON** (Newline-Delimited JSON) 格式输出结果：
- **优势**: 流式处理、内存占用低、支持增量读取
- **格式**: 每行一个完整的JSON对象
- **示例**:
  ```json
  {"placeId":"ChIJ123","name":"Location 1","rating":4.5}
  {"placeId":"ChIJ456","name":"Location 2","rating":4.8}
  ```

**转换为标准JSON**: 任务完成、暂停、失败或停止后，可在Monitor页面点击 "Convert to JSON" 按钮将NDJSON文件转换为标准JSON数组格式。

**5. 启动任务**

点击 "Start Scraping" 按钮:
- 系统自动创建任务
- 自动跳转到Monitor页面
- 开始实时监控

---

### 并行分割模式 (Parallel Split)

将输入数据拆分成多份，同时启动N个爬取进程并行处理。

**使用步骤**:

1. 选择输入文件（Traditional Mode 或 POI Search Mode）
2. 在 General Config 卡片中开启 **Parallel Split** 开关
3. 设置 **Split Into Parts** (2-10)
4. 系统自动显示:
   - 输入文件总条目数和每份大小
   - 自动生成的输出文件名预览（如 `output/places_001.ndjson, _002.ndjson, _003.ndjson`）
   - 如开启图片下载，自动生成的图片目录预览（如 `output/images/places/ {001, 002, 003}`）
5. Output File、Limit、Image Directory 输入框自动禁用（由系统自动管理）
6. 点击 **Start Scraping**，N个任务同时启动

**输出命名规则**:
- 输出文件: `output/{输入文件名}_{编号}.ndjson`（编号为 001, 002, ...）
- 图片目录: `output/images/{输入文件名}/{编号}/`（所有编号在同一父目录下）

**示例**:
- 输入: `data/coordinates_singapore.json`（300个place_id）
- 分割: 3份
- 输出文件: `output/coordinates_singapore_001.ndjson`, `_002.ndjson`, `_003.ndjson`
- 图片目录: `output/images/coordinates_singapore/001/`, `002/`, `003/`
- 每个进程处理约100个条目

**Monitor页面**:
- 并行任务组在Monitor页面顶部显示 **Group Overview Banner**
- 显示聚合进度条（所有部分的总进度）
- 显示聚合统计（总成功数、失败数、评论数、图片数）
- 每个部分显示为可点击的状态圆点（绿=运行, 黄=暂停, 蓝=完成, 红=失败）
- 点击圆点可切换到对应任务
- "Stop All" 按钮可一键停止所有部分

**注意事项**:
- 每个并行任务独立运行，如果一个失败不影响其他任务
- 每个任务有独立的 checkpoint 文件，可独立恢复
- 顶部实例切换器会将同一组的任务聚合显示

---

### 监控任务进度

进入 **Task Monitor** 页面后,您将看到:

**任务状态栏**
- **任务ID**: 唯一标识符 (如 `task-1737712345-abc123`)
- **状态指示器**:
  - 绿色 = Running/Starting (运行中/启动中)
  - 黄色 = Paused (已暂停)
  - 蓝色 = Completed (已完成)
  - 红色 = Failed (失败)
  - 灰色 = Stopped/Pending (已停止/待处理)
- **当前地点**: 正在处理的地点名称或POI搜索进度
- **进度条**: 实时百分比
- **ETA**: 预计剩余时间

**控制按钮**

根据任务状态显示不同按钮：
- **Pause**: 暂停任务 (可随时恢复) - 运行中时显示
- **Resume**: 恢复暂停的任务 - 暂停时显示
- **Stop**: 停止任务 (优雅退出,完成当前项) - 运行中/启动中/暂停时显示
- **Resume from Checkpoint**: 从上次保存的检查点恢复任务 - 停止/失败时显示
- **Convert to JSON**: 将NDJSON转换为JSON格式 - 暂停/完成/失败/停止时显示
- **Delete**: 删除任务记录 - 待处理/失败/完成/停止时显示

**统计卡片**

实时显示:
- **Success**: 成功处理的地点数
- **Failed**: 失败的地点数
- **Reviews**: 提取的评论总数
- **Images**: 提取的图片总数

**POI搜索模式特殊显示**

在POI搜索模式下，进度条会显示：
- 搜索进度：如 "Searching POIs: 1500/138100 (1.09%)"
- 当前搜索点：显示正在搜索的坐标点
- 搜索结果会增量保存（每50次搜索自动保存），防止数据丢失

**实时日志**
- 显示最新200条日志
- 按级别分类: INFO / SUCCESS / WARN / ERROR
- 自动滚动到最新

---

### 多任务管理

**顶部实例切换器** 显示所有运行中的任务:

- 显示每个任务的进度和状态
- 点击可快速切换监控视图
- 支持多个任务并行运行
- 同一并行组的任务会聚合显示（显示组标签和部分编号）

**示例工作流:**
1. 启动任务A (新加坡星巴克)
2. 切换回Config页面
3. 启动任务B (香港星巴克)
4. 使用顶部切换器在任务A和B之间切换查看

**并行分割工作流:**
1. 选择输入文件，开启Parallel Split，设为3份
2. 点击Start Scraping
3. 系统自动创建3个任务，同时启动
4. Monitor页面顶部显示组概览，可点击各部分切换查看
5. 顶部实例切换器将3个任务聚合在一个组内显示

---

### 后台运行

当您关闭浏览器时:

1. **自动检测**: 系统检测到运行中的任务
2. **弹出提示**: "检测到运行中的任务"对话框
3. **两个选项**:
   - **留在页面**: 继续监控
   - **转后台运行**: 关闭页面,任务继续执行

**重要**: 即使关闭浏览器,任务也会在服务器后台继续运行,重新打开页面可恢复监控。

---

### 从检查点恢复任务

系统自动保存任务进度到检查点文件,即使任务被完全停止或失败,也可以从上次位置继续执行。

**使用场景**:
1. 任务被意外停止（如服务器重启、进程崩溃）
2. 主动停止任务后想继续执行
3. 任务失败后修复问题并继续

**操作步骤**:

1. **找到停止或失败的任务**: 在Monitor页面查看状态为"stopped"或"failed"的任务
2. **点击Resume from Checkpoint按钮**: 系统会显示恢复确认对话框
3. **确认恢复**: 点击确认后,任务将从上次保存的检查点继续执行

**检查点保存机制**:
- 系统每处理一个地点后自动保存检查点
- 检查点文件位置: `output/{taskId}.checkpoint.json`
- 检查点内容包括: 最后处理的索引、Place ID、状态等

**示例**:

假设您有一个处理49323个地点的任务:
- 处理到第148个地点时服务器重启
- 使用 `./stop.sh` 选择"Stop ALL"完全关闭系统
- 重新启动系统: `./start.sh`
- 在Monitor页面找到该任务(状态显示为"stopped")
- 点击"Resume from Checkpoint"按钮
- 任务将从第149个地点继续执行,已处理的148个地点不会重复

**注意事项**:
- Resume from Checkpoint会创建一个新的进程继续执行
- 已处理的数据不会丢失,新数据会追加到原输出文件
- 检查点文件在任务完成后不会自动删除,可用于审计

---

## 实用示例

### 示例1: 爬取新加坡所有星巴克

**第一步: 准备输入文件**
```bash
# 假设已有采样点文件
data/singapore_points.csv
```

**第二步: 在Web界面配置**
- 模式: POI Search Mode
- Points File: `data/singapore_points.csv`
- Categories: `config/starbucks.json`
- Output: `output/singapore_starbucks.ndjson`
- Extract Reviews: 是 (Max: 100)
- Download Images: 是

**第三步: 启动任务**
- 点击 "Start Scraping"
- 自动跳转到Monitor页面

**第四步: 监控进度**
- 查看实时进度条
- 观察成功/失败统计
- 检查日志

**第五步: 完成后查看结果**
```bash
cat output/singapore_starbucks.ndjson | jq .
```

---

### 示例2: 并行运行多个任务

1. 启动任务A: 新加坡星巴克
2. 切换到Config页面
3. 启动任务B: 香港麦当劳
4. 使用顶部切换器查看不同任务
5. 关闭浏览器,两个任务继续后台运行
6. 稍后重新打开,恢复监控

---

### 示例3: 使用并行分割加速大数据集

**场景**: 需要爬取49000个place_id，使用5份并行分割加速

**第一步: 在Web界面配置**
- 模式: Traditional Mode
- Input File: `data/places_49k.json`
- 开启 **Parallel Split**
- Split Into Parts: `5`
- 系统自动显示: Total: 49000 items / ~9800 per part
- Extract Reviews: 是 (Max: 500)
- Download Images: 是

**第二步: 启动**
- 点击 "Start Scraping"
- 系统自动创建5个任务，每个处理约9800条
- 输出文件: `output/places_49k_001.ndjson` ~ `_005.ndjson`
- 图片目录: `output/images/places_49k/001/` ~ `005/`

**第三步: 监控**
- Monitor页面顶部显示组概览横幅
- 可看到5个部分的聚合进度（如 15000/49000 = 30%）
- 点击各部分的状态圆点切换查看单个任务详情

**第四步: 如某个部分失败**
- 其他部分继续正常运行
- 失败的部分可单独使用"Resume from Checkpoint"恢复

---

## API文档 (供开发者使用)

### REST API端点

```bash
# 健康检查
GET http://localhost:3000/api/health

# 获取所有任务
GET http://localhost:3000/api/tasks

# 获取运行中的任务
GET http://localhost:3000/api/tasks?status=running,paused

# 创建任务
POST http://localhost:3000/api/tasks
Content-Type: application/json
{
  "config": {
    "mode": "traditional",
    "input": "data/places.txt",
    "output": "output/results.ndjson",
    "headless": true,
    "maxReviews": 1000
  }
}

# 启动/暂停/停止任务
POST http://localhost:3000/api/tasks/{taskId}/start
POST http://localhost:3000/api/tasks/{taskId}/pause
POST http://localhost:3000/api/tasks/{taskId}/stop

# 并行分割 API
# 统计输入文件条目数
POST http://localhost:3000/api/files/count-items
Content-Type: application/json
{ "filePath": "data/places.txt", "mode": "traditional" }

# 创建并行任务组
POST http://localhost:3000/api/tasks/create-parallel
Content-Type: application/json
{ "config": { "mode": "traditional", "input": "data/places.txt", ... }, "splitCount": 3 }

# 批量启动并行任务
POST http://localhost:3000/api/tasks/start-parallel
Content-Type: application/json
{ "taskIds": ["task-xxx-001", "task-xxx-002", "task-xxx-003"] }

# 获取任务组
GET http://localhost:3000/api/tasks/group/{groupId}

# 停止整个任务组
POST http://localhost:3000/api/tasks/group/{groupId}/stop

# 删除整个任务组
DELETE http://localhost:3000/api/tasks/group/{groupId}
```

---

## 数据存储位置

- **任务数据**: `db/tasks.json`
- **日志数据**: `db/logs.json`
- **状态文件**: `output/{taskId}.state.json`
- **爬取结果**: `output/*.ndjson` 或 `output/*.json`
- **图片**: `output/images/`

---

## 常见问题

### 后端启动失败

**问题**: `Error: listen EADDRINUSE`

**原因**: 端口3000被占用

**解决**:
```bash
# 使用stop.sh脚本安全关闭
./stop.sh

# 或手动查找占用进程
lsof -i :3000
# 杀死进程
kill -9 <PID>
```

### 前端无法连接后端

**检查**:
1. 后端是否启动: `curl http://localhost:3000/api/health`
2. 查看浏览器控制台是否有错误
3. 检查后端日志: `logs/backend.log`
4. 检查前端日志: `logs/frontend.log`

### 任务无法启动

**检查**:
1. IPC脚本是否存在: `src/gmaps_batch_scrape_ipc.js`
2. 输入文件路径是否正确
3. 查看后端日志: `logs/backend.log`
4. 检查任务状态文件: `output/{taskId}.state.json`

### 任务卡在pending状态

**原因**: 任务创建后未启动，或启动进程失败

**解决**:
1. 检查后端日志查看错误信息
2. 在Monitor页面点击Delete按钮删除卡住的任务
3. 重新创建任务

### POI搜索结果丢失

**说明**: 系统已实现增量保存功能，每50次搜索自动保存一次结果

**检查**:
- 搜索结果文件：配置的输出路径（如 `output/search_results.json`）
- 增量保存确保即使任务失败，已搜索的结果也不会丢失

### Convert to JSON失败

**问题**: 点击"Convert to JSON"按钮后报错 "Output file does not exist"

**最常见原因** (已在2026-01-26修复):
后端进程从 `backend/` 目录启动，而 `config.output` 存储的是相对路径（如 `output/666.ndjson`），导致路径解析错误。修复方案是将相对路径解析为相对于项目根目录的绝对路径。

**其他可能原因**:
1. NDJSON文件确实不存在（任务尚未处理任何记录）
2. NDJSON文件为空
3. NDJSON文件格式有误
4. 磁盘空间不足

**解决**:
1. 确认任务已成功处理至少一条记录
2. 检查 `output/` 目录下是否存在对应的 `.ndjson` 文件
3. 查看后端日志获取详细错误信息
4. 确认有足够的磁盘空间

### WebSocket断开

**说明**: 系统会自动重连(最多10次)

**如果持续断开**: 检查网络连接和后端服务状态

### 任务中断后如何继续

**问题**: 任务运行到一半被停止或失败，如何继续执行？

**解决方案**: 使用"Resume from Checkpoint"功能

**步骤**:
1. 在Monitor页面找到状态为"stopped"或"failed"的任务
2. 点击"Resume from Checkpoint"按钮
3. 确认恢复对话框
4. 任务将从上次保存的位置继续执行

**注意**:
- 只有执行过的任务才有检查点文件
- 检查点文件位置: `output/{taskId}.checkpoint.json`
- 如果检查点文件不存在，需要创建新任务

### 完全关闭系统后任务能续跑吗

**问题**: 使用`./stop.sh`选择"Stop ALL"完全关闭系统后，任务还能继续吗？

**答案**: 可以！使用检查点恢复功能。

**操作流程**:
1. 完全关闭系统: `./stop.sh` → 选择选项1
2. 重新启动系统: `./start.sh`
3. 访问前端界面
4. 在Monitor页面找到被停止的任务
5. 点击"Resume from Checkpoint"按钮
6. 任务将从上次停止的位置继续执行

**已完成的数据**:
- 已爬取的数据保存在输出文件中（如`output/3333.ndjson`）
- 检查点文件记录了最后处理的位置
- 恢复后新数据会追加到原文件

---

## 获取帮助

- 技术实现细节: 查看本文档下方的"技术实现细节"部分
- 原始UI设计: [fronten/UI.jsx](../fronten/UI.jsx)
- 后端实现: [backend/](../backend/)
- 前端实现: [frontend/](../frontend/)

---

# 技术实现细节

## 一、基于现有UI.jsx的改进方案

### 改进点总结

基于您现有的 `/Volumes/Data/time_scraper/fronten/UI.jsx` 模版，我们将添加以下核心功能：

1. **任务持久化** - 使用后端数据库存储任务状态
2. **多实例管理** - 顶部添加实例切换器
3. **WebSocket实时通信** - 替代轮询，实时推送进度
4. **前端关闭提示** - 检测运行中任务，提示后台运行
5. **状态恢复** - 重新打开时自动恢复任务列表

### 保持不变的部分

✅ 现有的设计风格和色彩方案（zinc系列暗色主题）
✅ 三个主要Tab：Data Preparation, Scraper Config, Task Monitor
✅ 卡片式布局和组件结构
✅ 现有的UI组件（Card, Button, Input, Toggle等）

## 二、目录结构

```
time_scraper/
├── src/
│   ├── gmaps_batch_scrape_with_reviews.js  # 原始爬虫脚本
│   ├── gmaps_batch_scrape_ipc.js           # IPC版本爬虫脚本 (NEW)
│   ├── reviews_extractor_scroll.js
│   ├── review_image_downloader.js
│   ├── review_timestamp_parser.js
│   └── poi-searcher.js
│
├── frontend/                    # 前端（基于现有fronten/UI.jsx）
│   ├── src/
│   │   ├── components/
│   │   │   ├── shared/         # UI组件（从UI.jsx提取）
│   │   │   ├── InstanceSwitcher.jsx  # 新增：实例切换器（含并行组聚合）
│   │   │   ├── ExitModal.jsx         # 新增：退出确认框
│   │   │   └── ...
│   │   ├── hooks/
│   │   │   ├── useTask.js      # 新增：任务管理hook
│   │   │   └── useWebSocket.js # 新增：WebSocket hook
│   │   ├── services/
│   │   │   ├── api.js          # 新增：API调用封装
│   │   │   └── websocket.js    # 新增：WebSocket封装
│   │   └── App.jsx             # 基于UI.jsx改造
│   └── package.json
│
├── backend/                     # 后端API服务
│   ├── server.js               # Express服务器
│   ├── database.js             # SQLite数据库
│   ├── controllers/
│   │   └── TaskController.js   # 任务控制器（含并行分割）
│   ├── services/
│   │   └── WebSocketManager.js # WebSocket管理
│   └── routes/
│       ├── tasks.js            # 任务路由
│       ├── cityGenerator.js    # 城市生成路由
│       └── files.js            # 文件管理路由
│
└── db/                         # 数据库文件
    └── tasks.db                # SQLite数据库
```

## 二-A、IPC爬虫脚本说明

### gmaps_batch_scrape_ipc.js

这是 `gmaps_batch_scrape_with_reviews.js` 的IPC增强版本，专为前后端通信设计。

#### 新增参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--ipc-mode` | flag | false | 启用IPC模式，输出结构化JSON |
| `--state-file` | string | auto | 状态文件路径，自动生成如不指定 |

#### 使用示例

```bash
# 普通模式（和原脚本完全相同）
node src/gmaps_batch_scrape_ipc.js \
  --input data/places.json \
  --output output/results.ndjson \
  --headless

# IPC模式（供后端调用）
node src/gmaps_batch_scrape_ipc.js \
  --ipc-mode \
  --state-file output/task-001.state.json \
  --input data/places.json \
  --output output/results.ndjson \
  --headless
```

#### IPC消息格式

所有IPC消息通过stdout输出，格式为：`__IPC__{"type":"...", ...}`

**消息类型：**

```javascript
// 1. 进度更新
__IPC__{"type":"progress","timestamp":1737712200000,"current":10,"total":100,"percentage":10,"currentPlace":"ChIJxxx"}

// 2. 状态变化
__IPC__{"type":"status","timestamp":1737712200000,"status":"running"}
// status: 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'failed'

// 3. 日志消息
__IPC__{"type":"log","timestamp":1737712200000,"level":"info","message":"Processing place...","data":{"placeId":"ChIJxxx"}}
// level: 'info' | 'warn' | 'error' | 'success'

// 4. 统计更新
__IPC__{"type":"stats","timestamp":1737712200000,"success":50,"failed":2,"reviews":2500,"images":180}
```

#### 信号控制

| 信号 | 作用 | 示例 |
|------|------|------|
| `SIGTERM` | 优雅停止（完成当前项后退出） | `kill -TERM <pid>` |
| `SIGINT` | 立即停止 | `kill -INT <pid>` 或 `Ctrl+C` |
| `SIGUSR1` | 暂停/恢复切换 | `kill -USR1 <pid>` |

#### 状态文件格式

状态文件实时更新，可被外部程序读取：

```json
{
  "status": "running",
  "progress": {
    "current": 50,
    "total": 100,
    "percentage": 50
  },
  "stats": {
    "success": 48,
    "failed": 2,
    "reviews": 2400,
    "images": 150
  },
  "currentPlace": "ChIJxxx",
  "startedAt": 1737712200000,
  "error": null,
  "updatedAt": 1737712500000,
  "pid": 12345
}
```

## 三、前端改进方案

### 3.1 在现有UI.jsx基础上的修改

#### 步骤1：添加顶部实例切换器

在现有header下方添加实例切换栏：

```jsx
// 在现有的 <header> 和 <div className="border-b border-zinc-900"> 之间插入

<div className="border-b border-zinc-800 bg-zinc-950/50">
  <div className="max-w-7xl mx-auto px-6 py-3">
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-3">
        <span className="text-zinc-500 text-xs uppercase tracking-widest">Active Instances</span>
        <InstanceSwitcher
          instances={runningInstances}
          currentInstance={currentTaskId}
          onSwitch={setCurrentTaskId}
        />
      </div>
      <button
        onClick={createNewTask}
        className="text-xs text-zinc-400 hover:text-zinc-100 flex items-center gap-2"
      >
        <Plus className="w-4 h-4" />
        New Task
      </button>
    </div>
  </div>
</div>
```

#### 步骤2：修改MonitorView使用实时数据

```jsx
// 原来的 MonitorView 改为使用 useTask hook

const MonitorView = ({ taskId }) => {
  const { task, loading, start, pause, stop } = useTask(taskId);

  if (loading) return <div>Loading...</div>;
  if (!task) return <div>No task selected</div>;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* 使用task.progress替代硬编码数据 */}
      <div className="bg-zinc-900 border border-zinc-800 p-6 flex flex-col md:flex-row justify-between items-center gap-6">
        <div className="flex-1 w-full">
          <div className="flex justify-between items-end mb-2">
            <div>
              <h2 className="text-zinc-100 font-mono text-lg">{task.task_id}</h2>
              <div className="flex items-center mt-1 space-x-2">
                <span className={`w-2 h-2 rounded-full animate-pulse ${
                  task.status === 'running' ? 'bg-green-500' :
                  task.status === 'paused' ? 'bg-yellow-500' : 'bg-zinc-500'
                }`}></span>
                <span className="text-green-500 text-xs font-bold tracking-wider uppercase">
                  {task.status}
                </span>
                <span className="text-zinc-600 text-xs">|</span>
                <span className="text-zinc-400 text-xs">{task.current_place || 'Initializing...'}</span>
              </div>
            </div>
            <span className="text-zinc-100 font-mono text-xl">
              {task.progress?.percentage || 0}%
            </span>
          </div>
          <div className="w-full bg-zinc-800 h-1">
            <div
              className="bg-zinc-100 h-1 shadow-[0_0_10px_rgba(255,255,255,0.5)]"
              style={{ width: `${task.progress?.percentage || 0}%` }}
            ></div>
          </div>
          <div className="flex justify-between mt-2 text-xs font-mono text-zinc-500">
            <span>{task.progress?.current || 0} / {task.progress?.total || 0} Processed</span>
            <span>ETA: {formatETA(task.progress?.eta)}</span>
          </div>
        </div>

        <div className="flex gap-3">
          {task.status === 'running' && (
            <Button variant="secondary" icon={Pause} onClick={pause}>Pause</Button>
          )}
          {task.status === 'paused' && (
            <Button variant="primary" icon={Play} onClick={start}>Resume</Button>
          )}
          <Button variant="danger" icon={Square} onClick={stop}>Stop</Button>
        </div>
      </div>

      {/* Stats Cards - 使用真实数据 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card className="flex flex-col justify-between">
          <span className="text-zinc-500 text-xs uppercase tracking-wider">Success</span>
          <span className="text-zinc-100 text-3xl font-mono mt-2">
            {task.stats?.success || 0}
          </span>
        </Card>
        {/* ... 其他stats卡片 */}
      </div>

      {/* Console Log - 使用实时日志 */}
      <div className="bg-black border border-zinc-800 p-4 font-mono text-xs h-[400px] overflow-y-auto">
        {task.logs?.map((log, idx) => (
          <LogEntry key={idx} log={log} />
        ))}
      </div>
    </div>
  );
};
```

#### 步骤3：添加退出确认模态框

```jsx
// 在App组件中添加

function App() {
  const [runningTasks, setRunningTasks] = useState([]);
  const [showExitModal, setShowExitModal] = useState(false);

  useEffect(() => {
    // 检查运行中的任务
    api.getRunningTasks().then(tasks => {
      setRunningTasks(tasks);
    });

    const handleBeforeUnload = (e) => {
      if (runningTasks.length > 0) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [runningTasks]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300">
      {/* 现有UI内容 */}

      {/* 退出确认框 */}
      {showExitModal && (
        <ExitConfirmModal
          taskCount={runningTasks.length}
          onConfirm={() => {
            setShowExitModal(false);
            // 任务继续后台运行
          }}
          onCancel={() => setShowExitModal(false)}
        />
      )}
    </div>
  );
}
```

### 3.2 新增组件

#### InstanceSwitcher.jsx

```jsx
import React from 'react';
import { Layers } from 'lucide-react';

export function InstanceSwitcher({ instances, currentInstance, onSwitch }) {
  if (!instances || instances.length === 0) {
    return (
      <div className="text-zinc-600 text-xs italic">No active tasks</div>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto max-w-2xl">
      {instances.map(inst => {
        const isActive = currentInstance === inst.task_id;
        const statusColor =
          inst.status === 'running' ? 'bg-green-500' :
          inst.status === 'paused' ? 'bg-yellow-500' :
          'bg-zinc-500';

        return (
          <button
            key={inst.task_id}
            onClick={() => onSwitch(inst.task_id)}
            className={`
              group relative px-3 py-2 text-xs border transition-all
              ${isActive
                ? 'bg-zinc-800 border-zinc-100 text-zinc-100'
                : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-600'
              }
            `}
          >
            <div className="flex items-center gap-2 min-w-[120px]">
              <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
              <div className="flex-1 text-left">
                <div className="font-mono font-bold">
                  #{inst.task_id.slice(-8)}
                </div>
                <div className="text-[10px] text-zinc-600">
                  {inst.progress?.current || 0}/{inst.progress?.total || 0}
                </div>
              </div>
              <div className={`
                text-[10px] px-1.5 py-0.5 rounded
                ${isActive ? 'bg-zinc-700' : 'bg-zinc-900'}
              `}>
                {inst.progress?.percentage || 0}%
              </div>
            </div>

            {/* Hover tooltip */}
            <div className="
              absolute bottom-full left-1/2 -translate-x-1/2 mb-2
              px-3 py-2 bg-black border border-zinc-700 text-xs
              opacity-0 group-hover:opacity-100 transition-opacity
              pointer-events-none whitespace-nowrap z-10
            ">
              <div className="font-bold text-zinc-100">{inst.task_id}</div>
              <div className="text-zinc-500 mt-1">
                Created: {new Date(inst.created_at).toLocaleString()}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
```

#### ExitConfirmModal.jsx

```jsx
import React from 'react';
import { AlertTriangle, CheckCircle } from 'lucide-react';

export function ExitConfirmModal({ taskCount, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 animate-in fade-in">
      <div className="bg-zinc-900 border border-zinc-800 max-w-md w-full mx-4 animate-in slide-in-from-bottom-4">
        {/* Header */}
        <div className="border-b border-zinc-800 p-6 flex items-center gap-3">
          <AlertTriangle className="w-6 h-6 text-yellow-500" />
          <h2 className="text-zinc-100 text-lg font-bold tracking-wide">
            检测到运行中的任务
          </h2>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          <p className="text-zinc-400 leading-relaxed">
            您有 <span className="text-zinc-100 font-bold font-mono">{taskCount}</span> 个任务正在运行。
          </p>

          <div className="bg-zinc-950 border border-zinc-800 p-4 space-y-2">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-4 h-4 text-green-500 mt-0.5" />
              <div className="flex-1">
                <div className="text-zinc-200 text-sm font-medium">后台继续运行</div>
                <div className="text-zinc-500 text-xs mt-1">
                  关闭页面后，任务将继续在服务器后台执行
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <CheckCircle className="w-4 h-4 text-green-500 mt-0.5" />
              <div className="flex-1">
                <div className="text-zinc-200 text-sm font-medium">随时恢复监控</div>
                <div className="text-zinc-500 text-xs mt-1">
                  重新打开页面时，可以继续查看任务进度
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-800 p-6 flex gap-4">
          <button
            onClick={onCancel}
            className="flex-1 bg-zinc-800 text-zinc-300 py-3 px-6 text-sm font-bold uppercase tracking-widest hover:bg-zinc-700 transition-colors"
          >
            留在页面
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 bg-zinc-100 text-zinc-950 py-3 px-6 text-sm font-bold uppercase tracking-widest hover:bg-white transition-colors"
          >
            转后台运行
          </button>
        </div>
      </div>
    </div>
  );
}
```

## 四、核心Hook实现

### useTask.js

```javascript
import { useEffect, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import api from '../services/api';

export function useTask(taskId) {
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const { connect, disconnect, subscribe } = useWebSocket();

  useEffect(() => {
    if (!taskId) {
      setLoading(false);
      return;
    }

    // 1. 获取任务初始状态
    api.getTask(taskId)
      .then(data => {
        setTask(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load task:', err);
        setLoading(false);
      });

    // 2. 建立WebSocket连接
    connect(taskId);

    // 3. 订阅事件
    subscribe('progress', (data) => {
      setTask(prev => ({
        ...prev,
        progress: {
          ...prev.progress,
          ...data
        }
      }));
    });

    subscribe('log', (log) => {
      setTask(prev => ({
        ...prev,
        logs: [...(prev.logs || []).slice(-200), log] // 只保留最新200条
      }));
    });

    subscribe('status', (data) => {
      setTask(prev => ({
        ...prev,
        status: data.status,
        current_place: data.current_place
      }));
    });

    subscribe('stats', (data) => {
      setTask(prev => ({
        ...prev,
        stats: data
      }));
    });

    return () => {
      disconnect();
    };
  }, [taskId]);

  const start = async () => {
    try {
      await api.startTask(taskId);
    } catch (err) {
      console.error('Failed to start task:', err);
    }
  };

  const pause = async () => {
    try {
      await api.pauseTask(taskId);
    } catch (err) {
      console.error('Failed to pause task:', err);
    }
  };

  const stop = async () => {
    try {
      await api.stopTask(taskId);
    } catch (err) {
      console.error('Failed to stop task:', err);
    }
  };

  return { task, loading, start, pause, stop };
}
```

### useWebSocket.js

```javascript
import { useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';

const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3000';

export function useWebSocket() {
  const socket = useRef(null);
  const listeners = useRef({});
  const currentTaskId = useRef(null);

  const connect = useCallback((taskId) => {
    // 如果已连接且taskId相同，不重复连接
    if (socket.current?.connected && currentTaskId.current === taskId) {
      return;
    }

    // 断开旧连接
    if (socket.current) {
      socket.current.disconnect();
    }

    currentTaskId.current = taskId;

    socket.current = io(WS_URL, {
      query: { taskId },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10
    });

    socket.current.on('connect', () => {
      console.log('[WebSocket] Connected to task:', taskId);
      // 订阅任务
      socket.current.emit('subscribe', { taskId });
    });

    socket.current.on('disconnect', () => {
      console.log('[WebSocket] Disconnected');
    });

    socket.current.on('reconnect', () => {
      console.log('[WebSocket] Reconnected');
      socket.current.emit('subscribe', { taskId: currentTaskId.current });
    });

    // 分发所有事件到订阅者
    socket.current.onAny((event, data) => {
      const callbacks = listeners.current[event] || [];
      callbacks.forEach(callback => callback(data));
    });
  }, []);

  const disconnect = useCallback(() => {
    if (socket.current) {
      socket.current.emit('unsubscribe', { taskId: currentTaskId.current });
      socket.current.disconnect();
      socket.current = null;
    }
    listeners.current = {};
    currentTaskId.current = null;
  }, []);

  const subscribe = useCallback((event, callback) => {
    if (!listeners.current[event]) {
      listeners.current[event] = [];
    }
    listeners.current[event].push(callback);

    // 返回取消订阅函数
    return () => {
      listeners.current[event] = listeners.current[event].filter(
        cb => cb !== callback
      );
    };
  }, []);

  const emit = useCallback((event, data) => {
    if (socket.current?.connected) {
      socket.current.emit(event, data);
    }
  }, []);

  return { connect, disconnect, subscribe, emit };
}
```

### api.js

```javascript
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

async function request(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || 'Request failed');
  }

  return response.json();
}

export default {
  // 任务管理
  getTasks: () => request('/tasks'),
  getTask: (taskId) => request(`/tasks/${taskId}`),
  createTask: (config) => request('/tasks', {
    method: 'POST',
    body: JSON.stringify({ config })
  }),
  startTask: (taskId) => request(`/tasks/${taskId}/start`, { method: 'POST' }),
  pauseTask: (taskId) => request(`/tasks/${taskId}/pause`, { method: 'POST' }),
  stopTask: (taskId) => request(`/tasks/${taskId}/stop`, { method: 'POST' }),
  deleteTask: (taskId) => request(`/tasks/${taskId}`, { method: 'DELETE' }),

  // 获取运行中的任务
  getRunningTasks: () => request('/tasks?status=running,paused'),

  // 城市生成器
  generateCity: (config) => request('/city-generator/generate', {
    method: 'POST',
    body: JSON.stringify(config)
  }),

  // 文件管理
  browseFiles: (path) => request(`/files/browse?path=${encodeURIComponent(path)}`),
  getSharedFiles: () => request('/files/shared'),
  previewFile: (path) => request(`/files/preview?path=${encodeURIComponent(path)}`),

  // 并行分割 API
  countItems: (filePath, mode) => request('/files/count-items', {
    method: 'POST',
    body: JSON.stringify({ filePath, mode })
  }),
  createParallelTasks: (config, splitCount) => request('/tasks/create-parallel', {
    method: 'POST',
    body: JSON.stringify({ config, splitCount })
  }),
  startParallelTasks: (taskIds) => request('/tasks/start-parallel', {
    method: 'POST',
    body: JSON.stringify({ taskIds })
  }),
  getTaskGroup: (groupId) => request(`/tasks/group/${groupId}`),
  stopTaskGroup: (groupId) => request(`/tasks/group/${groupId}/stop`, {
    method: 'POST'
  }),
  deleteTaskGroup: (groupId) => request(`/tasks/group/${groupId}`, {
    method: 'DELETE'
  })
};
```

## 五、完整的App.jsx示例

```jsx
import React, { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { InstanceSwitcher } from './components/InstanceSwitcher';
import { ExitConfirmModal } from './components/ExitModal';
import { useTask } from './hooks/useTask';
import api from './services/api';

// 导入现有UI.jsx中的所有组件
import { DataPrepView, ScraperConfigView, MonitorView } from './components/Views';

export default function App() {
  const [activeTab, setActiveTab] = useState('config');
  const [runningInstances, setRunningInstances] = useState([]);
  const [currentTaskId, setCurrentTaskId] = useState(null);
  const [showExitModal, setShowExitModal] = useState(false);

  // 加载运行中的实例
  useEffect(() => {
    loadRunningInstances();

    // 每10秒刷新一次实例列表
    const interval = setInterval(loadRunningInstances, 10000);
    return () => clearInterval(interval);
  }, []);

  // 监听页面关闭
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (runningInstances.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [runningInstances]);

  async function loadRunningInstances() {
    try {
      const tasks = await api.getRunningTasks();
      setRunningInstances(tasks);

      // 如果没有选中的任务且有运行中的任务，选中第一个
      if (!currentTaskId && tasks.length > 0) {
        setCurrentTaskId(tasks[0].task_id);
      }
    } catch (error) {
      console.error('Failed to load instances:', error);
    }
  }

  async function handleStartTask(config) {
    try {
      const result = await api.createTask(config);
      await api.startTask(result.taskId);

      // 刷新实例列表并切换到新任务
      await loadRunningInstances();
      setCurrentTaskId(result.taskId);
      setActiveTab('monitor');
    } catch (error) {
      console.error('Failed to start task:', error);
      alert('启动任务失败: ' + error.message);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 font-sans selection:bg-zinc-700 selection:text-white">
      {/* Header - 保持UI.jsx原样 */}
      <header className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-zinc-100 flex items-center justify-center">
              <Globe className="w-5 h-5 text-zinc-950" />
            </div>
            <h1 className="text-zinc-100 font-bold tracking-tight text-lg">
              G-MAPS <span className="font-light text-zinc-500">BATCH SCRAPER</span>
            </h1>
          </div>
          <div className="flex items-center space-x-2">
            <span className={`h-2 w-2 rounded-full ${
              runningInstances.length > 0 ? 'bg-green-500 animate-pulse' : 'bg-zinc-500'
            }`}></span>
            <span className="text-xs text-zinc-500 uppercase tracking-widest">
              {runningInstances.length > 0 ? `${runningInstances.length} Running` : 'System Idle'}
            </span>
          </div>
        </div>
      </header>

      {/* Instance Switcher - 新增 */}
      {runningInstances.length > 0 && (
        <div className="border-b border-zinc-800 bg-zinc-950/50">
          <div className="max-w-7xl mx-auto px-6 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <span className="text-zinc-500 text-xs uppercase tracking-widest">Active Tasks</span>
                <InstanceSwitcher
                  instances={runningInstances}
                  currentInstance={currentTaskId}
                  onSwitch={setCurrentTaskId}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Navigation - 保持UI.jsx原样 */}
      <div className="border-b border-zinc-900 bg-zinc-950">
        {/* ... 导航标签 ... */}
      </div>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {activeTab === 'prep' && <DataPrepView />}
        {activeTab === 'config' && <ScraperConfigView onStart={handleStartTask} />}
        {activeTab === 'monitor' && <MonitorView taskId={currentTaskId} />}
      </main>

      {/* Exit Confirmation Modal */}
      {showExitModal && (
        <ExitConfirmModal
          taskCount={runningInstances.length}
          onConfirm={() => setShowExitModal(false)}
          onCancel={() => setShowExitModal(false)}
        />
      )}
    </div>
  );
}
```

## 六、后端TaskController实现

### 核心实现 - 使用IPC脚本

```javascript
// backend/controllers/TaskController.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const WebSocketManager = require('../services/WebSocketManager');

class TaskController {
  constructor() {
    this.runningProcesses = new Map(); // taskId -> { child, stateFile }
  }

  /**
   * 创建任务
   */
  async createTask(config) {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stateFile = path.join(__dirname, `../../output/${taskId}.state.json`);

    db.prepare(`
      INSERT INTO tasks (task_id, status, config, created_at, state_file)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, 'pending', JSON.stringify(config), Date.now(), stateFile);

    return { taskId, status: 'pending' };
  }

  /**
   * 启动任务
   */
  async startTask(taskId) {
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) throw new Error('Task not found');

    const config = JSON.parse(task.config);
    const stateFile = task.state_file;

    // 构建命令行参数
    const args = this._buildCommandArgs(config, taskId, stateFile);

    // 启动IPC版本的爬虫脚本
    const scriptPath = path.join(__dirname, '../../src/gmaps_batch_scrape_ipc.js');
    const child = spawn('node', [scriptPath, ...args], {
      cwd: path.join(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.runningProcesses.set(taskId, { child, stateFile });

    // 解析IPC消息
    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('__IPC__')) {
          try {
            const message = JSON.parse(line.slice(7));
            this._handleIPCMessage(taskId, message);
          } catch (e) {
            // 非IPC消息，忽略
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

    // 更新数据库
    db.prepare(`
      UPDATE tasks SET status = ?, started_at = ?, pid = ?
      WHERE task_id = ?
    `).run('running', Date.now(), child.pid, taskId);

    return { success: true, pid: child.pid };
  }

  /**
   * 暂停任务 (发送SIGUSR1信号)
   */
  async pauseTask(taskId) {
    const proc = this.runningProcesses.get(taskId);
    if (proc && proc.child) {
      proc.child.kill('SIGUSR1');
      // 状态更新由IPC消息处理
    }
    return { success: true };
  }

  /**
   * 恢复任务 (发送SIGUSR1信号)
   */
  async resumeTask(taskId) {
    return this.pauseTask(taskId); // 同样是SIGUSR1
  }

  /**
   * 停止任务 (发送SIGTERM信号)
   */
  async stopTask(taskId) {
    const proc = this.runningProcesses.get(taskId);
    if (proc && proc.child) {
      proc.child.kill('SIGTERM');
    }
    return { success: true };
  }

  /**
   * 获取任务状态 (从状态文件读取)
   */
  getTaskStatus(taskId) {
    const proc = this.runningProcesses.get(taskId);
    if (proc && proc.stateFile && fs.existsSync(proc.stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(proc.stateFile, 'utf8'));
        return state;
      } catch (e) {
        // 文件读取失败
      }
    }

    // 从数据库读取
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) return null;

    return {
      status: task.status,
      progress: {
        current: task.progress_current || 0,
        total: task.progress_total || 0,
        percentage: task.progress_total > 0
          ? Math.round((task.progress_current / task.progress_total) * 100)
          : 0
      },
      stats: task.stats ? JSON.parse(task.stats) : { success: 0, failed: 0, reviews: 0, images: 0 },
      error: task.error
    };
  }

  /**
   * 处理IPC消息
   */
  _handleIPCMessage(taskId, message) {
    const { type, ...data } = message;

    switch (type) {
      case 'progress':
        db.prepare(`
          UPDATE tasks SET progress_current = ?, progress_total = ?, current_place = ?
          WHERE task_id = ?
        `).run(data.current, data.total, data.currentPlace, taskId);

        WebSocketManager.emit(taskId, 'progress', data);
        break;

      case 'status':
        db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?')
          .run(data.status, taskId);

        WebSocketManager.emit(taskId, 'status', data);
        break;

      case 'stats':
        db.prepare('UPDATE tasks SET stats = ? WHERE task_id = ?')
          .run(JSON.stringify(data), taskId);

        WebSocketManager.emit(taskId, 'stats', data);
        break;

      case 'log':
        this._saveLog(taskId, data.level, data.message);
        WebSocketManager.emit(taskId, 'log', data);
        break;
    }
  }

  /**
   * 处理进程退出
   */
  _handleProcessExit(taskId, code) {
    this.runningProcesses.delete(taskId);

    const status = code === 0 ? 'completed' : 'failed';
    const error = code !== 0 ? `Process exited with code ${code}` : null;

    db.prepare(`
      UPDATE tasks SET status = ?, completed_at = ?, error = ?
      WHERE task_id = ?
    `).run(status, Date.now(), error, taskId);

    WebSocketManager.emit(taskId, 'status', { status, error });
  }

  /**
   * 构建命令行参数
   */
  _buildCommandArgs(config, taskId, stateFile) {
    const args = ['--ipc-mode', '--state-file', stateFile];

    if (config.mode === 'search') {
      args.push('--search-mode');
      args.push('--points', config.points);
      args.push('--categories', config.categories);
      if (config.searchZoom) args.push('--search-zoom', config.searchZoom);
    } else {
      args.push('--input', config.input);
    }

    args.push('--output', config.output);

    if (config.limit) args.push('--limit', String(config.limit));
    if (config.headless) args.push('--headless');
    if (config.maxReviews) args.push('--max-reviews', String(config.maxReviews));
    if (config.maxScrolls) args.push('--max-scrolls', String(config.maxScrolls));
    if (config.noReviews) args.push('--no-reviews');
    if (config.downloadImages) args.push('--download-images');
    if (config.imageOutput) args.push('--image-output', config.imageOutput);
    if (config.format) args.push('--format', config.format);
    if (config.useProxy) args.push('--use-proxy');
    if (config.proxyConfig) args.push('--proxy-config', config.proxyConfig);
    if (config.randomDelay) args.push('--random-delay');

    return args;
  }

  /**
   * 保存日志到数据库
   */
  _saveLog(taskId, level, message) {
    db.prepare(`
      INSERT INTO logs (task_id, timestamp, level, message)
      VALUES (?, ?, ?, ?)
    `).run(taskId, Date.now(), level, message);
  }

  /**
   * 恢复运行中的任务 (服务器重启时调用)
   */
  async recoverTasks() {
    const runningTasks = db.prepare(
      "SELECT * FROM tasks WHERE status IN ('running', 'paused')"
    ).all();

    for (const task of runningTasks) {
      // 检查进程是否存活
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
        // 进程存活，通过状态文件监控
        this.runningProcesses.set(task.task_id, {
          child: null, // 无法重新attach
          stateFile: task.state_file
        });

        // 启动状态文件轮询
        this._startStateFilePolling(task.task_id, task.state_file);
      } else {
        // 进程已死，标记为失败
        db.prepare(`
          UPDATE tasks SET status = 'failed', error = ?
          WHERE task_id = ?
        `).run('Process terminated unexpectedly', task.task_id);
      }
    }
  }

  /**
   * 轮询状态文件 (用于进程无法重新attach的情况)
   */
  _startStateFilePolling(taskId, stateFile) {
    const pollInterval = setInterval(() => {
      if (!fs.existsSync(stateFile)) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

        // 推送状态到WebSocket
        WebSocketManager.emit(taskId, 'progress', state.progress);
        WebSocketManager.emit(taskId, 'stats', state.stats);

        // 检查是否完成
        if (['completed', 'failed', 'stopped'].includes(state.status)) {
          clearInterval(pollInterval);
          this.runningProcesses.delete(taskId);

          db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?')
            .run(state.status, taskId);
        }
      } catch (e) {
        // 忽略读取错误
      }
    }, 2000); // 每2秒轮询
  }
}

module.exports = new TaskController();
```

## 七、快速开始

### 安装依赖

```bash
# 后端
cd backend
npm install

# 前端
cd ../frontend
npm install
```

### 启动服务

```bash
# 终端1: 启动后端
cd backend
npm run dev

# 终端2: 启动前端
cd frontend
npm run dev
```

### 访问

打开浏览器访问: http://localhost:5173

## 八、关键特性验证清单

### IPC爬虫脚本测试

- [ ] `--ipc-mode` 输出格式正确（`__IPC__` 前缀）
- [ ] `--state-file` 状态文件正确生成和更新
- [ ] `SIGTERM` 信号正确触发优雅停止
- [ ] `SIGUSR1` 信号正确切换暂停/恢复
- [ ] 状态文件包含完整的进度和统计信息

### 后端功能测试

- [ ] 创建任务API正常工作
- [ ] 启动任务正确调用IPC脚本
- [ ] IPC消息正确解析并推送到WebSocket
- [ ] 暂停/恢复/停止API正常工作
- [ ] 任务状态正确持久化到数据库
- [ ] 服务器重启后正确恢复运行中的任务

### 前端功能测试

- [ ] 创建新任务后可以在实例切换器中看到
- [ ] 切换实例后Monitor页面显示对应任务数据
- [ ] 实时日志正常推送
- [ ] 进度条实时更新
- [ ] 暂停/恢复/停止按钮功能正常
- [ ] 关闭页面时弹出确认框
- [ ] 重新打开页面时恢复任务列表

### 多实例测试

- [ ] 多个任务可以并行运行
- [ ] 不同任务的日志和进度互不干扰
- [ ] 前端关闭后后端任务继续执行
- [ ] 共享输入文件不产生冲突

### 并行分割测试

- [ ] `POST /files/count-items` 正确统计各类型输入文件的条目数
- [ ] `POST /tasks/create-parallel` 正确创建N个分割任务（start/limit/output/imageOutput正确计算）
- [ ] `POST /tasks/start-parallel` 正确同时启动所有任务
- [ ] `GET /tasks/group/:groupId` 返回同一组的所有任务
- [ ] 前端ScraperConfigView中Parallel Split开关正确禁用Output File/Limit/Image Directory
- [ ] 前端正确显示输出文件名和图片目录的自动预览
- [ ] MonitorView正确显示组概览横幅和聚合统计
- [ ] 实例切换器正确将同组任务聚合显示
- [ ] 搜索模式(POI Search)的并行分割正确切割采样点
- [ ] 单个任务失败不影响其他任务继续运行
- [ ] "Stop All"按钮正确停止组内所有运行中的任务

## 九、故障排除

### IPC消息未收到

1. 检查脚本是否使用 `--ipc-mode` 参数启动
2. 检查stdout是否被正确pipe到后端
3. 查看stderr是否有错误输出

### 信号控制不工作

1. Windows不支持SIGUSR1，暂停功能在Windows上不可用
2. 检查进程PID是否正确
3. 使用 `ps aux | grep gmaps` 确认进程存在

### 状态文件不更新

1. 检查文件路径是否正确
2. 检查磁盘空间
3. 确认进程有写入权限

### WebSocket连接断开

1. 检查后端服务是否运行
2. 检查防火墙/代理设置
3. 查看浏览器控制台错误

---

## 十、系统改进与新增功能

本章节记录了系统在开发过程中实现的重要改进和新增功能。

### 10.1 启动和关闭脚本

为了简化系统的启动和关闭流程，我们提供了两个Shell脚本：

#### start.sh - 一键启动脚本

**功能特性**:
- 自动检查Node.js版本
- 检测并安装缺失的依赖（后端和前端）
- 验证端口可用性（3000和5173）
- 后台启动服务并保存PID
- 生成日志文件（`logs/backend.log`, `logs/frontend.log`）

**使用方法**:
```bash
chmod +x start.sh
./start.sh
```

**脚本流程**:
1. 检查Node.js是否安装（要求16+）
2. 检查`backend/node_modules`，如不存在则运行`npm install`
3. 检查`frontend/node_modules`，如不存在则运行`npm install`
4. 创建必要目录（db, output, data, config）
5. 检查端口3000和5173是否被占用
6. 使用`nohup`后台启动后端和前端服务
7. 将PID保存到`logs/backend.pid`和`logs/frontend.pid`

#### stop.sh - 安全关闭脚本

**功能特性**:
- 检测运行中的后端、前端和爬虫任务
- 提供交互式选项菜单
- 优雅关闭（SIGTERM）+ 强制关闭（SIGKILL）后备方案
- 自动清理PID文件

**使用方法**:
```bash
chmod +x stop.sh
./stop.sh
```

**交互选项**:
1. **Stop ALL**: 关闭后端 + 前端 + 所有爬虫任务
2. **Stop servers only**: 仅关闭后端和前端，保留爬虫��务继续运行
3. **Stop scrapers only**: 仅关闭爬虫任务，保留服务器运行
4. **Cancel**: 取消操作

**关闭流程**:
1. 发送SIGTERM信号
2. 等待最多10秒让进程优雅退出
3. 如果进程仍在运行，发送SIGKILL强制关闭
4. 删除对应的PID文件
5. 显示剩余运行的进程（如果有）

### 10.2 NDJSON输出格式与JSON转换

#### 为什么使用NDJSON

**NDJSON优势**:
- **流式处理**: 可以边生成边写入，无需等待全部完成
- **内存效率**: 每次只处理一行，内存占用极低
- **容错性强**: 某行数据损坏不影响其他行
- **支持增量读取**: 可以实时读取部分结果
- **更适合大规模数据**: 处理数万条记录时表现更好

**JSON劣势**（在爬虫场景）:
- **内存占用高**: 需要在内存中维护整个数组
- **写入延迟**: 必须等到任务完成才能写入
- **任务失败风险**: 如果进程崩溃，所有数据丢失

#### Convert to JSON功能

**实现位置**:
- 后端API: `POST /api/tasks/{taskId}/convert-to-json`
- 前端按钮: Monitor页面，任务状态为paused/completed/failed/stopped时显示

**转换逻辑** (`backend/controllers/TaskController.js`):
```javascript
async convertToJSON(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  const config = JSON.parse(task.config);
  const ndjsonFile = config.output;

  // 生成JSON文件路径
  const jsonFile = ndjsonFile.replace(/\.ndjson$/, '.json');

  // 读取NDJSON，转换为JSON数组
  const lines = fs.readFileSync(ndjsonFile, 'utf8')
    .split('\n')
    .filter(line => line.trim());

  const results = lines.map(line => JSON.parse(line));

  // 写入JSON文件
  fs.writeFileSync(jsonFile, JSON.stringify(results, null, 2));

  return { success: true, outputFile: jsonFile, count: results.length };
}
```

**前端调用** (`frontend/src/components/views/MonitorView.jsx`):
```javascript
const convertToJSON = async () => {
  try {
    const result = await api.convertToJSON(task.task_id);
    alert(`Successfully converted to JSON\nOutput: ${result.outputFile}`);
  } catch (err) {
    alert(`Failed to convert: ${err.message}`);
  }
};

// 按钮显示条件
{['paused', 'completed', 'failed', 'stopped'].includes(task.status) && (
  <Button variant="secondary" onClick={convertToJSON}>Convert to JSON</Button>
)}
```

### 10.3 POI搜索增量保存

#### 问题背景

POI搜索模式可能需要进行数万甚至数十万次搜索（例如：2762个采样点 × 50个类别 = 138,100次搜索）。如果所有结果都保存在内存中，当任务失败时会导致所有数据丢失。

#### 解决方案：增量保存

**实现位置**: `src/poi-searcher.js` 的 `batchSearchPOIs` 函数

**新增参数**:
```javascript
async function batchSearchPOIs(points, categories, options = {}) {
  const {
    incrementalSaveFile,  // 增量保存文件路径
    saveInterval = 50,    // 保存间隔（默认50次搜索）
    progressCallback,     // 进度回调函数
    // ...其他参数
  } = options;
}
```

**保存逻辑**:
```javascript
let searchCount = 0;
const totalSearches = points.length * categories.length;

for (const point of points) {
  for (const category of categories) {
    // 执行搜索
    const placeIds = await searchNearby(point, category);
    allPlaceIds.add(...placeIds);

    searchCount++;

    // 触发进度回调
    if (progressCallback) {
      progressCallback(searchCount, totalSearches, `${point.lat},${point.lng}`);
    }

    // 增量保存：每50次搜索保存一次
    if (incrementalSaveFile && searchCount % saveInterval === 0) {
      const partialResults = {
        timestamp: new Date().toISOString(),
        progress: {
          searchCount,
          totalSearches,
          percentage: ((searchCount / totalSearches) * 100).toFixed(2)
        },
        totalPlaceIds: allPlaceIds.size,
        uniquePlaceIds: Array.from(allPlaceIds),
        results: results.slice()
      };

      fs.writeFileSync(incrementalSaveFile, JSON.stringify(partialResults, null, 2));
    }
  }
}

// 最终保存
if (incrementalSaveFile) {
  fs.writeFileSync(incrementalSaveFile, JSON.stringify(finalResults, null, 2));
}
```

**调用方式** (`src/gmaps_batch_scrape_ipc.js`):
```javascript
const searchOptions = {
  incrementalSaveFile: opts.searchResultsFile,
  saveInterval: 50,
  progressCallback: (current, total, currentPlace) => {
    ipcProgress(current, total, `Searching: ${currentPlace}`);
  }
};

const searchResults = await batchSearchPOIs(points, categories, searchOptions);
```

**增量保存文件格式**:
```json
{
  "timestamp": "2026-01-24T10:30:00.000Z",
  "progress": {
    "searchCount": 1500,
    "totalSearches": 138100,
    "percentage": "1.09"
  },
  "totalPlaceIds": 42387,
  "uniquePlaceIds": ["ChIJ123...", "ChIJ456...", ...],
  "results": [...]
}
```

**优势**:
- 每50次搜索自动保存，防止数据丢失
- 任务失败后可以查看已搜索的结果
- 支持实时监控搜索进度
- 对性能影响极小（文件写入仅占总时间<1%）

### 10.4 任务删除功能增强

#### 原始限制

最初版本只允许删除已完成或失败的任务，pending（待处理）和stuck（卡住）的任务无法删除。

#### 改进后的删除逻辑

**前端按钮显示条件** (`frontend/src/components/views/MonitorView.jsx`):
```javascript
{['pending', 'failed', 'completed', 'stopped'].includes(task.status) && (
  <Button variant="danger" onClick={deleteTask}>Delete</Button>
)}
```

**允许删除的状态**:
- `pending`: 任务创建但未启动
- `failed`: 任务执行失败
- `completed`: 任务已完成
- `stopped`: 任务被停止

**不允许删除的状态**:
- `starting`: 正在启动
- `running`: 正在运行
- `paused`: 已暂停

**后端删除API** (`backend/controllers/TaskController.js`):
```javascript
async deleteTask(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);

  if (!task) {
    throw new Error('Task not found');
  }

  // 不允许删除运行中的任务
  if (['starting', 'running', 'paused'].includes(task.status)) {
    throw new Error('Cannot delete active tasks. Please stop the task first.');
  }

  // 删除数据库记录
  db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM logs WHERE task_id = ?').run(taskId);

  // 删除状态文件（如果存在）
  if (task.state_file && fs.existsSync(task.state_file)) {
    fs.unlinkSync(task.state_file);
  }

  return { success: true };
}
```

**前端确认对话框**:
```javascript
const deleteTask = async () => {
  if (!confirm('Are you sure you want to delete this task?\n\nThis will remove the task record and state file, but will NOT delete the output files.')) {
    return;
  }

  try {
    await api.deleteTask(task.task_id);
    alert('Task deleted successfully');
    // 跳转到Config页面或刷新任务列表
  } catch (err) {
    alert(`Failed to delete task: ${err.message}`);
  }
};
```

### 10.5 按钮显示逻辑优化

#### Starting状态支持

在任务启动过程中，状态为`starting`，此时应该显示Stop按钮允许用户取消启动。

**更新后的按钮逻辑**:
```javascript
// Stop按钮：运行中、启动中、暂停时都显示
{(task.status === 'starting' || task.status === 'running' || task.status === 'paused') && (
  <Button variant="danger" icon={Square} onClick={stop}>Stop</Button>
)}

// Pause按钮：仅运行中时显示
{task.status === 'running' && (
  <Button variant="secondary" icon={Pause} onClick={pause}>Pause</Button>
)}

// Resume按钮：仅暂停时显示
{task.status === 'paused' && (
  <Button variant="primary" icon={Play} onClick={start}>Resume</Button>
)}

// Convert to JSON按钮：暂停、完成、失败、停止时显示
{['paused', 'completed', 'failed', 'stopped'].includes(task.status) && (
  <Button variant="secondary" onClick={convertToJSON}>Convert to JSON</Button>
)}

// Delete按钮：待处理、失败、完成、停止时显示
{['pending', 'failed', 'completed', 'stopped'].includes(task.status) && (
  <Button variant="danger" onClick={deleteTask}>Delete</Button>
)}
```

#### 状态完整列表

| 状态 | 说明 | 可用按钮 |
|------|------|---------|
| `pending` | 任务已创建，未启动 | Delete |
| `starting` | 任务正在启动 | Stop |
| `running` | 任务运行中 | Pause, Stop |
| `paused` | 任务已暂停 | Resume, Stop, Convert to JSON |
| `completed` | 任务已完成 | Convert to JSON, Delete |
| `failed` | 任务执行失败 | Resume from Checkpoint, Convert to JSON, Delete |
| `stopped` | 任务被停止 | Resume from Checkpoint, Convert to JSON, Delete |

### 10.6 数据库实现变更

#### 从SQLite切换到JSON文件

**原因**: better-sqlite3需要编译原生模块，在某些环境下会遇到Xcode Command Line Tools依赖问题。

**解决方案**: 使用JSON文件模拟SQLite API

**实现** (`backend/database.js`):
```javascript
const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '../db');
const TASKS_FILE = path.join(DB_DIR, 'tasks.json');
const LOGS_FILE = path.join(DB_DIR, 'logs.json');

// 确保数据库目录存在
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// 读取数据库
function readDB() {
  const tasksData = fs.existsSync(TASKS_FILE)
    ? JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'))
    : { tasks: [] };

  const logsData = fs.existsSync(LOGS_FILE)
    ? JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'))
    : { logs: [] };

  return { tasks: tasksData.tasks, logs: logsData.logs };
}

// 写入数据库
function writeDB(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: data.tasks }, null, 2));
  fs.writeFileSync(LOGS_FILE, JSON.stringify({ logs: data.logs }, null, 2));
}

// 模拟SQLite API
const db = {
  prepare: function(sql) {
    return {
      run: function(...params) {
        const data = readDB();
        // SQL解析和执行逻辑
        // INSERT, UPDATE, DELETE
        writeDB(data);
        return { changes: 1 };
      },

      get: function(...params) {
        const data = readDB();
        // SQL解析和查询逻辑
        // SELECT ... WHERE ... LIMIT 1
        return result;
      },

      all: function(...params) {
        const data = readDB();
        // SQL解析和查询逻辑
        // SELECT ... WHERE ...
        return results;
      }
    };
  }
};

module.exports = db;
```

**关键修复**: `arguments`对象访问

**问题**: 箭头函数没有`arguments`对象

**错误代码**:
```javascript
all: (...params) => {
  const sqlQuery = arguments[0];  // Error: arguments is not defined
}
```

**修复后**:
```javascript
all: function(...params) {
  const sqlQuery = arguments[0];  // OK: 使用常规函数
}
```

### 10.7 错误处理改进

#### MonitorView日志级别空值检查

**问题**: 某些日志消息可能没有`level`字段，导致`log.level.toUpperCase()`报错

**修复** (`frontend/src/components/views/MonitorView.jsx`):
```javascript
// 原代码
<span className={`text-${getLevelColor(log.level)}`}>
  {log.level.toUpperCase()}  // Error: Cannot read properties of undefined
</span>

// 修复后
<span className={`text-${getLevelColor(log.level)}`}>
  {log.level ? log.level.toUpperCase() : 'INFO'}
</span>
```

#### 进程已终止的优雅处理

**问题**: 后端重启后，数据库中标记为running的任务，其进程PID已失效，尝试发送信号会失败

**修复** (`backend/controllers/TaskController.js`):
```javascript
async stopTask(taskId) {
  const proc = this.runningProcesses.get(taskId);

  if (!proc || !proc.child) {
    // 进程不存在，检查数据库状态
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);

    if (task && (task.status === 'running' || task.status === 'paused')) {
      // 更新数据库为stopped
      db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE task_id = ?')
        .run('stopped', Date.now(), taskId);

      return { success: true, message: 'Task process has already terminated.' };
    }

    throw new Error('Task is not running');
  }

  // 进程存在，发送SIGTERM信号
  proc.child.kill('SIGTERM');
  return { success: true };
}
```

### 10.8 性能优化

#### 日志数量限制

前端只保留最新200条日志，避免内存占用过高：

```javascript
subscribe('log', (log) => {
  setTask(prev => ({
    ...prev,
    logs: [...(prev.logs || []).slice(-200), log]  // 只保留最新200条
  }));
});
```

#### WebSocket重连策略

```javascript
socket.current = io(WS_URL, {
  query: { taskId },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 10
});
```

#### 状态文件轮询间隔

对于无法重新attach的进程，使用状态文件轮询，间隔2秒：

```javascript
const pollInterval = setInterval(() => {
  // 读取状态文件并推送到WebSocket
}, 2000);  // 2秒间隔，平衡实时性和性能
```

### 10.9 检查点恢复机制

#### 问题背景

在实际使用中，任务可能因为各种原因被中断：
- 服务器重启或崩溃
- 主动停止任务进行维护
- 任务执行过程中遇到错误失败
- 使用 `./stop.sh` 完全关闭系统

在这些情况下，如果没有检查点恢复机制，用户需要：
1. 手动编辑输入文件，跳过已处理的地点
2. 创建新任务从头开始（浪费已完成的工作）

#### 解决方案：自动检查点恢复

**核心原理**:

爬虫脚本已经内置检查点保存功能（每处理一个地点保存一次），现在添加了从检查点恢复的API和UI。

**实现位置**:

1. **后端API** (`backend/controllers/TaskController.js`):

```javascript
async resumeFromCheckpoint(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);

  if (!task) {
    throw new Error('Task not found');
  }

  // 检查任务状态是否允许恢复
  if (!['paused', 'stopped', 'failed'].includes(task.status)) {
    throw new Error(`Cannot resume task with status: ${task.status}`);
  }

  // 检查检查点文件是否存在
  const checkpointFile = task.state_file.replace('.state.json', '.checkpoint.json');
  if (!fs.existsSync(checkpointFile)) {
    throw new Error('No checkpoint file found. Cannot resume from checkpoint.');
  }

  // 读取检查点信息
  const checkpointData = fs.readFileSync(checkpointFile, 'utf8');
  const checkpointInfo = JSON.parse(checkpointData);

  // 更新任务状态为pending
  db.prepare(`
    UPDATE tasks SET status = ?, error = NULL
    WHERE task_id = ?
  `).run('pending', taskId);

  // 启动任务（脚本会自动从检查点恢复）
  const result = await this.startTask(taskId);

  return {
    success: true,
    resumedFrom: checkpointInfo.lastIndex + 1,
    totalItems: task.progress_total,
    lastPlaceId: checkpointInfo.placeId,
    message: `Resuming from checkpoint: index ${checkpointInfo.lastIndex + 1} of ${task.progress_total}`,
    ...result
  };
}
```

2. **路由** (`backend/routes/tasks.js`):

```javascript
router.post('/:taskId/resume-from-checkpoint', async (req, res) => {
  try {
    const result = await TaskController.resumeFromCheckpoint(req.params.taskId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
```

3. **前端API** (`frontend/src/services/api.js`):

```javascript
resumeFromCheckpoint: (taskId) => request(`/tasks/${taskId}/resume-from-checkpoint`, {
  method: 'POST'
})
```

4. **前端UI** (`frontend/src/components/views/MonitorView.jsx`):

```javascript
const handleResumeFromCheckpoint = async () => {
  if (!confirm('Resume this task from the last saved checkpoint?\n\nThe task will continue from where it stopped.')) {
    return;
  }

  try {
    const result = await api.resumeFromCheckpoint(taskId);
    alert(`Task resumed successfully!\n\n${result.message}\n\nThe task is now running.`);
  } catch (err) {
    alert('Failed to resume from checkpoint: ' + err.message);
  }
};

// 按钮显示条件
{(task.status === 'stopped' || task.status === 'failed') && (
  <Button variant="primary" icon={PlayCircle} onClick={handleResumeFromCheckpoint}>
    Resume from Checkpoint
  </Button>
)}
```

#### 检查点文件格式

检查点文件保存在 `output/{taskId}.checkpoint.json`：

```json
{
  "lastIndex": 148,
  "placeId": "ChIJ2Ulmp4sX2jERNAywLFoljmI",
  "lastStatus": "ok",
  "updatedAt": "2026-01-24T15:24:58.045Z"
}
```

**字段说明**:
- `lastIndex`: 最后处理的索引位置（从0开始）
- `placeId`: 最后处理的Place ID
- `lastStatus`: 最后一次处理的状态（ok/error）
- `updatedAt`: 检查点更新时间

#### 恢复流程

1. 用户点击"Resume from Checkpoint"按钮
2. 前端发送POST请求到 `/api/tasks/{taskId}/resume-from-checkpoint`
3. 后端验证任务状态和检查点文件
4. 更新任务状态为`pending`，清除错误信息
5. 调用`startTask()`启动任务
6. 爬虫脚本检测到检查点文件存在，从`lastIndex + 1`开始执行
7. 已处理的数据追加到原输出文件
8. 前端显示恢复成功消息并开始实时监控

#### 完全关闭后恢复的完整示例

**场景**: 处理49323个地点的任务运行到148个后，使用`./stop.sh`完全关闭系统

**步骤**:

1. **完全关闭系统**:
```bash
./stop.sh
# 选择选项 1) Stop ALL (backend + frontend + scrapers)
```

2. **重新启动系统**:
```bash
./start.sh
```

3. **在前端恢复任务**:
   - 打开浏览器访问 `http://localhost:5173`
   - 切换到Monitor页面
   - 找到状态为"stopped"的任务
   - 点击"Resume from Checkpoint"按钮
   - 确认恢复

4. **任务继续执行**:
   - 任务从第149个地点开始处理
   - 已完成的148个地点不会重复
   - 新数据追加到 `output/3333.ndjson`
   - 统计数据继续累加

#### 优势

1. **数据不丢失**: 即使完全关闭系统，已处理的数据安全保存
2. **无需手动干预**: 不需要编辑输入文件或计算偏移量
3. **支持多种中断场景**: 停止、失败、崩溃都可以恢复
4. **用户友好**: 一键恢复，无需技术知识
5. **节省时间**: 大规模任务中断后不需要从头开始

#### 注意事项

1. **检查点文件必须存在**: 如果任务从未运行过或检查点文件被删除，无法使用此功能
2. **输出文件追加模式**: NDJSON格式天然支持追加，数据会自动续写
3. **统计数据重置**: 恢复后的统计从0开始累加，但最终输出文件包含所有数据
4. **不支持completed状态**: 已完成的任务不需要恢复，不显示此按钮

---

## 十一、迁移指南

如果您正在从旧版本升级，请注意以下变更：

### 从旧版本迁移

1. **数据库变更**: 从SQLite迁移到JSON文件
   - 旧数据库位置: `db/tasks.db`
   - 新数据库位置: `db/tasks.json`, `db/logs.json`
   - 迁移不需要手动操作，JSON格式会自动初始化

2. **输出格式变更**: JSON格式选项已移除
   - 所有任务现在统一使用NDJSON格式
   - 如需JSON格式，使用"Convert to JSON"功能转换

3. **启动方式变更**: 推荐使用启动脚本
   - 旧方式: 手动启动backend和frontend
   - 新方式: `./start.sh`一键启动
   - 旧方式仍然支持，但建议迁移到新方式

4. **API变更**: 新增端点
   - `POST /api/tasks/{taskId}/convert-to-json` - 转换为JSON格式
   - `DELETE /api/tasks/{taskId}` - 现在支持删除pending状态任务
   - `POST /api/tasks/{taskId}/resume-from-checkpoint` - 从检查点恢复任务

5. **前端组件变更**:
   - ScraperConfigView: 移除了输出格式选择器
   - MonitorView: 新增Convert to JSON、Delete和Resume from Checkpoint按钮

6. **检查点恢复功能**: 新增功能
   - 完全关闭系统后可以从上次位置继续执行
   - 停止或失败的任务可以一键恢复
   - 不需要手动编辑输入文件或计算偏移量

---

## 总结

通过以上改进，系统现在具备：

1. **更简单的部署**: 一键启动和关闭脚本
2. **更安全的数据**: 增量保存防止数据丢失
3. **更灵活的输出**: NDJSON流式输出 + 按需转换为JSON
4. **更强大的管理**: 支持删除pending任务、处理进程异常
5. **更好的用户体验**: POI搜索进度显示、状态完整覆盖
6. **检查点恢复**: 完全关闭后可从上次位置继续执行，不丢失进度
7. **完整的评论提取**: 修复了懒加载触发问题，评论提取量从10条提升到408条（40倍改进）
8. **更好的调试能力**: 浏览器控制台日志捕获，实时可见评论提取过程
9. **路径修复**: Convert-to-JSON功能正确解析相对路径
10. **Output-as-Truth架构**: 输出文件作为唯一真相来源，自动恢复、配置变更检测、内置重试逻辑

这些改进使系统更加稳定、易用和可靠，特别是Output-as-Truth架构彻底解决了进度/统计数据不一致的问题，并简化了恢复逻辑。

### 10.10 评论提取滚动机制修复 (2026-01-26)

#### 问题背景

评论提取只能获取约10条评论，即使目标地点有200+条评论且`maxReviews`设置为1000。

#### 根本原因

1. **懒加载未触发**: `scrollBy()` 只移动滚动位置，但不触发Google Maps的虚拟滚动懒加载机制。Google Maps需要检测到`scroll`事件才会从服务器加载新的评论批次。
2. **早停机制过于激进**: 旧的"连续3次滚动无新评论即停止"策略在懒加载尚未完成时就终止了提取。

#### 解决方案

修改文件: `src/reviews_extractor_scroll.js`

1. **在每次滚动后派发scroll事件**:
```javascript
scrollContainer.scrollBy(0, scrollContainer.clientHeight * 0.8);
scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
```

2. **替换早停为底部卡住检测**:
- 只在物理上卡在滚动容器底部时才考虑停止
- 额外等待2秒检查是否有新内容加载
- 连续3次卡住且无新内容才停止

3. **添加浏览器控制台日志捕获** (`gmaps_batch_scrape_ipc.js`):
```javascript
page.on('console', (msg) => {
    if (msg.text().includes('[Reviews]')) {
        ipcLog('info', `[Browser] ${msg.text()}`);
    }
});
```

#### 效果

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 提取评论数 | 10 | 408 |
| 滚动次数 | 6 | 169 |
| 提取时间 | ~8秒 | ~190秒 |
| 评论完整率 | 4.7% | ~100% |

#### 默认参数调整

同时将默认参数从保守值调整为充分提取值:
- `maxReviews`: 50 -> 1000
- `maxScrolls`: 20 -> 1000

修改涉及的文件:
- `src/gmaps_batch_scrape_ipc.js` (parseArgs默认值 + page.evaluate回退值)
- `src/gmaps_batch_scrape_with_reviews.js` (parseArgs默认值 + page.evaluate回退值)
- `src/reviews_extractor_scroll.js` (内部默认值)
- `frontend/src/components/views/ScraperConfigView.jsx` (表单默认值)

### 10.11 Convert-to-JSON路径修复 (2026-01-26)

#### 问题

点击"Convert to JSON"按钮总是报错: "Output file does not exist"

#### 原因

`config.output` 存储相对路径（如 `"output/666.ndjson"`），但后端进程从 `backend/` 目录启动（`start.sh` 中 `cd backend && npm run dev`），导致 `fs.existsSync("output/666.ndjson")` 解析为 `/Volumes/Data/time_scraper/backend/output/666.ndjson`，而实际文件在 `/Volumes/Data/time_scraper/output/666.ndjson`。

#### 修复

在 `backend/controllers/TaskController.js` 的 `convertToJSON` 方法中，将相对路径解析为相对于项目根目录:

```javascript
const projectRoot = path.join(__dirname, '../..');
const ndjsonPath = path.isAbsolute(config.output)
  ? config.output
  : path.join(projectRoot, config.output);
```

### 10.12 并行分割功能 (2026-01-27)

#### 功能概述

支持将输入数据拆分成2-10份，同时启动N个爬取进程并行处理。每个进程独立运行，有各自的checkpoint、输出文件和图片目录。通过在任务config JSON中嵌入`groupId`/`groupIndex`/`groupTotal`来逻辑关联同一组任务（无需数据库schema变更）。

#### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `backend/routes/files.js` | 新增 `POST /count-items` 统计输入文件条目数 |
| `backend/controllers/TaskController.js` | 新增 `_countItems()`, `createParallelTasks()`, `startParallelTasks()`, `getTasksByGroupId()`; 在 `_buildCommandArgs` 中添加 `config.start -> --start` 映射 |
| `backend/routes/tasks.js` | 新增5个路由（放在`/:taskId`之前）: `/create-parallel`, `/start-parallel`, `/group/:groupId`, `/group/:groupId/stop`, `/group/:groupId` (DELETE) |
| `src/gmaps_batch_scrape_ipc.js` | 搜索模式添加 `--start` 偏移支持（切割采样点数组） |
| `frontend/src/services/api.js` | 新增6个API方法: `countItems`, `createParallelTasks`, `startParallelTasks`, `getTaskGroup`, `stopTaskGroup`, `deleteTaskGroup` |
| `frontend/src/components/views/ScraperConfigView.jsx` | 新增并行分割UI: toggle、分割数输入、自动统计条目数、输出文件名/图片目录预览 |
| `frontend/src/App.jsx` | `handleStartTask` 支持并行模式分支 |
| `frontend/src/components/InstanceSwitcher.jsx` | 按`groupId`聚合显示同组任务 |
| `frontend/src/components/views/MonitorView.jsx` | 新增组概览横幅: 聚合进度条、聚合统计、可点击部分状态圆点、Stop All按钮 |

#### 核心实现

**后端 - createParallelTasks(baseConfig, splitCount)**:
```javascript
// 1. 确定输入文件
const inputFile = mode === 'search' ? baseConfig.points : baseConfig.input;
// 2. 统计总条目数
const totalItems = this._countItems(inputFile, mode);
// 3. 计算每份大小
const chunkSize = Math.ceil(totalItems / splitCount);
// 4. 生成groupId
const groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// 5. 创建N个任务
for (let i = 0; i < splitCount; i++) {
  const start = i * chunkSize;
  const limit = Math.min(chunkSize, totalItems - start);
  const suffix = String(i + 1).padStart(3, '0');
  const splitConfig = {
    ...baseConfig,
    start, limit,
    output: `output/${baseName}_${suffix}.ndjson`,
    imageOutput: `output/images/${baseName}/${suffix}`,
    groupId, groupIndex: i, groupTotal: splitCount, groupLabel: baseName
  };
  // 创建任务...
}
```

**前端 - ScraperConfigView并行UI**:
- 启用Parallel Split时，Output File、Limit、Image Directory自动禁用
- 自动调用`POST /files/count-items`统计条目数
- 实时预览输出文件名: `output/places_001.ndjson, _002.ndjson, _003.ndjson`
- 实时预览图片目录: `output/images/places/ {001, 002, 003}`
- 点击Start时传递`{ ...taskConfig, parallel: true, splitCount }`

**前端 - MonitorView组概览**:
- 检测到`task.config.groupId`时显示组概览横幅
- 每5秒轮询`GET /tasks/group/:groupId`获取所有部分状态
- 聚合计算: 总进度、总成功/失败/评论/图片数
- 显示每个部分的状态圆点，可点击切换

**任务Config Schema (并行任务)**:
```json
{
  "mode": "traditional",
  "input": "data/places.txt",
  "output": "output/places_001.ndjson",
  "imageOutput": "output/images/places/001",
  "start": 0,
  "limit": 100,
  "groupId": "group-1737900000-abc123",
  "groupIndex": 0,
  "groupTotal": 3,
  "groupLabel": "places",
  "headless": true,
  "downloadImages": true
}
```

#### 设计决策

1. **无独立"任务组"实体** -- 通过config中的`groupId`字段关联，无需数据库schema变更
2. **任务独立运行** -- 每个部分有独立checkpoint，一个失败不影响其他
3. **路由顺序** -- 并行路由必须在`/:taskId`之前定义，避免Express将"create-parallel"等当作taskId参数
4. **图片目录结构** -- 所有编号目录放在一个父文件夹下（`output/images/{baseName}/{suffix}`），方便管理

---

### 10.13 并行组进度数据一致性修复 (2026-01-27)

#### 问题描述

Parallel Group概览横幅上显示的进度数据与前端其他位置（Individual Task卡片、Instance Switcher）不一致。

#### 根本原因

三个独立问题叠加导致了数据不一致:

**1. percentage字段在WebSocket更新中未重新计算（最关键）**

后端`TaskController._handleIPCMessage()`通过WebSocket发送`progress`事件时，只包含`{current, total, currentPlace}`，**不含`percentage`**。前端`useTask` hook收到后用浅合并方式更新状态：

```javascript
// 修复前 (useTask.js)
progress: {
  ...prev?.progress,   // 旧的percentage保留
  ...data              // 只覆盖current, total, currentPlace
}
```

导致Individual Task卡片上的百分比显示（来自初始API加载时计算的`percentage`）与实时更新的`current/total`数字不匹配。

**2. 三处数据展示的更新频率不同**

| 展示位置 | 数据来源 | 更新频率 |
|---|---|---|
| Group Banner | HTTP轮询 `/tasks/group/:groupId` | 每5秒 |
| Individual Task Card | WebSocket实时推送 | 实时 |
| Instance Switcher | HTTP轮询 `loadRunningInstances` | 每10秒 |

**3. 后端WebSocket发射缺少percentage字段**

REST API返回的`progress`对象包含计算好的`percentage`，但WebSocket发射的`progress`事件不含该字段，导致前端两种数据源的数据结构不一致。

#### 修复方案

**修改文件1: `frontend/src/hooks/useTask.js`**

在WebSocket progress更新处理中重新计算`percentage`:

```javascript
// 修复后
const unsubProgress = subscribe('progress', (data) => {
  setTask(prev => ({
    ...prev,
    progress: {
      ...prev?.progress,
      ...data,
      percentage: data.total > 0
        ? Math.round((data.current / data.total) * 100)
        : (prev?.progress?.percentage || 0)
    }
  }));
});
```

**修改文件2: `backend/controllers/TaskController.js`**

在WebSocket progress发射中附加`percentage`字段:

```javascript
// 修复后
WebSocketManager.emit(taskId, 'progress', {
  ...data,
  percentage: data.total > 0 ? Math.round((data.current / data.total) * 100) : 0
});
```

**修改文件3: `frontend/src/App.jsx`**

统一Instance Switcher轮询间隔从10秒降至5秒，与Group Banner轮询频率一致:

```javascript
// 修复前
const interval = setInterval(loadRunningInstances, 10000);
// 修复后
const interval = setInterval(loadRunningInstances, 5000);
```

#### 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `frontend/src/hooks/useTask.js` | WebSocket progress handler中添加percentage重新计算 |
| `backend/controllers/TaskController.js` | `_handleIPCMessage` progress分支中WebSocket发射附加percentage |
| `frontend/src/App.jsx` | `loadRunningInstances`轮询间隔从10s改为5s |

---

### 10.14 Checkpoint Resume进度累积修复 (2026-01-27)

#### 问题描述

通过"Resume from Checkpoint"恢复的任务显示进度数据与统计数据严重不一致。例如：进度条显示2/8221 (0%)，但统计卡片显示success=184。

#### 根本原因

三个独立bug叠加:

**1. IPC脚本中`--start`参数阻止了checkpoint恢复**

IPC脚本(`src/gmaps_batch_scrape_ipc.js`)中的条件:
```javascript
if (opts.resume && !opts.startIndexSet) {
  // 只有当--start没有被设置时才读取checkpoint
}
```
由于`_buildCommandArgs()`始终传递`--start`来保持chunk边界，`opts.startIndexSet=true`，checkpoint文件被跳过。任务每次resume都从chunk起始位置重新开始。

注意: 不能简单地在后端跳过`--start`，因为IPC脚本使用`startIndex`计算`endIndex`(`endIndex = startIndex + limit`)。跳过`--start`会导致chunk边界偏移。

**2. 进度(progress)没有像统计(stats)一样累积**

`resumeFromCheckpoint()`保存了`statsBaseline`用于累积统计数据(baseline + 新进程stats),但没有对应的`progressBaseline`。因此:
- stats.success = baseline(182) + new(2) = 184 累积
- progress.current = new(2) 未累积,应该是184

**3. `error`和`completed_at`字段在resume时未清除**

原SQL `UPDATE tasks SET status = ?, error = NULL` 不匹配JSON数据库的handler,导致resume后旧的错误信息和完成时间仍然保留在数据库中。

#### 修复方案

**修改1: IPC脚本 (`src/gmaps_batch_scrape_ipc.js`)** - 核心修复在IPC脚本而非后端:
```javascript
// 修改前:
let startIndex = Math.max(0, opts.startIndex || 0);
if (opts.resume && !opts.startIndexSet) { // --start阻止checkpoint读取
  // ...
}
const endIndex = opts.limit
  ? Math.min(placeIds.length, startIndex + opts.limit) // startIndex偏移导致chunk边界错误
  : placeIds.length;

// 修改后:
const originalStart = Math.max(0, opts.startIndex || 0);
let startIndex = originalStart;
if (opts.resume) { // 始终读取checkpoint,不管--start是否设置
  const checkpoint = readCheckpoint(opts.checkpointFile);
  if (checkpoint && Number.isFinite(checkpoint.lastIndex)) {
    const resumeIndex = checkpoint.lastIndex + 1;
    if (resumeIndex > startIndex) {
      startIndex = resumeIndex;
    }
  }
}
const endIndex = opts.limit
  ? Math.min(placeIds.length, originalStart + opts.limit) // 用originalStart保持chunk边界
  : placeIds.length;
```

**修改2: `resumeFromCheckpoint()`** - 保存progress baseline并清除error/completed_at:
```javascript
const progressBaseline = {
  current: task.progress_current || 0,
  total: task.progress_total || 0
};
this.progressBaselines.set(taskId, progressBaseline);

db.prepare('UPDATE tasks SET status = ?, completed_at = ?, error = ? WHERE task_id = ?')
  .run('pending', null, null, taskId);
```

**修改3: `_handleIPCMessage()` progress分支** - 应用progress baseline:
```javascript
case 'progress':
  let progressCurrent = data.current;
  let progressTotal = data.total;
  if (this.progressBaselines.has(taskId)) {
    const baseline = this.progressBaselines.get(taskId);
    progressCurrent = (baseline.current || 0) + (data.current || 0);
    progressTotal = baseline.total || data.total;
  }
  // DB和WebSocket都使用累积后的值
```

**修改4: `_handleProcessExit()`** - 任务完成时清理`progressBaselines`。

#### 修复工具

`scripts/repair-progress.js` — 将checkpoint文件和数据库中的progress/stats与实际NDJSON输出数据同步。此脚本在应用代码修复后运行一次，修复历史数据。

```bash
node scripts/repair-progress.js          # 干跑模式(只显示会改什么)
node scripts/repair-progress.js --apply  # 实际应用修改
```

工作原理: 读取每个任务的NDJSON文件，提取placeId映射回输入数组的索引（处理重复placeId时只取chunk范围内的索引），更新checkpoint的lastIndex和数据库的progress_current/stats。

#### 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/gmaps_batch_scrape_ipc.js` | 去除`!opts.startIndexSet`条件，始终读取checkpoint；用`originalStart`计算`endIndex`保持chunk边界 |
| `backend/controllers/TaskController.js` | constructor添加`progressBaselines` Map; `resumeFromCheckpoint()`保存progress baseline并清除error/completed_at; `_handleIPCMessage()`累积progress; `_handleProcessExit()`清理progressBaselines |
| `scripts/repair-progress.js` | 新建修复脚本，同步checkpoint和DB与实际NDJSON数据 |

---

### 10.15 Output-as-Truth 架构 (2026-02-01)

#### 问题背景

之前基于checkpoint的恢复系统存在多个问题：
1. `TaskController.js`中复杂的baseline累加逻辑导致进度/统计数据不一致
2. checkpoint文件可能与实际输出文件不同步
3. 配置变更（如不同的`--max-reviews`）需要手动处理以避免混合数据
4. "真相来源"分散在checkpoint文件和输出文件之间

#### 解决方案: Output-as-Truth (输出即真相)

**核心思想**: 输出文件(`output.ndjson`, `errors.ndjson`)是唯一的真相来源。

#### gmaps_batch_scrape_ipc.js 新增函数 (行 545-700)

| 函数 | 用途 |
|------|------|
| `computeConfigHash()` | 计算爬取配置的MD5哈希，检测配置变更 |
| `scanOutputForDoneSet()` | 扫描输出文件，构建`doneSet`(已完成的placeId) + `retrySet`(可重试的失败项) |
| `loadMeta()` / `saveMeta()` | 管理`output.meta.json`，存储configHash、时间戳和汇总统计 |
| `backupOutputFiles()` | 配置变更时自动备份旧输出文件（创建`*.bak-YYYYMMDD-HHMMSS`文件） |
| `initOutputAsTruth()` | 主初始化函数，协调以上功能并返回`doneSet` |

#### 主循环改动 (行 1262-1350)

```javascript
// 启动时: 扫描输出文件确定已完成的内容
const { doneSet, retrySet, alreadyDoneCount } = await initOutputAsTruth(opts);

// 进度从 alreadyDoneCount 开始，而不是 0
let processedCount = alreadyDoneCount;

// 主循环: 跳过 doneSet 中的项，重试 retrySet 中的项
for (const item of inputItems) {
  if (doneSet.has(item.placeId) && !retrySet.has(item.placeId)) {
    continue; // 已成功处理，跳过
  }
  // 处理项目...
  doneSet.add(item.placeId); // 成功写入磁盘后更新内存集合
}
```

#### 新增 CLI 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--max-error-retries N` | 1 | 失败项的最大重试次数。`errors.ndjson`中`_errorCount < N`的项会被添加到`retrySet`自动重试 |

#### TaskController.js 简化 (行 311-455)

**`resumeFromCheckpoint()` 变更:**
- 移除复杂的baseline累加计算
- 进度/统计数据现在直接从输出文件读取
- 清除baseline存储（IPC脚本自己处理一切）

**`_handleIPCMessage()` 变更:**
- 移除baseline累加逻辑
- IPC脚本发送准确的进度值，controller直接传递

#### 工作流程图

```
任务启动
    │
    ▼
扫描 output.ndjson + errors.ndjson
    │
    ├── 构建 doneSet (已成功完成的 placeId)
    ├── 构建 retrySet (errorCount < maxRetries 的失败项)
    └── 计算 alreadyDoneCount 作为初始进度
    │
    ▼
检查 output.meta.json
    │
    ├── configHash 匹配 → 继续追加到现有文件
    └── configHash 不匹配 → 备份旧文件 (*.bak-YYYYMMDD-HHMMSS)
    │
    ▼
主循环遍历输入
    │
    ├── placeId 在 doneSet 中 (且不在 retrySet) → 跳过
    ├── placeId 在 retrySet 中 → 重试
    └── 新 placeId → 正常处理
    │
    ▼
处理完每个项目后
    │
    ├── 添加到 doneSet (内存)
    └── 写入 output.ndjson (磁盘 - 唯一真相来源)
```

#### 文件结构

```
output/
├── results.ndjson                          # 主输出 (成功的爬取)
├── results.errors.ndjson                   # 错误日志(含重试次数)
├── results.meta.json                       # 配置哈希、时间戳、汇总
└── results.ndjson.bak-20260201-143022      # 配置变更时的自动备份
```

#### meta.json 格式

```json
{
  "configHash": "a1b2c3d4e5f6...",
  "createdAt": "2026-02-01T14:30:22.000Z",
  "lastUpdatedAt": "2026-02-01T15:45:10.000Z",
  "config": {
    "maxReviews": 100,
    "maxScrolls": 1000,
    "reviewSort": "newest"
  },
  "summary": {
    "totalProcessed": 1500,
    "successful": 1480,
    "failed": 20
  }
}
```

#### 核心优势

1. **唯一真相来源**: 输出文件决定进度，而非checkpoint文件
2. **自动恢复**: 进程崩溃后重启自动从中断处继续
3. **配置变更检测**: MD5哈希检测配置变化（如`--max-reviews 50` vs `--max-reviews 100`）
4. **配置变更时自动备份**: 旧输出文件以时间戳后缀保留
5. **内置重试逻辑**: 失败项自动重试（最多`--max-error-retries`次）
6. **后端简化**: `TaskController.js`不再需要复杂的baseline算术

#### 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/gmaps_batch_scrape_ipc.js` | 新增5个函数: `computeConfigHash()`, `scanOutputForDoneSet()`, `loadMeta()`, `saveMeta()`, `backupOutputFiles()`, `initOutputAsTruth()`; 主循环使用doneSet/retrySet; 新增`--max-error-retries`参数 |
| `backend/controllers/TaskController.js` | `resumeFromCheckpoint()`移除复杂baseline计算，直接从输出文件读取; `_handleIPCMessage()`移除baseline累加逻辑 |
