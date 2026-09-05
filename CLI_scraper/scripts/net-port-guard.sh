#!/usr/bin/env bash
# Ephemeral-port watchdog for long scraper runs.
#
# Why this exists: on 2026-09-04 a macOS host finished a 830,686-profile reviewer
# run with 14,074 error records. Every one of them was `net::ERR_INTERNET_
# DISCONNECTED`, and the cause was not the network — 16,400 sockets were stuck in
# TIME_WAIT and never drained, occupying 16,374 of the 16,384 ephemeral ports.
# The kernel then failed every new outbound connect() with EADDRNOTAVAIL while
# ICMP and already-established connections kept working, so nothing looked wrong
# from the outside and the run kept "succeeding" into an empty network.
#
# A peer host running the same workload at the same concurrency held 425
# TIME_WAIT entries, so this is a stuck-reclaim anomaly rather than a rate limit.
# The guard therefore watches the port pool itself and stops the run cleanly
# before exhaustion, which turns silent data loss into a resumable checkpoint.
# It never lowers concurrency and never kills the browser pool.
set -Eeuo pipefail

RUN_ROOT="${RUN_ROOT:?RUN_ROOT is required}"
INTERVAL="${INTERVAL:-60}"
WARN_PCT="${WARN_PCT:-75}"
STOP_PCT="${STOP_PCT:-90}"
LOG="${LOG:-$RUN_ROOT/logs/net-port-guard.log}"

mkdir -p "$(dirname "$LOG")"

log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

# Echoes "<used> <total>" for the ephemeral range.
port_usage() {
  local first last total used
  case "$(uname -s)" in
    Darwin)
      first=$(sysctl -n net.inet.ip.portrange.first)
      last=$(sysctl -n net.inet.ip.portrange.last)
      used=$(netstat -an -p tcp 2>/dev/null \
        | awk -v f="$first" -v l="$last" '
            NR > 2 {
              n = split($4, a, ".")
              p = a[n] + 0
              if (p >= f && p <= l) seen[p] = 1
            }
            END { print length(seen) }')
      ;;
    Linux)
      read -r first last < <(sysctl -n net.ipv4.ip_local_port_range)
      used=$(ss -tan 2>/dev/null \
        | awk -v f="$first" -v l="$last" '
            NR > 1 {
              n = split($4, a, ":")
              p = a[n] + 0
              if (p >= f && p <= l) seen[p] = 1
            }
            END { print length(seen) }')
      ;;
    *) echo "0 1"; return ;;
  esac
  total=$((last - first + 1))
  echo "${used:-0} $total"
}

# The scraper exits 0 on a graceful SIGTERM drain, so the supervisor's `until`
# loop stops instead of relaunching — the run ends at a resumable point.
stop_run() {
  local node_pid
  node_pid=$(pgrep -f -- "run-reviewers-parallel.js --run-root $RUN_ROOT" | head -1 || true)
  local sup_pid=""
  [ -f "$RUN_ROOT/status/run.pid" ] && sup_pid=$(cat "$RUN_ROOT/status/run.pid" 2>/dev/null || true)
  [ -n "$sup_pid" ] && kill -TERM "$sup_pid" 2>/dev/null || true
  [ -n "$node_pid" ] && kill -TERM "$node_pid" 2>/dev/null || true
  log "SIGTERM sent (supervisor=${sup_pid:-none} node=${node_pid:-none})"
}

read -r used total < <(port_usage)
log "started: ${used}/${total} ephemeral ports in use, warn=${WARN_PCT}% stop=${STOP_PCT}%, interval=${INTERVAL}s"

warned=0
while :; do
  read -r used total < <(port_usage)
  pct=$((used * 100 / (total > 0 ? total : 1)))

  if [ "$pct" -ge "$STOP_PCT" ]; then
    log "CRITICAL ${used}/${total} (${pct}%) >= ${STOP_PCT}% — stopping the run so it resumes cleanly"
    stop_run
    exit 0
  fi

  if [ "$pct" -ge "$WARN_PCT" ] && [ "$warned" -eq 0 ]; then
    log "WARN ${used}/${total} (${pct}%) >= ${WARN_PCT}% — port pool filling; check TIME_WAIT reclaim"
    warned=1
  elif [ "$pct" -lt "$WARN_PCT" ] && [ "$warned" -eq 1 ]; then
    log "recovered to ${used}/${total} (${pct}%)"
    warned=0
  fi

  # Stop watching once the run is gone; nothing left to protect.
  if ! pgrep -f -- "run-reviewers-parallel.js --run-root $RUN_ROOT" >/dev/null 2>&1; then
    log "run finished; guard exiting at ${used}/${total} (${pct}%)"
    exit 0
  fi

  sleep "$INTERVAL"
done
