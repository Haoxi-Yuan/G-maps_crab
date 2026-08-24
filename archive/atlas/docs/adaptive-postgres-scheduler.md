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
- Every time threshold is derived from a successful-operation EWMA. Failed and
  timed-out calls never increase the mean, and each successful outlier is
  clipped to twice the previous mean. Current hard caps are 30 seconds for a
  POI/API request, 45 seconds for browser launch, 90 seconds without completed
  request progress, 180 seconds for a task lease, and 30 seconds for retry.
- A node-local launch gate permits only two simultaneous Chromium cold starts.
  Workers renew leases only after durable completed-request progress; a wedged
  renderer is closed and its tile returns to `RETRY` rather than holding a
  static shard forever.
- Commit RPCs are idempotent by lease token. If HTTPS drops after PostgreSQL
  commits but before the response reaches Atlas, repeating the call returns the
  first durable result instead of inserting observations or children twice.

## Connectivity prerequisite

On 2026-08-16 an Atlas compute job on `cnode-33-43-25` tested chark
`10.192.132.2` and strix `10.192.132.3`. Ping and TCP ports 22, 5432 and 6432 all
timed out. Therefore those private PostgreSQL locations cannot currently serve
Atlas workers directly.

PostgreSQL remains on a DB-reachable control host. Atlas workers talk only to a
small authenticated scheduler service through an Atlas-compute-reachable HTTPS
443 URL. PostgreSQL is never placed on `/hpctmp`, and its URI never enters a PBS
job. `scripts/hpc/atlas-adaptive-submit.sh` first runs an API probe on a compute
node; all workers depend on `afterok` of that probe.

Start the service on the PostgreSQL side, preferably behind an existing TLS
reverse proxy:

```bash
install -d -m 700 "$HOME/.config/gmaps"
openssl rand -hex 32 > "$HOME/.config/gmaps/scheduler-token"
chmod 600 "$HOME/.config/gmaps/scheduler-token"

DATABASE_URL='postgresql://...' \
SCHEDULER_API_TOKEN_FILE="$HOME/.config/gmaps/scheduler-token" \
SCHEDULER_HOST=127.0.0.1 SCHEDULER_PORT=8443 \
npm run scheduler:api
```

Terminate public TLS at the reverse proxy and forward only to loopback 8443.
Alternatively provide `SCHEDULER_TLS_CERT_FILE` and
`SCHEDULER_TLS_KEY_FILE` and bind the service directly. The bearer-token file
must be mode 600. Copy only the token file—not the database URI—to the user's
private Atlas `/hpctmp` directory and protect it with mode 600.

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

For Atlas, submit against the HTTPS control plane. Six browser workers per
12-CPU/24-GB PBS job is the conservative default; increase only after measured
throughput and RSS justify it.

```bash
scripts/hpc/atlas-adaptive-submit.sh \
  --workflow sg_parks_v2 \
  --scheduler-url https://scheduler.example.edu \
  --scheduler-token-file /hpctmp/haoxi.yuan/secrets/gmaps-scheduler-token \
  --output /hpctmp/haoxi.yuan/gmaps_atlas/CLI_scraper/output/_workflows/sg_parks_v2 \
  --groups 8 \
  --workers-per-job 6
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
The stream has its own EWMA-derived no-progress watchdog and is written through
a temporary file plus atomic rename. Only after both files and hashes exist does
the finalizer mark the workflow complete and publish `_poi_batch_complete.json`.

The same HTTPS backend is used when Review or image workers receive
`--scheduler-workflow`/`GMAPS_SCHEDULER_WORKFLOW`; their requests therefore
consume the separate `reviews` and `images` token buckets without exposing the
database to Atlas. `adaptive-poi-status.js` also accepts `SCHEDULER_URL` and
returns queue, per-boundary progress, budgets, worker progress timestamps, and
current EWMA values in one small JSON response for Scraper Monitor.
