#!/usr/bin/env bash
# Prove whether native Wayland fullscreen apps appear in XWayland's window list (#1369).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

fail() {
  log_error "$@"
  [ -n "${FIDGET_LOG:-}" ] && [ -f "$FIDGET_LOG" ] && tail -40 "$FIDGET_LOG" >&2
  exit 1
}

for tool in weston Xwayland weston-simple-shm xterm xprop openbox; do
  command -v "$tool" > /dev/null || fail "$tool not found"
done

cd "$WORKSPACE_ROOT"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT=".verify/fullscreen-wayland-native-xwayland-$STAMP"
mkdir -p "$OUT"
WESTON_LOG="$OUT/weston.log"
FIDGET_LOG="$OUT/fidget.log"
NATIVE_LOG="$OUT/native.log"
XTERM_LOG="$OUT/xterm.log"
OPENBOX_LOG="$OUT/openbox.log"

WESTON_PID=""
OPENBOX_PID=""
FIDGET_PID=""
NATIVE_PID=""
XTERM_PID=""

cleanup() {
  log_info "Cleaning up..."
  for pid in "$XTERM_PID" "$NATIVE_PID" "$FIDGET_PID" "$OPENBOX_PID" "$WESTON_PID"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}

trap cleanup EXIT

XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
export XDG_RUNTIME_DIR
WESTON_SOCKET="weston-${STAMP}"

log_info "Starting weston headless with XWayland..."
weston --backend=headless-backend.so --width=1920 --height=1080 --xwayland --socket="$WESTON_SOCKET" > "$WESTON_LOG" 2>&1 &
WESTON_PID=$!
export WAYLAND_DISPLAY="$WESTON_SOCKET"

log_info "Waiting for weston..."
for _ in $(seq 1 60); do
  [ -e "$XDG_RUNTIME_DIR/$WESTON_SOCKET" ] && break
  sleep 0.25
done
[ -e "$XDG_RUNTIME_DIR/$WESTON_SOCKET" ] || fail "Weston socket not found"

log_info "Waiting for XWayland..."
for _ in $(seq 1 60); do
  for display in $(seq 0 20); do
    if [ -e "/tmp/.X11-unix/X${display}" ]; then
      export DISPLAY=":${display}"
      log_info "XWayland started on DISPLAY=$DISPLAY"
      break 2
    fi
  done
  sleep 0.25
done
[ -n "$DISPLAY" ] || fail "XWayland not found"

log_info "Starting openbox window manager on $DISPLAY..."
DISPLAY="$DISPLAY" openbox > "$OPENBOX_LOG" 2>&1 &
OPENBOX_PID=$!
for _ in $(seq 1 40); do
  DISPLAY="$DISPLAY" xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id' && break
  sleep 0.25
done
DISPLAY="$DISPLAY" xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id' || fail "Openbox did not start"
log_info "Openbox started"

BIN="${FIDGET_VERIFY_BIN:-$WORKSPACE_ROOT/target/debug/fidget}"
[ -x "$BIN" ] || fail "fidget binary not found at $BIN"

get_window_count() {
  DISPLAY="$DISPLAY" xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -oE '0x[0-9a-fA-F]+' | wc -l | tr -d ' '
}

BASELINE_BEFORE_FIDGET=$(get_window_count)
log_info "Before fidget: $BASELINE_BEFORE_FIDGET X11 windows"

log_info "Starting fidget under XWayland..."
HOME_DIR="$OUT/home"
mkdir -p "$HOME_DIR"
stdbuf -oL -eL env -u FIDGET_DIRECTOR_API_KEY \
  HOME="$HOME_DIR" \
  DISPLAY="$DISPLAY" \
  WAYLAND_DISPLAY="$WESTON_SOCKET" \
  FIDGET_TRACE_FRAMES=1 \
  FIDGET_CAPTURABLE=1 \
  FIDGET_CHARACTER=timber-wolf \
  FIDGET_CHARACTERS="${FIDGET_CHARACTERS:-$WORKSPACE_ROOT/characters}" \
  GDK_BACKEND=x11 \
  LIBGL_ALWAYS_SOFTWARE=1 \
  "$BIN" > "$FIDGET_LOG" 2>&1 &
FIDGET_PID=$!

log_info "Waiting for fidget window to appear in _NET_CLIENT_LIST..."
for _ in $(seq 1 80); do
  CUR=$(get_window_count)
  if [ "$CUR" -gt "$BASELINE_BEFORE_FIDGET" ]; then
    log_info "Fidget window appeared"
    break
  fi
  sleep 0.25
done

BASELINE_WINDOWS=$(get_window_count)
if [ "$BASELINE_WINDOWS" -le "$BASELINE_BEFORE_FIDGET" ]; then
  fail "Fidget window never appeared in X11 client list"
fi
log_info "Baseline with fidget: $BASELINE_WINDOWS X11 windows"
sleep 1

log_info "Starting native Wayland client (weston-simple-shm)..."
DISPLAY="" WAYLAND_DISPLAY="$WESTON_SOCKET" weston-simple-shm > "$NATIVE_LOG" 2>&1 &
NATIVE_PID=$!
sleep 2

if kill -0 "$NATIVE_PID" 2>/dev/null; then
  NATIVE_WINDOWS=$(get_window_count)
  log_info "With native client: $NATIVE_WINDOWS X11 windows"
  kill "$NATIVE_PID" 2>/dev/null || true
  NATIVE_PID=""
else
  log_warn "Native client exited early"
  NATIVE_WINDOWS="$BASELINE_WINDOWS"
fi

sleep 1

log_info "Starting XWayland client (xterm)..."
DISPLAY="$DISPLAY" xterm -e "sleep 10" > "$XTERM_LOG" 2>&1 &
XTERM_PID=$!

for _ in $(seq 1 60); do
  CUR=$(get_window_count)
  [ "$CUR" -gt "$BASELINE_WINDOWS" ] && break
  sleep 0.25
done

XTERM_WINDOWS=$(get_window_count)
log_info "With XWayland client: $XTERM_WINDOWS X11 windows"

log_info ""
log_info "=== Results ==="
log_info "Baseline (fidget only): $BASELINE_WINDOWS windows"
log_info "Native Wayland client: $NATIVE_WINDOWS windows ($([ "$NATIVE_WINDOWS" -gt "$BASELINE_WINDOWS" ] && echo APPEARED || echo NOT IN LIST))"
log_info "XWayland client: $XTERM_WINDOWS windows ($([ "$XTERM_WINDOWS" -gt "$BASELINE_WINDOWS" ] && echo APPEARED || echo NOT IN LIST))"
log_info ""

if [ "$NATIVE_WINDOWS" -eq "$BASELINE_WINDOWS" ] && [ "$XTERM_WINDOWS" -gt "$BASELINE_WINDOWS" ]; then
  log_info "✓ CONFIRMED: Native Wayland apps invisible to XWayland, X clients visible"
  echo "RESULT: CONFIRMED"
  exit 0
elif [ "$NATIVE_WINDOWS" -gt "$BASELINE_WINDOWS" ]; then
  log_error "✗ REFUTED: Native client appeared in X11 list"
  echo "RESULT: REFUTED"
  exit 1
else
  log_warn "? INCONCLUSIVE: Could not verify both client types"
  echo "RESULT: INCONCLUSIVE"
  exit 2
fi
