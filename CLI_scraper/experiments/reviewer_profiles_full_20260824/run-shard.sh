#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-3]$ ]]; then
  echo "usage: $0 <shard 0-3>" >&2
  exit 2
fi

SHARD="$1"
RUN_ROOT=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
CODE_ROOT="$RUN_ROOT/code"
NODE_ROOT=/data/haoxi/CLI_scraper/.runtime/node-v22.14.0-linux-x64
DATABASE=/data/haoxi/CLI_scraper/output/singapore/2026-08-14/singapore_reviews_20260814.db
LIST="$RUN_ROOT/list/shards/reviewers.part-$SHARD.ndjson"
OUTPUT="$RUN_ROOT/output/reviewers.part-$SHARD.ndjson"
STATUS="$RUN_ROOT/status/reviewers.part-$SHARD.live.json"

if [[ ! -s "$RUN_ROOT/list/manifest.json" || ! -s "$LIST" ]]; then
  echo "reviewer list is not ready: $LIST" >&2
  exit 3
fi

export PATH="$NODE_ROOT/bin:/usr/bin:/bin"
export TMPDIR="$RUN_ROOT/tmp/shard-$SHARD"
export PLAYWRIGHT_BROWSERS_PATH=/data/haoxi/CLI_scraper/.playwright-browsers
mkdir -p "$TMPDIR" "$RUN_ROOT/output" "$RUN_ROOT/status" "$RUN_ROOT/logs"

cd "$CODE_ROOT"
printf '%s\n' "$(date -Is)" > "$RUN_ROOT/status/reviewers.part-$SHARD.started"
set +e
/usr/bin/time -v node src/cli/run-reviewers.js \
  --input "$DATABASE" \
  --reviewer-list-input "$LIST" \
  --output "$OUTPUT" \
  --live-status "$STATUS" \
  --max-profile-reviews 200 \
  --fetch-retries 2 \
  --delay-ms 500
exit_code=$?
set -e
printf '%s %s\n' "$(date -Is)" "$exit_code" > "$RUN_ROOT/status/reviewers.part-$SHARD.exit"
exit "$exit_code"
