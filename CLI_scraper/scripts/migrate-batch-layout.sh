#!/usr/bin/env bash
# Move legacy flat multi-boundary area dirs (data|output/<batch>__<slug>/) into
# the grouped layout (data|output/_batches/<batch>/<batch>__<slug>/), so a batch's
# hundreds of areas stop crowding the top level next to city folders.
#
#   ./scripts/migrate-batch-layout.sh            # dry run (shows what would move)
#   ./scripts/migrate-batch-layout.sh --apply    # actually move
#   ./scripts/migrate-batch-layout.sh --apply sg_parks   # only this batch
set -u
cd "$(dirname "$0")/.." || exit 1

APPLY=false
ONLY=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=true ;;
    *) ONLY="$a" ;;
  esac
done

moved=0
skipped=0
for root in data output; do
  [ -d "$root" ] || continue
  for dir in "$root"/*__*/; do
    [ -d "$dir" ] || continue
    base=$(basename "$dir")
    batch="${base%%__*}"                       # text before the first __
    [ "$batch" = "$base" ] && continue         # no __ separator: not a batch dir
    [ -n "$ONLY" ] && [ "$batch" != "$ONLY" ] && continue
    dest="$root/_batches/$batch/$base"
    if [ -e "$dest" ]; then
      echo "  SKIP (exists): $dest"
      skipped=$((skipped + 1))
      continue
    fi
    if $APPLY; then
      mkdir -p "$root/_batches/$batch"
      mv "$dir" "$dest" && moved=$((moved + 1))
    else
      echo "  $dir  ->  $dest"
      moved=$((moved + 1))
    fi
  done
done

if $APPLY; then
  echo "moved $moved dir(s); skipped $skipped"
  echo "data/ top-level now: $(ls data 2>/dev/null | wc -l | tr -d ' ') entries"
  echo "output/ top-level now: $(ls output 2>/dev/null | wc -l | tr -d ' ') entries"
else
  echo "(dry run) $moved dir(s) would move, $skipped skipped — re-run with --apply"
fi
