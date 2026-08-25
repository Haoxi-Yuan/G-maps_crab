#!/usr/bin/env bash
set -Eeuo pipefail

FULL_RUN=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
BENCH_RUN=/data/haoxi/CLI_scraper/experiments/reviewer_parallel_benchmark_20260824
CODE_ROOT="$FULL_RUN/code"
NODE_ROOT=/data/haoxi/CLI_scraper/.runtime/node-v22.14.0-linux-x64

export PATH="$NODE_ROOT/bin:/usr/bin:/bin"
export PLAYWRIGHT_BROWSERS_PATH=/data/haoxi/CLI_scraper/.playwright-browsers
cd "$CODE_ROOT"

exec node scripts/benchmark-reviewer-parallel.js \
  --list "$FULL_RUN/list/reviewers.all.ndjson" \
  --mode staircase \
  --concurrency-sequence 15,18,21,24 \
  --browser-count 3 \
  --profiles-per-stage 200 \
  --request-interval-ms 150 \
  --initial-wait-ms 2500 \
  --max-profile-reviews 200 \
  --fetch-retries 2 \
  --cooldown-ms 5000 \
  --stop-on-unsafe \
  --output "$BENCH_RUN/multichrome-upper-confirm-b3.json"
