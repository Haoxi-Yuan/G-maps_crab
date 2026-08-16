#!/bin/bash
set -Eeuo pipefail

BASE=/hpctmp/haoxi.yuan/gmaps_atlas
PROJECT="$BASE/CLI_scraper"
WORKFLOW_ID="${WORKFLOW_ID:?WORKFLOW_ID is required}"
WORKERS_PER_JOB="${WORKERS_PER_JOB:-12}"
JOB_ID="${PBS_JOBID:-manual}"
LOG_DIR="$BASE/logs/adaptive/$WORKFLOW_ID"

cd "$PROJECT"
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
export TMPDIR="/tmp/haoxi.yuan-adaptive-${JOB_ID}"
export XDG_CACHE_HOME="$TMPDIR/xdg-cache"
export NODE_OPTIONS=--max-old-space-size=2048
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$LOG_DIR"

pids=()
labels=()
for local_worker in $(seq 1 "$WORKERS_PER_JOB"); do
  label="${JOB_ID}.w$(printf '%02d' "$local_worker")"
  log="$LOG_DIR/$label.log"
  node src/adaptive-poi-worker.js \
    --workflow "$WORKFLOW_ID" \
    --worker-id "$label" \
    >>"$log" 2>&1 &
  pids+=("$!")
  labels+=("$label")
done

failures=0
for index in "${!pids[@]}"; do
  if wait "${pids[$index]}"; then
    :
  else
    rc=$?
    echo "worker ${labels[$index]} failed rc=$rc" >&2
    failures=$((failures + 1))
  fi
done

echo "workflow=$WORKFLOW_ID workers=$WORKERS_PER_JOB failures=$failures finished_at=$(date -Is)"
test "$failures" -eq 0
