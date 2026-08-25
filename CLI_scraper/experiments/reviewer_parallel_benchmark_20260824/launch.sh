#!/usr/bin/env bash
set -Eeuo pipefail

RUN=/data/haoxi/CLI_scraper/experiments/reviewer_parallel_benchmark_20260824
SESSION=gmaps-reviewer-parallel-bench
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "$SESSION already exists"
  exit 0
fi
tmux new-session -d -s "$SESSION" \
  "exec '$RUN/run-adaptive.sh' >> '$RUN/adaptive-live-load.log' 2>&1"
echo "started $SESSION"
