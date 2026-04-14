# Research Findings & Technical Discoveries

## 1. Google Maps Review Extraction

### 1.1 API Endpoint: `/maps/rpc/listugcposts`

Google Maps 使用内部 RPC 端点 `/maps/rpc/listugcposts` 返回评论数据。响应以 `)]}'` 开头，去掉前缀后为 JSON。

- `data[1]` = 下一页分页 token
- `data[2]` = 评论数组
- 每条评论结构：`r[0][0]` = review_id, `r[0][1]` = 评论者信息, `r[0][2]` = 内容

### 1.2 排序参数决定分页深度

URL 中 `!13m1!1eN` 控制排序方式：
- `!1e1` = Most Relevant — 分页深度约 8,000 条后停止返回新结果
- `!1e2` = Newest — **可以遍历全部评论**，无深度限制

原因：Relevant 排序基于相关性评分索引，有深度截断；Newest 走时间戳索引，天然支持线性遍历。

**结论：始终强制 `!13m1!1e2`（Newest）以获得最大覆盖。**

### 1.3 pageSize 白名单

`!1i{N}` 控制每页返回数。经测试：
- `!1i10` 和 `!1i20` 有效
- `!1i50` 和 `!1i100` 返回空数组（不报错，静默失败）

Google 服务端有硬编码的合法值白名单。**固定使用 `!1i20`。**

### 1.4 capturedUrl 捕获策略

通过 `page.on('request')` 拦截浏览器发出的 `listugcposts` 请求获取 base URL，然后用正则替换参数。

关键：`capturedUrl` 应持续更新（取最新的），不是 `if (!capturedUrl)` 只取第一个——因为第一个可能是默认排序的 URL。

### 1.5 ~3000 条评论上限是浏览器问题，不是 API 限制

DOM 滚动方式在 ~3000 条后停止加载，是因为浏览器 DOM 渲染性能瓶颈，不是服务端限制。API 端点无此限制，22,000+ 条可完整获取。

### 1.6 ftid URL 需要两步加载

`0x...:0x...` 格式的 place_id 直接用 `?ftid=` URL 打开时，Google Maps 只渲染 Overview + About，不加载 Reviews tab。必须先访问搜索 URL 预加载，再跳转 ftid URL。

### 1.7 API 封禁检测

区分"正常分页结束"和"被封"：
- 空页出现时覆盖率 < 80% → 可能被封，暂停 30s 重试
- 空页出现时覆盖率 ≥ 80% → 正常结束
- HTTP 429/403 → 暂停 30s 重试，再次失败 fallback 到 DOM

### 1.8 内存管理

单个 page 爬取 18,000+ 条评论后，renderer 进程内存达 2.8GB。后续页面加载极慢或崩溃。

**解决方案：每个地点使用独立的 browser context + page，用完关闭。**

---

## 2. Google Maps POI Search (`tbm=map` 端点)

### 2.1 端点基本特性

`/search?tbm=map&q={query}&pb={params}` 返回结构化 JSON（`)]}'` 前缀），包含搜索区域内的 POI 列表。

- 每个视口返回最多 ~20 个结果
- 响应体 ~800KB，包含丰富的 place 数据
- 请求延迟 ~500ms

### 2.2 分页有效：`!8i{offset}`

在 `pb=` 参数中插入 `!8i{offset}`（在 `!10b` 前面），offset = 0, 20, 40, 60...

- 每页 20 个结果，最多约 7 页（~140 POIs）
- 页间零重叠（完全不同的结果集）
- 分页到 offset=120 后开始出现重复，offset=160 空

**之前测试"分页无效"的原因：pb= 参数结构不完整，Google 忽略了 `!8i` 字段。必须使用从浏览器拦截的完整 pb 模板。**

### 2.3 `!1d` 是 altitude（视口高度），不是搜索半径

`!1d{value}` 控制的是地图视口的海拔高度（英尺），不是圆形搜索半径。计算公式：

```
altitude = (27.3611 * EARTH_RADIUS * SCREEN_HEIGHT) / (2^zoom * TILE_SIZE)
```

不同 zoom 对应不同 altitude，决定了可见区域大小。

### 2.4 返回结果按距离排序

tbm=map 的结果按离视口中心的距离排序返回。这个特性是距离比（distance ratio）判据的基础。

### 2.5 `data[64]` 是结构化 place 数组

响应 JSON 中 `data[64]` 包含搜索结果列表。每个 place 在 `item[1]` 中，字段映射：

| 路径 | 字段 |
|------|------|
| `[10]` | place_id (ftid) |
| `[78]` | place_id (ChIJ) |
| `[11]` | 名称 |
| `[2]` | 地址（数组） |
| `[18]` | 完整地址 |
| `[9][2]`, `[9][3]` | 纬度, 经度 |
| `[4][7]` | 评分 |
| `[4][8]` | 评论数 |
| `[4][2]` | 价格区间 |
| `[13]` | 分类（数组） |
| `[14]` | 街区/区域 |
| `[7][1]` | 网站域名 |
| `[178][0][0]` | 电话号码 |
| `[30]` | 时区 |

**在 POI 搜索阶段直接提取这些字段，避免后续评论爬取时重复提取。**

### 2.6 正则 ftid 提取会混入非 POI 数据

旧版用 `text.match(/0x[0-9a-f]+:0x[0-9a-f]+/g)` 从 800KB 响应全文提取 ftid，会匹配到地图图层数据、URL 参数等非 POI 位置的 hex 字符串。Zagreb 测试中导致 11,455 个空壳 place（65%）。

**解决方案：只从 `data[64]` 提取，不用正则。**

---

## 3. 四叉树自适应细分

### 3.1 距离比（Distance Ratio）判据

`distRatio = 最远结果距离 / 视口半径`

| distRatio | 含义 | 实测覆盖率 |
|-----------|------|-----------|
| 0.32 | 结果挤在中心 1/3 | 6.6% (20/303) |
| 0.58 | 中等截断 | 21.5% (20/93) |
| 1.39 | 超出视口 | 57.1% (20/35) |

**验证结论：distRatio 与覆盖率强相关，可用于判断是否需要细分。**

### 3.2 分页后距离比判据失效

有了分页后（每个视口 ~140 POIs），距离比的意义下降。新逻辑更简单：
- 分页到最后一页不满 → 停止（覆盖完整）
- 分页到最后一页仍满 → 细分（可能有截断）
- 返回 0 → 停止（空区域）

### 3.3 spread 判停是 bug

`distRatio >= 1.0` 时直接停止是错误的。即使结果散布到视口外，分页仍能拿到更多 POI。

实测：sparse area distRatio=1.39 时，单页 20 → 分页 78（+290%）。

### 3.4 偏移网格有效（+21%）

四叉树扫完后，用半步偏移的网格做第二遍扫描，能捕捉到四叉树边界上的盲区 POI。

实测：标准 3x3 网格 631 POIs → 加偏移 3x3 网格后 765 POIs（+21%）。

### 3.5 格子重叠无效

有了分页后，每个格子能拿到 ~120 POIs，相邻格子的覆盖范围足够大。15% 格子重叠测试中 0 个额外发现。

### 3.6 Zoom 19-21 有效

| zoom | 对应高度 | 验证结果 |
|------|---------|---------|
| 18 | ~1577m | 有效 |
| 19 | ~788m | 有效，+9 独有结果 vs z18 |
| 20 | ~394m | 有效，+6 独有（递减） |
| 21 | ~197m | 有效，+2 独有（极少） |

---

## 4. Category 搜索策略

### 4.1 tbm=map 是文本搜索，不是类型过滤

搜索词经过 Google 语义引擎处理，不是精确的 place type 匹配。搜 `food` 能返回 restaurant、cafe、bakery 等——因为 Google 理解语义关联。

### 4.2 宽泛词极其高效

| 搜索词 | 效率 (POI/请求) | 新增 POI |
|--------|----------------|---------|
| `food` | 14.3x | 1,148 |
| `shopping` | 11.0x | 462 |
| `services` | 11.1x | 467 |
| `religion` | 9.2x | 406 |

18 个 Tier 1 宽泛词贡献了 ~56% 的总 POI，使用了 ~15% 的总请求。

### 4.3 形容词+主词 ≠ 主词

`office` 和 `Corporate Office` 返回的结果集**几乎完全不同**（重叠仅 19%）。Google 把它们当作不同的搜索意图处理。

| broad | specific | 重叠率 |
|-------|----------|--------|
| `office` | `Corporate Office` | 19% |
| `restaurant` | `Chinese Restaurant` | 11% |
| `clinic` | `Dental Clinic` | 0% |
| `store` | `Clothing Store` | 5% |
| `salon` | `Hair Salon` | 75% |

**结论：不能用主词替代具体组合词。每个组合是独立的搜索意图。**

### 4.4 Bus Station 异常

`Bus Station` 搜索返回 3,114 个新 POI，但其中 0 个以 "Bus station" 为主类别。Google 将其语义扩展为"交通枢纽附近的商户"，充当了一个意外的宽泛搜索词。

### 4.5 两层类别策略

- **Tier 1（18 个宽泛词）**：food, shopping, services, health, education, transport, lodging, entertainment, sports, finance, government, business, religion, culture, automotive, housing, nature, facilities
- **Tier 2（159 个具体类别）**：覆盖 Google 官方 472 个 Place Type 的高密度子类别

总计 177 个搜索词。基于 Google Place Types Table A 的 19 个大类全覆盖。

### 4.6 类别优化建议（基于 SF 数据）

**应移除（新增<50, 效率<1.5）**：Bus Stop(0), Motel(0), B&B(0), Shinto Shrine(0), Subway Station(18), Vegan Restaurant(13), Pub(26) 等 19 个

**应添加的宽泛词**：`salon`, `professional`, `contractor`, `station` — 对应高贡献的 Tier 2 集群

**Tier 2 中最有价值的**：Real Estate Agent(+1012), Clinic(+812), Hair Salon(+759), Park(+678), Dentist(+621)

---

## 5. 工程经验

### 5.1 流式写入防数据丢失

单个地点 18,000 条评论爬取需要 5+ 分钟。如果全部存在内存中，崩溃则全丢。

解决：`onFlush` 回调每 100 条写入 `.partial` 文件；正常完成后合并为完整记录。

### 5.2 pb= 模板必须从浏览器拦截

不能硬编码 pb= 参数。必须先加载一次 Google Maps 页面，通过 `page.on('request')` 拦截真实请求中的 pb= 模板，然后修改其中的坐标/altitude/offset 参数复用。

### 5.3 增量保存 + 断点续跑

POI 搜索：每 20 次请求保存 `poi_search.json`，按类别断点恢复。
评论爬取：每完成一个地点 `appendFileSync` 写入 ndjson，通过 `doneSet` 跳过已完成地点。

### 5.4 Stealth 是基础设施，不是核心策略

85+ 浏览器启动参数、canvas 噪声、WebGL 伪装等降低封号率，但不能替代对 API 机制的理解。真正决定覆盖率的是排序参数（Newest）、分页（!8i）、四叉树细分。
