#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ojm.pi-leo-bridge"
CONFIG="${HOME}/.config/pi-leo-bridge/config.json"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
ASSUME_YES=false
PURGE=false

usage() {
  cat <<'EOF'
Usage: pi-leo uninstall [--yes] [--purge]

Stops and removes the LaunchAgent and removes models managed by this bridge
from Brave after creating a verified Preferences backup.

  --yes          Do not ask for confirmation
  --purge        Also remove bridge workspace and logs
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) ASSUME_YES=true; shift ;;
    --purge) PURGE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$ASSUME_YES" != true && -t 0 ]]; then
  read -r -p "Remove the Pi Leo service and its managed Brave models? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 0 ;; esac
fi

WAS_RUNNING=false
RELAUNCHED=false
APP_NAME="Brave Browser"
PREFERENCES=""
if [[ -f "$CONFIG" ]]; then
  TARGET="$(python3 - "$CONFIG" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]))
print(c.get('bravePreferencesPath',''))
print(c.get('braveApplicationName','Brave Browser'))
PY
)"
  PREFERENCES="$(printf '%s\n' "$TARGET" | sed -n '1p')"
  APP_NAME="$(printf '%s\n' "$TARGET" | sed -n '2p')"
fi

if [[ -f "$CONFIG" && ( -z "$PREFERENCES" || ! -f "$PREFERENCES" ) ]]; then
  echo "Configured Brave Preferences could not be found; refusing to orphan authenticated model entries." >&2
  echo "Expected: ${PREFERENCES:-<missing from configuration>}" >&2
  exit 1
fi

WAS_LOADED=false
UNINSTALL_SUCCEEDED=false
if launchctl print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then
  WAS_LOADED=true
fi
launchctl bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true

relaunch_if_needed() {
  if [[ "$UNINSTALL_SUCCEEDED" != true && "$WAS_LOADED" == true && -f "$PLIST" ]]; then
    launchctl bootstrap "gui/${UID}" "$PLIST" >/dev/null 2>&1 || true
    launchctl enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
  fi
  if [[ "$WAS_RUNNING" == true && "$RELAUNCHED" == false ]]; then
    open -a "$APP_NAME" >/dev/null 2>&1 || true
  fi
}
trap relaunch_if_needed EXIT

if [[ -f "$CONFIG" ]]; then
  if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
    WAS_RUNNING=true
    echo "Quitting $APP_NAME briefly to remove the managed model entries..."
    for _ in 1 2 3; do
      osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
      for _ in $(seq 1 20); do
        pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
        sleep 0.5
      done
      pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
    done
    if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
      echo "$APP_NAME did not quit; Brave Preferences were not changed." >&2
      exit 1
    fi
  fi
  python3 "$ROOT/scripts/remove-brave-models.py" \
    --config "$CONFIG" \
    --preferences "$PREFERENCES"
fi

rm -f "$PLIST"
rm -f "$CONFIG"
rmdir "${HOME}/.config/pi-leo-bridge" >/dev/null 2>&1 || true

BIN_LINK="${HOME}/.local/bin/pi-leo"
if [[ -L "$BIN_LINK" ]]; then
  LINK_TARGET="$(python3 - "$BIN_LINK" <<'PY'
import sys
from pathlib import Path
print(Path(sys.argv[1]).resolve())
PY
)"
  if [[ "$LINK_TARGET" == "$ROOT/bin/pi-leo" ]]; then
    rm -f "$BIN_LINK"
  fi
fi

if [[ "$PURGE" == true ]]; then
  rm -rf "${HOME}/.local/share/pi-leo-bridge"
  rm -f \
    "${HOME}/Library/Logs/pi-leo-bridge.log" \
    "${HOME}/Library/Logs/pi-leo-bridge.error.log"
fi

UNINSTALL_SUCCEEDED=true
if [[ "$WAS_RUNNING" == true ]]; then
  open -a "$APP_NAME"
  RELAUNCHED=true
fi
trap - EXIT

echo "Pi Leo bridge uninstalled."
if [[ "$PURGE" != true ]]; then
  echo "Workspace and logs were retained; use --purge to remove them."
fi
