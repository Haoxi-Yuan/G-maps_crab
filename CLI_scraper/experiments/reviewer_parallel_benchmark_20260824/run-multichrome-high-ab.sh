#!/usr/bin/env bash
set -Eeuo pipefail

FULL_RUN=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
BENCH_RUN=/data/haoxi/CLI_scraper/experiments/reviewer_parallel_benchmark_20260824
CODE_ROOT="$FULL_RUN/code"
NODE_ROOT=/data/haoxi/CLI_scraper/.runtime/node-v22.14.0-linux-x64

export PATH="$NODE_ROOT/bin:/usr/bin:/bin"
export PLAYWRIGHT_BROWSERS_PATH=/data/haoxi/CLI_scraper/.playwright-browsers
cd "$CODE_ROOT"

browser_order=(1 2 3 3 2 1)
for run_index in "${!browser_order[@]}"; do
  browser_count="${browser_order[$run_index]}"
  repeat=$((run_index < 3 ? 1 : 2))
  node scripts/benchmark-reviewer-parallel.js \
    --list "$FULL_RUN/list/reviewers.all.ndjson" \
    --mode staircase \
    --concurrency-sequence 27 \
    --browser-count "$browser_count" \
    --profiles-per-stage 100 \
    --request-interval-ms 150 \
    --initial-wait-ms 2500 \
    --max-profile-reviews 200 \
    --fetch-retries 2 \
    --cooldown-ms 0 \
    --output "$BENCH_RUN/multichrome-high-r${repeat}-b${browser_count}-c27.json" \
    >> "$BENCH_RUN/multichrome-high-r${repeat}-b${browser_count}-c27.log" 2>&1
done
