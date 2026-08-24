# 服务器连接与数据位置

> 最后更新: 2026-08-16

同校园内网两台机 (均需先开校园 VPN):

| 机器 | IP | 用途 |
|---|---|---|
| `ual-chark` (本机) | `10.192.132.2` | 项目根 `/data/haoxi/`, 有 RTX 5090 GPU |
| `ual-strix` (新加坡) | `10.192.132.3` | 项目根 `/data2/shared/haoxi/CLI_scraper/`, gmaps 抓取 |

NUS Atlas HPC 登录节点（需校园网络或 NUS VPN）：

| SSH 别名 | 主机 | 用途 |
|---|---|---|
| `nus-atlas8` | `atlas8.nus.edu.sg` | Atlas 登录节点；传文件、编辑脚本、提交 PBS 作业 |
| `nus-atlas9` | `atlas9.nus.edu.sg` | Atlas 登录节点；传文件、编辑脚本、提交 PBS 作业 |

**NAS** (挂载在 ual-strix): `/mnt/home/haoxi/` → Synology `10.246.164.52:/volume2/homes` (50T 共享卷)。
⚠️ strix 本地盘 `/data2` 已 99% 满 (剩 ~270G), 大文件一律放 NAS。

---

# 通用服务器部署经验与检查清单

本节适用于独立服务器、实验室工作站和 PBS/Slurm HPC。具体机器的地址、配额和
命令仍以各自章节为准。核心原则是把“连接成功”“环境可运行”“任务可恢复”及
“结果可信”分别验收，不能只凭进程存在或日志仍在增长判断部署成功。

## 1. 先区分控制面与计算面

- **控制面**只负责 SSH、传输代码、提交/取消任务、读取小型状态文件。HPC 登录
  节点属于控制面，不得直接运行爬虫、浏览器、建库或长时间分析。
- **计算面**才执行实际任务：独立服务器上通常是 `tmux`/受控后台进程，HPC 上
  必须是 PBS/Slurm 分配的计算节点。
- **数据面**单独规划：代码、输入、临时文件、运行输出和最终归档不要混在同一
  目录。服务器“CPU 很多”并不代表登录节点资源可独占，也不代表存储足够快。
- 调度环境以 `qstat`/`squeue` 为作业状态权威来源；进程 sidecar 只用于解释任务
  内部进度。独立服务器则以真实 PID 加完成标记共同判定。

## 2. 首次部署必须完成的环境探测

至少记录以下信息，并标注“配置上限”还是“本次实测”：

| 类别 | 必查项 |
|---|---|
| 连接 | VPN/校园网要求、DNS/IP、SSH 别名、认证方式、跳板机 |
| 系统 | 主机名、OS/kernel、架构、时区、shell、locale |
| 资源 | 可调度 CPU/内存/GPU，而非只看登录节点硬件 |
| 存储 | 各挂载点容量、个人 quota、inode、清理/备份策略、实际写权限 |
| 运行时 | Node/Python/Conda、包版本、浏览器及系统库、容器运行时 |
| 网络 | 目标站点 DNS/TLS/HTTP、代理、出口地区、限流或 CAPTCHA |
| 限制 | 最大作业数、CPU-hours/GPU-hours、walltime、文件描述符、进程数 |

```bash
# 通用轻量探测；不要在共享盘上直接执行 du -sh /
hostname
id
uname -a
date -Is
getconf _NPROCESSORS_ONLN
free -h 2>/dev/null || vm_stat
df -h <WORK_ROOT> <SCRATCH_ROOT>
df -i <WORK_ROOT> 2>/dev/null
ulimit -a
command -v node python3 jq singularity qstat squeue
```

`test -w <目录>` 不能完全代表能够创建新文件；ACL、quota 和 NAS 映射可能仍然
拒绝创建。应在指定工作目录实际创建并删除一个小型探针文件/目录，再开始大任务。
测试必须局限在自己的目录，不能用 `sudo` 或修改共享目录权限来绕过问题。

## 3. SSH 与非交互环境

- 为每台服务器建立稳定的 `~/.ssh/config` 别名，明确 `User`、`HostName`、
  `IdentityFile` 和 `IdentitiesOnly yes`。后者可避免客户端尝试过多密钥导致
  `Too many authentication failures`。
- 自动监控和批处理使用 `BatchMode=yes` 与有限 `ConnectTimeout`，不能卡在密码
  提示。密码、令牌和 cookie 不得写入仓库、job script 或日志。
- 交互式 shell 可用不代表后台任务环境正确。脚本必须显式设置 `PATH`、NVM/
  Conda、`PLAYWRIGHT_BROWSERS_PATH`、`TMPDIR` 和 locale，不能依赖 `.zshrc`。
- 长期监控应由应用持有独立 SSH control connection；短采样复用 channel。不要
  让带 stdout pipe 的一次性采样进程兼任 `ControlPersist` 主连接，否则完成信号
  可能迟迟无法返回。
- SSH 输出可能超过 pipe 缓冲区。父进程必须在子进程运行期间持续排空 stdout 和
  stderr，不能等子进程退出后才读取，否则会出现“远端已完成、本地一直等待”。

## 4. 可复现的代码和运行环境

- 只同步任务需要的文件，不直接复制整个脏工作区。远端无 Git 时至少保存：输入
  文件 SHA-256、核心脚本 SHA-256、依赖锁文件、容器镜像版本和提交时间。
- 每次运行使用独立 run directory；新输入不得复用旧 checkpoint/`places.ndjson`，
  除非程序明确验证输入哈希一致。`--fresh` 只有在确认会清理全部相关产物时才安全。
- 系统运行时版本不可靠时优先使用锁定版本的容器或项目内环境。容器部署仍需验证
  bind mount、用户 UID/GID、浏览器可执行文件和宿主机内核兼容性。
- 启动前做一次最小 import/launch 探针，例如加载 Playwright、打开一个页面、写入
  一条 sidecar 后正常退出；不要把正式批次当环境测试。
- 记录 builder/程序版本和输入哈希到 manifest，结果才能追溯到确切代码与输入。

## 5. 存储分层与 I/O

- `home`：SSH 配置、代码、小型 manifest；不要放大数据或浏览器缓存。
- 节点本地 `/tmp`/scratch：浏览器 profile、解压、SQLite 临时文件及高频随机 I/O。
- 共享 scratch：作业输入、checkpoint 和结果中转；注意 quota、inode 和自动清理期。
- NAS/归档盘：最终大文件；先确认创建权限、吞吐和剩余容量，不适合高频小文件写入。
- 任务前估算“输入 + 输出 + 临时峰值 + 安全余量”，并设置低空间自动停止阈值。
- 共享盘状态检查优先 `stat`、`ls -l`、小 sidecar；避免频繁 `du`、全文件 `grep`、
  `wc -l` 大 NDJSON 或遍历数百万图片。
- checkpoint/manifest 用“写临时文件 → `fsync`/关闭 → 原子改名”发布，避免监控器
  读取半个 JSON。最终结果先在目标文件系统内完成原子切换，再对外标记完成。

## 6. 并发必须实测，不按核心数猜测

按 `1 → 2 → 4 → 8 ...` 逐级增加并发，每一级都记录：

- 单位时间成功量、失败/重试率和延迟分位数；
- CPU、RSS/峰值内存、文件描述符和进程数；
- scratch/共享盘 IOPS、网络吞吐和上游限流/CAPTCHA；
- 资源增加后吞吐是否仍近似线性增长。

浏览器任务通常先受内存、远端限流或存储元数据影响，而不是 CPU。达到吞吐拐点、
错误率上升或节点开始 swap 时应退回上一级。HPC 若规定每个作业有最小 CPU 申请，
应把多个 worker 组织成少量 group job，避免大量小作业占满个人作业数额度。

正式放量顺序应为：环境探针 → 单 worker canary → 小批次并发 → 正式批次。探针
通过只代表当时出口和环境可用，不代表可以无限加并发。

## 7. 分片、依赖与可恢复性

- 分片算法必须稳定：相同输入、相同总 shard 数应得到相同归属；在 manifest 中记录
  shard 总数和映射规则。每个 shard 使用独立日志、checkpoint 和完成标记。
- worker 应幂等：重启只补未完成部分，输出以稳定业务键去重，不能依赖
  `INSERT OR REPLACE` 静默覆盖未知字段。
- 多阶段流水线必须用机器可验证的就绪条件，而不是 `sleep` 或仅看退出码。若下游
  Review 支持逐边界等待，POI 与 Review 可以同时提交：有 `_area_complete.json`
  的边界立即开始，POI group terminal 后才允许消费已有的部分 `places.ndjson`；
  未就绪输入不能静默跳过。全局 validation 可保留为审计，但不必作为启动闸门。
- PBS/Slurm 的 `afterok` 适合“任一上游失败就停止”；`afterany` 只适合下游能够逐个
  识别成功 shard、跳过半成品并明确汇报缺失项的场景。
- Shell supervisor 使用 `set -Eeuo pipefail`。`node ... | tee log` 若没有 `pipefail`，
  Node 失败可能被 `tee` 的退出码 0 掩盖。
- 提交前按稳定 job name/run ID 检查重复任务，提交后保存全部 job ID。取消时只使用
  本次 manifest 中的 ID，不能模糊匹配或触碰其他用户/项目任务。
- 正常完成、失败和人为取消必须是三种可区分状态；PID 消失、日志不再增长都不等于
  正常完成。

## 8. 低开销监控契约

每个 worker 建议原子更新一个小型 JSON sidecar，至少包含：

```text
run_id / host / stage / shard / pid_or_job_id / state
input_hash / builder_version / started_at / updated_at
current_item / completed / total / output_bytes / error_count
```

- 监控读取 scheduler/PID 与 sidecar，不重复解析完整 NDJSON 或大日志。
- 调度器查询慢时，将 `qstat`/`squeue` 与高频进度采样拆成两个不重入探针；调度状态
  可低频缓存，任务内部进度可较高频读取。
- UI 只保留最新对象和有界时间序列；评论正文、日志和图片不得在内存中持续累积。
- 监控失败不能影响生产任务。sidecar 缺失、SSH 离线和任务失败必须在 UI 中分别
  表示，不能把“暂时读不到”显示成“任务完成”。

## 9. 数据质量与完成验收

部署完成至少要通过以下验收：

1. 输入文件数量、大小和 SHA-256 与 manifest 一致。
2. 所有预期 shard/类别都有终态，且失败列表为空或被明确接受。
3. 输出能逐行解析；关键主键非空，重复率、空值率和记录数量处于合理范围。
4. 上下游数量可以对账，例如 POI 输入数、Review 已处理 POI 数、评论/图片总数。
5. 随机抽样若干记录做真实业务验证，而不仅验证 JSON/SQL 语法。
6. 模拟中断并重启一次，确认不会重复覆盖、混入旧 run 或从头重跑。
7. 结果拉回后再次核对大小和哈希；重要数据至少存在两个独立存储位置。
8. 只有完成标记、退出状态和数据质量检查同时通过，才标记任务完成。

## 10. 标准交付信息

每次服务器部署完成后，至少留下这些信息，避免任务只能由部署者本人维护：

- SSH 别名、项目根、run directory、输入和输出绝对路径；
- 启动/恢复/查看/停止命令，以及 scheduler job ID 或 tmux session；
- 程序版本、依赖/容器版本、输入哈希、并发和资源申请；
- sidecar、日志、manifest、失败清单与完成标记位置；
- 当前进度、正常完成判据、已知风险、空间阈值和数据拉回路径。

---

# 本机: ual-chark

## SSH 连接

| 项 | 值 |
|---|---|
| 主机名 | `ual-chark` |
| 用户 | `haoxi` |
| IP | `10.192.132.2` (内网 IP, **连接前必须先开校园 VPN**) |
| 登录 | `ssh haoxi@10.192.132.2` |
| 项目根 | `/data/haoxi/` |

**硬件 / 环境**:
- OS: Ubuntu 24.04.3 LTS (kernel 6.17), x86_64, 64 核, 251 GB 内存。
- GPU: 1× NVIDIA GeForce RTX 5090 (32 GB)。
- 磁盘: `/data` 挂载 11 TB (`/dev/sdc2`, 已用 5%)。
- 无 passwordless sudo。系统 node 为 v18 (`/usr/bin/node`)。
- Conda: `/data/haoxi/miniconda3/` (conda 26.3.2), 目前仅 `base` 环境。
  ```bash
  source /data/haoxi/miniconda3/bin/activate   # 激活 base
  ```

## 项目文件夹 (本机)

```
/data/haoxi/
├── miniconda3/          # conda 安装 (base 环境)
├── CLI_scraper/         # gmaps 抓取 (2026-08-17 部署, 见下节)
└── SERVER.md            # 本文件
```

⚠️ chark 是共用工作站, 不是独占机: 常驻他人任务 (koichi 的 GPU 训练、wenpei 的
图片管线), 基线 load 约 14-18/64。起 worker 前先看 `uptime`, 不要占满。

## sg_parks_473 评论抓取 (2026-08-17 从 Atlas 迁入)

Atlas 的 review 阶段按 area 分片, 而 473 个 area 的 POI 数差 4 个数量级
(`jurong_hill_park` 17887 vs `pulau_unum` 2), 巨型 area 被钉死在单个 worker 上,
5 小时只推进到 272/15754, 整批无法收敛。改为**先摊平去重再按工作量配平分片**。

- 出口: chark 公网 IP `137.132.213.207` (NUS 新加坡), Google Maps 直连 200, 无 GFW 问题。
- Node v18.19.1 (系统自带, 无 nvm), Playwright 1.57.0, 浏览器在 `~/.cache/ms-playwright`。
- 运行目录: `/data/haoxi/CLI_scraper/output/sg_parks_473_flat/`

```
sg_parks_473_flat/
├── places.ndjson            # 46238 唯一 POI (473 area 摊平去重, 原 92331 行)
├── place_area_map.tsv       # placeId -> 所属 area 列表, 去重后用它还原归属
├── reviews.prior.ndjson     # Atlas 已抓的 744 MB, 仅作 resume 依据
├── launch.sh                # 4 worker 启动器
└── shards_4/
    ├── places.part-{0..3}.ndjson    # 各约 10640 POI, 按 expectedReviews 配平
    ├── reviews.part-{0..3}.ndjson   # 产物
    ├── reviews.part-{0..3}.live.json
    ├── shard-manifest.json          # 输入 SHA-256 + 分片统计
    └── pids.txt
```

重建分片的两步 (输入哈希记录在 `shard-manifest.json`):

```bash
node scripts/merge-batch-places.js \
  --batch output/_batches/sg_parks_473 \
  --out-places output/sg_parks_473_flat/places.ndjson \
  --out-reviews output/sg_parks_473_flat/reviews.prior.ndjson \
  --out-map output/sg_parks_473_flat/place_area_map.tsv

node scripts/shard-review-input.js \
  --places output/sg_parks_473_flat/places.ndjson \
  --reviews output/sg_parks_473_flat/reviews.prior.ndjson \
  --out-dir output/sg_parks_473_flat/shards_4 --shards 4 --max-reviews 50000
```

| 项 | 值 |
|---|---|
| 启动 | 2026-08-17 19:39, tmux `gmaps-rev-sgparks` |
| 输入 | 42616 个未完成 POI (46238 唯一 - Atlas 已完成 3622) |
| 实测速率 | 21.8 POI/min (4 worker), ETA 约 32 小时 |
| 封锁率 | 约 6%, 脚本自动 30s 退避 |
| 恢复 | 重跑上面两步 + `bash output/sg_parks_473_flat/launch.sh`, 已完成的自动跳过 |
| 完成判据 | 4 个 log 末尾都出现 `Processed: N/N`; 只看进程消失不算 |

### part-0 重启与混版状态 (2026-08-18 14:37)

part-0 (PID 469541) 在 Lime Restaurant (11458 条评论) 上无限卡死: 实测 180 秒
零推进, 日志与 sidecar 同时静默。根因是 `page.evaluate` 内的 fetch 没有超时,
上游挂起响应就一直等 (见 `src/api-review-fetcher.js` 的 `postBatchPage`)。

- SIGTERM 触发了恢复路径, 已抓的 8760/11458 条正常落盘, partial 文件被清理,
  输出文件以换行结尾无截断。SIGTERM 不退再补 SIGKILL。
- 重启前只同步了 `src/api-review-fetcher.js` (45s fetch 超时 + 10s 退避),
  `review-scraper.js` 本就一致。

⚠️ **本次运行跨两个代码版本**, 分析产物时必须按 worker 区分:

| worker | api-review-fetcher.js | 退避 | fetch 超时 |
|---|---|---|---|
| part-0 (2026-08-18 14:37 起) | `d44e89ead3e75f52` | 10 s | 45 s |
| part-1/2/3 (2026-08-17 19:39 起) | `d9023561f743a729` | 30 s | 无 |

part-0 不再受 `launch.sh` 管理, 是独立的 setsid 进程; 停它用 pkill 匹配
`places.part-0`。重启命令与日志分隔标记都记在 `reviews.part-0.log` 里。

续跑实测: `Resuming: 1644 places already done`, 随后只回补 7 条标了
`_network_error` 的失败记录 (日志里 index 会跳跃, 属正常)。回补会在文件尾
追加新记录, 与旧的失败记录形成同 placeId 重复; `merge-review-shards.js` 按
placeId 去重且后出现的胜出, 因此最终产物取到的是完整那条。

跑完后用 `scripts/merge-review-shards.js` 合并 4 份, 再按 `place_area_map.tsv`
还原到 area 维度。

---

# ual-strix (新加坡)

## SSH 连接

| 项 | 值 |
|---|---|
| 主机名 | `ual-strix` (新加坡机, 出口不被 GFW 挡) |
| 用户 | `haoxi` |
| IP | `10.192.132.3` (内网 IP, **连接前必须先开校园 VPN**) |
| 登录 | `ssh haoxi@10.192.132.3` (已配公钥免密) |
| 项目根 | `/data2/shared/haoxi/CLI_scraper/` |

**Node**: 不在系统 PATH (系统 node 是 v12 太老)。用 nvm:
```bash
export NVM_DIR=$HOME/.nvm && . $NVM_DIR/nvm.sh   # → node v24.13.0
```
- 无 conda、无 sudo。Playwright 系统库 (libnss3/libgbm/libxkbcommon/libasound) 系统已自带。
- Playwright 浏览器路径: `export PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright-browsers`

## 数据位置 (服务器)

```
/data2/shared/haoxi/CLI_scraper/
├── data/
│   ├── paris/            # POI 边界 geojson + 采样点
│   └── berlin/
└── output/
    ├── zagreb/
    │   ├── places.ndjson         # POI 21360
    │   └── reviews.ndjson        # ✅ 完成, 已拉回本地 (205万评论)
    ├── berlin/
    │   ├── places.ndjson         # POI 104122
    │   ├── reviews.ndjson        # ✅ 完成 11 GB, 已拉回本地 (1160万评论)
    │   └── reviews.log
    ├── paris/
    │   ├── places.ndjson         # POI 101365
    │   ├── reviews.ndjson        # 🔄 运行中 (未完成)
    │   └── reviews.log
    └── singapore/
        ├── places.ndjson                    # POI 148454
        └── review_shards_4_20260814/        # ✅ 完成, 已拉回本地 (1071 万评论)
```

本机对应目录: `/Volumes/Data/CLI_scraper/output/`

## singapore 评论 (2026-08-14 → 08-18, 已拉回)

4 路分片跑完并已拉回 `output/singapore/review_shards_4_20260814/`。
爬取时间、逐分片统计和输入/代码哈希都在该目录的 `crawl-manifest.json` 里。

| 项 | 值 |
|---|---|
| 爬取窗口 | 2026-08-14 13:28:41 → 08-18 17:53:32 (+08), 墙钟 100.4 h |
| 覆盖 | 148452 / 148454 POI (99.999%), 全部 4 个分片 `rc=0` |
| 评论总数 | 10,715,789 |
| 体积 | 13.1 GB (4 个 `reviews.part-{0..3}.ndjson`) |
| 校验 | 24 个文件 SHA-256 与 strix 逐一比对一致; 148454 行 = 148454 唯一 placeId, 0 重复, 0 缺 placeId |
| 失败 | 2 条: `PCF Canberra Blk 468D` (Target crashed)、`Ban Kim Chuan Enterprises` (page.goto 超时, 已标 `_network_error`, 重跑会自动回补) |

分片间 placeId 无重叠, 合并即拼接; 需要单文件时用
`scripts/merge-review-shards.js` (按 placeId 去重, 后出现的胜出)。
rsync 用了 `-rtz` 保留 mtime, 所以每个文件自带各自分片的完成时刻。

## 运行状态 (tmux)

| 会话 | 状态 |
|---|---|
| `gmaps-rev-paris` | 已结束 (2026-07-12 时会话已不在) |
| `gmaps-rev-berlin` | ✅ 完成 (node 已退, 会话卡在结尾 read, 可 kill) |
| `imgdl` | 🔄 2026-07-12 启动: paris+berlin 全量图片下载 → NAS |
| `gmaps-rev-singapore-4way` | ✅ 2026-08-18 完成 (4 分片 rc=0, 数据已拉回本地) |

⚠️ 同机有别人的 tmux 会话 `peng_glm_train`, **勿碰**。

## ⚠️ 评论排序截断: 2026-08 Singapore 只抓到 65% 的根因 (2026-08-19 定位)

**结论: 是代码回归, 不是 Google 改版, 也不是封锁。**

Google 评论有四种排序, 编码在 batchexecute 请求体 `f.req` 的 `inner[12]`:
`[1]`=Most relevant、`[2]`=Newest、`[3]`=Highest、`[4]`=Lowest。
**"Most relevant" 是 Google 有意截断的精选子集**, 分页走到底会返回一个空页且
token 为空, 看起来像干净的自然结束。

`buildPaginatedBody()` 原本只改写 `inner[1] = [pageSize, token]`, 从不设置
`inner[12]`, 于是每次请求都沿用 UI 默认的 Most relevant。

GET 时代 (`7ee2f29`, 2026-04) 的实现是强制排序的, 且默认就是 newest:

```js
const sortNumMap = { newest: 2, relevant: 1, highest: 3, lowest: 4 };
const sortNum = sortNumMap[reviewSort] || 2;          // 默认 newest
baseUrl = capturedUrl.replace(/!13m1!1e\d+/, '!13m1!1e' + sortNum);
```

Google 停用 `/maps/rpc/listugcposts` GET 端点后改写到 batchexecute POST, 这个
强制排序**没有被移植**, 四月 98.58% 的覆盖率因此掉到八月的 65.26%。

单店 A/B 实测 (同一代码路径, 只翻转排序):

| 店 | 页面显示 | relevant | newest |
|---|---:|---:|---:|
| Marsiling Market & Cooked Food Centre | 2,475 | 823 (33.3%) | **2,475 (100%)** |
| Sri Layan Sithi Vinayagar Temple | 2,492 | 1,128 (45.3%) | **2,492 (100%)** |
| Food Republic 313@somerset | 2,471 | 1,310 (53.0%) | **2,471 (100%)** |

relevant 侧的数字与线上库逐一吻合 (库里分别是 823 / 1,126 / 1,308), 确认这就是
线上问题本身。newest 侧三家全部 100%, 均以 `no_token` 干净结束。

修复: `buildPaginatedBody(body, token, pageSize, sort = 'newest')` 现在会写入
`inner[12]`, `fetchAllReviews` 新增 `reviewSort` 选项 (默认 `newest`, 与四月一致)。

**误导性线索**: 线上 `stop:consecutive_duplicate_pages` (5,936 家, 缺 342 万条) 和
`stop:no_token` (8,870 家半截, 缺 175 万条) 都只是截断的**表象**。这两个终止条件
是为了应付 Most relevant 模式的行为而加的缓解措施, 不是缺数据的原因 —— 换成
newest 后它们自然消失。排查时不要被 stopReason 分布带偏。

## Menu 图必须按原图尺寸下载 (2026-08-19)

`photo_categories` 里存的 URL 自带缩略图后缀 (`=w203-h270-k-no`), 直接下载拿到的
是 **202x270**, 而原图是 3024x4032 起步 —— 只有 1/112 的字节。首批 246,980 张
(6.10 GB) 全是缩略图, 不可用于任何需要看清菜单文字的场景。

后缀改写实测 (同一张图):

| 后缀 | 结果 |
|---|---|
| `=w203-h270-k-no` (存储原样) | 203x177, 27 KB |
| `=s0` / `=d` / `=s4096` / `=w0-h0` | **2064x1800, 2.5 MB** |

`=s0` 是原图。导出时加 `--size s0`; 文件名仍按去后缀的 base URL 取 sha16, 所以
不同尺寸的两次导出可以逐张对应。

**限速是每 IP 的, 加并发无效**: 16 路和 40 路实测都是 2.4-2.9 张/秒 (约 6.2 MB/s),
403 全程为 0。所以用 16 路即可, 开更多只是多占连接。全量 391,087 张预估 863 GB,
ETA 约 38 小时。

产物留在 chark `/data/haoxi/gmaps_images/sg_menu_full_20260814/`, **不拉回本地**
(本地只剩 1.0 T), 完成后备份到 NAS `/mnt/home/haoxi/` (chark 已挂载, 剩 3.1 T)。
旧的缩略图目录 `sg_menu_20260814/` 在新版校验通过后可删。

## 照片抓取也会无限卡死 (2026-08-19)

`photo-category-fetcher.js` 的 in-page fetch 同样没有超时, 与评论侧是同一个洞。
实测 strix 上 part-1 (PID 1844429) 在 `Timbre+ One North` 上卡了 49 分钟:

- 评论部分已正常抓完 `DONE: 6411/6408 (100%)`, 卡在之后的 photos 阶段
- 52 分钟只用 14 秒 CPU (同伴各约 4 分钟), RSS 263 MB (同伴约 900 MB)
- 日志与 sidecar 同时冻结 —— photos 阶段只在进入时写一次 sidecar, 全程无心跳,
  所以监控里只显示 TELEMETRY UNAVAILABLE, 看不出卡在哪一步

已加 45 秒 `AbortController` 超时 (`PHOTO_FETCH_TIMEOUT_MS`), 超时按既有
`_error` 路径收尾该类目。诊断这类卡死的判据: **CPU 时间与同伴的比值**, 比看
进程是否存在可靠得多。

## 2026-08-19 重抓: 四处修复把覆盖率从 65% 拉到 100%

排序截断只是第一层。清空重跑后逐层实测, 一共四处, 全部是 GET→batchexecute
改写时丢掉的行为或没适配的响应形态:

| # | 问题 | 症状 | 修复 |
|---|---|---|---|
| 1 | 排序未强制 | 沿用 UI 默认 Most relevant, 被 Google 截断 | `inner[12]` 写入 newest |
| 2 | 信封字段只认一种 | 约一成响应用 rpcid `qv9Egd` 而非服务路径, 解析返回 null → 整店零抓取 | 两种都接受 |
| 3 | 捕获取了第一个请求 | 页面加载的预览调用只含 5 条且无 token | 改回 last-wins (四月版就是这样) |
| 4 | 短抓无重试 | 仍有约 7% 的店只拿到 5 条 | 覆盖率 <50% 时**换新 context** 重试一次 |

第 4 点的关键: 光重载页面无效 —— stub 会在同一个 browser context 内持续存在,
实测重试 10 次挽回 0 次。销毁 context 重建后, 6 次触发 6 次挽回。

逐层实测覆盖率: 65.3% → 80.3% (修 1+2) → 96.9% (修 3) → **100.28%** (修 4),
97.5% 的店抓满或超过 Google 显示数 (超过是因为缓存计数后又有新评论)。

排查教训: `stop:consecutive_duplicate_pages` 和 `stop:no_token` 在日志里最扎眼,
但都是表象。真正定位靠的是把失败时的**原始响应前 160 字节打进日志** —— 一眼就
看到信封里其实有完整数据, 是解析器不认。

代码: GitHub PR #2 (`fix/review-sort-truncation` → `scrapling_enhanced`), 6 个提交。
strix 上 `output/singapore/review_shards_4_20260819/` 正在用修复版全量重跑 162,447 家。

## ⚠️ chark 的 /tmp 在根盘上, 会连坐杀掉爬虫 (2026-08-18 事故)

`/tmp` 与 `/` 同在 `/dev/nvme0n1p3` (802 G), 长期被其他用户占到 95-96%,
只剩约 39 G。这点余量是全机共享的, 任何人一次大的临时写入都会打穿。

2026-08-18 21:30:22, sg_parks 的 4 个 review worker **同时**死于:

```
Fatal: browserType.launch: ENOSPC: no space left on device,
       mkdtemp '/tmp/playwright-artifacts-XXXXXX'
```

触发源是同机跑的一次 SQLite 大查询: `photo_category_images` 视图上的
GROUP BY 需要临时溢写, 未设 `SQLITE_TMPDIR` 时默认写 `/tmp`, 把最后几 G
吃光。该查询自己也报 `SQLITE_FULL`, 但爬虫是被连坐的。

**规避 (两条都要做)**:

```bash
# 1. 任何 SQLite 大查询/建库
export SQLITE_TMPDIR=/data/haoxi/tmp TMPDIR=/data/haoxi/tmp

# 2. 任何 Playwright 任务, 别依赖根盘那点余量
export TMPDIR=/data/haoxi/tmp
```

恢复用 `output/sg_parks_473_flat/relaunch.sh`: 4 个 worker 各自 setsid 独立启动
(不再由 launch.sh 的 `wait` 统一托管, 一个崩不影响其余), 并写入
`TMPDIR=/data/haoxi/tmp`。续跑实测正常, 4 个分片分别从 3502/3656/5875/6416
条继续; 崩溃点在浏览器启动阶段, 无残留 partial 文件, 4 个输出文件均以换行结尾
无截断。重启后 4 个 worker 的 `api-review-fetcher.js` 版本也统一了
(此前 part-0 已是带 45 s 超时的新版, 1/2/3 仍是旧版)。

## singapore 建库 + Menu 图下载 (2026-08-18, 在 chark 上)

评论 NDJSON 从本机推到 chark（**chark 直连 strix 实测超时**，只能经本机中转），
合并 → 建库 → 导出 Menu 图清单 → 全量下载。产物都在 chark。

```
/data/haoxi/CLI_scraper/output/singapore/
├── review_shards_4_20260814/
│   ├── places.all.ndjson          # 4 个分片输入拼接, 148454 行
│   ├── reviews.merged.ndjson      # 13,113,192,338 B, sha256 80e30591e6a3f05a…
│   └── reviews.merged.ndjson.manifest.json
└── singapore_reviews_20260814.db  # 14.97 GB, schema v3
/data/haoxi/gmaps_images/
├── url_lists/sg_menu_20260814.tsv # 247030 个唯一 URL
└── sg_menu_20260814/<sha[:2]>/<sha[2:4]>/<sha16>.jpg
```

| 阶段 | 结果 |
|---|---|
| 合并 | 148454 行, **0 条重复**, 3 分 29 秒 |
| 建库 | businesses 148454 / reviews 10715677 / review_images 6489816, 6 分片并行 |
| Menu 清单 | 12597 家店, 247046 条图片记录, 跳过 3586 个视频, 去重后 247030 |
| 下载 | 16 worker, 实测 50.9 张/秒, ETA 1.3 h, 预计约 10 GB |

⚠️ **两个环境坑**:

1. chark 预置的 `better-sqlite3` 原生模块是给 Node 20 (ABI 115) 编的, 而 chark 是
   Node 18 (ABI 109), `new Database()` 直接 `ERR_DLOPEN_FAILED`。
   `npm install` 会报 "up to date" 不重编, 必须
   `npm rebuild better-sqlite3 --build-from-source` (python3/g++/make 已具备)。
2. chark 的 `/tmp` 在根盘上, 只剩 42 G (95% 满)。SQLite 大查询会 `SQLITE_FULL`,
   必须 `SQLITE_TMPDIR=/data/haoxi/tmp`。

导出清单用 `scripts/export-photo-category-urls.js --db DB --label Menu --out TSV`,
沿用 `export_image_url_lists.py` 的约定 (按去尺寸后缀的 url 去重、sha16 命名、跳过视频)。

## imgdl: paris/berlin 图片批量下载 (2026-07-12 启动)

- 脚本: `scripts/bulk_image_downloader.py` (repo 内, 本地与 strix 已同步)
- 清单: `/mnt/home/haoxi/gmaps_images/url_lists/*.tsv` (sha16\turl, 按去尺寸后缀 url 去重)
- 产物: `/mnt/home/haoxi/gmaps_images/<list>/<sha[:2]>/<sha[2:4]>/<sha16>.jpg`
  - 文件名 = sha256(url 去掉最后一个 `=` 后缀)[:16], 可从 DB 反查归属
- 顺序 (评论图优先, 不可再生; gallery 有 CIHM/CIAB id 可换新):
  paris_review 6.08M → berlin_review 3.42M → paris_gallery 6.01M → berlin_gallery 4.13M, 共 19.64M
- 预估 ~0.8TB / 4-9 天; NAS 剩余 <300GB 自动停
- 日志: `tail -3 /mnt/home/haoxi/gmaps_images/logs/run.log` (每 30s 一行, 含 rate/eta/403 计数)
  - **403 计数是 URL 过期信号** (paris/berlin URL 为 6-22/23 抓取, zagreb 实测 20~47 天间过期)
- 断点续传: 重跑同一命令即可 (已存在文件自动跳过), 见 `scripts/launch_imgdl.sh`

## 常用命令

```bash
# 连接 (先开 VPN)
ssh haoxi@10.192.132.3

# 查进度 (轻量, 不扫盘 — 服务器磁盘是外置大盘, 避免 du/grep 大日志)
ls -l /data2/shared/haoxi/CLI_scraper/output/paris/reviews.ndjson   # 看 size + mtime
tmux ls                              # 看会话
tail -12 output/paris/reviews.log    # 看日志末尾 (别 grep 全文, 日志很大)

# 进程是否活着
pgrep -f "paris/places" && echo RUNNING || echo STOPPED

# 挂载 / 重启 review scrape (tmux 内必须先 source nvm)
cd /data2/shared/haoxi/CLI_scraper && \
export NVM_DIR=$HOME/.nvm && . $NVM_DIR/nvm.sh && \
export PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright-browsers && \
node src/review-scraper.js --input output/<city>/places.ndjson --output output/<city>/reviews.ndjson --max-reviews 50000

# 拉数据回本地 (rsync 压缩)
rsync -ptz haoxi@10.192.132.3:/data2/shared/haoxi/CLI_scraper/output/<city>/reviews.ndjson output/<city>/reviews.ndjson
```

## 注意事项

- 内网 IP, 断 VPN 就连不上 (历史上断过几次)。
- 服务器磁盘是外置大盘: 查状态用 `ls -l` (读元数据) 最快; 避免 `du` 扫盘、避免 `grep` 大日志 (用 `tail`)。
- `--max-reviews 50000`: 每店评论上限 5 万。极少数超大地标会被截断长尾 (Berlin 整体覆盖 78%, 但 89% 地点满覆盖)。
- 完成判定: 日志末尾出现 `=== Summary === Processed: N/N` 才是正常跑完; 只是 mtime 停更 + 进程 STOPPED 需 tail 日志确认是完成还是崩溃。

---

# NUS Atlas HPC

Atlas 是共享 HPC 集群，不是可直接长期占用的独立服务器。`atlas8` 和 `atlas9`
都是登录节点；计算任务必须通过 PBS 调度到后端计算节点。当前可免费使用 Atlas
CPU 资源，Hopper 通常需要获批项目及 GPU-hours 额度。

## SSH 连接

| 项 | 值 |
|---|---|
| NUS ID | `haoxi.yuan` (`haoxi.yuan@nus.edu.sg`) |
| Atlas 8 | `atlas8.nus.edu.sg` → `172.25.195.51` |
| Atlas 9 | `atlas9.nus.edu.sg` → `atlas9-c01.nus.edu.sg`, `172.19.119.12` |
| 本机别名 | `nus-atlas8`, `nus-atlas9` |
| 认证 | `~/.ssh/id_ed25519` 公钥，已验证免密码登录 |
| 用户 home | `/home/svu/haoxi.yuan`，Atlas 8/9 共享 |
| 网络要求 | NUS Campus 网络或 NUS VPN；SoC VPN 不受支持 |

```bash
# 推荐：使用本机 ~/.ssh/config 中的别名
ssh nus-atlas9
ssh nus-atlas8

# 等价的完整命令
ssh haoxi.yuan@atlas9.nus.edu.sg
ssh haoxi.yuan@atlas8.nus.edu.sg
```

截至 2026-08-15，两个入口的 DNS、TCP 22、SSH 握手和公钥认证均已验证成功。
Atlas 8/9 使用较旧的 OpenSSH 7.4，当前客户端会提示没有使用 post-quantum KEX；
这是服务端能力提示，不影响现有加密 SSH 会话。

## 登录节点实测配置

> 以下是登录节点配置，不能视为作业可独占的计算资源。

| 登录节点 | 实际主机名 | OS / Kernel | CPU | 内存 |
|---|---|---|---:|---:|
| `nus-atlas8` | `atlas8-c01` | Linux 3.10.0-1160.95.1.el7 | 80 vCPU（QEMU） | 85 GiB |
| `nus-atlas9` | `atlas9-c01` | Linux 3.10.0-862.el7 | 120 vCPU（QEMU） | 153 GiB |

登录节点只用于：

- 登录和文件传输；
- 编辑代码与 PBS job script；
- 提交、查看和取消 PBS 作业；
- 查看配额和轻量级结果文件。

**禁止在登录节点直接运行爬虫、建库、模型训练、长时间分析或常驻服务。**

## 存储与配额

| 路径 | 个人配额 | 备份 / 清理策略 | 用途 |
|---|---:|---|---|
| `/home/svu/haoxi.yuan` | 20 GB | 快照（onboarding 文档标注 7 天） | 配置、代码、小文件 |
| `/hpctmp/haoxi.yuan` | 500 GB | 无备份；旧文件可能在 60 天后清理 | 作业输入、临时数据、结果中转 |

```bash
# 查看实际配额
hpc s

# 从本机传入 Atlas
rsync -av --partial data/ nus-atlas9:/hpctmp/haoxi.yuan/data/

# 拉回本机
rsync -av --partial nus-atlas9:/hpctmp/haoxi.yuan/results/ results/
```

不要把 `/hpctmp` 当永久存储；重要结果应及时拉回本地或转存到正式项目存储。

## PBS 队列与常用命令

2026-08-15 实测：`serial` 和 `parallel` 队列处于 enabled/started 状态；
`gpu_workshop` 关闭，旧 onboarding 文档中的 `volta_gpu` 未出现在当前开放队列中。
因此当前只确认 Atlas CPU 资源可用，**不要假定存在免费 GPU 队列**。

```bash
# 查看队列
qstat -Q

# 查看自己的作业
qstat -u haoxi.yuan

# 提交作业
qsub job.pbs

# 查看作业详情
qstat -f <JOB_ID>

# 取消作业
qdel <JOB_ID>
```

旧 onboarding 文档给出的参考计算上限包括单节点最高约 96 CPU 核、384 GB 内存；
这只是历史队列定义，实际可用资源、walltime 和等待时间以当前 `qstat`、PBS 返回结果
及项目/个人 allocation 为准。

## 适合与不适合的任务

**适合：**

- 可拆分的大规模 CPU 批处理；
- 多城市 NDJSON 清洗、校验、哈希和统计；
- Monte Carlo、GIS 分块计算、参数扫描；
- 能通过 PBS job script 完整描述并在 walltime 内结束的任务。

**不适合：**

- 无 PBS 包装、直接在登录节点运行的 Google Maps/Playwright 长会话；
- monitor、数据库、Web 服务等常驻进程；
- TB 级图片长期保存；
- 当前需要 GPU 的训练或推理任务。

现有工作分配建议：GPU/交互式计算优先 `ual-chark`；Google 抓取和 NAS 下载
优先 `ual-strix`；可严格分片、可断点恢复的 Google 抓取和免费的大规模 CPU
批处理可以使用 Atlas PBS。

## Atlas 上的 gmaps-crab 部署经验（2026-08-16）

已在 Atlas 用 Singapore 473 个 park 多边界任务完成环境、并发和调度链验证。
当前项目根目录是 `/hpctmp/haoxi.yuan/gmaps_atlas/CLI_scraper`，运行时使用
`/hpctmp/haoxi.yuan/gmaps_atlas/images/playwright-1.57.0-noble.sif`。不要依赖
登录节点自带 Node/Python：Node 与 Playwright 在 Singularity 容器内运行；登录节点
目前有 `jq`，但没有 `python3`。

实测结论：

- `parallel` 队列当前允许该用户同时运行 8 个作业、合计 96 CPU；因此采用
  8 个 PBS group × 每组 12 个浏览器 worker，而不是提交 96 个小作业。
- 12 路 Chromium 探针全部成功访问 Google Maps（12/12 HTTP 200、无 CAPTCHA，
  约 4.3–5.1 秒）。正式作业每组申请 `12 CPU / 24 GB`。
- 容器临时目录、浏览器缓存和 `SINGULARITY_TMPDIR` 应放计算节点本地 `/tmp`；
  不要把高频 Chromium 临时 I/O 放在 `/hpctmp`。
- POI 被分成 96 个稳定 shard，`buffer=15m`、`cell-size=200m`。同一节点的
  12 个 Chromium 按 5 秒错峰启动，每个 worker 有 12 小时外层超时。
- 8 个 POI group 提交后立即提交 8 个 Review group，不创建 `sgp_check`，也不使用
  PBS `afterok`。Review worker 对自己的每个边界等待 `_area_complete.json`；对应
  `poi_group_N.status` 出现后，缺 marker 但已有 `places.ndjson` 的边界按 partial
  输入继续，空输入明确记录为 `noInput`，不会因为启动过早永久跳过。
- `/hpctmp` 无备份且可能清理 60 天旧文件；最终 NDJSON/数据库必须及时拉回。

本次正式任务：

| 阶段 | PBS 作业 | 结果 |
|---|---|---|
| POI | `980712`–`980719` (`sgp_p01`…`sgp_p08`) + 重投 `980729` | ✅ 完成，473/473 边界，92331 行 / 46238 唯一 POI |
| Review | `980808`–`980815` (`sgp_r01`…`sgp_r08`) | ❌ 2026-08-17 19:44 全部 qdel，改到 ual-chark 跑 |

**Review 阶段为什么撤出 Atlas**（两个独立原因，都不是抓取程序本身的问题）：

1. **按 area 分片不成立。** 473 个 area 的 POI 数差 4 个数量级
   (`jurong_hill_park` 17887、`hong_lim_park` 15754 vs `pulau_unum` 2)。
   `atlas-review-batch-worker.js` 每个 shard 固定摊 5 个 area 且串行处理，
   巨型 area 被钉死在单 worker 上：hong_lim_park 跑 5 小时才 272/15754。
   96 个 shard 里 53 个"完成"的全是只摊到小公园的。5.5 小时整体只推进到
   4277/92331 = 4.6%。要留在 Atlas 必须先摊平去重再按工作量配平，
   而不是按边界切。
2. **共享集群拿不到稳定资源。** 该账号只有 `parallel`/`serial` 两个无 ACL 队列；
   `pbs_rsub` 预留被 `acl_resv_users` 挡住；空闲的大节点
   (cnode-33-43-29、colo-chmlu-0X、colo-bliu-01) 全部绑给了别的课题组队列。
   `parallel` 池在线节点常年被占 60-96/96 CPU，8 个组只能零散被调度进来
   (14:03 提交，两个立刻跑、第三个 31 分钟后、其余更晚)，`place=excl` 整节点
   独占在当前占用率下等不到。

POI 阶段的产物完整可用，已整批迁到 chark（见 ual-chark 章节），不需要重跑。

关键路径：

```text
/hpctmp/haoxi.yuan/gmaps_atlas/CLI_scraper/output/_batches/sg_parks_473/
/hpctmp/haoxi.yuan/gmaps_atlas/logs/poi/shard_NNN_of_096.log
/hpctmp/haoxi.yuan/gmaps_atlas/status/review_direct_20260817T140320.txt
```

提交入口为 `scripts/hpc/atlas-gmaps-submit.sh`。Bash 中 `GROUPS` 是特殊数组，
不能用作普通的 group 数量变量；统一使用 `NUM_GROUPS`，并在提交前检查已有
`sgp_p*`/`sgp_r*` 作业，防止重复提交。

Scraper Monitor 通过 `scripts/hpc/atlas-monitor-snapshot.sh` 接入 Atlas：PBS
`R/Q/H` 状态来自 `qstat`，运行细节来自各 shard 的小型 live sidecar。由于 Atlas
的 `qstat` 可能耗时几十秒，适配器把调度状态缓存 60 秒并异步刷新；App 默认每
8 秒读取一次 sidecar，另一个不重入的探针每 60 秒刷新调度缓存；慢 `qstat` 不会
阻塞进度画面，也不会扫描完整 NDJSON。`sgp_check` 在 OTHER 视图中显示为
`validation`；POI 在 stage 1、浏览器启动、查询和错误阶段都会更新 sidecar。
可用以下命令覆盖默认连接：

App 为 Chark、Strix 和 Atlas 各维护一个独立 SSH control connection，采样命令只创建
短生命周期 channel；VPN/网络中断导致主连接退出后会每 5 秒自动重连。不要把
`ControlPersist` 直接挂在带 stdout pipe 的采样进程上，否则首个采样可能因为
主连接驻留而无法把完成信号交回 UI。

Chark 自 2026-08-17 起也是进程端点（`Location.chark`，默认根目录
`/data/haoxi/CLI_scraper`，可用 `--chark-root` 覆盖），与 Strix 共用同一套通用
进程探测脚本，因此 `sg_parks_473_flat` 的 4 个 review worker 会直接出现在
`ALL TASKS`/`REVIEWS` 列表里，排序为 LOCAL → CHARK → STRIX → ATLAS，右上角
状态位相应变成 `L✓ C✓ S✓ A✓`。三条传输由 `DiscoveryCoordinator` 统一持有，
`RESOURCES` 页复用它们，因此三台服务器合计只有 3 条常驻 SSH 传输——给
`ResourceCoordinator` 再开一条 chark 主连接会和进程端点抢同一个 control socket。UAL 每 3 秒只读两次短间隔 `/proc/stat`、
`/proc/meminfo`、top 24 `ps` 行和一次 `nvidia-smi`；不扫描日志或 NDJSON。Atlas
显示的是缓存的 PBS CPU/内存/作业槽分配及逐作业 usage，明确不是登录节点负载，
也不会为资源页额外发起 `qstat`。App 和 SSH 主连接之间有父进程 watchdog，即使
App 被强制结束，连接也会在约 5 秒内退出，不遗留后台 SSH 进程。

资源杯的水位是连续占用率，颜色阈值固定为：`<50%` 绿色、`50–74%` 橙色、
`>=75%` 红色。工作负载建议可在 CPU、GPU、SCRAPE 间切换；建议只是依据实时
资源和既定服务器用途的放置提示，Atlas 最终能否立即运行仍以 PBS 调度为准。

增强资源页底部显示运行任务 ETA，不再保存或绘制资源负载历史。ETA 优先采用
sidecar 的 `completed/total` 和最近进度速度；采样刚开始时可用累计进度/运行时长
给出带 `≈` 的低置信度估计。Atlas 缺少业务进度时只能显示 PBS walltime 上限，
普通进程没有进度契约时明确显示 `NO PROGRESS TELEMETRY`，不能把 walltime 或
进程已运行时长冒充为预计完成时间。除 `haoxi`/`haoxi.yuan` 外的 owner 默认显示
为 `***`，只在用户点击眼睛图标后临时显示；该开关不持久化，App 重启后恢复打码。

```bash
bash tools/review-rate-monitor/scraper-monitor.sh --install \
  --atlas-host nus-atlas9 \
  --atlas-root /hpctmp/haoxi.yuan/gmaps_atlas/CLI_scraper \
  --atlas-interval 8 \
  --atlas-qstat-interval 60
```
