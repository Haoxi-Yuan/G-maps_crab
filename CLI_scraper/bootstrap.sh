#!/bin/bash
# Sets up everything the pipeline needs: node deps + Playwright chromium +
# Python venv (geopandas/contextily/matplotlib) + tmux for backgrounding.
#
# Designed to work WITHOUT root. When a system tool is missing, falls back
# to `conda install` (most no-sudo users already have miniconda/anaconda).
# When env is broken — even if the *-bootstrap-ok marker is present — does
# a real-import check and reinstalls if the check fails.
#
# Re-running is cheap: every step short-circuits if already healthy.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# --- Output helpers --------------------------------------------------------
log() { printf "\033[1;34m[bootstrap]\033[0m %s\n" "$*"; }
ok()  { printf "\033[1;32m[bootstrap]\033[0m %s\n" "$*"; }
warn(){ printf "\033[1;33m[bootstrap]\033[0m %s\n" "$*" >&2; }
err() { printf "\033[1;31m[bootstrap]\033[0m %s\n" "$*" >&2; }

# --- Tool installer (no-sudo, conda-first) ---------------------------------
# Usage: ensure_cmd <command> <conda-package> "<plain-text install hint>"
# Tries: already-on-PATH → conda install (if conda available) → fail with hint.
ensure_cmd() {
  local cmd="$1" pkg="$2" hint="$3"
  if command -v "$cmd" >/dev/null 2>&1; then
    return 0
  fi
  warn "missing: $cmd"
  if command -v conda >/dev/null 2>&1; then
    log "  attempting:  conda install -y -c conda-forge $pkg"
    if conda install -y -c conda-forge "$pkg" >/dev/null 2>&1; then
      if command -v "$cmd" >/dev/null 2>&1; then
        ok "  installed via conda: $cmd → $(command -v "$cmd")"
        return 0
      fi
      err "conda install reported success but $cmd still not in PATH — activate the conda env and re-run, or install manually."
    else
      err "conda install of $pkg failed."
    fi
  else
    err "  conda not available either — cannot auto-install without root."
  fi
  err "  next step: $hint"
  exit 1
}

# --- Stage 0: required tools -----------------------------------------------
ensure_cmd node    nodejs    "install Node.js 18+ from https://nodejs.org/, via nvm (https://github.com/nvm-sh/nvm), or in any conda env"
ensure_cmd npm     nodejs    "npm ships with Node.js — reinstall Node"
ensure_cmd python3 'python>=3.10' "install Python 3.10+ via pyenv, uv (https://docs.astral.sh/uv/), or any conda env"
ensure_cmd tmux    tmux      "install tmux: 'conda install -c conda-forge tmux', or download static binary from https://github.com/nelsonenzo/tmux-appimage/releases, or use 'apt/brew install tmux' if you have sudo"

# Node version
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js $NODE_MAJOR detected; Playwright requires >= 18"
  exit 1
fi
ok "node $(node -v)  ·  npm $(npm -v)"

# Python version (geopandas 1.x requires 3.10+)
PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
PY_MAJOR=${PY_VER%%.*}; PY_MINOR=${PY_VER##*.}
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  err "Python $PY_VER detected; need >= 3.10 for geopandas 1.x (boundary map rendering)"
  err "  fix: install via conda ('conda install -y python=3.11') or pyenv/uv"
  exit 1
fi
ok "python $PY_VER  ·  tmux $(tmux -V | awk '{print $2}')"

# --- Stage 1: node_modules -------------------------------------------------
# Detect a copied-and-dereferenced node_modules (when copied across machines
# with a tool that flattens symlinks the .bin/* shims become broken file
# copies — internal `require(...)` paths fail).
if [ -d node_modules/.bin ] && find node_modules/.bin -maxdepth 1 -type f -print -quit 2>/dev/null | grep -q .; then
  warn "broken node_modules detected (.bin entries are regular files, not symlinks) — wiping"
  rm -rf node_modules
fi

# Marker-fast-path: only do the deep import check if the marker is missing,
# OR if the deep check itself fails (catches partial / corrupted installs).
need_npm_install=0
if [ ! -d node_modules ] || [ ! -f node_modules/.bootstrap-ok ]; then
  need_npm_install=1
else
  # Deep verify: try requiring every load-bearing module.
  if ! node -e 'require("playwright"); require("better-sqlite3"); require("@turf/turf"); require("proj4")' 2>/dev/null; then
    warn "node_modules looks present but a load-bearing require() failed — reinstalling"
    rm -f node_modules/.bootstrap-ok
    need_npm_install=1
  fi
fi

if [ "$need_npm_install" = "1" ]; then
  log "installing npm dependencies..."
  npm install --no-audit --no-fund
  if ! node -e 'require("playwright"); require("better-sqlite3"); require("@turf/turf"); require("proj4")'; then
    err "npm install completed but require() still failing — manual intervention needed"
    exit 1
  fi
  touch node_modules/.bootstrap-ok
  ok "node_modules installed and verified"
else
  ok "node_modules already healthy"
fi

# Restore +x on shims (lost when node_modules copied via scp/rsync without -p).
if [ -d node_modules/.bin ]; then
  chmod +x node_modules/.bin/* 2>/dev/null || true
fi

# --- Stage 2: Playwright chromium ------------------------------------------
# Don't trust the cache directory existing — actually try to launch and see.
log "verifying Playwright chromium..."
if node -e '
const { chromium } = require("playwright");
chromium.launch({ headless: true })
  .then(b => b.close())
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
' 2>/dev/null; then
  ok "Playwright chromium launches OK"
else
  warn "Playwright chromium missing or broken — installing"
  npx --yes playwright install chromium
  if node -e '
const { chromium } = require("playwright");
chromium.launch({ headless: true }).then(b => b.close()).then(() => process.exit(0)).catch(() => process.exit(1));
' 2>/dev/null; then
    ok "Playwright chromium installed and verified"
  else
    err "Playwright chromium install failed verification."
    err "  Likely cause: missing system shared libraries (libgbm, libxcb, etc.)."
    err "  If you have sudo:   npx playwright install-deps chromium"
    err "  If no sudo:         conda install -y -c conda-forge xorg-libxcomposite libgbm nspr nss"
    exit 1
  fi
fi

# --- Stage 3: Python venv --------------------------------------------------
# Detect a copied-and-dereferenced .venv (bin/python3 should be a symlink;
# if it's a regular file the venv was copied without preserving links and
# everything is broken).
if [ -d .venv ] && [ -f .venv/bin/python3 ] && [ ! -L .venv/bin/python3 ]; then
  warn "broken .venv detected (bin/python3 is a regular file, not a symlink) — recreating"
  rm -rf .venv
fi

if [ ! -d .venv ]; then
  log "creating Python virtualenv at .venv/..."
  python3 -m venv .venv
fi

need_pip_install=0
if [ ! -f .venv/.bootstrap-ok ]; then
  need_pip_install=1
else
  if ! .venv/bin/python3 -c 'import geopandas, contextily, matplotlib, pyproj' 2>/dev/null; then
    warn ".venv looks present but an import failed — reinstalling packages"
    rm -f .venv/.bootstrap-ok
    need_pip_install=1
  fi
fi

if [ "$need_pip_install" = "1" ]; then
  log "installing Python map-rendering packages (this can take a couple of minutes)..."
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet geopandas contextily matplotlib
  if ! .venv/bin/python3 -c 'import geopandas, contextily, matplotlib, pyproj' 2>&1; then
    err "Python package install completed but import still failing — manual intervention needed"
    exit 1
  fi
  touch .venv/.bootstrap-ok
  ok "Python venv installed and verified"
else
  ok "Python venv already healthy"
fi

# --- Stage 4: scaffolding --------------------------------------------------
mkdir -p data output logs
chmod +x bootstrap.sh poi-search.sh review-scrape.sh bin/gmaps-crab 2>/dev/null || true

# --- Done ------------------------------------------------------------------
echo ""
ok "bootstrap complete — environment is healthy."
printf "Launch the pipeline with:  \033[1;32m./bin/gmaps-crab\033[0m\n"
echo ""
echo "Tip: long scrapes run inside tmux. List sessions with: tmux ls"
echo "     Re-attach to one with:                              tmux attach -t <name>"
