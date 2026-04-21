#!/bin/bash
# One-shot setup for a fresh machine.
# Installs node deps + downloads the Chromium browser Playwright needs.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

log() { printf "\033[1;34m[bootstrap]\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m[bootstrap]\033[0m %s\n" "$*" >&2; }

# ---- Prereq checks ----
need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    err "$2"
    exit 1
  fi
}

need_cmd node    "install Node.js 18+ from https://nodejs.org/ (or via nvm)"
need_cmd npm     "npm ships with Node.js — reinstall Node"
need_cmd python3 "install python3 (used for JSON stats and boundary map rendering)"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js $NODE_MAJOR detected; need >= 18 for Playwright"
  exit 1
fi
log "node $(node -v) ok"

# ---- Detect copied-and-dereferenced node_modules ----
# When node_modules/ is copied with a tool that dereferences symlinks
# (e.g. plain `cp -r`, zip/tar that doesn't preserve links, some cloud sync),
# the .bin/* shims end up as regular file copies instead of symlinks,
# which breaks their internal relative `require(...)` paths. Nuke and reinstall.
if [ -d node_modules/.bin ] && find node_modules/.bin -maxdepth 1 -type f -print -quit 2>/dev/null | grep -q .; then
  log "detected broken node_modules (non-symlink .bin entries) — reinstalling from scratch..."
  rm -rf node_modules
fi

# ---- npm install ----
if [ ! -d node_modules ] || [ ! -f node_modules/.bootstrap-ok ]; then
  log "installing npm dependencies..."
  npm install --no-audit --no-fund
  touch node_modules/.bootstrap-ok
else
  log "npm dependencies already installed (node_modules/.bootstrap-ok exists)"
  log "  re-run with: rm node_modules/.bootstrap-ok && ./bootstrap.sh"
fi

# ---- Restore +x on npm-linked binaries ----
# When node_modules/ is copied across machines (scp, rsync without -a, etc.)
# the +x bit on .bin/* shims is often lost, causing "Permission denied" below.
if [ -d node_modules/.bin ]; then
  chmod +x node_modules/.bin/* 2>/dev/null || true
fi

# ---- Playwright browser (used by review scraper) ----
# Install chromium only (not full browser set) to keep disk usage down.
log "ensuring Playwright chromium is installed..."
npx --yes playwright install chromium

# ---- Python venv for map rendering ----
# Uses geopandas + contextily + matplotlib to fetch basemap tiles server-side
# and composite boundary/points into a PNG.
# Detect a copied-and-dereferenced .venv (bin/python3 should be a symlink
# to /usr/bin/python3 — if it's a regular file, the venv was copied with
# symlinks flattened, which breaks everything). Nuke and recreate.
if [ -d .venv ] && [ -f .venv/bin/python3 ] && [ ! -L .venv/bin/python3 ]; then
  log "detected broken .venv (python3 is a regular file, not a symlink) — recreating..."
  rm -rf .venv
fi

if [ ! -d .venv ]; then
  log "creating Python virtualenv at .venv/..."
  python3 -m venv .venv
fi
if [ ! -f .venv/.bootstrap-ok ]; then
  log "installing Python map-rendering packages..."
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet geopandas contextily matplotlib
  touch .venv/.bootstrap-ok
else
  log "Python venv already provisioned (.venv/.bootstrap-ok exists)"
  log "  re-run with: rm .venv/.bootstrap-ok && ./bootstrap.sh"
fi

# ---- Directories ----
mkdir -p data output logs
log "created data/ output/ logs/ if missing"

# ---- Executables ----
chmod +x bootstrap.sh poi-search.sh review-scrape.sh bin/gmaps-crab 2>/dev/null || true

log "done. Launch the pipeline with:"
printf "  \033[1;32m./bin/gmaps-crab\033[0m\n"
