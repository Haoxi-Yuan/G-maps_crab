# POI 采集：非搜索路径可行性实测 (poi-viewport-harvest)

## Reviewer 主页补充采集（2026-08-24 实测）

Reviewer 页面不是复用地点评论的 `qv9Egd` RPC，而是在页面预加载时请求
`/locationhistory/preview/mas?pb=...`。响应带 XSSI 前缀并使用 protobuf 风格的
JSON 数组。小响应的公开内容位于字段 45；大响应会把字段 46 序列化为稀疏对象。

目标 `reviews.ndjson` 共恢复并读取 1,819 个地点记录（其中 4 个旧记录含裸换行），
扫描 260,869 条地点评论，得到 186,247 个唯一 Google reviewer；另有 242 条
外部或无效主页链接被明确跳过。

真实主页验证：

| Reviewer | 公开评价 | 总评价贡献 | 请求结果 | 结论 |
|---|---:|---:|---:|---|
| Faylinn Wang | 7 | 7 | 7 | 可完整获取 |
| Forest BK | 1,030 | 1,098 | 200 | 服务上限 |
| Flo Y. | 5,825 | 5,882 | 200 | 服务上限；200/200 坐标齐全 |
| Khanh Dinh | 5,858 | 8,265 | 200 | 服务上限；200/200 坐标齐全 |
| Ak | 10,395 | 10,549 | 200 档为空、100 档成功 | 媒体量大时有效上限会下降 |
| Carbo Kuo (BYVoid) | 0（主页隐藏） | 14,429 | 0 | 只能取得统计，不能取得隐藏历史 |

Ak 的 100 条真实响应中有 99 条正文、100 条商家坐标、68 条结构化回答；其中
Order type 36 条、Price per person 52 条、Recommended dishes 2 条。Food、
Service、Atmosphere 分数也能解析。原始结构化回答同时完整保留，避免只依赖便捷
字段。

100 与 200 档均在不同主页上验证成功；500、1,000、2,000 档只返回个人统计而无评论
内容。因此仅当返回数覆盖公开数时才可声称“全部”；其余结果必须标记
requested/service cap。详细契约见 `docs/REVIEWER_PROFILES.md`。

> 上节里“两个 pb 数量字段必须同时修改”的说法已被 2026-08-24 的复测推翻，见下节。

## Reviewer 200 上限边界复测（2026-08-24）

对象 102873738934801008402（公开计数 10,400、贡献总数 10,554），逐项打靶而不是
推断：

| 试探 | 结果 |
|---|---|
| 页大小 200 | 200 条 |
| 页大小 201 / 250 / 300 / 500 / 1000 | 0 条，HTTP 仍是 200 |
| 关掉评论媒体后再取 201 | 仍然 0 条 → 与响应体积无关，是服务端硬校验 |
| 续页 token | 评论数组旁的 `publicContent[1]` 恒为 null |
| 在字段 41 内注入偏移（`3i`/`4i`/`5i`/`6i`/`8i`/`9i`/`10i`=200） | 响应字节数与基线完全相同（8,362,988）——未知字段被静默忽略 |
| 字段 41 的模式枚举 `!7m2!1m1!1e2` | 返回的是照片贡献而非另一种评论排序（rating 全 null、正文 3/200）；`1e3`~`1e12` 返回 0 |
| 地图视口 `/@lat,lng,zoom` | 视口确实进了 pb，但返回集合逐条相同，不过滤 |
| 开关扫描：字段 41 的 `2b`/`3b`/`7b`/`4m1!1e*`，顶层 `10m5` 的 `1b`/`5b`/`11b`、`9m1!1e*`、`6m2` 的 `4b`/`7b` | 窗口每次都一样（同一 firstId、同一尾部时间） |

**匿名主页本身只是预览**：页面只渲染 10 条，滚到底不再发任何请求，headless 与
有头浏览器结果一致。

**排序键是 `max(published, edited)` 降序**：用该键校验 200 条序列得 0 个逆序，
而单用发布时间有 16 个——被编辑过的旧评论会重新排进窗口前部。因此每条评论新增
`last_modified_at` 字段。

**200 条窗口覆盖多长时间**取决于发帖速率：10,400 条的人只覆盖 25.8 天，
3,088 条的人覆盖 100.5 天，2,834 条的人覆盖 1,974 天。

**受影响面**：berlin 评论库 11,521,913 行、4,038,136 个唯一 reviewer 中，公开
评论数 ≤200 的占 **97.81%**（3,949,778 人），201–1,000 占 2.13%，1,001–5,000 占
0.06%，>5,000 只有 10 人；来自 >200 那部分的评论行占 9.4%。之前 100 人实验全部
命中 `service_cap`，是因为那批人是按评论数降序专门挑的极端样本，不代表总体。

### 两个被推翻的旧结论

1. `!4m1!3i<n>` 不是第二个评论数量字段。固定页大小 50、把它扫过 0/1/3/10/50/200，
   返回评论数、解析出的图片总数（961）、单条最多图片数（50）全部不变，只有响应
   体积从 2.18MB 涨到 3.02MB——它选的是每个媒体项的图片规格。生产代码原先把它
   一起设成页大小，等于白付流量，已改为不再改写。
2. “计数 > 0 就说明主页可见”不成立。108984331081035263485 计数 4,269，但
   200/150/100/50/25 每一档都返回 0 条，Google 页面写的是 “This person hasn't
   written any reviews yet, or has chosen not to show them on their profile”。
   这类记录原先被误标为 `service_cap`（终态、不重试），现已归入
   `private_or_hidden`。

### 一个可选的省流开关

字段 41 的 `5b` 控制是否下发评论媒体。关掉后 50 条评论的 978 张图归零，正文、
翻译、坐标、place_id、品类、结构化回答、商家回复全部保留，体积从 2.26MB 降到
0.31MB。已作为 `--no-review-media` 暴露，默认不开启。

### 结构化问答标签

50 条样本里就出现 14 种 question id，横跨 `GUIDED_DINING_*` 和 `HOTELS_*`，而
`review_details` 原先只映射 9 种。已补上 `seating_type`、`noise_level`、
`reservation`；非餐饮家族保留在 `structured_responses` 里，不进便捷字段。

Google 只下发被选中的选项，从不下发候选全集，所以标签全集只能实证枚举，且必须
连同收敛曲线一起报告：`scripts/analyze-structured-responses.js`。

## Reviewer 单 IP 并发与多 Chrome 上限（2026-08-24）

在 ual-chark 的四个全量生产分片继续运行时，用同一 reviewer 样本、同一 150ms 全局
request-start gate 和相同解析/重试设置做顺序平衡 A/B。总并发 9 时，1/2/3 个
Chromium 的均值分别是 86.028/87.261/86.876 profiles/min；总并发 27 时分别是
142.867/139.588/135.373，单 Chromium 的吞吐和 p95 都最好。测试期间主机仍有
70–76% idle CPU 和约 194GiB 可用内存，所以多 Chrome 没有解除主机瓶颈，反而损失
连接池/cache 复用；同一公网 IP 的上游预算不会随进程数翻倍。

最终 200-reviewer 单 Chromium staircase 在并发 27/30/33 的中间 80% 稳态吞吐为
168.020/167.157/169.085 profiles/min，三档均 100% HTTP 成功、0 throttle、逐 reviewer
状态/返回数完全一致（均 12,816 条 review）。吞吐从 27 起已平台化，而 p50 继续上涨，
因此 419 万持续队列的有效点是 **1 Chrome + 27 in-flight + 全局 gate**；这不是 Google
封禁阈值，33 仍未出现 403/429/CAPTCHA。

一个三 Chromium、并发 30 的窗口在 HTTP 成功率和状态分布看似正常时少返回 50 条，
证明“请求成功”不等于“数据完整”。benchmark 现已逐阶段原子 checkpoint，并用
`content_mismatches` 比较每个 reviewer 的 status/returned count；
`--stop-on-unsafe` 会在内容漂移、错误或 throttle 时停止。

把 4,191,230 人压进 30 秒需要 139,708 profiles/s。按实测约 169/min/IP，纯算术下界
是约 4.96 万个独立出口容量单元和约 134 万 in-flight；样本均值还意味着约 2.69 亿条
review、近 900 万条/s。这个数量级未计连接、响应带宽、解析、写盘、上游执行限制与
适用规则，不是可行部署方案。单出口的稳态下界约 17.2 天，100 个约 4.1 小时，
1,000 个约 24.8 分钟。

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
