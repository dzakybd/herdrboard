#!/bin/sh
# Installs `hb` on PATH and runs `hb serve` as a launchd agent (idempotent).
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
LABEL=dev.dzaky.herdrboard
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUN=$(command -v bun)

cd "$REPO"
bun install --frozen-lockfile
bun link >/dev/null
mkdir -p "$HOME/.herdrboard" "$HOME/Library/LaunchAgents"
sed -e "s|__BUN__|$BUN|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
  launchd/$LABEL.plist > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if hb project list >/dev/null 2>&1; then
    echo "herdrboard is running: http://127.0.0.1:${HB_PORT:-7420}"
    exit 0
  fi
  sleep 1
done
echo "herdrboard did not come up; see ~/.herdrboard/serve.log" >&2
exit 1
