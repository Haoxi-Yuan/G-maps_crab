#!/usr/bin/env bash
set -Eeuo pipefail

RUN_ROOT=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
SESSION=gmaps-reviewers-list

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "$SESSION already exists"
  exit 0
fi

tmux new-session -d -s "$SESSION" \
  "exec /bin/bash '$RUN_ROOT/build-list.sh' >> '$RUN_ROOT/logs/build-list.log' 2>&1"
echo "started $SESSION"
