# G-Maps Crab workspace

This repository keeps the maintained CLI scraper separate from daily tools,
experiments, research, and historical code. The separation is intentional:
only `CLI_scraper/` is the production scraping product.

## Workspace map

| Path | Status | Purpose |
| --- | --- | --- |
| `CLI_scraper/` | maintained | Boundary, POI, review, SQLite, and image pipeline |
| `tools/local-monitor/` | maintained tool | Local/remote task monitoring; not a scraper dependency |
| `exploratory/` | experimental | OCR and image-analysis prototypes |
| `research/` | independent | Street View, satellite, and paper projects |
| `archive/atlas/` | retired | Atlas/PBS and adaptive-scheduler history |
| `archive/campaigns/` | archived | One-off city runs, probes, recovery, and plots |
| `archive/legacy-apps/` | archived | Superseded scraper, monitor, and pipeline applications |
| `docs/` | maintained | Maintenance and platform policy |

Atlas is no longer an active target. Its runners, PBS files, scheduler work,
server notes, and last monitor adapter are retained only for traceability.

## Start the scraper

Requirements: Node.js 20+, Python 3.10+, npm, and enough local disk space for
the data you explicitly choose to collect.

macOS or Linux:

```bash
cd CLI_scraper
./bootstrap.sh
./bin/gmaps-crab
```

Windows PowerShell:

```powershell
cd CLI_scraper
.\bootstrap.ps1
.\bin\gmaps-crab.ps1 help
```

The platform-neutral entry point is:

```bash
node CLI_scraper/bin/gmaps-crab.js help
```

See [CLI_scraper/README.md](CLI_scraper/README.md) for stage commands, data
contracts, tests, and operational details.

## Monitor

The portable local monitor works on macOS, Linux, and Windows and reads only
small live-status sidecars:

```bash
node tools/local-monitor/monitor.js --root CLI_scraper
```

macOS also has the native graphical monitor:

```bash
bash tools/local-monitor/scraper-monitor.sh
```

See [tools/local-monitor/README.md](tools/local-monitor/README.md).

## Active run: Singapore reviewer profiles, split across three hosts

Started 2026-09-01 from commit `6bea81f`. Stage 4 (reviewer profiles) for the
Singapore review database, resumed after 1,207,260 of 4,191,230 reviewers were
already collected on `ual-chark`.

| Host | Concurrency | Quota | Measured | Run root |
| --- | ---: | ---: | ---: | --- |
| `ual-chark` | 27 | 1,027,884 | 187.7/min | `/data/haoxi/CLI_scraper/experiments/reviewer_split_chark_20260901` |
| `labpro-ual2` (M1) | 16 | 830,686 | 115.5/min | `~/gmaps-production/reviewer_run` |
| `labpro-kun` (M3) | 16 | 1,125,400 | 158.2/min | `~/gmaps-production/reviewer_run` |

All three use identical data-affecting options — `--request-interval-ms 150`,
`--window-size 200`, `--browser-restart-every 2800`, `--max-profile-reviews 200`,
`--fetch-retries 2`. Only `--concurrency` differs, and it was chosen per host
from a measured 4→8→12→16 ladder rather than from core counts.

Two properties of the reviewer list drive the split and are easy to get wrong:

- **The list is ordered by reviewer activity, heaviest first.** Head-of-shard
  reviewers average 78.6 public reviews, the middle 7.1, the tail 9.8. Any
  contiguous split therefore hands one host most of the expensive work. The
  remaining list is instead **interleaved** by weight, so each host gets a
  statistically identical mix (verified: means 13.6/14.2/14.6, identical p50).
- **Cumulative `profiles_per_minute` is not a valid ETA.** Throughput rises over
  a run purely because the workload lightens. Compare hosts with
  `returned_reviews` per minute, or on matched slices.

Prior output on `ual-chark` (59 GB, `reviewer_profiles_full_20260824/output/`)
is untouched; each host writes fresh shards. The final dataset is the union of
the old four shards plus the three hosts' new ones, deduplicated by
`reviewer_id`.

Resume indexes (`output/reviewers.part-N.ndjson.done`) now exist for the old
run, so future resumes are O(ids) instead of a 55 GB rescan.

Operational notes:

- Neither Mac has `tmux`; both use `nohup` plus a supervisor loop. Node 22 is
  installed per-user under `~/gmaps-production/.runtime/node`, and
  `~/gmaps-production/env.sh` must be sourced first — background jobs cannot
  rely on `.zshrc`.
- `labpro-kun` has limited free space for its quota (~63 GB needed). A disk
  guard at `~/gmaps-production/disk-guard.sh` stops the run gracefully below
  10 GB free.
- `ual-chark` is shared and runs unrelated jobs under the same account. Scope
  every process action to explicit PIDs or the run's own `TMPDIR`; never match
  on user name alone.
- A reviewer run now claims its output directory with
  `output/.reviewer-writer.lock` and refuses to start while another live writer
  holds it, so a supervisor restart cannot race an orphaned earlier process. A
  lock left by a killed run is reclaimed automatically once its pid is gone; a
  lock written by another host is never reclaimed. The three runs above predate
  this and are unaffected until their next restart.
- **Watch the ephemeral-port pool on long runs.** `labpro-ual2` finished its
  830,686 profiles with 14,074 error records, every one of them
  `net::ERR_INTERNET_DISCONNECTED`. The network was fine: 16,400 sockets sat in
  TIME_WAIT and never drained, holding 16,374 of the 16,384 ephemeral ports, so
  the kernel failed every new `connect()` with `EADDRNOTAVAIL` while ICMP and
  already-established connections kept working. Nothing in the run looked wrong
  — it kept "succeeding" into a dead network, and the errors are recoverable
  only because error records stay out of the done index. `labpro-kun` ran the
  same workload at the same concurrency with 425 TIME_WAIT entries, so this is
  a stuck-reclaim anomaly, not a rate limit. Two scripts address it, and
  neither lowers concurrency:
  `scripts/tune-net-ports.sh` widens the pool (macOS 16,384 ports / 30 s
  TIME_WAIT → 49,152 / 4 s, a 22x margin; run it with `sudo` before a long
  scrape, it resets on reboot) and `scripts/net-port-guard.sh` watches usage
  during the run and sends a graceful stop at 90%, turning silent loss into a
  resumable checkpoint. Run `scripts/tune-net-ports.sh --show` to report the
  current pool without privileges.

## Data safety

Collected and generated content is intentionally outside version control:

- `data/`, `output/`, and `logs/`;
- NDJSON databases and downloaded images under those directories;
- `node_modules/`, `.venv/`, Playwright browsers, caches, and build products;
- local secrets and environment overrides.

Repository maintenance must not rewrite, migrate, copy, or delete existing
scrape outputs. Code backups should preserve source, configuration, lockfiles,
small fixtures, and documentation while excluding the generated content above.

## Development

Use short-lived `feature/*` and `fix/*` branches. Before merging core changes:

```bash
cd CLI_scraper
npm ci
npm test
```

The CI matrix runs the core checks on Ubuntu, macOS, and Windows. Release
commits should be tagged `cli-scraper-vX.Y.Z`; production runs should record a
clean commit and hashes with `npm run manifest -- --output <path>`.

Detailed policy is in [docs/MAINTENANCE.md](docs/MAINTENANCE.md) and
[docs/PLATFORM_SUPPORT.md](docs/PLATFORM_SUPPORT.md).
