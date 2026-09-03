#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ojm.pi-leo-bridge"
CONFIG="${HOME}/.config/pi-leo-bridge/config.json"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
CHANNEL="stable"
PROFILE=""
PROVIDER=""
MODEL=""
DISPLAY_NAME=""
LEVELS=""
PRIMARY_LEVEL=""
PORT=""
CONTEXT_SIZE=""
ASSUME_YES=false
SKIP_VERIFY=false
ROTATE_TOKEN=false
CHANNEL_SET=false
PROFILE_SET=false

usage() {
  cat <<'EOF'
Usage: pi-leo install [options]

Options:
  --provider ID          Pi provider (default: openai-codex)
  --model ID             Pi model (default: gpt-5.6-sol)
  --name NAME            Display name used in Brave
  --levels LIST          Comma-separated levels (default: low,medium,high)
  --primary-level LEVEL  Unsuffixed/default profile (default: medium)
  --context-size TOKENS  Context cap advertised to Leo (default: 100000)
  --port PORT             Loopback port (default: 43127)
  --channel CHANNEL      stable, beta, or nightly
  --profile DIRECTORY    Brave profile directory, e.g. Default or "Profile 1"
  --yes                   Accept defaults without interactive questions
  --rotate-token          Replace the local capability token
  --skip-verify           Skip source-checkout dependency and test step
  -h, --help              Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="${2:?Missing provider}"; shift 2 ;;
    --model) MODEL="${2:?Missing model}"; shift 2 ;;
    --name) DISPLAY_NAME="${2:?Missing display name}"; shift 2 ;;
    --levels) LEVELS="${2:?Missing levels}"; shift 2 ;;
    --primary-level) PRIMARY_LEVEL="${2:?Missing primary level}"; shift 2 ;;
    --context-size) CONTEXT_SIZE="${2:?Missing context size}"; shift 2 ;;
    --port) PORT="${2:?Missing port}"; shift 2 ;;
    --channel) CHANNEL="${2:?Missing channel}"; CHANNEL_SET=true; shift 2 ;;
    --profile) PROFILE="${2:?Missing profile}"; PROFILE_SET=true; shift 2 ;;
    --yes) ASSUME_YES=true; shift ;;
    --rotate-token) ROTATE_TOKEN=true; shift ;;
    --skip-verify) SKIP_VERIFY=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This release currently supports macOS only." >&2
  exit 1
fi
for command in node npm python3 curl launchctl osascript lsof; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done
NODE_BIN="$(command -v node)"
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<19)){console.error("Node.js 22.19 or newer is required"); process.exit(1)}'
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else "Python 3.10 or newer is required")'

if [[ -f "$ROOT/src/index.ts" && "$SKIP_VERIFY" != true ]]; then
  echo "Verifying source checkout..."
  (cd "$ROOT" && npm ci && npm run typecheck && npm test)
elif [[ ! -f "$ROOT/dist/src/index.js" ]]; then
  echo "Packaged runtime is missing: $ROOT/dist/src/index.js" >&2
  exit 1
fi

# Reuse the browser target chosen by an existing installation unless overridden.
PREFERENCES=""
APP_NAME=""
if [[ -f "$CONFIG" && "$CHANNEL_SET" != true && "$PROFILE_SET" != true ]]; then
  EXISTING_TARGET="$(python3 - "$CONFIG" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]))
print(c.get('bravePreferencesPath',''))
print(c.get('braveApplicationName',''))
PY
)"
  PREFERENCES="$(printf '%s\n' "$EXISTING_TARGET" | sed -n '1p')"
  APP_NAME="$(printf '%s\n' "$EXISTING_TARGET" | sed -n '2p')"
fi
if [[ -z "$PREFERENCES" || -z "$APP_NAME" ]]; then
  case "$CHANNEL" in
    stable)
      USER_DATA="${HOME}/Library/Application Support/BraveSoftware/Brave-Browser"
      APP_NAME="Brave Browser"
      ;;
    beta)
      USER_DATA="${HOME}/Library/Application Support/BraveSoftware/Brave-Browser-Beta"
      APP_NAME="Brave Browser Beta"
      ;;
    nightly)
      USER_DATA="${HOME}/Library/Application Support/BraveSoftware/Brave-Browser-Nightly"
      APP_NAME="Brave Browser Nightly"
      ;;
    *) echo "Unsupported Brave channel: $CHANNEL" >&2; exit 2 ;;
  esac
  if [[ -z "$PROFILE" ]]; then
    PROFILE="$(python3 - "$USER_DATA" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1])
try:
    state=json.loads((root/'Local State').read_text())
    value=state.get('profile',{}).get('last_used','Default')
    print(value if isinstance(value,str) and value else 'Default')
except Exception:
    print('Default')
PY
)"
  fi
  if [[ "$PROFILE" == *"/"* || "$PROFILE" == "." || "$PROFILE" == ".." ]]; then
    echo "Invalid Brave profile directory: $PROFILE" >&2
    exit 2
  fi
  PREFERENCES="$USER_DATA/$PROFILE/Preferences"
fi

if [[ -f "$CONFIG" ]]; then
  INSTALLED_PREFERENCES="$(python3 - "$CONFIG" <<'PY'
import json,sys
print(json.load(open(sys.argv[1])).get('bravePreferencesPath',''))
PY
)"
  if [[ -n "$INSTALLED_PREFERENCES" && "$INSTALLED_PREFERENCES" != "$PREFERENCES" ]]; then
    echo "Changing Brave channels or profiles in place could leave an authenticated model in the old profile." >&2
    echo "Run 'pi-leo uninstall' first, then install again with the new --channel/--profile." >&2
    exit 1
  fi
fi

case "$APP_NAME" in
  "Brave Browser"|"Brave Browser Beta"|"Brave Browser Nightly") ;;
  *) echo "Unsupported Brave application name in configuration: $APP_NAME" >&2; exit 1 ;;
esac
if [[ -L "$(dirname "$PREFERENCES")" || -L "$PREFERENCES" ]]; then
  echo "Refusing to modify symbolic-linked Brave profile data." >&2
  exit 1
fi
if [[ ! -f "$PREFERENCES" ]]; then
  echo "Brave Preferences not found: $PREFERENCES" >&2
  echo "Use --channel and --profile to select the correct Brave profile." >&2
  exit 1
fi

if [[ ! -f "$CONFIG" && "$ASSUME_YES" != true && -t 0 && -t 1 ]]; then
  echo "Configure the Pi model used by Leo. Run 'pi-leo models' in another terminal to list available models."
  read -r -p "Pi provider [openai-codex]: " answer
  PROVIDER="${PROVIDER:-${answer:-openai-codex}}"
  read -r -p "Pi model [gpt-5.6-sol]: " answer
  MODEL="${MODEL:-${answer:-gpt-5.6-sol}}"
  read -r -p "Brave display name [automatic]: " answer
  DISPLAY_NAME="${DISPLAY_NAME:-$answer}"
  read -r -p "Thinking levels [low,medium,high]: " answer
  LEVELS="${LEVELS:-${answer:-low,medium,high}}"
fi

EXISTING_MODEL_INFO=""
if [[ -f "$CONFIG" ]]; then
  EXISTING_MODEL_INFO="$(python3 - "$CONFIG" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]))
print(c.get('provider',''))
print(c.get('modelId',''))
print(c.get('displayName',''))
print(c.get('contextSize',''))
print(c.get('port',''))
PY
)"
fi
EXISTING_PROVIDER="$(printf '%s\n' "$EXISTING_MODEL_INFO" | sed -n '1p')"
EXISTING_MODEL="$(printf '%s\n' "$EXISTING_MODEL_INFO" | sed -n '2p')"
EXISTING_DISPLAY_NAME="$(printf '%s\n' "$EXISTING_MODEL_INFO" | sed -n '3p')"
EXISTING_CONTEXT_SIZE="$(printf '%s\n' "$EXISTING_MODEL_INFO" | sed -n '4p')"
EXISTING_PORT="$(printf '%s\n' "$EXISTING_MODEL_INFO" | sed -n '5p')"
if [[ -n "$PROVIDER" && -z "$MODEL" && -n "$EXISTING_PROVIDER" && "$PROVIDER" != "$EXISTING_PROVIDER" ]]; then
  echo "--model is required when changing --provider." >&2
  exit 2
fi
EFFECTIVE_PROVIDER="${PROVIDER:-${EXISTING_PROVIDER:-openai-codex}}"
EFFECTIVE_MODEL="${MODEL:-${EXISTING_MODEL:-gpt-5.6-sol}}"
EFFECTIVE_PORT="${PORT:-${EXISTING_PORT:-43127}}"
if [[ ! "$EFFECTIVE_PORT" =~ ^[0-9]+$ ]] || (( EFFECTIVE_PORT < 1024 || EFFECTIVE_PORT > 65535 )); then
  echo "Port must be an integer between 1024 and 65535." >&2
  exit 2
fi
MODEL_INFO="$(node "$ROOT/dist/src/check-model.js" "$EFFECTIVE_PROVIDER" "$EFFECTIVE_MODEL")"
MODEL_FIELDS="$(printf '%s' "$MODEL_INFO" | python3 -c 'import json,sys; m=json.load(sys.stdin); print(m["name"]); print(m["contextWindow"]); print(str(m["reasoning"]).lower()); print(str(m["vision"]).lower())')"
MODEL_DISPLAY_NAME="$(printf '%s\n' "$MODEL_FIELDS" | sed -n '1p')"
MODEL_CONTEXT_WINDOW="$(printf '%s\n' "$MODEL_FIELDS" | sed -n '2p')"
MODEL_REASONING="$(printf '%s\n' "$MODEL_FIELDS" | sed -n '3p')"
MODEL_VISION="$(printf '%s\n' "$MODEL_FIELDS" | sed -n '4p')"
echo "Validated Pi model: $EFFECTIVE_PROVIDER/$EFFECTIVE_MODEL (context $MODEL_CONTEXT_WINDOW)"
PROVIDER="$EFFECTIVE_PROVIDER"
MODEL="$EFFECTIVE_MODEL"
PORT="$EFFECTIVE_PORT"
if [[ -z "$DISPLAY_NAME" && ( -z "$EXISTING_MODEL" || "$MODEL" != "$EXISTING_MODEL" || -z "$EXISTING_DISPLAY_NAME" ) ]]; then
  DISPLAY_NAME="$MODEL_DISPLAY_NAME"
fi
if [[ -z "$CONTEXT_SIZE" ]]; then
  CONTEXT_SIZE="${EXISTING_CONTEXT_SIZE:-100000}"
fi
if [[ ! "$CONTEXT_SIZE" =~ ^[0-9]+$ || ! "$MODEL_CONTEXT_WINDOW" =~ ^[0-9]+$ ]]; then
  echo "Context sizes must be integers." >&2
  exit 2
fi
if (( CONTEXT_SIZE > MODEL_CONTEXT_WINDOW )); then
  CONTEXT_SIZE="$MODEL_CONTEXT_WINDOW"
fi
if [[ "$MODEL_REASONING" != true && -z "$LEVELS" ]]; then
  LEVELS="off"
  PRIMARY_LEVEL="off"
fi

CONFIGURE_ARGS=(
  --project "$ROOT"
  --node "$NODE_BIN"
  --preferences "$PREFERENCES"
  --app-name "$APP_NAME"
  --vision-support "$MODEL_VISION"
)
[[ -n "$PROVIDER" ]] && CONFIGURE_ARGS+=(--provider "$PROVIDER")
[[ -n "$MODEL" ]] && CONFIGURE_ARGS+=(--model "$MODEL")
[[ -n "$DISPLAY_NAME" ]] && CONFIGURE_ARGS+=(--display-name "$DISPLAY_NAME")
[[ -n "$LEVELS" ]] && CONFIGURE_ARGS+=(--levels "$LEVELS")
[[ -n "$PRIMARY_LEVEL" ]] && CONFIGURE_ARGS+=(--primary-level "$PRIMARY_LEVEL")
[[ -n "$PORT" ]] && CONFIGURE_ARGS+=(--port "$PORT")
[[ -n "$CONTEXT_SIZE" ]] && CONFIGURE_ARGS+=(--context-size "$CONTEXT_SIZE")
[[ "$ROTATE_TOKEN" == true ]] && CONFIGURE_ARGS+=(--rotate-token)

WAS_RUNNING=false
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  WAS_RUNNING=true
fi
ROLLBACK_DIR=""
CHANGES_STARTED=false
INSTALL_SUCCEEDED=false
HAD_CONFIG=false
HAD_PLIST=false
HAD_BIN_LINK=false
HAD_LOADED=false
BIN_LINK="${HOME}/.local/bin/pi-leo"
if [[ -e "$BIN_LINK" && ! -L "$BIN_LINK" ]]; then
  echo "Refusing to replace non-symlink command: $BIN_LINK" >&2
  exit 1
fi
if launchctl print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then
  HAD_LOADED=true
fi

finish_install() {
  local status=$?
  trap - EXIT
  if [[ "$CHANGES_STARTED" == true && "$INSTALL_SUCCEEDED" != true && -n "$ROLLBACK_DIR" ]]; then
    echo "Installation failed; restoring the previous bridge and Brave configuration." >&2
    launchctl bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
    cp -p "$ROLLBACK_DIR/Preferences" "$PREFERENCES" || true
    if [[ "$HAD_CONFIG" == true ]]; then
      mkdir -p "$(dirname "$CONFIG")"
      cp -p "$ROLLBACK_DIR/config.json" "$CONFIG" || true
    else
      rm -f "$CONFIG"
    fi
    if [[ "$HAD_PLIST" == true ]]; then
      mkdir -p "$(dirname "$PLIST")"
      cp -p "$ROLLBACK_DIR/launch-agent.plist" "$PLIST" || true
    else
      rm -f "$PLIST"
    fi
    rm -f "$BIN_LINK"
    if [[ "$HAD_BIN_LINK" == true ]]; then
      cp -P "$ROLLBACK_DIR/pi-leo-link" "$BIN_LINK" || true
    fi
    if [[ "$HAD_LOADED" == true && "$HAD_PLIST" == true ]]; then
      launchctl bootstrap "gui/${UID}" "$PLIST" >/dev/null 2>&1 || true
      launchctl enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
    fi
  fi
  [[ -z "$ROLLBACK_DIR" ]] || rm -rf "$ROLLBACK_DIR"
  if [[ "$WAS_RUNNING" == true ]]; then
    open -a "$APP_NAME" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap finish_install EXIT

if [[ "$WAS_RUNNING" == true ]]; then
  echo "Quitting $APP_NAME briefly to update its model list..."
  for _ in 1 2 3; do
    osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
      sleep 0.5
    done
    pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
  done
  if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
    echo "$APP_NAME did not quit within 30 seconds; no preferences were changed." >&2
    exit 1
  fi
fi

ROLLBACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-leo-install.XXXXXX")"
cp -p "$PREFERENCES" "$ROLLBACK_DIR/Preferences"
cmp -s "$PREFERENCES" "$ROLLBACK_DIR/Preferences"
if [[ -f "$CONFIG" ]]; then
  HAD_CONFIG=true
  cp -p "$CONFIG" "$ROLLBACK_DIR/config.json"
fi
if [[ -f "$PLIST" ]]; then
  HAD_PLIST=true
  cp -p "$PLIST" "$ROLLBACK_DIR/launch-agent.plist"
fi
if [[ -L "$BIN_LINK" ]]; then
  HAD_BIN_LINK=true
  cp -P "$BIN_LINK" "$ROLLBACK_DIR/pi-leo-link"
fi
CHANGES_STARTED=true

# Stop the prior managed process before trusting the port. A listener that
# remains cannot masquerade as this installation's public health endpoint.
launchctl bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
for _ in $(seq 1 50); do
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already used by another service." >&2
  exit 1
fi

python3 "$ROOT/scripts/configure-install.py" "${CONFIGURE_ARGS[@]}"

mkdir -p "${HOME}/.local/bin"
ln -sfn "$ROOT/bin/pi-leo" "$BIN_LINK"

launchctl bootstrap "gui/${UID}" "$PLIST"
launchctl enable "gui/${UID}/${LABEL}"

HEALTH_URL="$(python3 - "$CONFIG" "$PREFERENCES" <<'PY'
import hashlib,json,re,sys
config=json.load(open(sys.argv[1]))
preferences=json.load(open(sys.argv[2]))
keys=set(config.get('braveModelKeys',[]))
models=preferences.get('brave',{}).get('ai_chat',{}).get('custom_models',[])
pattern=re.compile(r'^(http://127\.0\.0\.1:\d+/auth/([A-Za-z0-9_-]{32,}))/v1/chat/completions$')
for model in models:
    if not isinstance(model,dict) or model.get('key') not in keys:
        continue
    match=pattern.match(str(model.get('endpoint_url','')))
    if match and hashlib.sha256(match.group(2).encode()).hexdigest()==config.get('tokenSha256'):
        print(f"{match.group(1)}/healthz")
        break
else:
    raise SystemExit('Could not recover the managed health capability')
PY
)"
managed_listener_matches() {
  local service_pid
  service_pid="$(launchctl print "gui/${UID}/${LABEL}" 2>/dev/null \
    | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
  [[ "$service_pid" =~ ^[0-9]+$ ]] || return 1
  lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -qx "$service_pid"
}

healthy=false
for _ in $(seq 1 90); do
  if managed_listener_matches \
    && payload="$(curl --fail --silent --max-time 2 "$HEALTH_URL" 2>/dev/null)" \
    && printf '%s' "$payload" | python3 -c 'import json,sys; p=json.load(sys.stdin); assert p.get("service")=="pi-leo-bridge" and p.get("status")=="ok"' 2>/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  echo "The bridge did not become healthy on its LaunchAgent-owned socket. Recent errors:" >&2
  tail -n 30 "${HOME}/Library/Logs/pi-leo-bridge.error.log" 2>/dev/null || true
  exit 1
fi

INSTALL_SUCCEEDED=true

echo
echo "Pi Leo bridge installed and healthy."
echo "Choose one of the new Pi profiles in Leo's model picker."
echo "Commands: pi-leo status | restart | doctor | logs | smoke-test | uninstall"
