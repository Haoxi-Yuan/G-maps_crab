# Time Series Data Pipeline

从 Google Maps 评论中提取营业时间和客流密度的**时序数据**，生成按月份的历史快照。

## 概述

本项目通过以下流程处理评论数据：

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Step 1    │    │   Step 2    │    │   Step 3    │    │   Step 4    │
│  向量检索   │ →  │  LLM 提取   │ →  │  时序构建   │ →  │  缺失填充   │
│  (筛选)     │    │  (带证据)   │    │  (按月汇总) │    │  (插值)     │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
      ↓                  ↓                  ↓                  ↓
 top-k reviews      时间段数据 +       月度快照           完整时序
 per place_id       evidence引用       timeseries         timeseries.ndjson
```

## 核心变更（v2.0）

### 输出格式变化

**旧格式**：提取变化事件（hour_changes）和调整（_adjustments）

**新格式**：完整的月度时序数据，格式与原始数据一致

```json
{
  "place_id": "xxx",
  "business_name": "xxx",
  "openingHours_timeseries": [
    {
      "period": "2026-01",
      "weeklyHours": [
        {"day": "Monday", "hours": "9:00 AM–9:00 PM", "openHour": 9, "closeHour": 21},
        ...
      ],
      "source": "current_data",
      "evidence": "Current data from Google Maps",
      "source_reviews": [],
      "confidence": 1.0
    },
    {
      "period": "2025-06",
      "weeklyHours": [...],
      "source": "review_inference",
      "evidence": "Review stated: 'They used to close at 9pm'",
      "source_reviews": ["review_id_1"],
      "confidence": 0.8
    }
  ],
  "popularTimes_timeseries": [
    {
      "period": "2026-01",
      "weeklyData": [
        {
          "day": "Sunday",
          "hourlyData": [{"hour": 9, "popularity": 45}, ...]
        },
        ...
      ],
      "source": "current_data",
      "evidence": "Current data from Google Maps",
      "source_reviews": [],
      "confidence": 1.0
    }
  ]
}
```

### 关键特性

1. **按月份的时序快照**：每个 period 是 YYYY-MM 格式
2. **原始格式兼容**：weeklyHours 和 weeklyData 结构与原始数据完全一致
3. **证据追溯**：每个推断都有 evidence 字段说明来源
4. **缺失填充**：自动用最近的已知数据填充缺失月份
5. **置信度评分**：每个快照都有 confidence 分数

## 目录结构

```
Pipeline/
├── venv/                   # Python 虚拟环境
├── __init__.py            # 包导出
├── schemas.py             # Pydantic 数据模型（时序格式）
├── vectorizer.py          # 向量检索模块
├── extractor.py           # LLM 结构化提取（带 evidence）
├── patcher.py             # 时序数据构建器
├── pipeline.py            # 主流程入口
├── config.py              # 配置预设
├── requirements.txt       # 依赖列表
└── README.md              # 本文档
```

## 安装

### 1. 激活虚拟环境

```bash
source /data2/shared/haoxi/projects/G-maps_crab/Pipeline/venv/bin/activate
```

### 2. 安装依赖（如需重建环境）

```bash
python -m venv venv
source venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install sentence-transformers faiss-cpu pydantic tqdm
# 可选 LLM 后端
pip install openai  # OpenAI API
pip install anthropic  # Anthropic API
```

## 使用方法

### 方法一：运行完整 Pipeline

```bash
cd /data2/shared/haoxi/projects/G-maps_crab/Pipeline
source venv/bin/activate

# Mock 模式（测试用，无需 API）
python pipeline.py --llm-backend mock

# OpenAI 模式
export OPENAI_API_KEY="sk-..."
python pipeline.py --llm-backend openai --llm-model gpt-4o-mini

# Anthropic 模式
export ANTHROPIC_API_KEY="..."
python pipeline.py --llm-backend anthropic --llm-model claude-3-haiku-20240307

# 指定当前数据的时间段
python pipeline.py --llm-backend openai --current-period 2026-01

# 不填充缺失月份
python pipeline.py --llm-backend openai --no-fill-gaps
```

### 方法二：分步运行

#### Step 1: 向量检索

```bash
python -u vectorizer.py
```

输出：`vector_search_results.json`

#### Step 2: LLM 提取（需要 API）

```python
from extractor import create_extractor
import json

# 加载候选
with open('vector_search_results.json') as f:
    candidates = json.load(f)

# 创建提取器
extractor = create_extractor(backend='openai', model='gpt-4o-mini')

# 提取（新格式带 evidence）
for place_id, info in candidates.items():
    result = extractor.extract(place_id, info['business_name'], info['candidates'])
    # result 包含 hours_observations 和 popularity_observations
    print(result)
```

#### Step 3: 生成时序数据

```python
from patcher import TimeSeriesBuilder, generate_timeseries_file

# 创建构建器
builder = TimeSeriesBuilder(extractions, current_period="2026-01")

# 生成单个 POI 的时序数据
ts_data = builder.build_place_timeseries(place_id, original_record, fill_gaps=True)

# 或批量生成文件
stats = generate_timeseries_file(
    extractions=extractions,
    input_path='input.ndjson',
    output_path='timeseries_output.ndjson',
    current_period="2026-01",
    fill_gaps=True
)
```

## 命令行参数

```
python pipeline.py [OPTIONS]

Options:
  --input-dir PATH        输入目录 (default: time_scraper/output)
  --output-dir PATH       输出目录 (default: Pipeline/output)
  --pattern GLOB          文件匹配模式 (default: coordinates_singapore_00[1-6].ndjson)
  --llm-backend TYPE      LLM 后端: openai|anthropic|local|mock (default: mock)
  --llm-model NAME        模型名称 (default: gpt-4o-mini)
  --threshold FLOAT       相似度阈值 (default: 0.35)
  --max-per-place INT     每个商家最大评论数 (default: 15)
  --save-intermediate     保存中间结果
  --current-period YYYY-MM 当前数据的时间段 (default: 2026-01)
  --no-fill-gaps          不填充缺失月份
```

## 模块说明

### vectorizer.py

向量检索模块，使用预定义查询模板筛选相关评论。

**预定义查询类型：**

| 类型 | 查询示例 |
|------|----------|
| 营业时间 | "Opening hours changed", "Temporarily closed", "No longer 24 hours" |
| 客流密度 | "Very crowded busy", "Long queue waiting", "Empty quiet" |

### extractor.py

LLM 结构化提取模块，提取带时间段和证据的数据。

**提取的信息类型：**

1. **营业时间观测** (`hours_observations`)
   - inferred_period: 推断的时间段 (YYYY-MM)
   - mentioned_hours: 具体的营业时间数据
   - evidence: 支持该推断的评论原文

2. **客流密度观测** (`popularity_observations`)
   - inferred_period: 推断的时间段 (YYYY-MM)
   - observations: 具体的人气数据
   - evidence: 支持该推断的评论原文

### patcher.py

时序数据构建模块，将提取的观测数据构建为完整的月度时序。

**主要功能：**
- 按月份汇总观测数据
- 将原始数据标记为指定时间段（默认 2026-01）
- 自动填充缺失月份（使用最近的已知数据）
- 生成与原始格式兼容的时序文件

## 输出数据结构

### 时序数据 NDJSON 示例

```json
{
  "place_id": "ChIJ...",
  "business_name": "Example Restaurant",
  "openingHours_timeseries": [
    {
      "period": "2025-06",
      "weeklyHours": [
        {"day": "Monday", "hours": "9:00 AM–9:00 PM", "openHour": 9, "closeHour": 21},
        {"day": "Tuesday", "hours": "9:00 AM–9:00 PM", "openHour": 9, "closeHour": 21},
        ...
      ],
      "source": "review_inference",
      "evidence": "Review from 2025-07-15 stated: 'They used to close at 9pm but now close at 10pm'",
      "source_reviews": ["review_id_123"],
      "confidence": 0.85
    },
    {
      "period": "2025-07",
      "weeklyHours": [...],
      "source": "interpolated",
      "evidence": "Interpolated from 2025-06 data",
      "source_reviews": [],
      "confidence": 0.68
    },
    {
      "period": "2026-01",
      "weeklyHours": [...],
      "source": "current_data",
      "evidence": "Current data from Google Maps",
      "source_reviews": [],
      "confidence": 1.0
    }
  ],
  "popularTimes_timeseries": [
    {
      "period": "2025-06",
      "weeklyData": [
        {
          "day": "Sunday",
          "hourlyData": [
            {"hour": 9, "popularity": 45, "timeLabel": "9 am"},
            {"hour": 10, "popularity": 55, "timeLabel": "10 am"},
            ...
          ]
        },
        ...
      ],
      "source": "review_inference",
      "evidence": "Review stated: 'On weekends around 3pm it gets very crowded'",
      "source_reviews": ["review_id_456"],
      "confidence": 0.75
    }
  ]
}
```

## 数据来源类型 (source)

| 值 | 含义 |
|---|---|
| `current_data` | 当前从 Google Maps 抓取的数据 |
| `review_inference` | 从评论中推断的数据 |
| `interpolated` | 使用最近时间段的数据填充的缺失月份 |

## 性能参数

| 配置 | 值 |
|------|-----|
| Embedding 模型 | all-MiniLM-L6-v2 (22M params) |
| 向量维度 | 384 |
| 编码速度 | ~5000 reviews/sec (CPU) |
| 索引类型 | FAISS IndexFlatIP |

## 注意事项

1. **API 费用**：使用 OpenAI/Anthropic 时会产生 API 调用费用
2. **速率限制**：大规模提取时注意 API 速率限制
3. **数据隐私**：评论数据会发送到 LLM API
4. **置信度**：
   - 1.0: 当前数据或明确陈述
   - 0.7-0.9: 较明确的推断
   - 0.5-0.7: 有一定依据的推断
   - <0.5: 插值或弱推断

## 扩展开发

### 添加新的查询模板

编辑 `vectorizer.py` 中的 `HOUR_QUERIES` 或 `POPULARITY_QUERIES`：

```python
HOUR_QUERIES = [
    "Opening hours changed modified different now",
    # 添加新查询...
]
```

### 自定义 LLM Prompt

编辑 `extractor.py` 中的 `EXTRACTION_PROMPT`。

### 添加新的提取字段

1. 在 `schemas.py` 中定义新的 Pydantic 模型
2. 修改 `extractor.py` 中的 prompt
3. 更新 `patcher.py` 中的处理逻辑

## 许可证

Internal Use Only

## 联系方式

项目维护：haoxi
