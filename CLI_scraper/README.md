# G-Maps Crab CLI

G-Maps Crab is a six-stage, resumable Google Maps collection pipeline:

```text
1. Boundary and sampling points
2. POI search (single area or multi-boundary batch)
3. Review collection
4. Reviewer-profile collection
5. NDJSON to SQLite
6. Selected image download
```

The maintained runtime supports macOS, Ubuntu/mainstream Linux, and native
Windows. Existing data directories, checkpoints, NDJSON records, and SQLite
databases remain compatibility contracts.

## Requirements and installation

- Node.js 20 or newer
- Python 3.10 or newer
- npm

macOS/Linux:

```bash
./bootstrap.sh
```

Windows PowerShell:

```powershell
.\bootstrap.ps1
```

Both launch the same `scripts/bootstrap.js`, install locked npm dependencies,
install Playwright Chromium, create `.venv`, and install the pinned Python map
dependencies. Installed environments and browsers are rebuilt locally and are
not committed.

## Entry points

Portable on every supported platform:

```bash
node bin/gmaps-crab.js help
```

Windows shortcut:

```powershell
.\bin\gmaps-crab.ps1 help
```

macOS/Linux users can also open the richer Bash menu:

```bash
./bin/gmaps-crab
```

The portable POI and review runners stay in the foreground. Use tmux, systemd,
PowerShell jobs, Task Scheduler, or another platform supervisor when background
execution is required.

## Stage 1 — boundary and sampling points

```bash
node bin/gmaps-crab.js boundary
```

The wizard accepts an OSM city search or existing GeoJSON, generates sampling
points, and can render an optional map. Outputs are placed in `data/<city>/`:

```text
<city>_boundary.geojson
<city>_points.json
<city>_points.csv
<city>_points.geojson
<city>_summary.json
<city>_map.png
```

## Stage 2 — POI search

Single city, portable foreground runner:

```bash
node bin/gmaps-crab.js poi --city singapore
node bin/gmaps-crab.js poi --city singapore --categories restaurant,cafe
node bin/gmaps-crab.js poi --help
```

It reuses existing `data/<city>/*_points.json` and boundary files. If the city
data does not exist, it invokes the city generator. Checkpoint and live-status
files are written beside `output/<city>/places.ndjson`; interrupted runs resume
from the existing checkpoint.

Multi-boundary batches:

```bash
node bin/gmaps-crab.js multi \
  --boundaries areas.geojson \
  --name parks
```

Each GeoJSON feature is isolated under `data/_batches/<batch>/` and
`output/_batches/<batch>/`. The orchestrator preserves per-area checkpoints and
completion markers. Run `multi --help` for sharding, category, buffer, and
self-adapting discovery options.

The legacy Unix wizard remains available as `./poi-search.sh`.

## Stage 3 — reviews

```bash
node bin/gmaps-crab.js reviews --city singapore
node bin/gmaps-crab.js reviews --input output/custom/places.ndjson
node bin/gmaps-crab.js reviews --help
```

`reviews.ndjson` is append-only and resumable. The scraper deliberately does
not rewrite a multi-gigabyte review file during finalization; consumers should
combine `places.ndjson` and `reviews.ndjson` when building their final dataset.
An optional `--min-count` creates a derived filtered input beside the source.

The legacy Unix wizard remains available as `./review-scrape.sh`.

To continue automatically into reviewer profiles after the place-review run:

```bash
node bin/gmaps-crab.js reviews --city singapore --reviewers
```

## Stage 4 — reviewer profiles

```bash
node bin/gmaps-crab.js reviewers --city singapore
node bin/gmaps-crab.js reviewers \
  --input output/custom/reviews.ndjson \
  --max-profile-reviews 200
node bin/gmaps-crab.js reviewers \
  --input output/custom/reviews.db \
  --list-limit 100 --list-order review-count-desc
node bin/gmaps-crab.js reviewers --help
```

For an existing stable-shard run, resume all shard lists through one Chromium
and one global IP gate while preserving the original append-only outputs:

```bash
node bin/gmaps-crab.js reviewers-parallel \
  --run-root experiments/reviewer_profiles_full_20260824 \
  --input output/singapore/reviews.db \
  --concurrency 27 \
  --request-interval-ms 150
```

The runner streams the lists rather than loading millions of reviewers into
memory, scans every shard output for non-error completion markers, writes each
new profile back to its stable shard, drains in-flight work on SIGINT/SIGTERM,
rotates Chromium between drained windows, and backs off after unsafe windows.

The command streams `reviews.ndjson`, deduplicates Google reviewer IDs into
`reviewers.list.ndjson`, and appends one resumable record per profile to
`reviewers.ndjson`. Each public review contains the review text and translation,
rating, time, owner response, media, business identity/address/categories and
coordinates. Google structured answers are retained verbatim and normalized as
`order_type`, `price_per_person`, `meal_type`, `group_size`, `wait_time`,
food/service/atmosphere scores, and `recommended_dishes` when present.

Google currently returns at most 200 public reviews per profile, and very
media-heavy profiles can have a lower effective response limit. The scraper
automatically falls back through smaller request sizes and records every attempt.
It only marks a profile complete when the returned count covers the public count.
Hidden/private histories and capped results are explicit in
`completeness.stop_reason`; they are never reported as fully collected. See
[`docs/REVIEWER_PROFILES.md`](docs/REVIEWER_PROFILES.md) for the field contract,
count semantics, resume behavior, and verified limitations.

Use `reviewer-benchmark` to measure the safe concurrency envelope of one public
IP with one or more Chromium processes, a single shared IP request gate, and
adaptive feedback. Read
[`docs/REVIEWER_PARALLELISM.md`](docs/REVIEWER_PARALLELISM.md) before changing a
production run.

```bash
node bin/gmaps-crab.js reviewer-benchmark --help
```

The validated chark long-queue topology is one Chromium with a shared global
queue and 27 in-flight reviewer contexts. `--browser-count` is available for
controlled topology A/B tests; multiple Chromium processes do not create an
independent IP request budget. The benchmark checkpoints every completed stage
and can stop on per-reviewer content drift with `--stop-on-unsafe`.

## Stage 5 — SQLite

Interactive portable wizard:

```bash
node bin/gmaps-crab.js db
```

Direct builders:

```bash
node scripts/build-sqlite-db.js \
  --input output/singapore/places.ndjson \
  --input output/singapore/reviews.ndjson \
  --output output/singapore/reviews.db --fresh

node scripts/build-sqlite-db-mt.js \
  --input output/singapore/places.ndjson \
  --input output/singapore/reviews.ndjson \
  --output output/singapore/reviews.db --fresh

node scripts/summarize-review-db.js \
  --db output/singapore/reviews.db --quick-check
```

The schema uses explicit UPSERTs, records source provenance, preserves local
enrichment fields when incoming values are null, and validates the independent
NDJSON-to-SQLite contract.

## Stage 6 — images

The cross-platform image command reads a review SQLite database and streams a
bounded selection; it does not load the whole database into memory.

```bash
node bin/gmaps-crab.js images \
  --db output/singapore/reviews.db \
  --output output/singapore/menu-images \
  --source photo-categories \
  --category menu \
  --poi-category restaurant,cafe,bakery \
  --max-images-per-poi 2 \
  --concurrency 4
```

Existing non-empty files are skipped, so the command is safe to resume. Use
`images --help` for review-image selection, sampling, proxy, source-IP binding,
URL-cache, and dry-run options. The tmux-based `src/cli/image-wizard.js` remains
an optional Unix convenience interface.

## Layout and compatibility

```text
bin/                 command launchers
config/              category configuration
contracts/           independent data-retention contracts
scripts/             database, image, validation, and maintenance tools
src/                 supported runtime implementation
test/                deterministic core tests and small fixtures
data/                 generated boundaries and points (ignored)
output/               checkpoints, NDJSON, DBs, images (ignored)
logs/                 generated logs (ignored)
```

Atlas/PBS, one-off campaigns, OCR prototypes, and Street View/satellite research
are outside this directory in the workspace-level `archive/`, `exploratory/`,
and `research/` trees. Core runtime code must not import them.

## Tests

```bash
npm ci
npm test
```

Tests cover syntax, the independent NDJSON key contract, SQL mapping, database
UPSERT/provenance behavior, image-download planning, URL refresh/cache behavior,
POI resume/failure boundaries, reviewer-profile wire variants, structured dining
answers, coordinates, reviewer deduplication, and legacy multiline NDJSON
recovery. CI runs these checks on Ubuntu, macOS, and Windows without calling live
Google endpoints.

## Reproducible runs

Create a manifest before a production run:

```bash
npm run manifest -- \
  --output output/<run>/run-manifest.json \
  --input data/<city>/<city>_boundary.geojson
```

The manifest records the Git branch and commit, dirty state, runtime versions,
and SHA-256 hashes of dependency locks, configuration, and selected inputs. It
refuses a dirty worktree unless `--allow-dirty` is explicitly supplied.

## Secrets and generated data

Keep credentials in environment variables or the ignored `.secrets/` directory.
Never commit data, outputs, databases, downloaded images, virtual environments,
browser binaries, caches, or machine-specific `.env` files.
