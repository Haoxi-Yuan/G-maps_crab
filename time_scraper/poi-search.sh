#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ============================================
# Defaults
# ============================================
CELL_SIZE=1000
MAX_DEPTH=8
MIN_CELL=0.06
THRESHOLD=18
DELAY=150
SAVE_INTERVAL=20
RUN_MODE=""         # "foreground" or "background" (default: background)
CITY_NAME=""
POINTS_FILE=""
OUTPUT_FILE=""
CAT_FILTER=""
BBOX_INPUT=""

# ============================================
# Parse CLI arguments (non-interactive mode)
# ============================================
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --run)       RUN_MODE="background"; shift ;;
      --foreground) RUN_MODE="foreground"; shift ;;
      --city)      CITY_NAME="$2"; shift 2 ;;
      --points)    POINTS_FILE="$2"; shift 2 ;;
      --output)    OUTPUT_FILE="$2"; shift 2 ;;
      --categories) CAT_FILTER="$2"; shift 2 ;;
      --bbox)      BBOX_INPUT="$2"; shift 2 ;;
      --max-depth) MAX_DEPTH="$2"; shift 2 ;;
      --min-cell)  MIN_CELL="$2"; shift 2 ;;
      --threshold) THRESHOLD="$2"; shift 2 ;;
      --delay)     DELAY="$2"; shift 2 ;;
      --cell-size) CELL_SIZE="$2"; shift 2 ;;
      --fresh)     FRESH=1; shift ;;
      --status)    show_status; exit 0 ;;
      --stop)      stop_background; exit 0 ;;
      --help)      show_help; exit 0 ;;
      *)           echo "Unknown option: $1"; show_help; exit 1 ;;
    esac
  done
}

show_help() {
  echo ""
  echo "Usage: ./poi-search.sh [options]"
  echo ""
  echo "Interactive mode (default):"
  echo "  ./poi-search.sh                 Start interactive wizard"
  echo ""
  echo "Non-interactive mode:"
  echo "  ./poi-search.sh --run --city san_francisco"
  echo "  ./poi-search.sh --run --city 'New York' --bbox '-74.05,40.68,-73.90,40.88'"
  echo "  ./poi-search.sh --run --city san_francisco --foreground"
  echo ""
  echo "Options:"
  echo "  --run             Run directly (background by default)"
  echo "  --foreground      Run in foreground instead of background"
  echo "  --city <name>     City name or existing data dir name"
  echo "  --points <file>   Points file (auto-detected from city if omitted)"
  echo "  --output <file>   Output file (default: output/{city}_poi_search.json)"
  echo "  --categories <list>  Comma-separated category filter"
  echo "  --bbox <coords>   Bounding box: minLng,minLat,maxLng,maxLat"
  echo "  --max-depth <n>   Max quadtree depth (default: 8)"
  echo "  --min-cell <km>   Min cell size in km (default: 0.06)"
  echo "  --threshold <n>   Subdivide threshold (default: 18)"
  echo "  --delay <ms>      Request delay in ms (default: 150)"
  echo "  --cell-size <m>   Sampling cell size in meters (default: 1000)"
  echo "  --fresh           Delete existing output and start fresh"
  echo "  --status          Show status of running/completed searches"
  echo "  --stop            Stop background search process"
  echo ""
}

# ============================================
# Status and process management
# ============================================
show_status() {
  echo ""
  echo "=== POI Search Status ==="
  echo ""

  # Check for running processes
  local pids=$(pgrep -f "poi-searcher-api" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Running processes:"
    for pid in $pids; do
      local elapsed=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
      echo "  PID $pid (elapsed: $elapsed)"
    done
    echo ""
  else
    echo "No running search processes."
    echo ""
  fi

  # Check output files
  for f in output/*_poi_search.json; do
    [ -f "$f" ] || continue
    local info=$(python3 -c "
import json
d = json.load(open('$f'))
cats = d.get('results', [])
prog = d.get('progress', {})
total_cats = prog.get('totalCategories', len(cats))
cur = prog.get('currentCategory', '')
print(f'{d.get(\"totalPlaceIds\",0)} POIs | {len(cats)}/{total_cats} categories' + (f' | current: {cur}' if cur else ' | done'))
" 2>/dev/null || echo "error reading")
    echo "  $f"
    echo "    $info"
    echo ""
  done
}

stop_background() {
  local pids=$(pgrep -f "poi-searcher-api" 2>/dev/null || true)
  if [ -z "$pids" ]; then
    echo "No running search processes found."
    return
  fi
  for pid in $pids; do
    echo "Stopping PID $pid..."
    kill "$pid" 2>/dev/null || true
  done
  sleep 2
  echo "Done. Progress has been saved to the output file."
}

# ============================================
# Helper functions
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
  echo '    Quadtree POI Search  v2.0           '
  echo '    ================================    '
  echo ""
}

list_cities() {
  echo "Available cities with existing boundary data:"
  echo ""
  local i=1
  CITIES=()
  for dir in data/*/; do
    if [ -f "${dir}"*_boundary.geojson ] 2>/dev/null || [ -f "${dir}"*_points.json ] 2>/dev/null; then
      local name=$(basename "$dir")
      local has_boundary="no"
      local has_points="no"
      local point_count="-"

      if ls "${dir}"*_boundary.geojson 1>/dev/null 2>&1; then has_boundary="yes"; fi
      if ls "${dir}"*_points.json 1>/dev/null 2>&1; then
        has_points="yes"
        point_count=$(python3 -c "import json; print(len(json.load(open('$(ls ${dir}*_points.json | head -1)'))))" 2>/dev/null || echo "?")
      fi

      printf "  [%d] %-20s boundary=%-3s  points=%-3s (%s)\n" "$i" "$name" "$has_boundary" "$has_points" "$point_count"
      CITIES+=("$name")
      i=$((i + 1))
    fi
  done

  if [ ${#CITIES[@]} -eq 0 ]; then
    echo "  (none found)"
  fi
  echo ""
}

# ============================================
# Resolve city → points file + output file
# ============================================
resolve_city() {
  local city_slug=$(echo "$CITY_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_')
  CITY_DIR="data/$city_slug"

  # Auto-detect points file
  if [ -z "$POINTS_FILE" ]; then
    POINTS_FILE=$(ls "${CITY_DIR}/"*_points.json 2>/dev/null | head -1)
  fi

  # If no points file, need to generate
  if [ -z "$POINTS_FILE" ] || [ ! -f "$POINTS_FILE" ]; then
    echo "Generating boundary and points for: $CITY_NAME"
    local bbox_arg=""
    [ -n "$BBOX_INPUT" ] && bbox_arg="--bbox $BBOX_INPUT"
    node src/city-generator/index.js \
      --city "$CITY_NAME" \
      --output "$CITY_DIR" \
      --cell-size "$CELL_SIZE" \
      $bbox_arg
    POINTS_FILE=$(ls "${CITY_DIR}/"*_points.json 2>/dev/null | head -1)
    if [ -z "$POINTS_FILE" ]; then
      echo "ERROR: Failed to generate points"
      exit 1
    fi
  fi

  # Auto-detect output file
  if [ -z "$OUTPUT_FILE" ]; then
    OUTPUT_FILE="output/${city_slug}_poi_search.json"
  fi

  # Fresh start
  if [ "${FRESH:-0}" = "1" ] && [ -f "$OUTPUT_FILE" ]; then
    rm -f "$OUTPUT_FILE"
  fi
}

# ============================================
# Core node command (used by both modes)
# ============================================
build_node_command() {
  local cat_filter_code=""
  if [ -n "$CAT_FILTER" ]; then
    cat_filter_code="
    const selected = new Set('${CAT_FILTER}'.split(',').map(s => s.trim().toLowerCase()));
    categories = categories.filter(c => selected.has(c.toLowerCase()));
    console.log('Filtered to', categories.length, 'categories:', categories.join(', '));
    "
  fi

  NODE_CMD="node -e \"
const { chromium } = require('playwright');
const api = require('./src/poi-searcher-api');

(async () => {
  const points = api.loadPointsFromJSON('${POINTS_FILE}');
  let categories = api.loadCategories('config/categories.json');
  ${cat_filter_code}
  console.log('Points:', points.length, '| Categories:', categories.length);

  const browser = await chromium.launch({ headless: true });
  try {
    const result = await api.batchSearchPOIs(browser, points, categories, {
      maxDepth: ${MAX_DEPTH},
      subdivideThreshold: ${THRESHOLD},
      requestDelayMs: ${DELAY},
      minCellSizeKm: ${MIN_CELL},
      saveInterval: ${SAVE_INTERVAL},
      incrementalSaveFile: '${OUTPUT_FILE}',
    });
    console.log('');
    console.log('=== COMPLETED ===');
    console.log('Total unique POIs:', result.totalPlaceIds);
    let totalReq = 0;
    for (const r of result.results) {
      console.log('  ' + r.category + ': +' + r.newPlaceIds + ' (' + r.requests + ' req, ' + r.elapsed + 's)');
      totalReq += r.requests;
    }
    console.log('Total requests:', totalReq);
    console.log('Output saved to: ${OUTPUT_FILE}');
  } finally {
    await browser.close();
  }
})();
\""
}

# ============================================
# Non-interactive run
# ============================================
run_direct() {
  if [ -z "$CITY_NAME" ]; then
    echo "ERROR: --city is required with --run"
    show_help
    exit 1
  fi

  resolve_city
  build_node_command

  local LOG_FILE="${OUTPUT_FILE%.json}.log"

  # Log rotation
  if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 2000 ]; then
    tail -500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi

  local pc=$(python3 -c "import json; print(len(json.load(open('$POINTS_FILE'))))" 2>/dev/null || echo "?")

  if [ "$RUN_MODE" = "foreground" ]; then
    echo ""
    echo "Starting POI search (foreground)..."
    echo "  City: $CITY_NAME | Points: $pc | Output: $OUTPUT_FILE"
    echo ""
    eval "$NODE_CMD" 2>&1 | tee "$LOG_FILE"
  else
    # Background mode (default)
    echo ""
    echo "Starting POI search (background)..."
    echo "  City:    $CITY_NAME"
    echo "  Points:  $POINTS_FILE ($pc points)"
    echo "  Output:  $OUTPUT_FILE"
    echo "  Log:     $LOG_FILE"
    echo ""

    mkdir -p "$(dirname "$OUTPUT_FILE")"
    nohup bash -c "cd '$SCRIPT_DIR' && $NODE_CMD" > "$LOG_FILE" 2>&1 &
    local PID=$!

    echo "  PID:     $PID"
    echo ""
    echo "Monitor progress:"
    echo "  tail -f $LOG_FILE"
    echo "  ./poi-search.sh --status"
    echo ""
    echo "Stop:"
    echo "  ./poi-search.sh --stop"
    echo "  (progress is auto-saved, restart to resume)"
    echo ""
  fi
}

# ============================================
# Interactive mode steps
# ============================================
step_select_city() {
  print_header
  list_cities

  echo "Options:"
  echo "  Enter a number to select an existing city"
  echo "  Enter a new city name to download its boundary"
  echo "  Enter 'q' to quit"
  echo ""
  read -p "City> " CITY_INPUT

  if [ "$CITY_INPUT" = "q" ]; then exit 0; fi

  # Check if it's a number (selecting existing city)
  if [[ "$CITY_INPUT" =~ ^[0-9]+$ ]] && [ "$CITY_INPUT" -ge 1 ] && [ "$CITY_INPUT" -le ${#CITIES[@]} ]; then
    CITY_NAME="${CITIES[$((CITY_INPUT - 1))]}"
    CITY_DIR="data/$CITY_NAME"
    echo ""
    echo "Selected: $CITY_NAME"
  else
    # New city
    CITY_NAME="$CITY_INPUT"
    CITY_DIR="data/$(echo "$CITY_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_')"
    echo ""
    echo "New city: $CITY_NAME"
    echo "Output directory: $CITY_DIR"
  fi
}

step_boundary_and_points() {
  local boundary_file=$(ls "${CITY_DIR}/"*_boundary.geojson 2>/dev/null | head -1)
  local points_file=$(ls "${CITY_DIR}/"*_points.json 2>/dev/null | head -1)

  if [ -n "$boundary_file" ] && [ -n "$points_file" ]; then
    local pc=$(python3 -c "import json; print(len(json.load(open('$points_file'))))" 2>/dev/null || echo "?")
    echo ""
    echo "Existing data found:"
    echo "  Boundary: $boundary_file"
    echo "  Points:   $points_file ($pc points)"
    echo ""
    read -p "Use existing data? [Y/n] " USE_EXISTING
    if [ "$USE_EXISTING" != "n" ] && [ "$USE_EXISTING" != "N" ]; then
      POINTS_FILE="$points_file"
      return
    fi
  fi

  # Need to generate boundary + points
  echo ""
  read -p "Cell size in meters (default: $CELL_SIZE)> " INPUT_CELL
  [ -n "$INPUT_CELL" ] && CELL_SIZE="$INPUT_CELL"

  echo ""
  echo "Optional: clip to bounding box (format: minLng,minLat,maxLng,maxLat)"
  echo "  Example for San Francisco: -122.52,37.70,-122.35,37.82"
  read -p "BBox (leave empty to skip)> " BBOX_INPUT

  echo ""
  echo "Downloading boundary and generating points..."

  local bbox_arg=""
  [ -n "$BBOX_INPUT" ] && bbox_arg="--bbox $BBOX_INPUT"

  node src/city-generator/index.js \
    --city "$CITY_NAME" \
    --output "$CITY_DIR" \
    --cell-size "$CELL_SIZE" \
    $bbox_arg

  POINTS_FILE=$(ls "${CITY_DIR}/"*_points.json 2>/dev/null | head -1)

  if [ -z "$POINTS_FILE" ]; then
    echo "ERROR: Points file not generated"
    exit 1
  fi

  local pc=$(python3 -c "import json; print(len(json.load(open('$POINTS_FILE'))))" 2>/dev/null || echo "?")
  echo ""
  echo "Generated $pc sampling points"
}

step_configure() {
  echo ""
  echo "--- Search Configuration ---"
  echo ""
  echo "Current settings:"
  echo "  Max depth:          $MAX_DEPTH"
  echo "  Min cell size:      ${MIN_CELL}km (adaptive: dense areas go deeper)"
  echo "  Subdivide threshold: $THRESHOLD (subdivide if results >= this)"
  echo "  Request delay:      ${DELAY}ms"
  echo ""
  echo "  Adaptive subdivision (based on distance ratio):"
  echo "    r < 0.5  extreme density → min 0.06km (zoom 20)"
  echo "    r 0.5-0.7 dense          → min 0.12km (zoom 19)"
  echo "    r 0.7-1.0 moderate       → min 0.25km (zoom 18)"
  echo "    r >= 1.0  sparse         → stop"
  echo ""
  read -p "Adjust settings? [y/N] " ADJUST

  if [ "$ADJUST" = "y" ] || [ "$ADJUST" = "Y" ]; then
    read -p "  Max depth (default: $MAX_DEPTH)> " INPUT
    [ -n "$INPUT" ] && MAX_DEPTH="$INPUT"

    read -p "  Min cell size km (default: $MIN_CELL)> " INPUT
    [ -n "$INPUT" ] && MIN_CELL="$INPUT"

    read -p "  Subdivide threshold (default: $THRESHOLD)> " INPUT
    [ -n "$INPUT" ] && THRESHOLD="$INPUT"

    read -p "  Request delay ms (default: $DELAY)> " INPUT
    [ -n "$INPUT" ] && DELAY="$INPUT"
  fi

  # Categories
  local cat_count=$(python3 -c "import json; d=json.load(open('config/categories.json')); print(len(d.get('categories',d)))" 2>/dev/null || echo "?")
  echo ""
  echo "Categories: $cat_count (from config/categories.json)"
  read -p "Filter categories? (comma-separated, or Enter for all)> " CAT_FILTER

  # Output file
  local city_slug=$(echo "$CITY_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_')
  OUTPUT_FILE="output/${city_slug}_poi_search.json"
  echo ""
  read -p "Output file (default: $OUTPUT_FILE)> " INPUT
  [ -n "$INPUT" ] && OUTPUT_FILE="$INPUT"

  # Check for existing output (resume)
  if [ -f "$OUTPUT_FILE" ]; then
    local existing_pois=$(python3 -c "import json; print(json.load(open('$OUTPUT_FILE')).get('totalPlaceIds',0))" 2>/dev/null || echo "0")
    echo ""
    echo "Existing output found: $existing_pois POIs"
    read -p "Resume from checkpoint? [Y/n] " RESUME
    if [ "$RESUME" = "n" ] || [ "$RESUME" = "N" ]; then
      rm -f "$OUTPUT_FILE"
      echo "Starting fresh."
    else
      echo "Will resume from checkpoint."
    fi
  fi
}

step_launch() {
  build_node_command

  local LOG_FILE="${OUTPUT_FILE%.json}.log"

  echo ""
  echo "=========================================="
  echo "  Launching POI Search"
  echo "=========================================="
  echo "  City:       $CITY_NAME"
  echo "  Points:     $POINTS_FILE"
  echo "  Output:     $OUTPUT_FILE"
  echo "  Log:        $LOG_FILE"
  echo "  Max depth:  $MAX_DEPTH"
  echo "  Min cell:   ${MIN_CELL}km"
  echo "  Threshold:  $THRESHOLD"
  echo "  Delay:      ${DELAY}ms"
  echo "=========================================="
  echo ""
  read -p "Run in background? [Y/n] " BG_CHOICE

  # Log rotation
  if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 2000 ]; then
    tail -500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi

  mkdir -p "$(dirname "$OUTPUT_FILE")"

  if [ "$BG_CHOICE" = "n" ] || [ "$BG_CHOICE" = "N" ]; then
    echo ""
    echo "Starting (foreground, Ctrl+C to stop)..."
    echo ""
    eval "$NODE_CMD" 2>&1 | tee "$LOG_FILE"
  else
    echo ""
    nohup bash -c "cd '$SCRIPT_DIR' && $NODE_CMD" > "$LOG_FILE" 2>&1 &
    local PID=$!
    echo "Started in background (PID: $PID)"
    echo ""
    echo "Monitor progress:"
    echo "  tail -f $LOG_FILE"
    echo "  ./poi-search.sh --status"
    echo ""
    echo "Stop:"
    echo "  ./poi-search.sh --stop"
    echo ""
  fi
}

# ============================================
# Main
# ============================================
parse_args "$@"

if [ -n "$RUN_MODE" ]; then
  # Non-interactive mode
  run_direct
else
  # Interactive mode
  step_select_city
  step_boundary_and_points
  step_configure
  step_launch
fi
