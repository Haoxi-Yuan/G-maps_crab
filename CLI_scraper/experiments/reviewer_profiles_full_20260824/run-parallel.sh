#!/usr/bin/env bash
set -Eeuo pipefail

RUN_ROOT=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
CODE_ROOT="$RUN_ROOT/code"
NODE_ROOT=/data/haoxi/CLI_scraper/.runtime/node-v22.14.0-linux-x64
DATABASE=/data/haoxi/CLI_scraper/output/singapore/2026-08-14/singapore_reviews_20260814.db

export PATH="$NODE_ROOT/bin:/usr/bin:/bin"
export TMPDIR="$RUN_ROOT/tmp/parallel"
export PLAYWRIGHT_BROWSERS_PATH=/data/haoxi/CLI_scraper/.playwright-browsers
mkdir -p "$TMPDIR" "$RUN_ROOT/output" "$RUN_ROOT/status" "$RUN_ROOT/logs"
cd "$CODE_ROOT"

# Single-writer lock: never let two runs append to the same shard outputs.
# flock releases automatically when this process exits (no stale pidfile).
exec 9>"$RUN_ROOT/status/parallel.lock"
if ! flock -n 9; then
  echo "parallel run already active (lock held); exiting"
  exit 1
fi

# Supervised restart loop: the scraper exits 0 on natural completion or a
# graceful SIGTERM drain, and non-zero on watchdog escalation / launch
# exhaustion / kill -9. Restart on non-zero, reaping stray chromium (scoped to
# this run's TMPDIR) between attempts. Resume is append-only and safe.
backoff=5
until /usr/bin/time -v node src/cli/run-reviewers-parallel.js \
  --run-root "$RUN_ROOT" \
  --input "$DATABASE" \
  --live-status "$RUN_ROOT/status/reviewers.parallel.live.json" \
  --concurrency 27 \
  --request-interval-ms 150 \
  --window-size 200 \
  --browser-restart-every 2800 \
  --max-profile-reviews 200 \
  --fetch-retries 2; do
  rc=$?
  echo "[supervisor] node exited rc=$rc; reaping stray chromium and restarting in ${backoff}s"
  pgrep -f -- "$TMPDIR" | xargs -r kill -9 || true
  sleep "$backoff"
  backoff=$(( backoff < 60 ? backoff * 2 : 60 ))
done
echo "[supervisor] node exited 0 (complete/drained); stopping"
