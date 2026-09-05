#!/usr/bin/env bash
# Widen the ephemeral-port pool before a long, high-concurrency scrape.
#
# This raises the ceiling instead of lowering concurrency, so the host keeps its
# full throughput. Settings are not persistent — they reset on reboot, which is
# deliberate: they are a per-run choice, not a permanent machine change.
#
#   sudo bash scripts/tune-net-ports.sh          # apply
#   bash scripts/tune-net-ports.sh --show        # report only, no privileges
#
# macOS default is 16,384 ports with a 30 s TIME_WAIT (2 x MSL), i.e. ~546 new
# connections per second sustained. Tuned, it becomes 49,152 ports with a 4 s
# TIME_WAIT, i.e. ~12,288/s — a 22x margin. That margin matters less for the
# steady-state rate (a 16-way run needs well under 100/s) than for surviving a
# stuck-reclaim episode: see scripts/net-port-guard.sh for the incident this
# came from.
set -Eeuo pipefail

SHOW_ONLY=0
[ "${1:-}" = "--show" ] && SHOW_ONLY=1

report() {
  case "$(uname -s)" in
    Darwin)
      local f l m
      f=$(sysctl -n net.inet.ip.portrange.first)
      l=$(sysctl -n net.inet.ip.portrange.last)
      m=$(sysctl -n net.inet.tcp.msl)
      printf '  ephemeral range : %s-%s (%s ports)\n' "$f" "$l" "$((l - f + 1))"
      printf '  TIME_WAIT       : %s ms (2 x msl %s ms)\n' "$((m * 2))" "$m"
      printf '  sustained rate  : ~%s new conn/s\n' "$(( (l - f + 1) / ((m * 2) / 1000) ))"
      ;;
    Linux)
      local range f l t
      range=$(sysctl -n net.ipv4.ip_local_port_range)
      f=$(echo "$range" | awk '{print $1}')
      l=$(echo "$range" | awk '{print $2}')
      t=$(sysctl -n net.ipv4.tcp_fin_timeout)
      printf '  ephemeral range : %s-%s (%s ports)\n' "$f" "$l" "$((l - f + 1))"
      printf '  tcp_fin_timeout : %s s\n' "$t"
      ;;
  esac
}

echo "before:"
report

if [ "$SHOW_ONLY" -eq 1 ]; then
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo
  echo "needs root; re-run as: sudo bash $0" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    sysctl -w net.inet.ip.portrange.first=16384 >/dev/null
    sysctl -w net.inet.ip.portrange.hifirst=16384 >/dev/null
    sysctl -w net.inet.tcp.msl=2000 >/dev/null
    ;;
  Linux)
    sysctl -w net.ipv4.ip_local_port_range="16384 60999" >/dev/null
    sysctl -w net.ipv4.tcp_fin_timeout=15 >/dev/null
    ;;
  *)
    echo "unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

echo
echo "after:"
report
echo
echo "resets on reboot; re-run before the next long scrape."
