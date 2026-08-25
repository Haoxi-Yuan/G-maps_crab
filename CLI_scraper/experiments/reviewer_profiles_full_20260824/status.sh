#!/usr/bin/env bash
set -Eeuo pipefail

RUN_ROOT=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
echo "SESSIONS"
tmux list-sessions 2>/dev/null | grep -E 'gmaps-reviewers-(full|list|parallel)' || true
echo "MANIFEST"
if [[ -s "$RUN_ROOT/list/manifest.json" ]]; then
  cat "$RUN_ROOT/list/manifest.json"
else
  echo "not ready"
fi
echo "WORKERS"
for shard in 0 1 2 3; do
  echo "shard=$shard"
  if [[ -s "$RUN_ROOT/status/reviewers.part-$shard.live.json" ]]; then
    cat "$RUN_ROOT/status/reviewers.part-$shard.live.json"
  else
    echo "no live status"
  fi
  tail -n 3 "$RUN_ROOT/logs/reviewers.part-$shard.log" 2>/dev/null || true
done

echo "PARALLEL"
if [[ -s "$RUN_ROOT/status/reviewers.parallel.live.json" ]]; then
  cat "$RUN_ROOT/status/reviewers.parallel.live.json"
else
  echo "not active"
fi
tail -n 5 "$RUN_ROOT/logs/reviewers.parallel.log" 2>/dev/null || true

echo "AGGREGATE"
node - "$RUN_ROOT" <<'NODE'
const fs = require('fs');
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(`${root}/list/manifest.json`));
let completed = 0;
let currentRunErrors = 0;
const shards = [];
for (let shard = 0; shard < manifest.shards; shard += 1) {
  const file = `${root}/status/reviewers.part-${shard}.live.json`;
  if (!fs.existsSync(file)) continue;
  const live = JSON.parse(fs.readFileSync(file));
  const completedBeforeStart = manifest.shard_counts[shard] - live.total;
  const completedTotal = completedBeforeStart + live.processed;
  completed += completedTotal;
  currentRunErrors += live.errors || 0;
  shards.push({ shard, completed: completedTotal, total: manifest.shard_counts[shard], phase: live.phase, updated_at: live.updated_at });
}
console.log(JSON.stringify({
  completed,
  total: manifest.unique_google_reviewers,
  progress: Number((completed / manifest.unique_google_reviewers).toFixed(8)),
  current_run_errors: currentRunErrors,
  shards,
}, null, 2));
NODE
