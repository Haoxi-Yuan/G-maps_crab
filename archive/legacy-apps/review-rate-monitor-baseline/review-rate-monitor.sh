#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$ROOT/ReviewRateMonitor.swift"
PLIST="$ROOT/Info.plist"
ICON_SOURCE="$ROOT/app-icon.png"
BOUNDARY_SOURCE="$ROOT/singapore_boundary.geojson"
BUILD_DIR="$ROOT/.build"
BINARY="$BUILD_DIR/ReviewRateMonitor"
APP="$BUILD_DIR/ReviewRateMonitor.app"
APP_BINARY="$APP/Contents/MacOS/ReviewRateMonitor"
INSTALL_APP="$HOME/Applications/Review Rate Monitor.app"
FOREGROUND=0
BUILD_ONLY=0
INSTALL=0
ARGS=()

for arg in "$@"; do
  case "$arg" in
    --foreground) FOREGROUND=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --install) INSTALL=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

mkdir -p "$BUILD_DIR"

if [[ ! -x "$BINARY" || "$SOURCE" -nt "$BINARY" ]]; then
  echo "Building ReviewRateMonitor..."
  CLANG_MODULE_CACHE_PATH="$BUILD_DIR/module-cache" \
  SWIFT_MODULE_CACHE_PATH="$BUILD_DIR/module-cache" \
    swiftc -swift-version 5 -O -framework AppKit -framework Foundation "$SOURCE" -o "$BINARY"
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP_BINARY"
cp "$PLIST" "$APP/Contents/Info.plist"
cp "$BOUNDARY_SOURCE" "$APP/Contents/Resources/singapore_boundary.geojson"
chmod 755 "$APP_BINARY"

if [[ -f "$ICON_SOURCE" ]]; then
  cp "$ICON_SOURCE" "$APP/Contents/Resources/app-icon.png"
fi

if (( BUILD_ONLY )); then
  echo "$APP"
  exit 0
fi

if (( INSTALL )); then
  mkdir -p "$HOME/Applications"
  ditto "$APP" "$INSTALL_APP"
  touch "$INSTALL_APP"
  APP="$INSTALL_APP"
  APP_BINARY="$APP/Contents/MacOS/ReviewRateMonitor"
fi

if pgrep -f "$APP_BINARY" >/dev/null 2>&1; then
  echo "ReviewRateMonitor is already running."
  exit 0
fi

if (( FOREGROUND )); then
  if (( ${#ARGS[@]} )); then
    exec "$BINARY" "${ARGS[@]}"
  else
    exec "$BINARY"
  fi
fi

if (( ${#ARGS[@]} )); then
  open -n "$APP" --args "${ARGS[@]}"
else
  open -n "$APP"
fi
echo "ReviewRateMonitor opened."
