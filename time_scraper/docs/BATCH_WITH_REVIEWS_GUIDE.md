# Google Maps批处理抓取（含评论） - 使用指南

## 文件说明

`gmaps_batch_scrape_with_reviews.js` 是基于 `gmaps_batch_scrape_stable.js` 的增强版本，集成了评论提取功能。

## 关键改进

### 1. 两步加载策略

自动使用两步加载确保完整界面：
```javascript
// Step 1: 初始化搜索API
await page.goto(searchUrl, ...)
// Step 2: 加载完整place页面
await page.goto(placeUrl, ...)
```

### 2. 自动评论提取

在基础数据提取后自动提取评论：
- 默认提取50条评论
- 可配置滚动次数和最大评论数
- 失败不影响基础数据提取

### 3. 新增命令行参数

| 参数 | 说明 | 默认值 |
|-----|------|-------|
| `--no-reviews` | 禁用评论提取 | 启用 |
| `--max-reviews N` | 最大提取评论数 | 50 |
| `--max-scrolls N` | 最大滚动次数 | 20 |
| `--no-review-images` | 不提取评论图片URL | 提取 |

## 基础用法

### 标准运行（提取评论）

```bash
node gmaps_batch_scrape_with_reviews.js \
  --input coordinates_singapore.json \
  --output output/places_with_reviews.ndjson \
  --limit 10
```

### 提取更多评论

```bash
node gmaps_batch_scrape_with_reviews.js \
  --input coordinates_singapore.json \
  --output output/places_with_reviews.ndjson \
  --max-reviews 100 \
  --max-scrolls 30 \
  --limit 10
```

### 禁用评论提取

```bash
node gmaps_batch_scrape_with_reviews.js \
  --input coordinates_singapore.json \
  --output output/places_basic.ndjson \
  --no-reviews \
  --limit 10
```

## 高级用法

### 使用代理 + 评论提取

```bash
node gmaps_batch_scrape_with_reviews.js \
  --input coordinates_singapore.json \
  --output output/places_with_reviews.ndjson \
  --use-proxy \
  --proxy-config proxy.json \
  --random-delay \
  --max-reviews 50 \
  --limit 10
```

### Headless模式

```bash
node gmaps_batch_scrape_with_reviews.js \
  --input coordinates_singapore.json \
  --output output/places_with_reviews.ndjson \
  --headless \
  --max-reviews 30 \
  --limit 10
```

## 输出格式

基础数据 + 评论数据：

```json
{
  "business": {
    "name": "Cappadocia Restaurant",
    "rating": 4.7,
    "categories": ["Turkish restaurant"],
    "mainCategory": "Turkish restaurant"
  },
  "about": { ... },
  "metadata": { ... },
  "openingHours": { ... },
  "popularTimes": { ... },
  "detailedReviews": [
    {
      "review_id": "26354;mutable:true;",
      "rating": 5,
      "review_text": "I ordered the Lamb Chops...",
      "published_at": "a month ago",
      "reviewer_name": "Andriana Stefani",
      "reviewer_photo_count": 21,
      "reviewer_review_count": 19,
      "is_local_guide": true,
      "review_images": ["https://..."]
    }
  ],
  "_meta": {
    "placeId": "ChIJ...",
    "sourceUrl": "https://..."
  }
}
```

## 性能考虑

### 时间成本

每个地点的处理时间：

| 模式 | 时间 | 说明 |
|-----|------|------|
| 无评论 | ~5-10秒 | 基础数据提取 |
| 50条评论 | ~25-35秒 | +20秒评论提取 |
| 100条评论 | ~45-60秒 | +40秒评论提取 |

### 推荐配置

**快速模式** (测试用):
```bash
--max-reviews 20 --max-scrolls 10
```

**平衡模式** (推荐):
```bash
--max-reviews 50 --max-scrolls 20
```

**完整模式** (数据密集):
```bash
--max-reviews 100 --max-scrolls 30
```

## 错误处理

### 评论提取失败

评论提取失败不会影响基础数据：
```
[1/10] [REVIEWS] Failed: Reviews tab not found
[1/10] [OK] ChIJ...
```

基础数据仍会保存，`detailedReviews` 字段不存在或为空。

### 页面加载失败

使用两步加载后，如果仍然失败：
- 自动重试（最多3次）
- 增加 `--random-delay` 参数
- 检查网络连接

### CAPTCHA处理

遇到CAPTCHA时：
1. 使用代理轮换: `--use-proxy --proxy-config proxy.json`
2. 增加随机延迟: `--random-delay`
3. 配置CAPTCHA solver: `--captcha-solver YOUR_API_KEY`

## 与原版比较

| 特性 | 原版 (stable) | 评论版 (with_reviews) |
|-----|--------------|---------------------|
| 基础数据提取 | ✓ | ✓ |
| 页面加载 | 单步 | **两步** |
| 评论提取 | ✗ | **✓** |
| 向后兼容 | N/A | ✓ |
| 性能 | 快 | 稍慢（+20-40秒/地点） |

## 依赖

需要以下文件存在：
- `/Volumes/Data/scraper/google-maps-scraper-pipeline.js` - 基础数据提取pipeline
- `/Volumes/Data/time_scraper/reviews_extractor_scroll.js` - 评论提取模块

如果 `reviews_extractor_scroll.js` 不存在，会跳过评论提取但继续运行。

## 示例：批量处理100个地点

```bash
node gmaps_batch_scrape_with_reviews.js \
  --input coordinates_singapore.json \
  --output output/singapore_places_reviews.ndjson \
  --limit 100 \
  --max-reviews 50 \
  --random-delay \
  --restart-every 25
```

预计时间：
- 100个地点 × 30秒/地点 = 50分钟
- 包含基础数据 + 50条评论/地点

## Troubleshooting

### 问题：评论数量为0

检查：
1. 确认 `reviews_extractor_scroll.js` 文件存在
2. 查看控制台是否显示 "Reviews extractor loaded"
3. 检查是否使用了 `--no-reviews` 参数

### 问题：评论提取很慢

解决：
- 减少 `--max-reviews` (如设为30)
- 减少 `--max-scrolls` (如设为15)
- 使用 `--no-review-images` 禁用图片提取

### 问题：内存占用高

解决：
- 使用 `--headless` 模式
- 减少 `--restart-every` 值（如设为10）
- 限制同时处理数量 `--limit`

## 更新日志

### v1.0 (2026-01-23)
- ✓ 集成两步加载策略
- ✓ 添加评论提取功能
- ✓ 新增4个命令行参数
- ✓ 向后兼容原版功能
- ✓ 错误处理不影响基础数据
