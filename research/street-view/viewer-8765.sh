#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT=8765
HOST="127.0.0.1"
PID_FILE="$SCRIPT_DIR/.viewer-8765.pid"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/viewer-8765.log"
SERVE_PY="$SCRIPT_DIR/src/py/viewers/serve.py"
PYTHON="$SCRIPT_DIR/.venv/bin/python3"

usage() {
  cat <<EOF
Usage:
  ./viewer-8765.sh start [run_dir]
  ./viewer-8765.sh stop
  ./viewer-8765.sh restart [run_dir]
  ./viewer-8765.sh status

Defaults:
  port:    $PORT
  host:    $HOST
  run_dir: latest data/streetview_3d/* containing 3d_viewer_megafused.html

Examples:
  ./viewer-8765.sh start
  ./viewer-8765.sh start data/streetview_3d/2026-04-27_18-48-56-123_place_20_Ghim_Moh_Road_Market_26_Fo
  ./viewer-8765.sh stop
EOF
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

listener_pids() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

latest_run_dir() {
  local latest
  latest=$(
    find "$SCRIPT_DIR/data/streetview_3d" \
      -name 3d_viewer_megafused.html \
      -type f \
      -print 2>/dev/null \
      | sort \
      | tail -n 1
  )

  if [ -z "$latest" ]; then
    echo "could not find data/streetview_3d/*/3d_viewer_megafused.html" >&2
    exit 1
  fi

  dirname "$latest"
}

resolve_run_dir() {
  local run_dir="${1:-}"

  if [ -z "$run_dir" ]; then
    run_dir="$(latest_run_dir)"
  elif [[ "$run_dir" != /* ]]; then
    run_dir="$SCRIPT_DIR/$run_dir"
  fi

  if [ ! -d "$run_dir" ]; then
    echo "run dir does not exist: $run_dir" >&2
    exit 1
  fi

  if [ ! -f "$run_dir/3d_viewer_megafused.html" ] && [ ! -f "$run_dir/3d_viewer_combined.html" ]; then
    echo "run dir has no 3d viewer HTML: $run_dir" >&2
    exit 1
  fi

  printf "%s\n" "$run_dir"
}

show_status() {
  local pids
  pids="$(listener_pids)"

  if [ -z "$pids" ]; then
    echo "No process is listening on $HOST:$PORT"
    return 0
  fi

  echo "Processes listening on $HOST:$PORT:"
  for pid in $pids; do
    ps -p "$pid" -o pid,ppid,stat,lstart,command 2>/dev/null || echo "  PID $pid (process details unavailable)"
  done

  echo
  echo "URLs:"
  echo "  http://localhost:$PORT/"
  echo "  http://localhost:$PORT/3d_viewer_megafused.html"
  echo "  http://localhost:$PORT/derived/primitive_atlas/index.html"
  echo "  http://localhost:$PORT/derived/mesh_textured/3d_viewer_textured.html"

  if [ -f "$LOG_FILE" ]; then
    echo
    echo "Log: $LOG_FILE"
  fi
}

start_server() {
  need_cmd lsof

  if [ ! -x "$PYTHON" ]; then
    PYTHON="$(command -v python3)"
  fi

  if [ ! -f "$SERVE_PY" ]; then
    echo "server script not found: $SERVE_PY" >&2
    exit 1
  fi

  local existing
  existing="$(listener_pids)"
  if [ -n "$existing" ]; then
    echo "Port $PORT is already in use:"
    show_status
    echo
    echo "Run './viewer-8765.sh restart [run_dir]' to replace it."
    exit 1
  fi

  local run_dir
  run_dir="$(resolve_run_dir "${1:-}")"
  mkdir -p "$LOG_DIR"

  nohup "$PYTHON" "$SERVE_PY" "$run_dir" --host "$HOST" --port "$PORT" >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  sleep 0.4
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "server failed to start; log follows:" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi

  echo "Started viewer server on http://localhost:$PORT"
  echo "PID: $pid"
  echo "Run dir: $run_dir"
  echo "Log: $LOG_FILE"
}

stop_server() {
  need_cmd lsof

  local pids
  pids="$(listener_pids)"

  if [ -z "$pids" ]; then
    echo "No process is listening on $HOST:$PORT"
    rm -f "$PID_FILE"
    return 0
  fi

  echo "Stopping processes listening on $HOST:$PORT: $pids"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done

  local waited=0
  while [ "$waited" -lt 30 ]; do
    pids="$(listener_pids)"
    [ -z "$pids" ] && break
    sleep 0.2
    waited=$((waited + 1))
  done

  pids="$(listener_pids)"
  if [ -n "$pids" ]; then
    echo "Force stopping remaining processes on $HOST:$PORT: $pids"
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi

  rm -f "$PID_FILE"
  echo "Stopped viewer server on $HOST:$PORT"
}

case "${1:-status}" in
  start)
    shift
    start_server "${1:-}"
    ;;
  stop)
    stop_server
    ;;
  restart)
    shift
    stop_server
    start_server "${1:-}"
    ;;
  status)
    show_status
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "unknown command: ${1:-}" >&2
    usage
    exit 1
    ;;
esac
