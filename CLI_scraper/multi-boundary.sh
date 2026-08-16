#!/bin/bash
# ============================================
# Multi-Boundary Batch — interactive wizard
# ============================================
# Surfaces src/multi-boundary-orchestrator.js: scrape many disjoint boundaries
# (e.g. all parks) from one multi-Feature GeoJSON, each as its own area with its
# own sampling points / quadtree / boundary filter / output dir. Supports the
# self-adapt (category-free) mode and multi-IP sharding.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "=== Multi-Boundary Batch (stage 2, many areas) ==="
echo ""

# --- boundaries file ---
read -p "Multi-Feature GeoJSON path> " BFILE
if [ -z "$BFILE" ] || [ ! -f "$BFILE" ]; then
  echo "File not found: '$BFILE'"; exit 1
fi

# --- batch name ---
read -p "Batch name (prefixes every area dir, e.g. sg_parks)> " BATCH
if [ -z "$BATCH" ]; then echo "Batch name required."; exit 1; fi

# --- geometry knobs ---
CELL=200; read -p "Cell size in meters (default: $CELL)> " INPUT; [ -n "$INPUT" ] && CELL="$INPUT"
BUFFER=0; read -p "Boundary buffer in meters (default: $BUFFER)> " INPUT; [ -n "$INPUT" ] && BUFFER="$INPUT"

# --- category mode ---
echo ""
echo "Category mode:"
echo "  [1] Fixed taxonomy (config/categories.json)"
echo "  [2] Self-adapt — discover types from Google's own labels (category-free)"
read -p "Select [1]> " CAT_MODE
SA_ARGS=""
CAT_ARGS=""
if [ "$CAT_MODE" = "2" ]; then
  SA_MAXQ=80; read -p "  Query budget per area (default: $SA_MAXQ)> " INPUT; [ -n "$INPUT" ] && SA_MAXQ="$INPUT"
  SA_DRY=6;  read -p "  Stop after K consecutive dry (in-boundary) queries (default: $SA_DRY)> " INPUT; [ -n "$INPUT" ] && SA_DRY="$INPUT"
  SA_ARGS="--self-adapt --sa-max-queries $SA_MAXQ --sa-stop-after-dry $SA_DRY"
else
  read -p "Filter categories? (comma-separated, or Enter for all)> " CATS
  [ -n "$CATS" ] && CAT_ARGS="--category-filter $CATS"
fi

# --- sharding ---
echo ""
echo "Sharding: run N processes over disjoint 1/N slices (one per IP/machine)."
echo "  On a single IP, more shards just share the same throttle — 1 is safest here."
NSHARD=1; read -p "Number of shards (default: $NSHARD)> " INPUT; [ -n "$INPUT" ] && NSHARD="$INPUT"

COMMON="--boundaries \"$BFILE\" --name \"$BATCH\" --cell-size $CELL --buffer $BUFFER $SA_ARGS $CAT_ARGS"

echo ""
echo "About to run:"
if [ "$NSHARD" -le 1 ]; then
  echo "  node src/multi-boundary-orchestrator.js $COMMON"
else
  echo "  $NSHARD tmux shards, each: ... $COMMON --shard i/$NSHARD" \
       "$([ -n "$SA_ARGS" ] && echo '--sa-vocab output/_selfadapt_vocab__'"${BATCH}"'_shard_i.json')"
fi
read -p "Proceed? [Y/n] " GO
if [ "$GO" = "n" ] || [ "$GO" = "N" ]; then echo "Aborted."; exit 0; fi

mkdir -p output logs

if [ "$NSHARD" -le 1 ]; then
  # single process, foreground (resume-safe: re-run to continue)
  eval "node src/multi-boundary-orchestrator.js $COMMON 2>&1 | tee -a logs/${BATCH}.log"
else
  command -v tmux >/dev/null || { echo "tmux not found — needed for sharded runs."; exit 1; }
  for i in $(seq 1 "$NSHARD"); do
    VOCAB=""
    [ -n "$SA_ARGS" ] && VOCAB="--sa-vocab output/_selfadapt_vocab__${BATCH}_shard_${i}.json"
    tmux kill-session -t "${BATCH}_sh${i}" 2>/dev/null || true
    tmux new-session -d -s "${BATCH}_sh${i}" \
      "cd \"$SCRIPT_DIR\"; node src/multi-boundary-orchestrator.js $COMMON --shard ${i}/${NSHARD} $VOCAB 2>&1 | tee -a logs/${BATCH}_shard_${i}.log"
    echo "  launched shard ${i}/${NSHARD} (tmux ${BATCH}_sh${i})"
    sleep 1
  done
  echo ""
  echo "Attach:  tmux attach -t ${BATCH}_sh1     (Ctrl-B D to detach)"
  echo "Stop:    for i in \$(seq 1 $NSHARD); do tmux kill-session -t ${BATCH}_sh\$i; done"
  echo "Resume:  re-run this wizard with the same inputs (done areas skip via _area_complete.json)"
fi
