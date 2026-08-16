#!/bin/bash
set -Eeuo pipefail

BASE=/hpctmp/haoxi.yuan/gmaps_atlas
PROJECT="$BASE/CLI_scraper"
BOUNDARIES="$PROJECT/data/Park_singapore/473parks.geojson"
BATCH=sg_parks_473
RESCUE_WORKERS="${RESCUE_WORKERS:-4}"
if [ -n "${AREAS_FILE:-}" ]; then
  test -r "$AREAS_FILE"
  AREAS=$(paste -sd, "$AREAS_FILE")
else
  AREAS="${AREAS:?AREAS or AREAS_FILE is required}"
fi

test "$RESCUE_WORKERS" -ge 1
test "$RESCUE_WORKERS" -le 6
cd "$PROJECT"
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
export TMPDIR="/tmp/haoxi.yuan-gmaps-rescue-${PBS_JOBID:-manual}"
export XDG_CACHE_HOME="$TMPDIR/xdg-cache"
export NODE_OPTIONS=--max-old-space-size=3072
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$BASE/logs/poi-rescue" "$BASE/status"

pids=()
labels=()
for worker in $(seq 1 "$RESCUE_WORKERS"); do
  label=$(printf 'rescue_%02d_of_%02d' "$worker" "$RESCUE_WORKERS")
  log="$BASE/logs/poi-rescue/${label}.log"
  echo "[RESCUE] starting $label at $(date -Is)" | tee -a "$log"
  node src/multi-boundary-orchestrator.js \
    --boundaries "$BOUNDARIES" \
    --name "$BATCH" \
    --cell-size 200 \
    --buffer 15 \
    --areas "$AREAS" \
    --shard "$worker/$RESCUE_WORKERS" \
    >>"$log" 2>&1 &
  pids+=("$!")
  labels+=("$label")
  # The bootstrap browser-launch mean is 8s; stagger cold starts by one mean.
  if [ "$worker" -lt "$RESCUE_WORKERS" ]; then sleep 8; fi
done

failures=0
for index in "${!pids[@]}"; do
  if wait "${pids[$index]}"; then
    echo "[RESCUE] ${labels[$index]} completed at $(date -Is)"
  else
    rc=$?
    echo "[RESCUE] ${labels[$index]} failed rc=$rc at $(date -Is)" >&2
    failures=$((failures + 1))
  fi
done

printf '%s\n' "workers=$RESCUE_WORKERS" "failures=$failures" \
  "finished_at=$(date -Is)" > "$BASE/status/poi_rescue.status"
test "$failures" -eq 0
