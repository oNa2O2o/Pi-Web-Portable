#!/bin/bash
# Smoke test for the macOS portable package:
#   scripts/test-portable-mac.sh <package-dir> [port]
# Starts it through "Pi Web.command", checks HTTP, the bundled Node.js, voice input and
# the model-health service, then stops it.
set -euo pipefail
PKG="$(cd "$1" && pwd)"
PORT="${2:-31879}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$PKG/runtime/node"

if /usr/bin/curl -fs -m 2 -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "Port $PORT is already in use; refusing to run." >&2; exit 1
fi
"$NODE" --version
cleanup() { "$PKG/Pi Web.command" --stop --port="$PORT" || true; }
trap cleanup EXIT

if ! PI_WEB_PORT="$PORT" "$PKG/Pi Web.command" --no-open; then
  tail -n 80 "$PKG/logs/pi-web.stderr.log" 2>/dev/null || true
  exit 1
fi
code="$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")"
[ "$code" = 200 ] || { echo "HTTP $code"; tail -n 80 "$PKG/logs/pi-web.stderr.log"; exit 1; }

pid="$(cat "$PKG/data/pi-web.pid")"
exe="$(ps -o comm= -p "$pid")"
[ "$exe" = "$NODE" ] || { echo "Wrong Node.js runtime: $exe"; exit 1; }

"$NODE" "$SRC/scripts/verify-voice-input.mjs" "$PORT"
"$NODE" "$SRC/scripts/verify-model-health.mjs" "$PORT"
"$NODE" "$SRC/scripts/verify-resend-model.mjs" "$PKG/app"
echo "macOS portable smoke test passed (PID $pid)"
