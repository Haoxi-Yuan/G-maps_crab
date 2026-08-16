# PostgreSQL adaptive scheduler

This scheduler replaces fixed area shards with deterministic, retryable work
units:

```text
workflow / boundary_id / category_group / Web-Mercator quadkey
```

It is designed for both hundreds of small boundaries and one city/country-sized
boundary. A large boundary receives multiple deterministic root tiles when its
category count alone does not provide enough initial parallelism. Any tile that
hits the pagination cap is split into the four standard quadkey children.

## Safety invariants

- A page that still fails after three attempts makes the whole tile incomplete.
  It becomes `RETRY`, then `QUARANTINED` after the configured number of task
  attempts. It is never recorded as complete.
- Empty tiles have two terminal states. `DONE_EMPTY_CONFIRMED` requires a recent
  successful known-nonempty probe from the same browser session, a structurally
  complete response, and normal fleet-wide production. Otherwise the state is
  `DONE_EMPTY_SUSPECT`.
- POI UPSERTs, observations, the parent `SPLIT` transition, and all child inserts
  happen in one PostgreSQL transaction. A failed child insert rolls everything
  back.
- Task identity is the composite `(workflow_id, boundary_id, category_group,
  tile_id)`. `tile_id` is a standard Web Mercator quadkey, so regeneration and
  concurrent split attempts naturally converge through `ON CONFLICT DO NOTHING`.
- Workers claim with `FOR UPDATE SKIP LOCKED` and expiring leases. PostgreSQL is
  the source of truth; `/hpctmp` contains logs and final exports, never queue
  state.
- POI, Review, and image requests consume separate database token buckets. More
  browser processes cannot exceed the configured global request rate.
- Scheduling fairness is request-based. It orders boundaries by actual plus
  reserved request cost, guarantees an aging boundary a turn, and boosts a
  boundary after it reaches 95% terminal tasks so complete boundaries become
  available quickly.

## Connectivity prerequisite

On 2026-08-16 an Atlas compute job on `cnode-33-43-25` tested chark
`10.192.132.2` and strix `10.192.132.3`. Ping and TCP ports 22, 5432 and 6432 all
timed out. Therefore those private PostgreSQL locations cannot currently serve
Atlas workers directly.

Do not submit workers until there is an Atlas-compute-reachable PostgreSQL
endpoint. `scripts/hpc/atlas-adaptive-submit.sh` enforces this with a compute
node database probe; all workers depend on `afterok` of that probe.

## Seed and run

```bash
export DATABASE_URL='postgresql://user:password@reachable-host/db?sslmode=require'

node src/adaptive-poi-seed.js \
  --workflow sg_parks_v2 \
  --boundaries data/Park_singapore/473parks.geojson \
  --workers 96 \
  --poi-rps 4 \
  --poi-burst 8

node src/adaptive-poi-worker.js --workflow sg_parks_v2
node src/adaptive-poi-status.js --workflow sg_parks_v2
```

For Atlas, store the connection URI in a mode-600 credential file and submit:

```bash
scripts/hpc/atlas-adaptive-submit.sh \
  --workflow sg_parks_v2 \
  --database-url-file "$HOME/.config/gmaps/postgres-url" \
  --output /hpctmp/haoxi.yuan/gmaps_atlas/CLI_scraper/output/_workflows/sg_parks_v2 \
  --groups 8
```

The finalizer is deliberately strict. Any `QUARANTINED` or
`DONE_EMPTY_SUSPECT` tile prevents `_poi_batch_complete.json`. Review must depend
on `afterok:<finalizer-job-id>`, not directly on the worker groups. To audit and
retry terminal exceptions:

```bash
node src/adaptive-poi-admin.js --workflow sg_parks_v2 \
  --requeue-suspect-empty --reset-attempts

node src/adaptive-poi-admin.js --workflow sg_parks_v2 \
  --requeue-quarantined --reset-attempts
```

The finalizer streams a globally deduplicated `places.ndjson` plus
`place_boundaries.ndjson`. Review therefore fetches each `place_id` once and can
map it back to every intersecting boundary without duplicate requests.
