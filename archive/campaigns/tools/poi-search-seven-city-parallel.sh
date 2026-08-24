#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/data2/shared/haoxi/CLI_scraper
MANIFEST="$ROOT/.tmp/poi-seven-city-inputs.tsv"
LOCK="$ROOT/.tmp/poi-seven-city-pipeline.lock"
AGGREGATE="$ROOT/output/poi-seven-city-pipeline.live.json"
FAILURES="$ROOT/output/poi-seven-city-failures.tsv"
MAX_CONCURRENT=${MAX_CONCURRENT:-2}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-2}

[[ "$MAX_CONCURRENT" =~ ^[1-3]$ ]] || { echo "MAX_CONCURRENT must be 1..3"; exit 64; }
[[ -f "$MANIFEST" ]] || { echo "missing $MANIFEST"; exit 66; }
mkdir -p "$ROOT/.tmp" "$ROOT/output"
exec 9>"$LOCK"
flock -n 9 || { echo "another seven-city pipeline holds $LOCK"; exit 73; }

cd "$ROOT"
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use default >/dev/null
export TMPDIR="$ROOT/.tmp"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.playwright-browsers"

category_count=$(node -e 'console.log(require("./config/categories.json").categories.length)')
[[ "$category_count" == 177 ]] || { echo "expected 177 categories, got $category_count"; exit 65; }

write_json() {
  local file=$1 phase=$2 city=${3:-} attempt=${4:-0} message=${5:-}
  FILE="$file" PHASE="$phase" CITY="$city" ATTEMPT="$attempt" MESSAGE="$message" \
    MAX_CONCURRENT="$MAX_CONCURRENT" node - <<'NODE'
const fs = require('fs');
const value = {
  version: 2, pipeline: 'poi-search', phase: process.env.PHASE,
  city: process.env.CITY || null, attempt: Number(process.env.ATTEMPT || 0),
  maxConcurrent: Number(process.env.MAX_CONCURRENT),
  message: process.env.MESSAGE || null, updatedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.FILE + '.tmp', JSON.stringify(value));
fs.renameSync(process.env.FILE + '.tmp', process.env.FILE);
NODE
}

verify_city() {
  local city=$1
  node - "output/$city/poi_search.json" "output/$city/places.ndjson" <<'NODE'
const fs = require('fs');
const expected = require('./config/categories.json').categories;
const checkpoint = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const got = new Set((checkpoint.results || []).map(x => x.category));
const missing = expected.filter(x => !got.has(x));
const extra = [...got].filter(x => !expected.includes(x));
const bytes = fs.statSync(process.argv[3]).size;
if (got.size !== expected.length || missing.length || extra.length || !bytes) {
  throw Error(`got=${got.size} missing=${missing.length} extra=${extra.length} placesBytes=${bytes}`);
}
console.log(`[PARALLEL] verified ${process.argv[2]} categories=${got.size} placesBytes=${bytes}`);
NODE
}

run_city() (
  set +e
  local city=$1 expected_count=$2 points_hash=$3 boundary_hash=$4
  local run="output/$city" points="data/$city/${city}_points.json"
  local boundary="data/$city/${city}_boundary.geojson" checkpoint="$run/poi_search.json"
  local log="$run/poi_search.log" status="$run/poi_search.pipeline.json"
  mkdir -p "$run"

  if [[ ! -f "$points" || ! -f "$boundary" ]]; then
    write_json "$status" failed "$city" 0 "missing input"
    printf '%s\t%s\t%s\n' "$(date -Is)" "$city" "missing input" >> "$FAILURES"
    exit 0
  fi
  actual_count=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).length)' "$points")
  actual_points_hash=$(sha256sum "$points" | awk '{print $1}')
  actual_boundary_hash=$(sha256sum "$boundary" | awk '{print $1}')
  if [[ "$actual_count" != "$expected_count" || "$actual_points_hash" != "$points_hash" || "$actual_boundary_hash" != "$boundary_hash" ]]; then
    write_json "$status" failed "$city" 0 "input validation failed"
    printf '%s\t%s\t%s\n' "$(date -Is)" "$city" "input validation failed" >> "$FAILURES"
    exit 0
  fi

  if [[ -f "$run/.poi_search_complete" ]] && verify_city "$city"; then
    write_json "$status" complete "$city" 0 "already validated"
    exit 0
  fi

  for ((attempt=1; attempt<=MAX_ATTEMPTS; attempt++)); do
    write_json "$status" running "$city" "$attempt" "POI search"
    {
      echo "started_at=$(date -Is) attempt=$attempt"
      echo "city=$city points_count=$actual_count"
      echo "points_sha256=$actual_points_hash boundary_sha256=$actual_boundary_hash"
      sha256sum poi-search.sh src/poi-searcher-api.js src/filter-by-boundary.js config/categories.json
    } >> "$run/run_manifest.txt"
    echo "[PARALLEL] START city=$city attempt=$attempt at $(date -Is)"
    ./poi-search.sh --run --foreground --city "$city" --points "$points" --output "$checkpoint"
    wrapper_rc=$?
    if (( wrapper_rc == 0 )) && tail -n 500 "$log" | grep -qx '=== COMPLETED ===' && verify_city "$city"; then
      printf 'completed_at=%s\n' "$(date -Is)" > "$run/.poi_search_complete"
      write_json "$status" complete "$city" "$attempt" "validated 177 categories"
      echo "[PARALLEL] COMPLETE city=$city attempt=$attempt at $(date -Is)"
      exit 0
    fi
    write_json "$status" retrying "$city" "$attempt" "checkpoint incomplete"
    echo "[PARALLEL] RETRY city=$city attempt=$attempt wrapper_rc=$wrapper_rc"
    sleep 30
  done

  write_json "$status" failed "$city" "$MAX_ATTEMPTS" "attempts exhausted; queue continued"
  printf '%s\t%s\t%s\n' "$(date -Is)" "$city" "attempts exhausted" >> "$FAILURES"
  echo "[PARALLEL] FAILED city=$city; continuing other cities"
  exit 0
)

cleanup() {
  rc=$?
  if (( rc != 0 )); then write_json "$AGGREGATE" interrupted "" 0 "supervisor rc=$rc"; fi
}
trap cleanup EXIT

: > "$FAILURES"
write_json "$AGGREGATE" running "" 0 "two-city scheduler"
echo "[PARALLEL] START max_concurrent=$MAX_CONCURRENT at $(date -Is)"

while IFS=$'\t' read -r city count points_hash boundary_hash; do
  while (( $(jobs -pr | wc -l | tr -d ' ') >= MAX_CONCURRENT )); do
    wait -n || true
  done
  run_city "$city" "$count" "$points_hash" "$boundary_hash" &
done < "$MANIFEST"
wait

failed_count=$(wc -l < "$FAILURES" | tr -d ' ')
if (( failed_count == 0 )); then
  write_json "$AGGREGATE" complete "" 0 "all cities validated"
else
  write_json "$AGGREGATE" complete_with_failures "" 0 "$failed_count cities need attention"
fi
echo "[PARALLEL] FINISH failures=$failed_count at $(date -Is)"
