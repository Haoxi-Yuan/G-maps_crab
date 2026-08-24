#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/data2/shared/haoxi/CLI_scraper
CITY=munich
RUN="$ROOT/output/$CITY"
POINTS="$ROOT/data/$CITY/${CITY}_points.json"
BOUNDARY="$ROOT/data/$CITY/${CITY}_boundary.geojson"
STATUS="$RUN/poi_search.pipeline.json"
EXPECTED_POINTS=309
EXPECTED_POINTS_SHA=722659cd86ed0d0fa7053f4b36faef6fa4bdb7c0528f42adc132deada1932754
EXPECTED_BOUNDARY_SHA=6eb38aafeae93cde4a5b0097776c94247006d3acb32d01cc24d35f071f191fd2
MAX_ATTEMPTS=2

cd "$ROOT"
mkdir -p "$RUN" "$ROOT/.tmp"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use default >/dev/null
export TMPDIR="$ROOT/.tmp"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.playwright-browsers"

write_status() {
  local phase=$1 attempt=$2 message=$3
  FILE="$STATUS" PHASE="$phase" ATTEMPT="$attempt" MESSAGE="$message" node - <<'NODE'
const fs = require('fs');
const value = {
  version: 2,
  pipeline: 'poi-search',
  phase: process.env.PHASE,
  city: 'munich',
  attempt: Number(process.env.ATTEMPT),
  maxConcurrent: 3,
  message: process.env.MESSAGE,
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.FILE + '.tmp', JSON.stringify(value));
fs.renameSync(process.env.FILE + '.tmp', process.env.FILE);
NODE
}

verify_inputs() {
  local count points_sha boundary_sha
  count=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).length)' "$POINTS")
  points_sha=$(sha256sum "$POINTS" | awk '{print $1}')
  boundary_sha=$(sha256sum "$BOUNDARY" | awk '{print $1}')
  [[ $count == "$EXPECTED_POINTS" && $points_sha == "$EXPECTED_POINTS_SHA" && $boundary_sha == "$EXPECTED_BOUNDARY_SHA" ]]
}

verify_output() {
  node - "$RUN/poi_search.json" "$RUN/places.ndjson" <<'NODE'
const fs = require('fs');
const expected = require('./config/categories.json').categories;
const checkpoint = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const got = new Set((checkpoint.results || []).map((value) => value.category));
const missing = expected.filter((value) => !got.has(value));
const bytes = fs.statSync(process.argv[3]).size;
if (got.size !== expected.length || missing.length || bytes === 0) {
  throw Error(`categories=${got.size}/${expected.length} missing=${missing.length} placesBytes=${bytes}`);
}
console.log(`[MUNICH] verified categories=${got.size} placesBytes=${bytes}`);
NODE
}

if ! verify_inputs; then
  write_status failed 0 'input validation failed'
  echo '[MUNICH] input validation failed' >&2
  exit 65
fi

{
  echo "started_at=$(date -Is)"
  echo "points_count=$EXPECTED_POINTS"
  echo "points_sha256=$EXPECTED_POINTS_SHA"
  echo "boundary_sha256=$EXPECTED_BOUNDARY_SHA"
  sha256sum poi-search.sh src/poi-searcher-api.js src/filter-by-boundary.js config/categories.json
} >> "$RUN/run_manifest.txt"

for ((attempt=1; attempt<=MAX_ATTEMPTS; attempt++)); do
  write_status running "$attempt" 'POI search'
  echo "[MUNICH] START attempt=$attempt at $(date -Is)"
  set +e
  ./poi-search.sh --run --foreground --city "$CITY" --points "$POINTS" --output "$RUN/poi_search.json"
  wrapper_rc=$?
  set -e
  if (( wrapper_rc == 0 )) && tail -n 500 "$RUN/poi_search.log" | grep -qx '=== COMPLETED ===' && verify_output; then
    printf 'completed_at=%s\n' "$(date -Is)" > "$RUN/.poi_search_complete"
    write_status complete "$attempt" 'validated 177 categories'
    echo "[MUNICH] COMPLETE at $(date -Is)"
    exit 0
  fi
  write_status retrying "$attempt" "checkpoint incomplete; wrapper_rc=$wrapper_rc"
  echo "[MUNICH] RETRY attempt=$attempt wrapper_rc=$wrapper_rc"
  sleep 30
done

write_status failed "$MAX_ATTEMPTS" 'attempts exhausted'
echo '[MUNICH] FAILED after retries' >&2
exit 1
