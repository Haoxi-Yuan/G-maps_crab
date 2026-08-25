#!/usr/bin/env bash
set -Eeuo pipefail

RUN_ROOT=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
if [[ ! -s "$RUN_ROOT/list/manifest.json" ]]; then
  echo "reviewer list manifest is not ready" >&2
  exit 3
fi

for shard in 0 1 2 3; do
  session="gmaps-reviewers-full-s$shard"
  if tmux has-session -t "$session" 2>/dev/null; then
    echo "$session already exists"
    continue
  fi
  tmux new-session -d -s "$session" \
    "exec '$RUN_ROOT/run-shard.sh' '$shard' >> '$RUN_ROOT/logs/reviewers.part-$shard.log' 2>&1"
  echo "started $session"
done

