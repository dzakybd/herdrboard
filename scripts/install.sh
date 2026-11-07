#!/bin/sh
# Installs `hb` on PATH and runs `hb serve` as a service (idempotent):
# a launchd agent on macOS, a systemd user unit on Linux.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
LABEL=dev.dzaky.herdrboard
BUN=$(command -v bun)

case "$(uname -s)" in
  Darwin | Linux) ;;
  *)
    echo "herdrboard install supports macOS (launchd) and Linux (systemd) only, not $(uname -s)" >&2
    exit 1
    ;;
esac

cd "$REPO"
bun install --frozen-lockfile
bun link >/dev/null
mkdir -p "$HOME/.herdrboard"

render() {
  sed -e "s|__BUN__|$BUN|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" "$1"
}

if [ "$(uname -s)" = Darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  render launchd/$LABEL.plist > "$PLIST"

  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  render systemd/$LABEL.service > "$UNIT_DIR/$LABEL.service"

  systemctl --user daemon-reload
  systemctl --user enable --now "$LABEL.service"
  systemctl --user restart "$LABEL.service"
  echo "To keep it running after you log out: sudo loginctl enable-linger $(id -un)"
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if hb project list >/dev/null 2>&1; then
    echo "herdrboard is running: http://127.0.0.1:${HB_PORT:-7320}"
    exit 0
  fi
  sleep 1
done
echo "herdrboard did not come up; see ~/.herdrboard/serve.log" >&2
exit 1
