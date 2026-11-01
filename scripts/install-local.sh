#!/usr/bin/env bash
# Baut Cable aus diesem Repo und installiert es nach /Applications (nur macOS).
#
#   npm run install:local                 bauen, laufendes Cable beenden, installieren, wieder starten
#   scripts/install-local.sh --pull       vorher git pull --ff-only
#   scripts/install-local.sh --build-only nur release/mac-arm64/Cable.app bauen
#   scripts/install-local.sh --no-build --wait-pid <PID> --relaunch
#                                         (so ruft die App selbst das Skript nach „Neu starten“ auf)
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install-local.sh ist nur für macOS. Unter Windows/Linux: npm run dist:linux bzw. electron-builder." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

pull=0 build=1 install=1 relaunch=0 wait_pid=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pull) pull=1 ;;
    --build-only) install=0 ;;
    --no-build) build=0 ;;
    --relaunch) relaunch=1 ;;
    --wait-pid) wait_pid="$2"; shift ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
  shift
done

arch="$(uname -m)"; [ "$arch" = "x86_64" ] && arch="x64"
built="release/mac-$arch/Cable.app"
[ "$arch" = "x64" ] && built="release/mac/Cable.app"
target="/Applications/Cable.app"

if [ $pull -eq 1 ]; then
  echo "== git pull"
  git pull --ff-only
fi

if [ $build -eq 1 ]; then
  echo "== Bauen ($(git rev-parse --short HEAD 2>/dev/null || echo ohne git))"
  npx --no-install electron-builder --version >/dev/null
  npm run build:renderer
  npx --no-install electron-builder --mac dir "--$arch"
fi

[ -d "$built" ] || { echo "Kein Build unter $built" >&2; exit 1; }
[ $install -eq 1 ] || { echo "== Fertig gebaut: $built"; exit 0; }

if [ -n "$wait_pid" ]; then
  echo "== Warte, bis Cable (PID $wait_pid) beendet ist"
  for _ in $(seq 1 120); do kill -0 "$wait_pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$wait_pid" 2>/dev/null && { echo "Cable läuft noch – Abbruch" >&2; exit 1; }
elif pgrep -xq Cable; then
  echo "== Cable läuft – wird beendet, offene Verbindungen werden getrennt"
  relaunch=1
  osascript -e 'quit app "Cable"' || true
  for _ in $(seq 1 60); do pgrep -xq Cable || break; sleep 0.5; done
  pgrep -xq Cable && { echo "Cable wurde nicht beendet – Abbruch, nichts ersetzt" >&2; exit 1; }
fi

echo "== Installieren nach $target"
tmp="$(mktemp -d /Applications/.Cable-update.XXXXXX)"
ditto "$built" "$tmp/Cable.app"
xattr -dr com.apple.quarantine "$tmp/Cable.app" 2>/dev/null || true
codesign --force --deep -s - "$tmp/Cable.app"
rm -rf "$target"
mv "$tmp/Cable.app" "$target"
rmdir "$tmp"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target" >/dev/null 2>&1 || true
echo "== Installiert: $(defaults read "$target/Contents/Info" CFBundleShortVersionString)"

if [ $relaunch -eq 1 ]; then open "$target"; fi
