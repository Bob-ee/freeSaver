#!/bin/sh
# Install / remove a launchd user agent that keeps the TV's Developer Mode
# session alive (runs devmode-extend.mjs at login and once a day).
#
#   sh scripts/devmode-schedule.sh install
#   sh scripts/devmode-schedule.sh uninstall
#   sh scripts/devmode-schedule.sh status
set -eu

LABEL="com.freesaver.devmode-extend"
DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/devmode-extend.mjs"
PLIST="${PLIST_OUT:-$HOME/Library/LaunchAgents/$LABEL.plist}"
LOG="$HOME/Library/Logs/freesaver-devmode.log"
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
  </array>
  <key>WorkingDirectory</key><string>$DIR/..</string>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>15</integer></dict>
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
    echo "Installed $LABEL (runs at login and daily at 12:15). Log: $LOG"
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
