# POI 采集：非搜索路径可行性实测 (poi-viewport-harvest)

> 目标：验证"不靠 category 搜索、改用 zoom-in / 拦截"能否更完整/更快地枚举 Google Maps POI。
> 结论（六轮实测）：**在 tbm=map 生态里，搜索是覆盖上限；所有 render/拦截路径要么返回 0，要么被 declutter 锁在 ~29%。**
> 测试区：新加坡牛车水（超密骑楼区）。所有脚本见 `scripts/probe-*.js`，报告 JSON 在 scratchpad。

## 背景：现状为何是"搜索"
`src/poi-searcher-api.js` 对 177 个 category 逐个当 `q=` 打 `tbm=map`，四叉树细分 + `!8i` 分页（~140/视口 cap）。覆盖率 = category 词表的并集。**软肋 = 依赖手工词表**（forensics：Singapore 实测 2,777 个真实 mainCategory，词表只有 177 个；70% 的类型、~49% 的 POI 质量靠 18 个宽桶的服务端语义扩展兜底）。

## 关键原语对比：为什么优雅方案移植不过来
| 3.2/3.3 (Insights API) 依赖 | Insights API | tbm=map |
|---|---|---|
| 免枚举拿 count | `INSIGHT_COUNT` ✓ | ✗（顶层 72 字段无计数字段，实测） |
| 主类型互斥划分 | `includedPrimaryTypes` ✓ | ✗（自由文本，重叠） |
| 残差探测 | `excludedTypes` ✓ | ✗ |
| 区域硬裁剪 | customArea 多边形 ✓ | ✗（viewport 只偏置排序，会 spread） |

## 六轮实测

### 1. 空/泛型 query (`probe-viewport-vs-search.js`)
- `q=""` / `" "` / `"*"` → **0**（`data[64]=null`，HTTP 200）
- `q="point of interest"` → 19，`q="establishment"` → 17（curated 单页，非全量）
- 结论：tbm=map 是相关性文本后端，无 query 即无结果。

### 2. cap-hit 自适应桶调度 (`test-adaptive-scheduler.js`)
- 350m cell：FULL(176 类)=15357，ADAPTIVE(tier1 ∪ 撞cap桶的tier2)=11360 → **保留 74%，请求只省 27%**。亏。
- 铁证 cap-hit ≠ 完备：`government` 返回 44、**没撞 cap**，但子类 `Post Office` 仍 +135、`Embassy` +125。"桶没满"不代表"抓全"。

### 3. 矢量瓦片解码 (`probe-vt-decode.js` / `probe-proto-tiles.js`)
- 一个小片区 zoom = **277 瓦片 / 14.9MB**。
- `proto` 标注瓦片：XOR key=0xD9 解出 96% 可读，但**全是打包坐标几何**（`6GC6GC…`）；扫遍 256 个 XOR key，**0 个地标名**。
- `icon`/`texture` = PNG（标注是**栅格像素**）。每瓦片仅 1 个 ID token = 瓦片版本号，非 POI ID。
- **瓦片 zoom 封顶 z21**；z22+ 只放大像素、不加数据。

### 4. reveal/click (`probe-hover-click.js` / `probe-reveal.js`)
- 点一个没搜过的 dot → `/maps/preview/reveal`(坐标→**1 个 ftid**) → `/maps/preview/place`(ftid→详情+名字)。
- `reveal` 每次只回 1 个 ftid，**无批量**。名字是点击时按 ftid 现 fetch 的，不在瓦片里。

### 5. 客户端内存/网络拦截 (`probe-client-memory.js` / `probe-memory-deep.js`)
- JS 内存**确实**持有 POI ftid（要素数组 `window._…service.U[i]`），平移会累积 → **机制成立、keyword-free**。
- 但**后台无批量 ftid feed**（平移只发瓦片+遥测）；`APP_INITIALIZATION_STATE` 无 POI。

### 6. 完整性对比 (`probe-completeness.js` / `probe-zoom-sweep.js` / `probe-finegrid2.js`)
| 100m 牛车水 cell | 框内 POI |
|---|---|
| 搜索 177 类（raw 16473 → 裁剪） | **146–150** |
| 平移+内存 z21（粗平移） | **40** |
| **细网格 z21（81 点 @12.5m）** | raw 199 → **裁剪框内 42** |
| 大牌档 70m cell：搜索 73 / render | **14** |

- 细网格 raw(199) 看着超搜索，但**裁剪到框内只剩 42**——多出的 157 全是**框外 spread**。粗 64raw→40，细 199raw→42：**多扫 135 个 raw，框内只多 2 个**。→ 细网格**不能破 declutter**（declutter 按视口标签密度选，平移同 zoom 不改密度，数据又封顶 z21）。
- render 独有真实 POI ≈ **0**，是搜索的严格子集。

### 类别分布：render 丢的是什么 (`probe-categories.js`)
- 同框：搜索 150 / 渲染 40 / **搜索独有 110**。
- 110 个 render 漏掉的：零售小店 34、杂项专业服务长尾 35、个人服务 15、餐饮 12、办公 10、住宿 4（手信店、美容院、中医馆、翻译社、批发商、联合办公…）。
- render 只画显眼门面（tourist attraction / hotel / mall / 知名 café）。
- **结构性原因**：骑楼**一址多商户**（楼上楼下叠好几家），地图一个点只画得下 1 个标签，其余物理上画不下 → 无论多深 zoom / 多细网格都拿不到。

## 总结论（枚举侧）
- **要全** → 只能搜索（render 天花板 29%，且丢的正是"一址多商户"长尾）。count 驱动的不重不漏只有 Insights API 能给。
- **要快** → 分片并发压墙钟（ual-chark 已有），换 render 反而又慢又缺。
- **搜索的真软肋 = category 词表依赖**（跨城/跨语言适应差）→ 由 Round 7 解决。

## Round 7（构造性结论）：自适应类别发现闭环 (`probe-typeagnostic.js` / `probe-selfadapt.js`)
先否一条：**类型无关的 query 不行**——14 个类别无关种子（字母/`pte`/`店`/街道词）并集只有 32/146 = 22%；`pte` 最高（137 返回、68 类、27 框内），但单 token 名字匹配比类别还差。**没有"一个 query 吐全部"的原语。**

**但真正的解法成立**：用 Google 自己返回的 mainCategory(`p[13]`)/GCID(`p[76]`) 做自发现闭环。
- **8 个通用种子词**（restaurant/shop/store/service/clinic/office/salon/hotel）、**零 taxonomy** → 100m 框内 **145**，对比手工 177 表 **149**，几乎打平。
- **且未收敛**：170 query 时框内仍单调爬升（81→106→117→133→145），队列还剩 **722** 个类别 → 补预算会反超。
- **真自适应**：170 个搜过的里 **139 个不在 177 表**，全是本地真实类型（Hawker Stall / Modern izakaya / Feng shui consultant / Chinese medicine store / Herb shop / Tattoo shop / Sichuan·Filipino·West African restaurant …）。
- **捞回长尾**：disc-only 28 个 177 漏掉的 POI（Feng shui consultant / Herb shop / Tattoo shop / Manufacturer / 各类 wholesaler·supplier / Advertising agency）。

**结论**：枚举仍靠 search（无法绕开），但 **category 词表依赖这个真软肋被消掉**——自发现闭环语言/城市无关、还能捞长尾。
**产品化要补**：(1) 队列按产出优先级排序；(2) GCID 去重（非显示串，跨语言）；(3) 边际产出截断；(4) 复用现有四叉树/分页/去重/boundary 裁剪。
