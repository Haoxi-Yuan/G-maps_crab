#!/bin/bash
set -Eeuo pipefail

BASE=/hpctmp/haoxi.yuan/gmaps_atlas
PROJECT="$BASE/CLI_scraper"
PBS_LOGS="$BASE/pbs_logs"
STATUS="$BASE/status"
NUM_GROUPS=8

cd "$PROJECT"
mkdir -p "$PBS_LOGS" "$STATUS"
test -s "$BASE/images/playwright-1.57.0-noble.sif"
test -d node_modules/playwright

existing=$({ qstat -u haoxi.yuan 2>/dev/null || true; } \
  | awk '$4 ~ /^sgp_[pr][0-9]+$/ { print $1 }')
if [ -n "$existing" ]; then
  echo "Refusing duplicate submission; existing sgp_p*/sgp_r* jobs:" >&2
  echo "$existing" >&2
  exit 2
fi

stamp=$(date +%Y%m%dT%H%M%S)
manifest="$STATUS/submission_${stamp}.txt"
poi_ids=()
review_ids=()

# Status files are readiness signals for the matching POI/Review group. Never
# let a new submission observe completion state from an older run.
for group in $(seq 1 "$NUM_GROUPS"); do
  rm -f "$STATUS/poi_group_${group}.status" "$STATUS/review_group_${group}.status"
done

for group in $(seq 1 "$NUM_GROUPS"); do
  job=$(qsub \
    -N "sgp_p$(printf '%02d' "$group")" \
    -v "GROUP=$group" \
    -o "$PBS_LOGS/poi_group_${group}.${stamp}.out" \
    scripts/hpc/atlas-gmaps-poi.pbs)
  poi_ids+=("$job")
  printf 'POI group=%s job=%s\n' "$group" "$job" | tee -a "$manifest"
done

# Review groups are submitted immediately after the POI groups. Their workers
# wait per area for an individual completion marker, or for the corresponding
# POI group status before consuming partial output. There is deliberately no
# global validation job or PBS dependency gate.
for group in $(seq 1 "$NUM_GROUPS"); do
  job=$(qsub \
    -N "sgp_r$(printf '%02d' "$group")" \
    -v "GROUP=$group" \
    -o "$PBS_LOGS/review_group_${group}.${stamp}.out" \
    scripts/hpc/atlas-gmaps-review.pbs)
  review_ids+=("$job")
  printf 'REVIEW group=%s job=%s dependency=none\n' "$group" "$job" | tee -a "$manifest"
done

printf 'SUBMITTED_AT=%s\nPIPELINE_GATE=none\nPOI_WORKERS=%s\nREVIEW_WORKERS=%s\nBUFFER_METERS=15\nCELL_SIZE_METERS=200\nBOUNDARIES=473\n' \
  "$(date -Is)" "$((NUM_GROUPS * 12))" "$((NUM_GROUPS * 12))" >> "$manifest"

echo "manifest=$manifest"
