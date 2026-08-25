#!/usr/bin/env bash
set -Eeuo pipefail

EXPERIMENT_ROOT=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_100_20260824
CODE_ROOT="$EXPERIMENT_ROOT/code"
RUN_ROOT="$EXPERIMENT_ROOT/run"
DATABASE=/data/haoxi/CLI_scraper/output/singapore/2026-08-14/singapore_reviews_20260814.db
NODE_BIN=/data/haoxi/CLI_scraper/.runtime/node-v22.14.0-linux-x64/bin/node

mkdir -p "$RUN_ROOT"
if [ "${1:-resume}" = "fresh" ]; then
  rm -f "$RUN_ROOT/reviewers.ndjson" "$RUN_ROOT/reviewers.live.json" \
    "$RUN_ROOT/reviewer-quality-report.json" "$RUN_ROOT/time.txt" \
    "$RUN_ROOT/exit.code" "$RUN_ROOT/complete.marker" "$RUN_ROOT/needs-retry.marker"
fi

export PLAYWRIGHT_BROWSERS_PATH=/data/haoxi/CLI_scraper/.playwright-browsers
cd "$CODE_ROOT"
exec >>"$RUN_ROOT/run.log" 2>&1

echo "RUN_START=$(date -Is)"
echo "NODE=$($NODE_BIN -v)"
echo "DATABASE=$DATABASE"

set +e
/usr/bin/time -v -o "$RUN_ROOT/time.txt" \
  "$NODE_BIN" src/cli/run-reviewers.js \
    --input "$DATABASE" \
    --output "$RUN_ROOT/reviewers.ndjson" \
    --list-output "$RUN_ROOT/reviewers.list.ndjson" \
    --list-limit 100 \
    --list-order review-count-desc \
    --max-reviewers 100 \
    --max-profile-reviews 200 \
    --delay-ms 500 \
    --live-status "$RUN_ROOT/reviewers.live.json"
exit_status=$?
set -e

printf '%s\n' "$exit_status" >"$RUN_ROOT/exit.code"
if [ "$exit_status" -eq 0 ]; then
  "$NODE_BIN" scripts/analyze-reviewer-profiles.js \
    --input "$RUN_ROOT/reviewers.ndjson" \
    --live-status "$RUN_ROOT/reviewers.live.json" \
    --output "$RUN_ROOT/reviewer-quality-report.json"
  terminal_errors=$(
    "$NODE_BIN" -e 'const r=require(process.argv[1]);process.stdout.write(String(r.summary.error_records))' \
      "$RUN_ROOT/reviewer-quality-report.json"
  )
  if [ "$terminal_errors" -eq 0 ]; then
    rm -f "$RUN_ROOT/needs-retry.marker"
    date -Is >"$RUN_ROOT/complete.marker"
  else
    date -Is >"$RUN_ROOT/needs-retry.marker"
  fi
fi
echo "RUN_END=$(date -Is) EXIT=$exit_status"
exit "$exit_status"
