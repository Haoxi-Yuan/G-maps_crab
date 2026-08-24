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
