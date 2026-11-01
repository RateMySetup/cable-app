#!/usr/bin/env bash
# Überträgt den Stand von main aus dem privaten Repo (RateMySetup/cable) ins öffentliche Repo
# (RateMySetup/cable-app) – nur auf ausdrücklichen Wunsch.
#
#   npm run publish:public              Vorschau: Tests, Leak-Prüfung, geänderte Dateien; nichts wird gepusht
#   npm run publish:public -- --push    zusätzlich als ein Commit „Cable <Version>“ committen und pushen
#
# Was nie öffentlich wird, steht in .gitattributes als export-ignore (private/, z. B. die Perlen-Datei).
# Die Leak-Prüfung bricht ab, wenn ein Muster aus private/leak-patterns.txt im öffentlichen Stand vorkommt.
set -euo pipefail

cd "$(dirname "$0")/.."
PUBLIC_URL="https://github.com/RateMySetup/cable-app.git"
PUBLIC_DIR="${CABLE_PUBLIC_DIR:-$(cd .. && pwd)/cable-app}"
GREP=/usr/bin/grep
push=0
[ "${1:-}" = "--push" ] && push=1

[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Private Arbeitskopie hat ungespeicherte Änderungen – erst committen." >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "HEAD ist nicht origin/main – erst pushen bzw. pullen." >&2; exit 1; }
version="$(node -p "require('./package.json').version")"

echo "== Tests"
npm test --silent >/dev/null 2>&1 || { echo "npm test schlägt fehl – Abbruch." >&2; exit 1; }

echo "== Öffentlichen Stand aus $(git rev-parse --short HEAD) erzeugen"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git archive HEAD | tar -x -C "$tmp"
[ ! -e "$tmp/private" ] || { echo "private/ wäre öffentlich – .gitattributes prüfen." >&2; exit 1; }

echo "== Leak-Prüfung"
if hits="$($GREP -rInE -f private/leak-patterns.txt "$tmp" 2>/dev/null)"; then
  echo "$hits" | sed "s#$tmp/##" >&2
  echo "Leak-Prüfung: Treffer oben – nichts veröffentlicht." >&2
  exit 1
fi

if [ ! -d "$PUBLIC_DIR/.git" ]; then
  git clone -q "$PUBLIC_URL" "$PUBLIC_DIR"
  git -C "$PUBLIC_DIR" config user.name "$(git config user.name)"
  git -C "$PUBLIC_DIR" config user.email "$(git config user.email)"
fi
git -C "$PUBLIC_DIR" fetch -q origin
if git -C "$PUBLIC_DIR" rev-parse -q --verify origin/main >/dev/null; then
  git -C "$PUBLIC_DIR" checkout -q -B main origin/main
fi
rsync -a --delete --exclude .git "$tmp/" "$PUBLIC_DIR/"
git -C "$PUBLIC_DIR" add -A

if git -C "$PUBLIC_DIR" diff --cached --quiet; then
  echo "== Öffentliches Repo ist schon auf diesem Stand."
  exit 0
fi
echo "== Änderungen für cable-app (Cable $version)"
git -C "$PUBLIC_DIR" diff --cached --stat | tail -25

if [ $push -eq 0 ]; then
  git -C "$PUBLIC_DIR" reset -q
  git -C "$PUBLIC_DIR" checkout -q -- . 2>/dev/null || true
  git -C "$PUBLIC_DIR" clean -fdq
  echo "== Vorschau – nichts gepusht. Veröffentlichen: npm run publish:public -- --push"
  exit 0
fi

git -C "$PUBLIC_DIR" commit -q -m "Cable $version"
git -C "$PUBLIC_DIR" push -q origin HEAD:main
echo "== Veröffentlicht: $PUBLIC_URL ($(git -C "$PUBLIC_DIR" rev-parse --short HEAD))"
