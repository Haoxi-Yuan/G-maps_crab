#!/usr/bin/env bash
set -Eeuo pipefail

RUN_ROOT=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
SESSION=gmaps-reviewers-full-parallel
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "$SESSION already exists"
  exit 0
fi
tmux new-session -d -s "$SESSION" \
  "exec '$RUN_ROOT/run-parallel.sh' >> '$RUN_ROOT/logs/reviewers.parallel.log' 2>&1"
echo "started $SESSION"
