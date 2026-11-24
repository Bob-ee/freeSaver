#!/bin/sh
# One-time pairing with the TV. Run after Developer Mode is on and
# "Key Server" is switched on in the TV's Developer Mode app.
#   npm run tv:setup -- <TV IP address>
set -e
IP="$1"
if [ -z "$IP" ]; then
  echo "Usage: npm run tv:setup -- <TV IP address>   (shown in the TV's Developer Mode app)"
  exit 1
fi
BIN="$(dirname "$0")/../node_modules/.bin"

"$BIN/ares-setup-device" --remove tv >/dev/null 2>&1 || true
"$BIN/ares-setup-device" --add tv -i "host=$IP" -i "port=9922" -i "username=prisoner"
echo
printf "Passphrase shown in the TV's Developer Mode app: "
read PASS
printf '%s\n' "$PASS" | "$BIN/ares-novacom" --device tv --getkey >/dev/null
"$BIN/ares-setup-device" --modify tv -i "privateKey=tv_webos" -i "passphrase=$PASS" >/dev/null
"$BIN/ares-device" --system-info --device tv
