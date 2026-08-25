#!/usr/bin/env bash
set -Eeuo pipefail

RUN_ROOT=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
CODE_ROOT="$RUN_ROOT/code"
NODE_ROOT=/data/haoxi/CLI_scraper/.runtime/node-v22.14.0-linux-x64
DATABASE=/data/haoxi/CLI_scraper/output/singapore/2026-08-14/singapore_reviews_20260814.db

export PATH="$NODE_ROOT/bin:/usr/bin:/bin"
export TMPDIR="$RUN_ROOT/tmp/parallel-canary"
export PLAYWRIGHT_BROWSERS_PATH=/data/haoxi/CLI_scraper/.playwright-browsers
mkdir -p "$TMPDIR" "$RUN_ROOT/parallel-canary-output" "$RUN_ROOT/status" "$RUN_ROOT/logs"
cd "$CODE_ROOT"

exec /usr/bin/time -v node src/cli/run-reviewers-parallel.js \
  --run-root "$RUN_ROOT" \
  --input "$DATABASE" \
  --output-dir "$RUN_ROOT/parallel-canary-output" \
  --live-status "$RUN_ROOT/status/reviewers.parallel.canary.live.json" \
  --concurrency 27 \
  --request-interval-ms 150 \
  --window-size 200 \
  --browser-restart-every 2800 \
  --max-reviewers 400 \
  --max-profile-reviews 200 \
  --fetch-retries 2
