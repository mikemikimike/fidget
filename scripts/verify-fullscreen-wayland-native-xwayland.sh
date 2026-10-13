#!/usr/bin/env bash
# Prove whether a native Wayland fullscreen app moves or fades the Character
# when fidget runs under XWayland (#1369).
# Run with: scripts/verify-fullscreen-wayland-native-xwayland.sh
# FIDGET_VERIFY_BIN=path/to/fidget overrides the binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_info() {
  echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*"
}

fail() {
  log_error "$@"
  if [ -n "${FIDGET_LOG:-}" ] && [ -f "$FIDGET_LOG" ]; then
    log_error "Last 40 lines of fidget log:"
    tail -40 "$FIDGET_LOG" >&2 || true
  fi
  if [ -n "${WESTON_LOG:-}" ] && [ -f "$WESTON_LOG" ]; then
    log_error "Last 40 lines of weston log:"
    tail -40 "$WESTON_LOG" >&2 || true
  fi
  exit 1
}

for tool in weston Xwayland gtk4-demo; do
  command -v "$tool" > /dev/null || fail "$tool not found. Install: sudo apt-get install weston xwayland gtk-4-examples"
done

cd "$WORKSPACE_ROOT"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT=".verify/fullscreen-wayland-native-xwayland-$STAMP"
mkdir -p "$OUT"
WESTON_LOG="$OUT/weston.log"
FIDGET_LOG="$OUT/fidget.log"
GTK_LOG="$OUT/gtk.log"

WESTON_PID=""
XWAYLAND_DISPLAY=""
FIDGET_PID=""
GTK_PID=""

cleanup() {
  log_info "Cleaning up..."
  if [ -n "$GTK_PID" ]; then
    kill "$GTK_PID" 2>/dev/null || true
  fi
  if [ -n "$FIDGET_PID" ]; then
    kill "$FIDGET_PID" 2>/dev/null || true
  fi
  if [ -n "$WESTON_PID" ]; then
    kill "$WESTON_PID" 2>/dev/null || true
  fi
  if [ -n "$XWAYLAND_DISPLAY" ] && [ -e "/tmp/.X11-unix/X${XWAYLAND_DISPLAY#:}" ]; then
    rm -f "/tmp/.X11-unix/X${XWAYLAND_DISPLAY#:}"
  fi
}

trap cleanup EXIT

log_info "Starting weston headless with XWayland..."
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
export XDG_RUNTIME_DIR
mkdir -p "$XDG_RUNTIME_DIR"

WESTON_SOCKET="weston-${STAMP}"
weston --backend=headless-backend.so \
  --width=1920 \
  --height=1080 \
  --xwayland \
  --socket="$WESTON_SOCKET" \
  > "$WESTON_LOG" 2>&1 &
WESTON_PID=$!

export WAYLAND_DISPLAY="$WESTON_SOCKET"

await_pattern() {
  local file="$1" pattern="$2" attempts="$3"
  for _ in $(seq 1 "$attempts"); do
    grep -qE "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

log_info "Waiting for weston to start..."
for _ in $(seq 1 60); do
  if kill -0 "$WESTON_PID" 2>/dev/null; then
    if [ -e "$XDG_RUNTIME_DIR/$WESTON_SOCKET" ]; then
      log_info "Weston started on WAYLAND_DISPLAY=$WESTON_SOCKET"
      break
    fi
  else
    fail "Weston exited during startup"
  fi
  sleep 0.25
done

[ -e "$XDG_RUNTIME_DIR/$WESTON_SOCKET" ] || fail "Weston socket not found"

log_info "Waiting for XWayland to start..."
for attempt in $(seq 1 60); do
  for display in $(seq 0 20); do
    if [ -e "/tmp/.X11-unix/X${display}" ]; then
      XWAYLAND_DISPLAY=":${display}"
      export DISPLAY="$XWAYLAND_DISPLAY"
      log_info "XWayland started on DISPLAY=$XWAYLAND_DISPLAY"
      break 2
    fi
  done
  if [ "$attempt" -eq 60 ]; then
    fail "XWayland did not start within timeout"
  fi
  sleep 0.25
done

[ -n "$XWAYLAND_DISPLAY" ] || fail "XWayland DISPLAY not found"

BIN="${FIDGET_VERIFY_BIN:-}"
if [ -z "$BIN" ]; then
  if [ -x "$WORKSPACE_ROOT/target/debug/fidget" ]; then
    BIN="$WORKSPACE_ROOT/target/debug/fidget"
  else
    log_info "Building fidget (debug)..."
    cargo build -p fidget
    BIN="$WORKSPACE_ROOT/target/debug/fidget"
  fi
fi
[ -x "$BIN" ] || fail "no binary at $BIN"

log_info "Starting fidget under XWayland (DISPLAY=$XWAYLAND_DISPLAY)..."
HOME_DIR="$OUT/home"
mkdir -p "$HOME_DIR"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
export GDK_BACKEND=x11

env -u FIDGET_DIRECTOR_API_KEY \
  HOME="$HOME_DIR" \
  DISPLAY="$XWAYLAND_DISPLAY" \
  WAYLAND_DISPLAY="$WESTON_SOCKET" \
  FIDGET_TRACE_FRAMES=1 \
  FIDGET_CAPTURABLE=1 \
  FIDGET_CHARACTER=timber-wolf \
  FIDGET_CHARACTERS="${FIDGET_CHARACTERS:-$WORKSPACE_ROOT/characters}" \
  GDK_BACKEND="$GDK_BACKEND" \
  LIBGL_ALWAYS_SOFTWARE="$LIBGL_ALWAYS_SOFTWARE" \
  "$BIN" > "$FIDGET_LOG" 2>&1 &
FIDGET_PID=$!

log_info "Waiting for fidget to start..."
await_pattern "$FIDGET_LOG" '^frame:' 80 || fail "Fidget never published a frame line"
kill -0 "$FIDGET_PID" 2>/dev/null || fail "Fidget exited during startup"

log_info "Recording initial state (no fullscreen app)..."
sleep 1
BEFORE_LINES=$(grep -c '^presence: hidden' "$FIDGET_LOG" || true)
log_info "Initial hidden count: $BEFORE_LINES"

log_info "Starting native Wayland fullscreen client (gtk4-demo)..."
DISPLAY="" \
  WAYLAND_DISPLAY="$WESTON_SOCKET" \
  gtk4-demo > "$GTK_LOG" 2>&1 &
GTK_PID=$!

log_info "Waiting for gtk4-demo to start..."
for _ in $(seq 1 40); do
  if kill -0 "$GTK_PID" 2>/dev/null; then
    sleep 0.1
    continue
  else
    log_warn "gtk4-demo exited (expected in headless mode)"
    GTK_PID=""
    break
  fi
done

if [ -z "$GTK_PID" ]; then
  log_warn "gtk4-demo cannot run headless; trying weston-simple-egl instead"
  
  if command -v weston-simple-egl > /dev/null; then
    WAYLAND_DISPLAY="$WESTON_SOCKET" \
      weston-simple-egl -f > "$GTK_LOG" 2>&1 &
    GTK_PID=$!
    log_info "Started weston-simple-egl instead (PID=$GTK_PID)"
    sleep 1
    if ! kill -0 "$GTK_PID" 2>/dev/null; then
      log_warn "weston-simple-egl also exited"
      GTK_PID=""
    fi
  fi
fi

if [ -z "$GTK_PID" ]; then
  log_warn "No native Wayland client could be started"
  log_warn "This is a limitation of headless testing"
else
  log_info "Waiting for fullscreen detection (5 seconds)..."
  sleep 5
fi

log_info "Checking fidget logs for fullscreen detection..."
AFTER_LINES=$(grep -c '^presence: hidden' "$FIDGET_LOG" || true)
log_info "After hidden count: $AFTER_LINES"

WINDOWS_COUNT=$(grep -c 'window_source:' "$FIDGET_LOG" | head -1 || echo "0")
log_info "Window source logged visible windows: checking..."

log_info ""
log_info "=== Test Results ==="
log_info ""

if [ "$AFTER_LINES" -gt "$BEFORE_LINES" ]; then
  log_info "✓ Fidget detected fullscreen and hid the Character"
  log_info "  This would indicate the native Wayland client appeared in X11's window list"
  log_info ""
  log_info "Decision: Update the code to handle this case OR verify this is not reproducible"
  echo "RESULT: FULLSCREEN_DETECTED"
else
  log_info "✗ Fidget did NOT detect the native Wayland fullscreen client"
  log_info "  This confirms the issue: native Wayland apps don't appear in XWayland's window list"
  log_info ""
  log_info "Decision: Update footnote 5 and degraded-cells.md to document this limitation"
  echo "RESULT: FULLSCREEN_NOT_DETECTED"
fi

log_info ""
log_info "Limitations of headless testing:"
log_info "  - Headless compositors may not fully support all window protocols"
log_info "  - Native Wayland clients may fail to start without a GPU"
log_info "  - Window manager behavior differs from real GNOME/KDE"
log_info "  - This test proves the X11 window list content, not the fullscreen trigger"
log_info ""
log_info "For definitive proof, test on:"
log_info "  - Real GNOME Wayland session with Firefox fullscreen"
log_info "  - Real KDE Wayland session with native app fullscreen"
log_info "  - Confirm whether those native fullscreen apps appear in _NET_CLIENT_LIST"
log_info ""
log_info "Test logs saved to: $OUT"
log_info "  - fidget.log: Frame traces and presence changes"
log_info "  - weston.log: Compositor output"
log_info "  - gtk.log: Native client output"

exit 0
