#!/bin/sh
# Install / remove a launchd user agent that keeps the freeSaver photo server
# (photo-server.mjs) running whenever you are logged in; it restarts if it stops.
#
#   sh scripts/photo-server-schedule.sh install
#   sh scripts/photo-server-schedule.sh uninstall
#   sh scripts/photo-server-schedule.sh status
#
# Optional: PHOTO_PORT=9000 sh scripts/photo-server-schedule.sh install
set -eu

LABEL="com.freesaver.photos"
DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/photo-server.mjs"
PORT="${PHOTO_PORT:-8377}"
PLIST="${PLIST_OUT:-$HOME/Library/LaunchAgents/$LABEL.plist}"
LOG="$HOME/Library/Logs/freesaver-photos.log"
DOMAIN="gui/$(id -u)"

write_plist() {
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || { echo "node not found in PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SCRIPT</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR/..</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
}

case "${1:-}" in
  install)
    write_plist
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed $LABEL on port $PORT. Log: $LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "$LABEL: loaded"
    else
      echo "$LABEL: not loaded"
    fi
    if [ -f "$LOG" ]; then echo "--- last log lines ($LOG)"; tail -n 8 "$LOG"; fi
    ;;
  *)
    echo "usage: sh $0 install|uninstall|status" >&2
    exit 2
    ;;
esac
