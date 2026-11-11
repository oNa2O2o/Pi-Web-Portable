#!/bin/bash
# Pi Web Portable for macOS.
#   双击运行：启动 Pi Web 并打开浏览器（已经在运行时只打开浏览器）
#   "Pi Web.command" --stop      停止
#   "Pi Web.command" --restart   重启（Pi Web 里的「重启」按钮也走这里）
#   "Pi Web.command" --no-open   启动但不打开浏览器
#   PI_WEB_PORT=xxxx             换端口（默认 30141）
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${PI_WEB_PORT:-30141}"
HOST="127.0.0.1"
URL="http://$HOST:$PORT/"
NODE="$ROOT/runtime/node"
APP="$ROOT/app"
DATA="$ROOT/data"
LOGS="$ROOT/logs"
PIDF="$DATA/pi-web.pid"

mkdir -p "$DATA" "$LOGS"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGS/launcher.log"; }
say() { echo "$*"; log "$*"; }
alert() {
  say "$1"
  /usr/bin/osascript -e "display alert \"Pi Web\" message \"$1\" as critical" >/dev/null 2>&1 || true
}

# Files unpacked from a downloaded zip carry the quarantine flag; Gatekeeper would then
# refuse to load the bundled native modules (speech recognition). The user already
# approved this launcher, so clear the flag for the whole package once.
if [ ! -f "$DATA/.unquarantined" ]; then
  /usr/bin/xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true
  touch "$DATA/.unquarantined"
fi

healthy() { /usr/bin/curl -fs -m 3 -o /dev/null "http://$HOST:$PORT/api/agent/running"; }

stop_server() {
  [ -f "$PIDF" ] || return 0
  local pid
  pid="$(cat "$PIDF" 2>/dev/null)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    say "正在停止 Pi Web（PID $pid）…"
    # Plugin services are child processes. Skip ourselves: a restart started from the
    # web UI runs as a child of the server.
    for c in $(/usr/bin/pgrep -P "$pid" 2>/dev/null); do
      [ "$c" = "$$" ] || [ "$c" = "$PPID" ] || kill "$c" 2>/dev/null
    done
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$PIDF"
}

start_server() {
  local open_browser="$1"
  if healthy; then
    say "Pi Web 已经在运行：$URL"
    [ "$open_browser" = 1 ] && /usr/bin/open "$URL"
    return 0
  fi
  if [ ! -x "$NODE" ] || [ ! -f "$APP/bin/pi-web.js" ] || [ ! -f "$APP/.next/BUILD_ID" ]; then
    alert "便携包文件不完整，请重新下载。"
    return 2
  fi
  if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" != "1" ]; then
    alert "这个版本只支持 Apple 芯片（M1 及更新）的 Mac。"
    return 2
  fi

  local loader="$APP/plugins/piweb-plugin-loader.cjs"
  if [ -f "$loader" ]; then
    case "${NODE_OPTIONS:-}" in
      *piweb-plugin-loader*) ;;
      *) export NODE_OPTIONS="${NODE_OPTIONS:-} --require \"$loader\"" ;;
    esac
    export PIWEB_PLUGIN_LOG_DIR="$LOGS"
  fi
  export PI_WEB_INSTALL_ROOT="$ROOT"
  export PI_WEB_RESTART_COMMAND="sleep 1; \"$ROOT/Pi Web.command\" --restart --no-open --port=$PORT"
  export NEXT_TELEMETRY_DISABLED=1

  say "正在启动 Pi Web…"
  cd "$APP" || return 2
  # Detach into a new session so closing this Terminal window does not stop Pi Web.
  if [ -x /usr/bin/perl ]; then
    /usr/bin/nohup /usr/bin/perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die "exec: $!"' \
      "$NODE" "$APP/bin/pi-web.js" --port "$PORT" --hostname "$HOST" --no-open \
      >> "$LOGS/pi-web.stdout.log" 2>> "$LOGS/pi-web.stderr.log" < /dev/null &
  else
    /usr/bin/nohup "$NODE" "$APP/bin/pi-web.js" --port "$PORT" --hostname "$HOST" --no-open \
      >> "$LOGS/pi-web.stdout.log" 2>> "$LOGS/pi-web.stderr.log" < /dev/null &
  fi
  local pid=$!
  echo "$pid" > "$PIDF"
  log "Started Pi Web process $pid."

  for _ in $(seq 1 360); do
    if healthy; then
      say "Pi Web 已启动：$URL"
      say "可以关闭这个终端窗口，Pi Web 会继续在后台运行。"
      [ "$open_browser" = 1 ] && /usr/bin/open "$URL"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done
  tail -n 30 "$LOGS/pi-web.stderr.log" 2>/dev/null
  kill "$pid" 2>/dev/null
  rm -f "$PIDF"
  alert "Pi Web 没能启动，请查看 logs/pi-web.stderr.log。"
  return 3
}

action="start"
open_browser=1
for arg in "$@"; do
  case "$arg" in
    --stop) action="stop" ;;
    --restart) action="restart" ;;
    --no-open) open_browser=0 ;;
    --port=*) PORT="${arg#--port=}"; URL="http://$HOST:$PORT/" ;;
  esac
done

case "$action" in
  stop) stop_server ;;
  restart) stop_server; sleep 1; start_server "$open_browser" ;;
  *) start_server "$open_browser" ;;
esac
