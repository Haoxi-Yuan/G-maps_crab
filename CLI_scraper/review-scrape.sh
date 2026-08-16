#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export TMPDIR="$SCRIPT_DIR/.tmp"
export PLAYWRIGHT_BROWSERS_PATH="$SCRIPT_DIR/.playwright-browsers"
mkdir -p "$TMPDIR" "$PLAYWRIGHT_BROWSERS_PATH"

# ============================================
# Defaults
# ============================================
MAX_REVIEWS=50000
MIN_REVIEW_COUNT=0
RUN_MODE=""
CITY_NAME=""
INPUT_FILE=""
OUTPUT_FILE=""

# ============================================
# CLI arguments (non-interactive)
# ============================================
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --run)           RUN_MODE="background"; shift ;;
      --foreground)    RUN_MODE="foreground"; shift ;;
      --city)          CITY_NAME="$2"; shift 2 ;;
      --input)         INPUT_FILE="$2"; shift 2 ;;
      --output)        OUTPUT_FILE="$2"; shift 2 ;;
      --max-reviews)   MAX_REVIEWS="$2"; shift 2 ;;
      --min-count)     MIN_REVIEW_COUNT="$2"; shift 2 ;;
      --fresh)         FRESH=1; shift ;;
      --status)        show_status; exit 0 ;;
      --stop)          STOP_CITY="${2:-}"; stop_background; exit 0 ;;
      --help)          show_help; exit 0 ;;
      *)               echo "Unknown option: $1"; show_help; exit 1 ;;
    esac
  done
}

show_help() {
  echo ""
  echo "Usage: ./review-scrape.sh [options]"
  echo ""
  echo "Interactive mode (default):"
  echo "  ./review-scrape.sh"
  echo ""
  echo "Non-interactive mode:"
  echo "  ./review-scrape.sh --run --city san_francisco"
  echo "  ./review-scrape.sh --run --city san_francisco --min-count 100"
  echo ""
  echo "Options:"
  echo "  --run              Run directly (background by default)"
  echo "  --foreground       Run in foreground"
  echo "  --city <name>      City folder name in output/"
  echo "  --input <file>     Input places.ndjson file"
  echo "  --output <file>    Output reviews.ndjson file"
  echo "  --max-reviews <n>  Max reviews per place (default: 50000)"
  echo "  --min-count <n>    Only scrape places with >= N reviews (default: 0)"
  echo "  --fresh            Start fresh (delete existing output)"
  echo "  --status           Show status of running/completed scrapes"
  echo "  --stop             Stop background scrape process"
  echo ""
}

# ============================================
# Status and process management
# ============================================
show_status() {
  echo ""
  echo "=== Review Scrape Status ==="
  echo ""

  local pids=$(pgrep -f "review-scraper" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Running processes:"
    for pid in $pids; do
      local elapsed=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
      echo "  PID $pid (elapsed: $elapsed)"
    done
    echo ""
  else
    echo "No running review scrape processes."
    echo ""
  fi

  for f in output/*/reviews.ndjson output/_batches/*/*/reviews.ndjson; do
    [ -f "$f" ] || continue
    [ -f "$f" ] || continue
    local city=$(basename "$(dirname "$f")")
    local lines=$(wc -l < "$f" 2>/dev/null || echo 0)
    local total_reviews=$(python3 -c "
import json
total = 0
with open('$f') as fh:
    for line in fh:
        if not line.strip(): continue
        d = json.loads(line)
        total += len(d.get('detailedReviews', []))
print(total)
" 2>/dev/null || echo "?")
    echo "  $city: $lines places, $total_reviews reviews ($f)"
  done
  echo ""
}

stop_background() {
  local all_pids=$(pgrep -f "review-scraper" 2>/dev/null || true)
  if [ -z "$all_pids" ]; then
    echo "No running review scrape processes found."
    return
  fi

  # List running processes
  echo ""
  echo "Running review-scraper processes:"
  echo ""
  local i=1
  local PID_LIST=()
  for pid in $all_pids; do
    local cmd=$(ps -o args= -p "$pid" 2>/dev/null | head -1)
    local elapsed=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
    # Extract city from command
    local city=$(echo "$cmd" | grep -oP 'output/\K[^/]+' | head -1)
    printf "  [%d] PID %-8s %-20s (elapsed: %s)\n" "$i" "$pid" "${city:-unknown}" "$elapsed"
    PID_LIST+=("$pid")
    i=$((i + 1))
  done

  echo ""
  echo "  [a] Stop ALL"
  echo "  [q] Cancel"
  echo ""
  read -p "Select> " CHOICE

  if [ "$CHOICE" = "q" ]; then return; fi

  local targets=()
  if [ "$CHOICE" = "a" ] || [ "$CHOICE" = "A" ]; then
    targets=("${PID_LIST[@]}")
  elif [[ "$CHOICE" =~ ^[0-9]+$ ]] && [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le ${#PID_LIST[@]} ]; then
    targets=("${PID_LIST[$((CHOICE - 1))]}")
  else
    echo "Invalid selection."
    return
  fi

  for pid in "${targets[@]}"; do
    echo "Stopping PID $pid..."
    kill "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in "${targets[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Force killing PID $pid..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  echo "Done. Progress saved — restart to resume."
}

# ============================================
# Logo
# ============================================
print_header() {
  echo ""
  echo '    ___                        ___    '
  echo '   / _ \                      / _ \   '
  echo '  | | | |  __   _        _   | | | |  '
  echo '  | | | | /  \ / \    / \ /\ | | | |  '
  echo '   \ \_|_|   | \_/\  /\_/ |  |_|_/ /  '
  echo '    \___  \  /\_ /\\//\ _/\  /  ___/   '
  echo '        \  \/   V  VV  V   \/  /       '
  echo '         )  \   |  ||  |   /  (        '
  echo '        /  / \  |  ||  |  / \  \       '
  echo '       /  /   \_|  ||  |_/   \  \      '
  echo '      (__/      |__||__|      \__)     '
  echo '                                       '
  echo '       G - M A P S _ C R A B           '
  echo '     Review Scraper  v1.0               '
  echo '    ================================    '
  echo ""
}

# ============================================
# Step 1: Select city
# ============================================
step_select_city() {
  print_header

  echo "Cities with place data (places.ndjson):"
  echo ""

  local i=1
  CITY_DIRS=()
  for dir in output/*/ output/_batches/*/*/; do
    [ -d "$dir" ] || continue
    local pf="${dir}places.ndjson"
    [ -f "$pf" ] || continue
    local city=$(basename "$dir")
    local place_count=$(wc -l < "$pf" 2>/dev/null || echo 0)

    # Check existing reviews
    local review_file="${dir}reviews.ndjson"
    local done_count=0
    local review_total=0
    if [ -f "$review_file" ]; then
      done_count=$(wc -l < "$review_file" 2>/dev/null || echo 0)
      review_total=$(python3 -c "
import json
total = 0
with open('$review_file') as fh:
    for line in fh:
        if not line.strip(): continue
        d = json.loads(line)
        total += len(d.get('detailedReviews', []))
print(total)
" 2>/dev/null || echo "?")
    fi

    printf "  [%d] %-20s %d places" "$i" "$city" "$place_count"
    if [ "$done_count" -gt 0 ] 2>/dev/null; then
      printf "  (%d/%d done, %s reviews)" "$done_count" "$place_count" "$review_total"
    fi
    echo ""

    CITY_DIRS+=("$dir")
    i=$((i + 1))
  done

  if [ ${#CITY_DIRS[@]} -eq 0 ]; then
    echo "  (none found — run poi-search.sh first)"
    exit 1
  fi

  echo ""
  read -p "Select city> " CITY_INPUT

  if [ "$CITY_INPUT" = "q" ]; then exit 0; fi

  if [[ "$CITY_INPUT" =~ ^[0-9]+$ ]] && [ "$CITY_INPUT" -ge 1 ] && [ "$CITY_INPUT" -le ${#CITY_DIRS[@]} ]; then
    CITY_DIR="${CITY_DIRS[$((CITY_INPUT - 1))]}"
    CITY_NAME=$(basename "$CITY_DIR")
    INPUT_FILE="${CITY_DIR}places.ndjson"
    echo ""
    echo "Selected: $CITY_NAME"
  else
    echo "Invalid selection."
    exit 1
  fi
}

# ============================================
# Step 2: Show place stats and filter
# ============================================
step_configure() {
  local place_count=$(wc -l < "$INPUT_FILE")

  # Show review count distribution
  echo ""
  echo "--- Place Statistics ---"
  python3 -c "
import json

places = []
with open('$INPUT_FILE') as f:
    for line in f:
        if not line.strip(): continue
        p = json.loads(line)
        rc = p.get('business', {}).get('reviewCount') or 0
        places.append(rc)

places.sort(reverse=True)
total = len(places)
with_reviews = sum(1 for r in places if r > 0)
total_reviews = sum(places)

print(f'  Total places: {total}')
print(f'  With reviews: {with_reviews}')
print(f'  Total review count: {total_reviews:,}')
print()
print(f'  Distribution:')
for threshold in [10000, 5000, 1000, 500, 100, 50, 10, 1]:
    count = sum(1 for r in places if r >= threshold)
    if count > 0:
        print(f'    >= {threshold:>6} reviews: {count:>5} places')
print(f'    =      0 reviews: {total - with_reviews:>5} places')

# Estimate time
est_seconds = sum(min(r * 0.02, 600) for r in places if r > 0)
print()
print(f'  Estimated scrape time: ~{int(est_seconds/60)} minutes ({int(est_seconds/3600)}h{int(est_seconds%3600/60):02d}m)')
" 2>/dev/null

  # Filter by min review count
  echo ""
  read -p "Min review count to scrape (default: $MIN_REVIEW_COUNT, 0=all)> " INPUT
  [ -n "$INPUT" ] && MIN_REVIEW_COUNT="$INPUT"

  # If filtering, create a filtered input file
  if [ "$MIN_REVIEW_COUNT" -gt 0 ] 2>/dev/null; then
    FILTERED_FILE="${INPUT_FILE%.ndjson}.filtered.ndjson"
    python3 -c "
import json
count = 0
with open('$INPUT_FILE') as fin, open('$FILTERED_FILE', 'w') as fout:
    for line in fin:
        if not line.strip(): continue
        p = json.loads(line)
        rc = p.get('business', {}).get('reviewCount') or 0
        if rc >= $MIN_REVIEW_COUNT:
            fout.write(line)
            count += 1
print(f'Filtered: {count} places with >= $MIN_REVIEW_COUNT reviews')
" 2>/dev/null
    INPUT_FILE="$FILTERED_FILE"
  fi

  # Max reviews per place
  echo ""
  read -p "Max reviews per place (default: $MAX_REVIEWS)> " INPUT
  [ -n "$INPUT" ] && MAX_REVIEWS="$INPUT"

  # Output file
  if [ -z "$OUTPUT_FILE" ]; then
    OUTPUT_FILE="${CITY_DIR}reviews.ndjson"
  fi
  echo ""
  read -p "Output file (default: $OUTPUT_FILE)> " INPUT
  [ -n "$INPUT" ] && OUTPUT_FILE="$INPUT"

  # Resume check
  if [ -f "$OUTPUT_FILE" ]; then
    local done_count=$(wc -l < "$OUTPUT_FILE" 2>/dev/null || echo 0)
    echo ""
    echo "Existing output: $done_count places already scraped"
    read -p "Resume? [Y/n] " RESUME
    if [ "$RESUME" = "n" ] || [ "$RESUME" = "N" ]; then
      rm -f "$OUTPUT_FILE"
      echo "Starting fresh."
    else
      echo "Will resume from checkpoint."
    fi
  fi
}

# ============================================
# Step 3: Launch
# ============================================
step_launch() {
  local LOG_FILE="${OUTPUT_FILE%.ndjson}.log"
  local input_count=$(wc -l < "$INPUT_FILE" 2>/dev/null || echo "?")

  echo ""
  echo "=========================================="
  echo "  Launching Review Scraper"
  echo "=========================================="
  echo "  City:        $CITY_NAME"
  echo "  Input:       $INPUT_FILE ($input_count places)"
  echo "  Output:      $OUTPUT_FILE"
  echo "  Log:         $LOG_FILE"
  echo "  Max reviews: $MAX_REVIEWS per place"
  echo "=========================================="
  echo ""
  read -p "Run in background? [Y/n] " BG_CHOICE

  # Log rotation
  if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1000 ]; then
    tail -500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi

  local CMD="node src/review-scraper.js --input '$INPUT_FILE' --output '$OUTPUT_FILE' --max-reviews $MAX_REVIEWS"

  if [ "$BG_CHOICE" = "n" ] || [ "$BG_CHOICE" = "N" ]; then
    echo ""
    echo "Starting (foreground, Ctrl+C to stop)..."
    echo ""
    eval "$CMD" 2>&1 | tee "$LOG_FILE"
  else
    echo ""
    local SESS="gmaps-rev-$(echo "${CITY_NAME:-default}" | tr '[:upper:] ' '[:lower:]_' | tr -cd 'a-z0-9_')"
    tmux kill-session -t "$SESS" 2>/dev/null || true
    tmux new-session -d -s "$SESS" "cd '$SCRIPT_DIR' && $CMD 2>&1 | tee -a '$LOG_FILE'; echo; echo '=== scraper exited; press Enter to close this tmux pane ==='; read"
    sleep 1
    local PID=$(pgrep -f "review-scraper.js.*$(basename "$INPUT_FILE")" 2>/dev/null | head -1)
    echo "tmux session: $SESS  (re-attach: tmux attach -t $SESS  ·  detach: Ctrl-B D)"
    echo "Started in background (PID: $PID)"
    echo ""
    echo "Monitor:"
    echo "  tail -f $LOG_FILE"
    echo "  ./review-scrape.sh --status"
    echo ""
    echo "Stop:"
    echo "  ./review-scrape.sh --stop"
    echo ""
  fi
}

# ============================================
# Non-interactive run
# ============================================
run_direct() {
  if [ -z "$INPUT_FILE" ] && [ -z "$CITY_NAME" ]; then
    echo "ERROR: --city or --input is required with --run"
    show_help
    exit 1
  fi

  # Resolve input file from city name
  if [ -z "$INPUT_FILE" ] && [ -n "$CITY_NAME" ]; then
    local city_slug=$(echo "$CITY_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_')
    INPUT_FILE="output/${city_slug}/places.ndjson"
    if [ ! -f "$INPUT_FILE" ]; then
      # grouped batch layout: output/_batches/<batch>/<batch>__<slug>/
      local grouped=$(ls -d output/_batches/*/"${city_slug}"/ 2>/dev/null | head -1)
      [ -n "$grouped" ] && INPUT_FILE="${grouped}places.ndjson"
    fi
  fi

  if [ ! -f "$INPUT_FILE" ]; then
    echo "ERROR: Input file not found: $INPUT_FILE"
    echo "Run poi-search.sh first to generate places.ndjson"
    exit 1
  fi

  # Filter if needed
  if [ "$MIN_REVIEW_COUNT" -gt 0 ] 2>/dev/null; then
    FILTERED_FILE="${INPUT_FILE%.ndjson}.filtered.ndjson"
    python3 -c "
import json
count = 0
with open('$INPUT_FILE') as fin, open('$FILTERED_FILE', 'w') as fout:
    for line in fin:
        if not line.strip(): continue
        p = json.loads(line)
        rc = p.get('business', {}).get('reviewCount') or 0
        if rc >= $MIN_REVIEW_COUNT:
            fout.write(line)
            count += 1
print(f'Filtered: {count} places with >= $MIN_REVIEW_COUNT reviews')
" 2>/dev/null
    INPUT_FILE="$FILTERED_FILE"
  fi

  if [ -z "$OUTPUT_FILE" ]; then
    OUTPUT_FILE="$(dirname "$INPUT_FILE")/reviews.ndjson"
  fi

  if [ "${FRESH:-0}" = "1" ] && [ -f "$OUTPUT_FILE" ]; then
    rm -f "$OUTPUT_FILE"
  fi

  local LOG_FILE="${OUTPUT_FILE%.ndjson}.log"
  local input_count=$(wc -l < "$INPUT_FILE" 2>/dev/null || echo "?")

  # Log rotation
  if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1000 ]; then
    tail -500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi

  local CMD="node src/review-scraper.js --input '$INPUT_FILE' --output '$OUTPUT_FILE' --max-reviews $MAX_REVIEWS"

  if [ "$RUN_MODE" = "foreground" ]; then
    echo "Starting review scraper (foreground)..."
    echo "  Input: $INPUT_FILE ($input_count places) | Output: $OUTPUT_FILE"
    eval "$CMD" 2>&1 | tee "$LOG_FILE"
  else
    echo ""
    echo "Starting review scraper (background)..."
    echo "  City:    $CITY_NAME"
    echo "  Input:   $INPUT_FILE ($input_count places)"
    echo "  Output:  $OUTPUT_FILE"
    echo "  Log:     $LOG_FILE"
    echo ""

    local SESS="gmaps-rev-$(echo "${CITY_NAME:-default}" | tr '[:upper:] ' '[:lower:]_' | tr -cd 'a-z0-9_')"
    tmux kill-session -t "$SESS" 2>/dev/null || true
    tmux new-session -d -s "$SESS" "cd '$SCRIPT_DIR' && $CMD 2>&1 | tee -a '$LOG_FILE'; echo; echo '=== scraper exited; press Enter to close this tmux pane ==='; read"
    sleep 1
    local PID=$(pgrep -f "review-scraper.js.*$(basename "$INPUT_FILE")" 2>/dev/null | head -1)
    echo "tmux session: $SESS  (re-attach: tmux attach -t $SESS  ·  detach: Ctrl-B D)"

    echo "  PID:     $PID"
    echo ""
    echo "Monitor:  tail -f $LOG_FILE"
    echo "Status:   ./review-scrape.sh --status"
    echo "Stop:     ./review-scrape.sh --stop"
    echo ""
  fi
}

# ============================================
# Main
# ============================================
parse_args "$@"

if [ -n "$RUN_MODE" ]; then
  run_direct
else
  step_select_city
  step_configure
  step_launch
fi
