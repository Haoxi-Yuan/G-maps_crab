#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/data2/shared/haoxi/CLI_scraper
RUN="$ROOT/output/singapore"
MIN_FREE_KB=$((25 * 1024 * 1024))

mkdir -p "$RUN" "$ROOT/.tmp"
exec > >(tee -a "$RUN/pipeline.log") 2>&1

timestamp() { date '+%Y-%m-%d %H:%M:%S %z'; }
trap 'rc=$?; (( rc == 0 )) || echo "[PIPELINE] REVIEW RESUME FAILED rc=$rc at $(timestamp)"' EXIT

exec 9>"$ROOT/.tmp/singapore_20260811.pipeline.lock"
if ! flock -n 9; then
  echo "[PIPELINE] another Singapore pipeline already holds the lock"
  exit 73
fi

cd "$ROOT"
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use default >/dev/null
export TMPDIR="$ROOT/.tmp"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.playwright-browsers"

node --check src/review-scraper.js
node --check src/api-review-fetcher.js
echo "[PIPELINE] REVIEW RESUME WITH LIVE STATUS at $(timestamp)"
sha256sum src/review-scraper.js src/api-review-fetcher.js >> "$RUN/run_manifest.txt"

setsid node src/review-scraper.js \
  --input "$RUN/places.ndjson" \
  --output "$RUN/reviews.ndjson" \
  --live-status "$RUN/reviews.live.json" \
  --max-reviews 50000 \
  > >(tee -a "$RUN/reviews.log") 2>&1 &
review_pid=$!
guard_marker="$RUN/.disk_guard_triggered.$review_pid"
echo "[PIPELINE] review_pid=$review_pid live_status=$RUN/reviews.live.json"

(
  while kill -0 "$review_pid" 2>/dev/null; do
    sleep 300
    kill -0 "$review_pid" 2>/dev/null || exit 0
    free_kb=$(df -Pk "$RUN" | awk 'NR==2 {print $4}')
    echo "[PIPELINE] disk_free_kb=$free_kb at $(timestamp)"
    if (( free_kb < MIN_FREE_KB )); then
      echo "[PIPELINE] DISK GUARD: less than 25 GiB free; stopping review safely"
      : > "$guard_marker"
      kill -TERM -- "-$review_pid" 2>/dev/null || true
      exit 0
    fi
  done
) &
guard_pid=$!

set +e
wait "$review_pid"
review_rc=$?
kill "$guard_pid" 2>/dev/null
wait "$guard_pid" 2>/dev/null
set -e

if [[ -f "$guard_marker" ]]; then
  echo "[PIPELINE] review stopped by disk guard; it can be resumed after freeing space"
  exit 88
fi
if (( review_rc != 0 )); then
  echo "[PIPELINE] review exited with rc=$review_rc"
  exit "$review_rc"
fi

grep -Fq '=== Summary ===' "$RUN/reviews.log"
echo "[PIPELINE] COMPLETE at $(timestamp)"
