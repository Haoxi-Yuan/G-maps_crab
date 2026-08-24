#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/data2/shared/haoxi/CLI_scraper}
CITIES=(warsaw vienna madrid stockholm taipei tokyo new_york)

cd "$ROOT"
export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
nvm use default >/dev/null 2>&1

date '+time=%F %T %Z'
if tmux has-session -t gmaps-poi-seven-cities 2>/dev/null; then
  echo 'tmux=running'
else
  echo 'tmux=missing'
fi

node - "${CITIES[@]}" <<'NODE'
const fs = require('fs');

for (const city of process.argv.slice(2)) {
  const readJSON = (path) => {
    try { return JSON.parse(fs.readFileSync(path)); } catch { return {}; }
  };
  const pipeline = readJSON(`output/${city}/poi_search.pipeline.json`);
  const live = readJSON(`output/${city}/poi_search.live.json`);
  const checkpoint = readJSON(`output/${city}/poi_search.json`);
  let bytes = 0;
  try { bytes = fs.statSync(`output/${city}/places.ndjson`).size; } catch {}
  const value = (candidate) => candidate == null ? '-' : candidate;

  console.log([
    city,
    pipeline.phase || 'pending',
    pipeline.attempt || 0,
    `${(checkpoint.results || []).length}/177`,
    live.category || '-',
    live.phase || '-',
    value(live.depth),
    value(live.zoom),
    value(live.totalPlaceIds),
    bytes,
  ].join('\t'));
}
NODE

echo 'failures:'
if [[ -s output/poi-seven-city-failures.tsv ]]; then
  tail -n 20 output/poi-seven-city-failures.tsv
else
  echo 'none'
fi

roots=$(ps -eo pid=,args= | awk '$2 == "node" && index($0, "src/poi-searcher-api") { print $1 }' | tr '\n' ' ')
all=$roots
front=$roots
for _level in 1 2 3 4 5; do
  [[ -n $front ]] || break
  next=''
  for pid in $front; do
    children=$(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ' || true)
    next="$next $children"
  done
  all="$all $next"
  front=$next
done

ids=$(tr ' ' '\n' <<<"$all" | awk 'NF && !seen[$0]++' | paste -sd, -)
echo "poi_tree_pids=$ids"
if [[ -n $ids ]]; then
  ps -o %cpu=,rss= -p "$ids" | awk '
    { cpu += $1; rss += $2; count += 1 }
    END { printf "poi_tree_processes=%d cpu_sum=%.1f%% rss_mib=%.1f\n", count, cpu, rss / 1024 }
  '
fi
