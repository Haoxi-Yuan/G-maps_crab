#!/bin/bash
# Emit Scraper Monitor TSV records for the Atlas PBS pipeline.
# This runs on an Atlas login node and only reads qstat plus compact sidecars.
set -u

ROOT=${1:-/hpctmp/haoxi.yuan/gmaps_atlas/CLI_scraper}
BASE=${ROOT%/*}
BATCH=sg_parks_473
TOTAL_AREAS=473
TOTAL_SHARDS=96
GROUP_SIZE=12
GROUP_COUNT=8
MAP="$BASE/status/${BATCH}.shards.tsv"
BOUNDARIES="$ROOT/data/Park_singapore/473parks.geojson"
QSTAT_CACHE="$BASE/status/atlas-monitor.qstat.tsv"
QSTAT_LOCK="$BASE/status/atlas-monitor.qstat.lock"

b64text() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
b64file() { if [ -r "$1" ]; then base64 < "$1" | tr -d '\r\n'; else printf '-'; fi; }
filesize() { stat -c %s -- "$1" 2>/dev/null || printf '0'; }
mtime() { stat -c %Y -- "$1" 2>/dev/null || printf '0'; }
now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

emit() {
  local stage=$1 pid=$2 city=$3 path=$4 bytes=$5 mode=$6 amount=$7 status=$8
  local job_id=$9 job_state=${10} unit=${11}
  local task_type=${12:--} command=${13:--} elapsed=${14:-0} total=${15:-0} measure=${16:--}
  [ "$task_type" = - ] || task_type=$(b64text "$task_type")
  [ "$command" = - ] || command=$(b64text "$command")
  [ "$measure" = - ] || measure=$(b64text "$measure")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$stage" "$pid" "$city" "$(b64text "$path")" "$bytes" "$mode" "$amount" \
    "$status" "$job_id" "$job_state" "$(b64text "$unit")" "$task_type" "$command" \
    "$elapsed" "$total" "$measure"
}

synthetic_poi() {
  local phase=$1
  b64text "{\"city\":\"$BATCH\",\"phase\":\"$phase\",\"updatedAt\":\"$(now_iso)\",\"categoryIndex\":0,\"categoryTotal\":177,\"totalPlaceIds\":0}"
}

synthetic_review() {
  local phase=$1
  b64text "{\"city\":\"$BATCH\",\"phase\":\"$phase\",\"updatedAt\":\"$(now_iso)\",\"index\":0,\"total\":0,\"fetchedReviews\":0}"
}

synthetic_task() {
  local type=$1 phase=$2 city=${3:-project}
  b64text "{\"version\":1,\"pipeline\":\"$type\",\"taskType\":\"$type\",\"city\":\"$city\",\"phase\":\"$phase\",\"updatedAt\":\"$(now_iso)\",\"completed\":0,\"total\":0,\"unit\":\"items\"}"
}

# Older Atlas jobs were launched from a poi-searcher build that predates the
# live sidecar contract. Reconstruct the same compact status from the durable
# checkpoint plus the worker's latest quadtree log line. This keeps monitoring
# useful without restarting a long-running PBS job; new launches use the native
# sidecar and bypass this compatibility path.
legacy_poi_status() {
  local checkpoint=$1 log=$2 city=$3
  local category_line='' cell_line='' category='' category_index=0 category_total=177
  local parsed='' depth=0 lat='' lng='' size='' zoom=0 bbox='' stamp=0 log_stamp=0 updated='' json=''
  [ -r "$checkpoint" ] || { synthetic_poi pbs_running; return; }

  if [ -r "$log" ]; then
    category_line=$(tail -n 700 "$log" 2>/dev/null \
      | grep -E '^\[QUADTREE\] === Query [0-9]+/[0-9]+:' | tail -n 1)
    cell_line=$(tail -n 700 "$log" 2>/dev/null \
      | grep -E '\[d[0-9]+\] \([-0-9.]+,[-0-9.]+\) [0-9.]+km z[0-9]+:' | tail -n 1)
  fi
  if [ -n "$category_line" ]; then
    category_index=$(printf '%s\n' "$category_line" | sed -E 's/.*Query ([0-9]+)\/([0-9]+):.*/\1/')
    category_total=$(printf '%s\n' "$category_line" | sed -E 's/.*Query ([0-9]+)\/([0-9]+):.*/\2/')
    category=$(printf '%s\n' "$category_line" | sed -E 's/.*Query [0-9]+\/[0-9]+: (.*) ===/\1/')
  else
    category_index=$(jq -r '.progress.categoriesDone // 0' "$checkpoint" 2>/dev/null)
    category_total=$(jq -r '.progress.totalCategories // 177' "$checkpoint" 2>/dev/null)
    category=$(jq -r '.results[-1].category // ""' "$checkpoint" 2>/dev/null)
  fi
  case "$category_index" in ''|*[!0-9]*) category_index=0 ;; esac
  case "$category_total" in ''|*[!0-9]*) category_total=177 ;; esac

  if [ -n "$cell_line" ]; then
    parsed=$(printf '%s\n' "$cell_line" | sed -nE \
      's/.*\[d([0-9]+)\] \(([-0-9.]+),([-0-9.]+)\) ([0-9.]+)km z([0-9]+):.*/\1\t\2\t\3\t\4\t\5/p')
    IFS=$'\t' read -r depth lat lng size zoom <<< "$parsed"
  fi
  if [ -n "$lat" ] && [ -n "$lng" ] && [ -n "$size" ]; then
    bbox=$(awk -v lat="$lat" -v lng="$lng" -v size="$size" 'BEGIN {
      pi=atan2(0,-1); hlat=size/(2*111.32); c=cos(lat*pi/180); if (c<0.01) c=0.01;
      hlng=size/(2*111.32*c);
      printf "{\"minLat\":%.9f,\"maxLat\":%.9f,\"minLng\":%.9f,\"maxLng\":%.9f,\"centerLat\":%.9f,\"centerLng\":%.9f,\"sizeKm\":%.6f}", lat-hlat,lat+hlat,lng-hlng,lng+hlng,lat,lng,size
    }')
  else
    bbox=$(jq -c 'if (.searchArea | type) == "object" then
      .searchArea | {minLat,maxLat,minLng,maxLng,centerLat,centerLng,sizeKm}
      else null end' "$checkpoint" 2>/dev/null)
    bbox=${bbox:-null}
  fi

  stamp=$(mtime "$checkpoint")
  if [ -r "$log" ]; then log_stamp=$(mtime "$log"); [ "$log_stamp" -gt "$stamp" ] && stamp=$log_stamp; fi
  updated=$(date -u -d "@$stamp" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
  json=$(jq -c --arg city "$city" --arg phase legacy-live --arg category "$category" --arg updatedAt "$updated" \
    --argjson categoryIndex "$category_index" --argjson categoryTotal "$category_total" \
    --argjson depth "${depth:-0}" --argjson zoom "${zoom:-0}" --argjson bbox "$bbox" '
      {
        city:$city, phase:$phase, category:(if $category == "" then null else $category end),
        updatedAt:$updatedAt, categoryIndex:$categoryIndex, categoryTotal:$categoryTotal,
        depth:$depth, zoom:$zoom, bbox:$bbox, children:[],
        newPlaceIds:(.results[-1].newPlaceIds // 0), totalPlaceIds:(.totalPlaceIds // 0),
        requests:(.results[-1].requests // 0)
      }
    ' "$checkpoint" 2>/dev/null)
  [ -n "$json" ] && b64text "$json" || synthetic_poi pbs_running
}

# Reproduce multi-boundary-orchestrator's stable duplicate-slug handling once.
# Atlas has jq on the login nodes but no python3, so keep this adapter Python-free.
ensure_legacy_map() {
  [ -r "$BOUNDARIES" ] || return 2
  if [ ! -s "$MAP" ] || [ "$BOUNDARIES" -nt "$MAP" ]; then
  mkdir -p "${MAP%/*}"
  tmp="${MAP}.tmp.$$"
  : > "$tmp"
  declare -A seen_slugs
  position=0
  while IFS=$'\t' read -r source_index raw; do
    slug=$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' \
      | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//')
    [ -n "$slug" ] || slug=$(printf 'area_%02d' "$((source_index + 1))")
    base_slug=$slug
    duplicate=2
    while [ -n "${seen_slugs[$slug]:-}" ]; do
      slug="${base_slug}_${duplicate}"
      duplicate=$((duplicate + 1))
    done
    seen_slugs[$slug]=1
    shard=$((position % TOTAL_SHARDS + 1))
    printf '%s\t%s\n' "$shard" "$slug" >> "$tmp"
    position=$((position + 1))
  done < <(jq -r '
    .features | to_entries[]
    | select(.value.geometry.type == "Polygon"
          or .value.geometry.type == "MultiPolygon"
          or .value.geometry.type == "GeometryCollection")
    | [.key, (.value.properties.name // .value.properties.NAME
        // .value.properties.Name // .value.properties.title
        // .value.properties.id // "" | tostring)]
    | @tsv
  ' "$BOUNDARIES")
  [ "$(wc -l < "$tmp" | tr -d ' ')" = "$TOTAL_AREAS" ] || {
    rm -f "$tmp"
    echo "Atlas monitor: boundary map count mismatch" >&2
    return 2
  }
  mv "$tmp" "$MAP"
  fi
}

refresh_qstat_cache() {
  local raw="${QSTAT_CACHE}.raw.$$" selected="${QSTAT_CACHE}.selected.$$" tmp="${QSTAT_CACHE}.tmp.$$"
  local ids job_id job_name job_state stage owner ncpus requested_mem cpu_used used_mem walltime requested_walltime
  ids=$(qselect -u "${USER:-haoxi.yuan}" 2>/dev/null | tr '\n' ' ' || true)
  : > "$raw"
  if [ -n "$ids" ]; then
    # One batched scheduler RPC is dramatically cheaper than qstat -f once per
    # job on Atlas (sub-second instead of minutes for ten jobs).
    qstat -f $ids > "$raw" 2>/dev/null || true
  fi
  awk -v root="$ROOT" '
    function flush() {
      if (job != "" && name != "" && state != "" && project) {
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", job, name, state,
          owner, ncpus, requested_mem, cpu_used, used_mem, walltime, requested_walltime
      }
    }
    $1 == "Job" && $2 == "Id:" {
      flush(); job=$3; name=""; state=""; owner=""; ncpus="0"; requested_mem="0";
      cpu_used="0"; used_mem="0"; walltime="0"; requested_walltime="0"; project=0; next
    }
    $1 == "Job_Name" && $2 == "=" { name=$3; next }
    $1 == "job_state" && $2 == "=" { state=$3; next }
    $1 == "Job_Owner" && $2 == "=" { split($3,a,"@"); owner=a[1]; next }
    $1 == "Resource_List.ncpus" && $2 == "=" { ncpus=$3; next }
    $1 == "Resource_List.mem" && $2 == "=" { requested_mem=$3; next }
    $1 == "Resource_List.walltime" && $2 == "=" { requested_walltime=$3; next }
    $1 == "resources_used.cpupercent" && $2 == "=" { cpu_used=$3; next }
    $1 == "resources_used.mem" && $2 == "=" { used_mem=$3; next }
    $1 == "resources_used.walltime" && $2 == "=" { walltime=$3; next }
    index($0, root) { project=1 }
    END { flush() }
  ' "$raw" > "$selected"
  : > "$tmp"
  while IFS=$'\t' read -r job_id job_name job_state owner ncpus requested_mem cpu_used used_mem walltime requested_walltime; do
    [ -n "$job_id" ] || continue
    stage=other
    case "$job_name" in
      *check*|*valid*|*final*) stage=other ;;
      *review*|sgp_r[0-9]*) stage=reviews ;;
      *poi*|*search*|*rescue*|sgp_p[0-9]*) stage=poi ;;
    esac
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$job_id" "$job_name" "$job_state" "$stage" "${owner:-haoxi.yuan}" \
      "${ncpus:-0}" "${requested_mem:-0}" "${cpu_used:-0}" "${used_mem:-0}" "${walltime:-0}" \
      "${requested_walltime:-0}" >> "$tmp"
  done < "$selected"
  mv "$tmp" "$QSTAT_CACHE"
  rm -f "$raw" "$selected" "$tmp"
}

if [ "${2:-}" = "--refresh-qstat" ]; then
  if ! mkdir "$QSTAT_LOCK" 2>/dev/null; then
    now=$(date +%s); stamp=$(mtime "$QSTAT_LOCK")
    if [ "$stamp" -gt 0 ] && [ $((now - stamp)) -gt 180 ]; then
      rmdir "$QSTAT_LOCK" 2>/dev/null || true
    fi
    mkdir "$QSTAT_LOCK" 2>/dev/null || exit 0
  fi
  trap 'rmdir "$QSTAT_LOCK" 2>/dev/null || true' EXIT
  refresh_qstat_cache
  exit 0
fi

# The App runs --refresh-qstat through an independent, non-overlapping probe.
# Snapshot calls stay fast and consume the most recent scheduler cache.
[ -e "$QSTAT_CACHE" ] || : > "$QSTAT_CACHE"

declare -A JOB_ID JOB_STATE JOB_STAGE EMITTED_JOB
while IFS=$'\t' read -r job_id job_name job_state job_stage _owner _ncpus _requested_mem _cpu_used _used_mem _walltime _requested_walltime _extra; do
  [ -n "$job_name" ] || continue
  JOB_ID["$job_name"]=$job_id
  JOB_STATE["$job_name"]=$job_state
  JOB_STAGE["$job_name"]=${job_stage:-other}
done < "$QSTAT_CACHE"

latest_for_shard() {
  local shard=$1 filename=$2 latest='' latest_time=0 slug file stamp
  ensure_legacy_map >/dev/null || { printf ''; return 0; }
  while IFS=$'\t' read -r _ slug; do
    file="$ROOT/output/_batches/$BATCH/${BATCH}__${slug}/$filename"
    [ -r "$file" ] || continue
    stamp=$(mtime "$file")
    if [ "$stamp" -ge "$latest_time" ]; then latest=$file; latest_time=$stamp; fi
  done < <(awk -F '\t' -v shard="$shard" '$1 == shard' "$MAP")
  printf '%s' "$latest"
}

for group in $(seq 1 "$GROUP_COUNT"); do
  name=$(printf 'sgp_p%02d' "$group")
  state=${JOB_STATE[$name]:-}
  [ -n "$state" ] || continue
  job=${JOB_ID[$name]:--}
  EMITTED_JOB["$job"]=1
  if [ "$state" != R ]; then
    phase=pbs_queued; [ "$state" = H ] && phase=pbs_held
    emit poi $((11000 + group)) "$BATCH" "$ROOT/output/_batches/$BATCH" 0 P 0 \
      "$(synthetic_poi "$phase")" "$job" "$state" "GROUP $(printf '%02d' "$group")"
    continue
  fi
  first=$(( (group - 1) * GROUP_SIZE + 1 )); last=$((group * GROUP_SIZE))
  for shard in $(seq "$first" "$last"); do
    live=$(latest_for_shard "$shard" poi_search.live.json)
    if [ -n "$live" ]; then
      dir=${live%/*}; city=${dir##*/}; places="$dir/places.ndjson"
      emit poi $((10000 + shard)) "$city" "$places" "$(filesize "$places")" P 0 \
        "$(b64file "$live")" "$job" "$state" "SHARD $(printf '%03d' "$shard")"
    else
      emit poi $((10000 + shard)) "$BATCH" "$ROOT/output/_batches/$BATCH" 0 P 0 \
        "$(synthetic_poi pbs_starting)" "$job" "$state" "SHARD $(printf '%03d' "$shard")"
    fi
  done
done

for group in $(seq 1 "$GROUP_COUNT"); do
  name=$(printf 'sgp_r%02d' "$group")
  state=${JOB_STATE[$name]:-}
  [ -n "$state" ] || continue
  job=${JOB_ID[$name]:--}
  EMITTED_JOB["$job"]=1
  if [ "$state" != R ]; then
    phase=pbs_queued; [ "$state" = H ] && phase=pbs_dependency_hold
    emit reviews $((21000 + group)) "$BATCH" "$ROOT/output/_batches/$BATCH" 0 B 0 \
      "$(synthetic_review "$phase")" "$job" "$state" "GROUP $(printf '%02d' "$group")"
    continue
  fi
  first=$(( (group - 1) * GROUP_SIZE + 1 )); last=$((group * GROUP_SIZE))
  for shard in $(seq "$first" "$last"); do
    live=$(latest_for_shard "$shard" reviews.live.json)
    if [ -n "$live" ]; then
      dir=${live%/*}; city=${dir##*/}; output="$dir/reviews.ndjson"
      amount=$(wc -l < "$output" 2>/dev/null | tr -d ' '); amount=${amount:-0}
      emit reviews $((20000 + shard)) "$city" "$output" "$(filesize "$output")" B "$amount" \
        "$(b64file "$live")" "$job" "$state" "SHARD $(printf '%03d' "$shard")"
    else
      emit reviews $((20000 + shard)) "$BATCH" "$ROOT/output/_batches/$BATCH" 0 B 0 \
        "$(synthetic_review pbs_starting)" "$job" "$state" "SHARD $(printf '%03d' "$shard")"
    fi
  done
done

# Emit every remaining PBS job whose metadata points at this project. Known
# legacy group jobs above keep their detailed shard view; all other names are
# handled here, including rescue/finalize jobs and future schedulers.
for name in "${!JOB_ID[@]}"; do
  job=${JOB_ID[$name]}
  [ -z "${EMITTED_JOB[$job]:-}" ] || continue
  state=${JOB_STATE[$name]:-Q}
  stage=${JOB_STAGE[$name]:-other}
  job_number=${job%%.*}; case "$job_number" in ''|*[!0-9]*) job_number=$(printf '%s' "$job" | cksum | awk '{print $1}') ;; esac

  if [ "$stage" = poi ] && [ "$state" = R ] && [[ "$name" == *rescue* ]]; then
    emitted=0
    rescue_logs=${BASE}/logs/poi-rescue
    if [ -d "$rescue_logs" ]; then
      for log in "$rescue_logs"/rescue_*_of_*.log; do
        [ -r "$log" ] || continue
        run_dir=$(grep 'stage 1:' "$log" 2>/dev/null | tail -n 1 \
          | sed -n "s#.*data/_batches/$BATCH/\\([^/]*\\)/.*#\\1#p")
        [ -n "$run_dir" ] || continue
        live="$ROOT/output/_batches/$BATCH/$run_dir/poi_search.live.json"
        emitted=$((emitted + 1))
        dir=${live%/*}; city=${dir##*/}; places="$dir/places.ndjson"
        now=$(date +%s); live_stamp=$(mtime "$live")
        if [ -r "$live" ] && [ $((now - live_stamp)) -le 150 ]; then
          status=$(b64file "$live")
        else
          status=$(legacy_poi_status "$dir/poi_search.json" "$log" "$city")
        fi
        emit poi "$((job_number * 10 + emitted))" "$city" "$places" "$(filesize "$places")" P 0 \
          "$status" "$job" "$state" "RESCUE $(printf '%02d' "$emitted")" \
          poi-rescue "$name" 0 "$TOTAL_AREAS" POIs
      done
    fi
    [ "$emitted" -gt 0 ] && continue
  fi

  phase=pbs_queued
  [ "$state" = R ] && phase=pbs_running
  [ "$state" = H ] && phase=pbs_held
  task_type=$name
  case "$name" in *check*|*valid*|*final*) task_type=validation ;; esac
  case "$stage" in poi) task_type=poi-search ;; reviews) task_type=reviews ;; esac
  emit "$stage" "$job_number" project "$ROOT" 0 F 0 "$(synthetic_task "$task_type" "$phase" project)" \
    "$job" "$state" "PBS $name" "$task_type" "$name" 0 0 items
done
