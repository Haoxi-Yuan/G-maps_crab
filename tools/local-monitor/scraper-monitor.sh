#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CLI_ROOT=$(cd "$HERE/../../CLI_scraper" && pwd)
BUILD="$HERE/.build-unified"
APP="$BUILD/Scraper Monitor.app"
CONTENTS="$APP/Contents"
INSTALL="$HOME/Applications/Scraper Monitor.app"
BUILD_ONLY=0
INSTALL_MODE=0
FOREGROUND=0
ARGS=()

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    --install) INSTALL_MODE=1 ;;
    --foreground) FOREGROUND=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

HAS_LOCAL_ROOT=0
if (( ${#ARGS[@]} )); then
  for arg in "${ARGS[@]}"; do
    [[ "$arg" == "--local-root" ]] && HAS_LOCAL_ROOT=1
  done
fi
if (( ! HAS_LOCAL_ROOT )); then
  ARGS+=(--local-root "$CLI_ROOT")
fi

mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
swiftc -O -framework AppKit -framework MapKit \
  "$HERE/ScraperMonitor.swift" "$HERE/ResourceMonitor.swift" \
  -o "$CONTENTS/MacOS/ScraperMonitor"
cp "$HERE/ScraperMonitorInfo.plist" "$CONTENTS/Info.plist"
cp "$HERE/app-icon.png" "$CONTENTS/Resources/app-icon.png"

ICONSET="$BUILD/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for spec in \
  '16 icon_16x16.png' '32 icon_16x16@2x.png' \
  '32 icon_32x32.png' '64 icon_32x32@2x.png' \
  '128 icon_128x128.png' '256 icon_128x128@2x.png' \
  '256 icon_256x256.png' '512 icon_256x256@2x.png' \
  '512 icon_512x512.png' '1024 icon_512x512@2x.png'
do
  size=${spec%% *}
  name=${spec#* }
  sips -s format png -z "$size" "$size" "$HERE/app-icon.png" \
    --out "$ICONSET/$name" >/dev/null
done
if ! iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"; then
  # iconutil on some macOS/Xcode combinations rejects otherwise valid RGBA
  # iconsets. Keep the last known-good ICNS; the runtime PNG below is always
  # copied and is also assigned explicitly by ScraperMonitor.swift.
  if [[ -s "$CONTENTS/Resources/AppIcon.icns" ]]; then
    printf 'warning: using existing AppIcon.icns fallback\n' >&2
  else
    printf 'warning: AppIcon.icns unavailable; the runtime PNG icon will be used\n' >&2
  fi
fi
xattr -cr "$APP"
codesign --force --deep --sign - "$APP" >/dev/null

if (( BUILD_ONLY )); then
  printf '%s\n' "$APP"
  exit 0
fi

if (( INSTALL_MODE )); then
  mkdir -p "$HOME/Applications"
  rm -rf "$INSTALL"
  ditto "$APP" "$INSTALL"
  xattr -cr "$INSTALL"
  codesign --force --deep --sign - "$INSTALL" >/dev/null
  APP="$INSTALL"
fi

if (( FOREGROUND )); then
  exec "$APP/Contents/MacOS/ScraperMonitor" "${ARGS[@]}"
fi

if (( ${#ARGS[@]} )); then open "$APP" --args "${ARGS[@]}"; else open "$APP"; fi
