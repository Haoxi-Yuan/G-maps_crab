#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/data2/shared/haoxi/CLI_scraper
LOCK="$ROOT/.tmp/poi-seven-city-pipeline.lock"
STATUS="$ROOT/output/poi-seven-city-pipeline.live.json"
CITIES=(warsaw vienna madrid stockholm taipei tokyo new_york)
POINT_COUNTS=(515 413 603 214 270 724 1217)
POINT_HASHES=(
  6b9c7f08b2924707f0c1725803c5166ac995703dcdbad5cfbc92e3f711680dd6
  3e57abb795acf290813f9d97628a2fcb9ec135e9279a40ea0a9e3631b6ae93f2
  c89d0684402cd1f457d27db216e950fde35f0b71076532aa4119c7b0037a0e91
  9396529891735a384a32c6629a602524431f8e3df7f9611aeb4ed0bd7589c0b8
  d1b2239df63c64603148411a32f8ac57a1e9be0e588d7766a3269885e5f9b5db
  0e15afa967aacb167cd4ac8ee03ccb0d60d36067d8b79bc1a2846f37a7e69b3e
  54005a7c25ffaff96ddb372d7d3055b70a431d3409ad21b43812540905733938
)
BOUNDARY_HASHES=(
  56f9032b88080fba5b2d5a77bc8581797266f10ab274d17b14de80a3322fa5da
  bbe3e7f5200239aa11b3ec37344085b518611e44ed1b7dddda1472cc23f8324c
  42cc2b55ed01f336118e785665f707dd79b694f775cc23b92d9b348155c62881
  0ca335d1c20a8db7d8f957f1f0b4491867dede802471e1d4a1c1d5126b6bebaf
  20dd94e550eb42ae058aad8b5a6766e44f93798e9b4b071674077bbb2e3f30e3
  a4b584ee1d9a4828c57f03466eee5b0633c5a4b66d896b0269f25e4af0947038
  e1aa70afd7f04e037dbce0067b63fe9a7b297e8e4ddb3b09db54de58452c2379
)

mkdir -p "$ROOT/.tmp" "$ROOT/output"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[MULTICITY] another seven-city POI pipeline holds $LOCK"
  exit 73
fi

cd "$ROOT"
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use default >/dev/null
export TMPDIR="$ROOT/.tmp"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.playwright-browsers"

expected_categories=$(node -e 'console.log(require("./config/categories.json").categories.length)')
if [[ "$expected_categories" != 177 ]]; then
  echo "[MULTICITY] expected 177 categories, got $expected_categories"
  exit 65
fi

current_city=""
current_index=0
write_status() {
  local phase=$1 message=${2:-}
  STATUS_FILE="$STATUS" PHASE="$phase" MESSAGE="$message" CITY="$current_city" \
    CITY_INDEX="$current_index" CITY_TOTAL="${#CITIES[@]}" node - <<'NODE'
const fs = require('fs');
const file = process.env.STATUS_FILE;
const value = {
  version: 1,
  pipeline: 'poi-search',
  phase: process.env.PHASE,
  city: process.env.CITY || null,
  cityIndex: Number(process.env.CITY_INDEX),
  cityTotal: Number(process.env.CITY_TOTAL),
  message: process.env.MESSAGE || null,
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(file + '.tmp', JSON.stringify(value));
fs.renameSync(file + '.tmp', file);
NODE
}

on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    write_status failed "pipeline exited with rc=$rc"
    echo "[MULTICITY] FAILED city=$current_city rc=$rc at $(date -Is)"
  fi
}
trap on_exit EXIT

verify_city() {
  local city=$1
  local checkpoint="output/$city/poi_search.json"
  local places="output/$city/places.ndjson"
  node - "$checkpoint" "$places" <<'NODE'
const fs = require('fs');
const categories = require('./config/categories.json').categories;
const checkpoint = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const got = new Set((checkpoint.results || []).map(x => x.category));
const missing = categories.filter(x => !got.has(x));
const extra = [...got].filter(x => !categories.includes(x));
const places = fs.statSync(process.argv[3]);
if (missing.length || extra.length || got.size !== categories.length || places.size === 0) {
  throw new Error(`incomplete checkpoint: got=${got.size} missing=${missing.length} extra=${extra.length} placesBytes=${places.size}`);
}
console.log(`[MULTICITY] verified categories=${got.size} placesBytes=${places.size} totalPlaceIds=${checkpoint.totalPlaceIds || 0}`);
NODE
}

echo "[MULTICITY] START order=${CITIES[*]} at $(date -Is)"
write_status starting "validating inputs"

for i in "${!CITIES[@]}"; do
  city=${CITIES[$i]}
  current_city=$city
  current_index=$((i + 1))
  points="data/$city/${city}_points.json"
  boundary="data/$city/${city}_boundary.geojson"
  run="output/$city"
  checkpoint="$run/poi_search.json"
  log="$run/poi_search.log"
  complete="$run/.poi_search_complete"

  [[ -f "$points" && -f "$boundary" ]] || {
    echo "[MULTICITY] missing input for $city"; exit 66;
  }
  actual_count=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).length)' "$points")
  actual_points_hash=$(sha256sum "$points" | awk '{print $1}')
  actual_boundary_hash=$(sha256sum "$boundary" | awk '{print $1}')
  [[ "$actual_count" == "${POINT_COUNTS[$i]}" ]] || {
    echo "[MULTICITY] $city point count mismatch: $actual_count"; exit 65;
  }
  [[ "$actual_points_hash" == "${POINT_HASHES[$i]}" ]] || {
    echo "[MULTICITY] $city points hash mismatch"; exit 65;
  }
  [[ "$actual_boundary_hash" == "${BOUNDARY_HASHES[$i]}" ]] || {
    echo "[MULTICITY] $city boundary hash mismatch"; exit 65;
  }

  mkdir -p "$run"
  {
    echo "started_at=$(date -Is)"
    echo "city=$city"
    echo "points_count=$actual_count"
    echo "points_sha256=$actual_points_hash"
    echo "boundary_sha256=$actual_boundary_hash"
    sha256sum poi-search.sh src/poi-searcher-api.js src/filter-by-boundary.js config/categories.json
  } >> "$run/run_manifest.txt"

  if [[ -f "$complete" ]]; then
    verify_city "$city"
    echo "[MULTICITY] SKIP completed city=$city"
    continue
  fi

  write_status running "POI search"
  echo "[MULTICITY] CITY START $current_index/${#CITIES[@]} $city at $(date -Is)"
  ./poi-search.sh --run --foreground \
    --city "$city" \
    --points "$points" \
    --output "$checkpoint"

  tail -n 500 "$log" | grep -qx '=== COMPLETED ===' || {
    echo "[MULTICITY] completion marker missing for $city"; exit 67;
  }
  verify_city "$city"
  printf 'completed_at=%s\n' "$(date -Is)" > "$complete"
  write_status city_complete "validated 177 categories"
  echo "[MULTICITY] CITY COMPLETE $current_index/${#CITIES[@]} $city at $(date -Is)"
done

current_city=""
current_index=${#CITIES[@]}
write_status complete "all seven cities validated"
echo "[MULTICITY] COMPLETE all cities at $(date -Is)"
