#!/bin/bash
set -Eeuo pipefail

BASE=/hpctmp/haoxi.yuan/gmaps_atlas
PROJECT="$BASE/CLI_scraper"
BOUNDARIES="$PROJECT/data/Park_singapore/473parks.geojson"
BATCH=sg_parks_473
NUM_GROUPS=8
WORKERS_PER_GROUP=12
TOTAL_WORKERS=$((NUM_GROUPS * WORKERS_PER_GROUP))
START_STAGGER_SECONDS=${START_STAGGER_SECONDS:-5}
WORKER_TIMEOUT=${WORKER_TIMEOUT:-12h}

: "${GROUP:?GROUP is required}"
if [ "$GROUP" -lt 1 ] || [ "$GROUP" -gt "$NUM_GROUPS" ]; then
  echo "Invalid GROUP=$GROUP" >&2
  exit 2
fi

cd "$PROJECT"
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
export TMPDIR="/tmp/haoxi.yuan-gmaps-${PBS_JOBID:-manual}"
export XDG_CACHE_HOME="$TMPDIR/xdg-cache"
export NODE_OPTIONS=--max-old-space-size=3072
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$BASE/logs/poi" "$BASE/status"

pids=()
labels=()
for local_worker in $(seq 1 "$WORKERS_PER_GROUP"); do
  global_worker=$(( (GROUP - 1) * WORKERS_PER_GROUP + local_worker ))
  label=$(printf 'shard_%03d_of_%03d' "$global_worker" "$TOTAL_WORKERS")
  log="$BASE/logs/poi/${label}.log"
  echo "[PBS] starting $label at $(date -Is)" | tee -a "$log"
  timeout --signal=TERM --kill-after=60s "$WORKER_TIMEOUT" \
    node src/multi-boundary-orchestrator.js \
    --boundaries "$BOUNDARIES" \
    --name "$BATCH" \
    --cell-size 200 \
    --buffer 15 \
    --shard "$global_worker/$TOTAL_WORKERS" \
    >>"$log" 2>&1 &
  pids+=("$!")
  labels+=("$label")
  if [ "$local_worker" -lt "$WORKERS_PER_GROUP" ]; then
    sleep "$START_STAGGER_SECONDS"
  fi
done

failures=0
for idx in "${!pids[@]}"; do
  if wait "${pids[$idx]}"; then
    echo "[PBS] ${labels[$idx]} completed at $(date -Is)"
  else
    rc=$?
    echo "[PBS] ${labels[$idx]} failed rc=$rc at $(date -Is)" >&2
    failures=$((failures + 1))
  fi
done

printf '%s\n' "group=$GROUP" "workers=$WORKERS_PER_GROUP" "failures=$failures" \
  "finished_at=$(date -Is)" > "$BASE/status/poi_group_${GROUP}.status"

if [ "$failures" -gt 0 ]; then
  exit 1
fi
