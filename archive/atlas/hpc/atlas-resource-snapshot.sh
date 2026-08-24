#!/bin/bash
# Fast resource summary for Scraper Monitor. It intentionally reads the cached
# qstat snapshot maintained by atlas-monitor-snapshot.sh; it never samples the
# Atlas login node and never performs a scheduler RPC itself.
set -u

ROOT=${1:-/hpctmp/haoxi.yuan/gmaps_atlas/CLI_scraper}
BASE=${ROOT%/*}
CACHE="$BASE/status/atlas-monitor.qstat.tsv"
CPU_CAP=${ATLAS_CPU_CAP:-96}
MEMORY_REFERENCE_MB=${ATLAS_MEMORY_REFERENCE_MB:-393216}
JOB_CAP=${ATLAS_JOB_CAP:-8}

b64text() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
mem_mb() {
  value=${1:-0}
  number=$(printf '%s' "$value" | sed -E 's/[^0-9.].*$//')
  unit=$(printf '%s' "$value" | sed -E 's/^[0-9.]+//;s/[[:space:]]//g' | tr '[:upper:]' '[:lower:]')
  case "$number" in ''|*[!0-9.]*) printf '0'; return ;; esac
  case "$unit" in tb) awk -v n="$number" 'BEGIN{printf "%.0f",n*1048576}' ;;
    gb|g) awk -v n="$number" 'BEGIN{printf "%.0f",n*1024}' ;;
    kb|k) awk -v n="$number" 'BEGIN{printf "%.0f",n/1024}' ;;
    b) awk -v n="$number" 'BEGIN{printf "%.0f",n/1048576}' ;;
    *) awk -v n="$number" 'BEGIN{printf "%.0f",n}' ;;
  esac
}
duration_seconds() {
  printf '%s\n' "${1:-0}" | awk -F: '{if(NF==3)print $1*3600+$2*60+$3;else if(NF==2)print $1*60+$2;else print 0}'
}

running=0 queued=0 held=0 cpu_alloc=0 mem_alloc=0
rows=''
[ -r "$CACHE" ] || CACHE=/dev/null
while IFS=$'\t' read -r job_id job_name state stage owner ncpus requested_mem cpu_used used_mem walltime requested_walltime extra; do
  [ -n "${job_id:-}" ] || continue
  owner=${owner:-haoxi.yuan}; ncpus=${ncpus:-0}; requested_mem=${requested_mem:-0}
  cpu_used=${cpu_used:-0}; used_mem=${used_mem:-0}; walltime=${walltime:-0}; requested_walltime=${requested_walltime:-0}
  case "$ncpus" in ''|*[!0-9]*) ncpus=0 ;; esac
  # Compatibility with the original four-column cache used by the Singapore
  # parks batch. Values are known from its PBS group contract.
  if [ "$ncpus" -eq 0 ]; then
    case "$job_name" in sgp_p[0-9]*|sgp_r[0-9]*) ncpus=12; requested_mem=24gb ;; esac
  fi
  requested_mb=$(mem_mb "$requested_mem"); used_mb=$(mem_mb "$used_mem")
  case "$state" in
    R) running=$((running+1)); cpu_alloc=$((cpu_alloc+ncpus)); mem_alloc=$((mem_alloc+requested_mb)) ;;
    Q|W) queued=$((queued+1)) ;;
    H|S) held=$((held+1)) ;;
  esac
  case "$cpu_used" in ''|*[!0-9.]*) cpu_used=0 ;; esac
  elapsed=$(duration_seconds "$walltime")
  time_limit=$(duration_seconds "$requested_walltime")
  state_label=$state
  case "$state" in R) state_label=RUNNING ;; Q|W) state_label=QUEUED ;; H|S) state_label=HOLD ;; esac
  cpu_text="${ncpus} cores"
  [ "$cpu_used" = 0 ] || cpu_text="${ncpus}c · ${cpu_used}%"
  if [ "$requested_mb" -gt 0 ]; then
    ram_text=$(awk -v u="$used_mb" -v r="$requested_mb" 'BEGIN{printf "%.1f / %.0f GB",u/1024,r/1024}')
  else
    ram_text='—'
  fi
  rows="${rows}P\t$(b64text "$owner")\t${job_id}\t$(b64text "$job_name")\t$(b64text "$cpu_text")\t$(b64text '—')\t$(b64text "$ram_text")\t${elapsed}\t${state_label}\t1\t${cpu_used}\t0\t0\t${time_limit}\n"
done < "$CACHE"

cpu_load=$(awk -v u="$cpu_alloc" -v t="$CPU_CAP" 'BEGIN{if(t>0)printf "%.2f",u/t*100;else print 0}')
mem_load=$(awk -v u="$mem_alloc" -v t="$MEMORY_REFERENCE_MB" 'BEGIN{if(t>0)printf "%.2f",u/t*100;else print 0}')
job_load=$(awk -v u="$running" -v t="$JOB_CAP" 'BEGIN{if(t>0)printf "%.2f",u/t*100;else print 0}')
cpu_detail="${cpu_alloc} / ${CPU_CAP} cores"
mem_detail=$(awk -v u="$mem_alloc" -v t="$MEMORY_REFERENCE_MB" 'BEGIN{printf "%.0f / %.0f GB ref",u/1024,t/1024}')
job_detail="${running} / ${JOB_CAP} running"
note="PBS allocations · ${queued} queued · ${held} held · not login-node load"
printf 'S\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$cpu_load" "$(b64text "$cpu_detail")" "$mem_load" "$(b64text "$mem_detail")" \
  "$job_load" "$(b64text "$job_detail")" "$(b64text 'JOB SLOTS')" "$(b64text 'PBS CPU')" \
  "$(b64text "$note")" "$(date +%s)"
printf '%b' "$rows"
