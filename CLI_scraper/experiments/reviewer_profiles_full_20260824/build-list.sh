#!/usr/bin/env bash
set -Eeuo pipefail

RUN_ROOT=/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824
CODE_ROOT="$RUN_ROOT/code"
NODE_ROOT=/data/haoxi/CLI_scraper/.runtime/node-v22.14.0-linux-x64
DATABASE=/data/haoxi/CLI_scraper/output/singapore/2026-08-14/singapore_reviews_20260814.db

export PATH="$NODE_ROOT/bin:/usr/bin:/bin"
export TMPDIR="$RUN_ROOT/tmp"
export SQLITE_TMPDIR="$RUN_ROOT/tmp"
mkdir -p "$RUN_ROOT"/{list/shards,logs,status,tmp}

cd "$CODE_ROOT"
/usr/bin/time -v node scripts/build-reviewer-list-sqlite.js \
  --db "$DATABASE" \
  --output "$RUN_ROOT/list/reviewers.all.ndjson" \
  --shard-dir "$RUN_ROOT/list/shards" \
  --shards 4 \
  --manifest "$RUN_ROOT/list/manifest.json"

