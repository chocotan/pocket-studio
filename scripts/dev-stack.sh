#!/usr/bin/env bash
#
# One-click dev stack for Pocket Studio.
#
# Starts/stops the four local components:
#   - server  : Go backend (HTTP + WebSocket hub)   -> :$BACKEND_PORT
#   - daemon  : Go daemon, connects to the server   -> ws://localhost:$BACKEND_PORT/ws/daemon
#   - studio  : studio-frontend vite dev server     -> :5173  (proxies /api,/ws/* to backend)
#   - user    : user-frontend vite dev server       -> :5174
#
# NOTE: the backend default port 18080 is occupied on this machine by an
# unrelated Java gateway, so this stack uses 18081. The two vite configs
# (studio-frontend/vite.config.ts, user-frontend/vite.config.ts) are pinned to
# the same port. If you change BACKEND_PORT here, change those too.
#
# Usage:
#   scripts/dev-stack.sh start          # start everything (idempotent)
#   scripts/dev-stack.sh stop           # stop everything
#   scripts/dev-stack.sh restart        # stop then start
#   scripts/dev-stack.sh status         # show what is up
#   scripts/dev-stack.sh logs [name]    # tail logs (all, or one of: server daemon studio user)
#
# Env overrides:
#   PS_BACKEND_PORT (default 18081)
#   PS_ADMIN_TOKEN  (default dev_token)
#   PS_LOG_DIR      (default /tmp/ps-logs)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BACKEND_PORT="${PS_BACKEND_PORT:-18081}"
ADMIN_TOKEN="${PS_ADMIN_TOKEN:-dev_token}"
STUDIO_PORT=5173
USER_PORT=5174
SERVER_WS="ws://localhost:${BACKEND_PORT}/ws/daemon"

LOG_DIR="${PS_LOG_DIR:-/tmp/ps-logs}"
RUN_DIR="$LOG_DIR/run"
mkdir -p "$LOG_DIR" "$RUN_DIR"

# Workspaces exposed by the daemon. Add more lines as needed.
WORKSPACES=( "$HOME/Agent" )
[ -d "$ROOT" ] && WORKSPACES+=( "$ROOT" )

# ── colors ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
  G="\033[32m"; R="\033[31m"; Y="\033[33m"; C="\033[36m"; N="\033[0m"
else
  G=""; R=""; Y=""; C=""; N=""
fi
info() { echo -e "${C}==>${N} $*"; }
ok()   { echo -e "${G}ok ${N} $*"; }
warn() { echo -e "${Y}!! ${N} $*"; }
err()  { echo -e "${R}xx ${N} $*"; }

# ── low-level helpers ───────────────────────────────────────────────
port_up()   { ss -ltn 2>/dev/null | grep -q ":$1\b"; }
port_pids() { ss -ltnp 2>/dev/null | grep -oP ":$1\b.*pid=\K[0-9]+" | sort -u; }

# start_one <name> <workdir> <command...>
# Runs the command in its own process group so the whole tree can be killed.
start_one() {
  local name="$1" workdir="$2"; shift 2
  local pidfile="$RUN_DIR/$name.pid"
  local log="$LOG_DIR/$name.log"

  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    warn "$name already running (pid $(cat "$pidfile"))"
    return 0
  fi

  setsid bash -c "cd '$workdir' && exec $*" >"$log" 2>&1 &
  local pid=$!
  echo "$pid" > "$pidfile"
  ok "$name started (pid $pid) -> $log"
}

wait_port() {
  local port="$1" label="$2" tries="${3:-40}"
  for ((i=1; i<=tries; i++)); do
    port_up "$port" && { ok "$label listening on :$port"; return 0; }
    sleep 0.5
  done
  err "$label did not come up on :$port within $((tries/2))s — check $LOG_DIR"
  return 1
}

# stop_one <name> <fallback_port>
stop_one() {
  local name="$1" port="${2:-}"
  local pidfile="$RUN_DIR/$name.pid"
  local pid=""
  [ -f "$pidfile" ] && pid="$(cat "$pidfile")"

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    ok "$name stopped (pid $pid)"
  else
    warn "$name not tracked as running"
  fi
  rm -f "$pidfile"

  # fallback: anything still squatting the port (only our own processes)
  if [ -n "$port" ] && port_up "$port"; then
    local leftovers; leftovers="$(port_pids "$port")"
    if [ -n "$leftovers" ]; then
      warn "$name: killing leftover pid(s) on :$port -> $leftovers"
      kill -TERM $leftovers 2>/dev/null || true
    fi
  fi
}

# ── commands ────────────────────────────────────────────────────────
cmd_start() {
  info "starting Pocket Studio dev stack (backend :$BACKEND_PORT, token '$ADMIN_TOKEN')"

  if port_up "$BACKEND_PORT" && [ ! -f "$RUN_DIR/server.pid" ]; then
    err "port :$BACKEND_PORT is already taken by another process: $(port_pids "$BACKEND_PORT")"
    err "set PS_BACKEND_PORT to a free port (and update the vite configs), or free it first."
    return 1
  fi

  start_one server "$ROOT" \
    "go run ./cmd/server -server.addr :$BACKEND_PORT -server.admin-token $ADMIN_TOKEN"
  wait_port "$BACKEND_PORT" server || return 1

  local ws_args=()
  for w in "${WORKSPACES[@]}"; do ws_args+=( -daemon.workspace "$w" ); done
  start_one daemon "$ROOT" \
    "go run ./cmd/daemon -daemon.server.url $SERVER_WS -daemon.server.token $ADMIN_TOKEN ${ws_args[*]}"

  start_one studio "$ROOT/studio-frontend" "npm run dev"
  start_one user   "$ROOT/user-frontend"   "npm run dev"
  wait_port "$STUDIO_PORT" studio || true
  wait_port "$USER_PORT"   user   || true

  echo
  cmd_status
  echo
  ok  "Studio UI : http://localhost:$STUDIO_PORT/studio/?token=$ADMIN_TOKEN"
  ok  "User  UI  : http://localhost:$USER_PORT/user/"
}

cmd_stop() {
  info "stopping Pocket Studio dev stack"
  stop_one user   "$USER_PORT"
  stop_one studio "$STUDIO_PORT"
  stop_one daemon ""
  stop_one server "$BACKEND_PORT"
}

cmd_status() {
  printf "%-8s %-7s %s\n" "COMPONENT" "PORT" "STATUS"
  _row() { # name port
    local name="$1" port="$2" st
    if port_up "$port"; then st="${G}UP${N}   pid $(port_pids "$port" | tr '\n' ' ')"; else st="${R}DOWN${N}"; fi
    printf "%-8s %-7s %b\n" "$name" "$port" "$st"
  }
  _row server "$BACKEND_PORT"
  _row studio "$STUDIO_PORT"
  _row user   "$USER_PORT"
  # daemon has no listening port; check via the backend's project list
  local d
  d="$(curl -s -m 3 -H "Authorization: Bearer $ADMIN_TOKEN" \
        "http://localhost:$BACKEND_PORT/api/project/list" 2>/dev/null)"
  if echo "$d" | grep -q '"device_id"'; then
    printf "%-8s %-7s %b\n" "daemon" "-" "${G}CONNECTED${N} ($(echo "$d" | grep -oP '"device_id":"\K[^"]+' | sort -u | head -1))"
  else
    printf "%-8s %-7s %b\n" "daemon" "-" "${R}NOT CONNECTED${N}"
  fi
}

cmd_logs() {
  local name="${1:-}"
  case "$name" in
    server|daemon|studio|user) tail -n 60 -f "$LOG_DIR/$name.log" ;;
    ""|all) tail -n 20 -f "$LOG_DIR"/server.log "$LOG_DIR"/daemon.log "$LOG_DIR"/studio.log "$LOG_DIR"/user.log ;;
    *) err "unknown log '$name' (use: server|daemon|studio|user|all)"; return 2 ;;
  esac
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; echo; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs "${2:-}" ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs [server|daemon|studio|user]}"
    exit 2
    ;;
esac
