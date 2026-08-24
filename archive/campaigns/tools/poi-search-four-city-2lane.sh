#!/usr/bin/env bash
# POI search re-run for four cities, two lanes running side by side.
#
# Modelled on poi-search-seven-city-pipeline.sh: each lane walks its cities
# sequentially, verifies its inputs before touching the network, records a run
# manifest, and marks finished cities so an interrupted lane resumes instead of
# repeating work.
#
# Cities carry a _20260820 suffix so both data/ and output/ land beside the
# originals rather than overwriting them — output/paris alone is 31 GB of
# earlier work, and Paris here uses a different boundary entirely.
#
# Usage:  poi-search-four-city-2lane.sh <lane>     lane = a | b
set -Eeuo pipefail

ROOT=/data2/shared/haoxi/CLI_scraper
LANE=${1:?usage: $0 <a|b>}
case "$LANE" in
  # Balanced by sampling points: 812+214 against 603+305.
  a) CITIES=(paris_grand_20260820 stockholm_20260820); POINTS=(812 214) ;;
  b) CITIES=(madrid_20260820 zagreb_20260820);        POINTS=(603 305) ;;
  *) echo "lane must be a or b" >&2; exit 64 ;;
esac

LOCK="$ROOT/.tmp/poi-four-city-$LANE.lock"
STATUS="$ROOT/output/poi-four-city-$LANE.live.json"
mkdir -p "$ROOT/.tmp" "$ROOT/output" "$ROOT/logs"
cd "$ROOT"

exec 9>"$LOCK"
flock -n 9 || { echo "[4CITY-$LANE] another lane instance holds the lock"; exit 70; }

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.playwright-browsers"
export TMPDIR="$ROOT/.tmp"

expected_categories=$(node -e 'console.log(require("./config/categories.json").categories.length)')
[[ "$expected_categories" == 177 ]] || { echo "[4CITY-$LANE] expected 177 categories, got $expected_categories"; exit 65; }

current_city=""
current_index=0

write_status() {
  STATUS_FILE="$STATUS" PHASE="$1" MESSAGE="${2:-}" CITY="$current_city" LANE="$LANE" \
  CITY_INDEX="$current_index" CITY_TOTAL="${#CITIES[@]}" node - <<'NODE'
const fs = require('fs');
const file = process.env.STATUS_FILE;
const value = {
  version: 1, pipeline: 'poi-search', lane: process.env.LANE,
  phase: process.env.PHASE, city: process.env.CITY || null,
  cityIndex: Number(process.env.CITY_INDEX), cityTotal: Number(process.env.CITY_TOTAL),
  message: process.env.MESSAGE || null, updatedAt: new Date().toISOString(),
};
fs.writeFileSync(file + '.tmp', JSON.stringify(value));
fs.renameSync(file + '.tmp', file);
NODE
}

on_exit() {
  local rc=$?
  (( rc == 0 )) || { write_status failed "lane exited rc=$rc at city=$current_city"; \
    echo "[4CITY-$LANE] FAILED city=$current_city rc=$rc at $(date -Is)"; }
}
trap on_exit EXIT

write_status starting "lane $LANE: ${CITIES[*]}"
echo "[4CITY-$LANE] START ${CITIES[*]} at $(date -Is)"

for i in "${!CITIES[@]}"; do
  city=${CITIES[$i]}
  current_city=$city
  current_index=$((i + 1))
  data="data/$city"
  points="$data/${city}_points.json"
  boundary="$data/${city}_boundary.geojson"
  run="output/$city"
  complete="$run/.poi_search_complete"

  [[ -f "$points" && -f "$boundary" ]] || { echo "[4CITY-$LANE] missing input for $city"; exit 66; }

  actual_count=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).length)' "$points")
  [[ "$actual_count" == "${POINTS[$i]}" ]] || {
    echo "[4CITY-$LANE] $city point count mismatch: got $actual_count want ${POINTS[$i]}"; exit 65; }

  if [[ -f "$complete" ]]; then
    echo "[4CITY-$LANE] SKIP completed city=$city"
    continue
  fi

  mkdir -p "$run"
  {
    echo "started_at=$(date -Is)"
    echo "lane=$LANE"
    echo "city=$city"
    echo "points_count=$actual_count"
    sha256sum "$points" "$boundary"
    sha256sum poi-search.sh src/poi-searcher-api.js src/filter-by-boundary.js config/categories.json
  } >> "$run/run_manifest.txt"

  write_status running "POI search"
  echo "[4CITY-$LANE] CITY START $current_index/${#CITIES[@]} $city at $(date -Is)"

  ./poi-search.sh --run --foreground \
    --city "$city" \
    --points "$points" \
    --output "$run/poi_search.json"

  tail -n 500 "$run/poi_search.log" | grep -qx '=== COMPLETED ===' || {
    echo "[4CITY-$LANE] completion marker missing for $city"; exit 67; }

  printf 'completed_at=%s\n' "$(date -Is)" > "$complete"
  write_status city_complete "$city done"
  echo "[4CITY-$LANE] CITY COMPLETE $current_index/${#CITIES[@]} $city at $(date -Is)"
done

write_status complete "lane $LANE finished"
echo "[4CITY-$LANE] ALL DONE at $(date -Is)"
