#!/bin/bash
set -Eeuo pipefail

BASE=/hpctmp/haoxi.yuan/gmaps_atlas
PROJECT="$BASE/CLI_scraper"
GROUPS_COUNT=8
WORKFLOW_ID=''
DATABASE_URL_FILE=''
FINAL_OUTPUT=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workflow) WORKFLOW_ID=$2; shift 2 ;;
    --groups) GROUPS_COUNT=$2; shift 2 ;;
    --database-url-file) DATABASE_URL_FILE=$2; shift 2 ;;
    --output) FINAL_OUTPUT=$2; shift 2 ;;
    --help)
      echo 'Usage: atlas-adaptive-submit.sh --workflow ID --database-url-file FILE --output DIR [--groups 8]'
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${WORKFLOW_ID:?--workflow is required}"
: "${DATABASE_URL_FILE:?--database-url-file is required}"
: "${FINAL_OUTPUT:?--output is required}"
test -r "$DATABASE_URL_FILE"
test "$GROUPS_COUNT" -ge 1

mkdir -p "$BASE/pbs_logs/adaptive" "$BASE/status"
stamp=$(date +%Y%m%dT%H%M%S)
manifest="$BASE/status/adaptive_${WORKFLOW_ID}_${stamp}.txt"

# Compute-node reachability is a hard dependency, not a login-node assumption.
probe=$(qsub \
  -N "adb_${WORKFLOW_ID:0:8}" \
  -v "WORKFLOW_ID=$WORKFLOW_ID,DATABASE_URL_FILE=$DATABASE_URL_FILE" \
  -o "$BASE/pbs_logs/adaptive/db_probe_${stamp}.out" \
  "$PROJECT/scripts/hpc/atlas-adaptive-db-probe.pbs")
printf 'DB_PROBE job=%s\n' "$probe" | tee -a "$manifest"

worker_ids=()
for group in $(seq 1 "$GROUPS_COUNT"); do
  job=$(qsub \
    -N "ap${group}_${WORKFLOW_ID:0:6}" \
    -v "WORKFLOW_ID=$WORKFLOW_ID,DATABASE_URL_FILE=$DATABASE_URL_FILE,WORKERS_PER_JOB=12" \
    -W "depend=afterok:$probe" \
    -o "$BASE/pbs_logs/adaptive/worker_${group}_${stamp}.out" \
    "$PROJECT/scripts/hpc/atlas-adaptive-poi.pbs")
  worker_ids+=("$job")
  printf 'WORKER group=%s job=%s dependency=afterok:%s\n' "$group" "$job" "$probe" | tee -a "$manifest"
done

dependency=$(IFS=:; echo "${worker_ids[*]}")
finalizer=$(qsub \
  -N "af_${WORKFLOW_ID:0:8}" \
  -v "WORKFLOW_ID=$WORKFLOW_ID,DATABASE_URL_FILE=$DATABASE_URL_FILE,FINAL_OUTPUT=$FINAL_OUTPUT" \
  -W "depend=afterany:$dependency" \
  -o "$BASE/pbs_logs/adaptive/finalize_${stamp}.out" \
  "$PROJECT/scripts/hpc/atlas-adaptive-finalize.pbs")
printf 'FINALIZER job=%s dependency=afterany:%s\n' "$finalizer" "$dependency" | tee -a "$manifest"
printf 'REVIEW_BARRIER=afterok:%s\n' "$finalizer" | tee -a "$manifest"
printf 'WORKFLOW=%s\nGROUPS=%s\nWORKERS=%s\nOUTPUT=%s\n' \
  "$WORKFLOW_ID" "$GROUPS_COUNT" "$((GROUPS_COUNT * 12))" "$FINAL_OUTPUT" | tee -a "$manifest"

echo "manifest=$manifest"
