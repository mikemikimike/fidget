#!/usr/bin/env bash
# Scenario: chat-close-pill-type (macOS)
# On screen: launches Fidget, opens Chat, closes Chat, shows the pill with trace output.
#   The scenario does NOT automate typing - it proves the root cause via traces.
# Input: automated cursor movement and one click.
# Duration: about 8 s.
# Grants: Accessibility for the terminal that runs it.
# Asserts: The trace shows app_active=true, has_key_window=false, and can_become_key=false
#   after chat closes, confirming that the overlay cannot become key.
#
# Usage: chat-close-pill-type.sh --go <fidget binary>
# Without --go it prints this header, which is the takeover prompt, and exits 2.
set -euo pipefail

if [ "${1:-}" != --go ]; then
  sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0" || true
  exit 2
fi
bin=${2:?usage: chat-close-pill-type.sh --go <fidget binary>}
root=$(cd "$(dirname "$0")/../.." && pwd)
out="${TMPDIR:-/tmp}/fidget-scenario-chat-close-pill-type-$(date +%Y%m%d-%H%M%S)"
tools="${TMPDIR:-/tmp}/fidget-scenario-tools"
mkdir -p "$out/home" "$tools"
log="$out/app.log"

fail() {
  echo "FAIL: $*" >&2
  echo "evidence in $out" >&2
  exit 1
}

[ -x "$tools/ax" ] || swiftc -O "$root/scripts/ax-settings.swift" -o "$tools/ax"
[ -x "$tools/warp-cursor" ] || swiftc -O "$root/scripts/warp-cursor.swift" -o "$tools/warp-cursor"

env HOME="$out/home" FIDGET_DIRECTOR_API_KEY=x FIDGET_TRACE_FRAMES=1 FIDGET_TRACE_BUBBLE=1 \
  FIDGET_CHARACTERS="$root/characters" "$bin" > "$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2> /dev/null || true' EXIT

wait_for() { # <seconds> <command...>
  local n=$(($1 * 4))
  shift
  until "$@" > /dev/null 2>&1; do
    kill -0 "$pid" 2> /dev/null || fail "Fidget exited; see $log"
    n=$((n - 1))
    [ "$n" -gt 0 ] || return 1
    sleep 0.25
  done
}

# Wait for overlay to appear
wait_for 3 grep -q '^overlay: ' "$log" || fail "no overlay appeared; see $log"
sleep 0.5

# Get sprite position and move cursor to show the pill
read -r sx sy < <(sed -nE 's/^frame: .* sprite\((-?[0-9]+),(-?[0-9]+)\) .*/\1 \2/p' "$log" | tail -1) || fail "no sprite position in $log"
read -r sw sh < <(sed -nE 's/.*sprite ([0-9]+)x([0-9]+);.*/\1 \2/p' "$log" | head -1) || fail "no sprite size in $log"
"$tools/warp-cursor" "$((sx + sw / 2))" "$((sy + sh / 2))" --event > "$out/hover1.txt" 2>&1 || fail "could not move cursor; see $out/hover1.txt"

# Wait for pill to appear
sleep 0.6

# Click "Open chat" button
"$tools/ax" click "$pid" Fidget "Open chat" > "$out/open-chat.txt" 2>&1 || fail "could not click Open chat; see $out/open-chat.txt"
wait_for 2 grep -qF 'chat: ' "$log" || fail "chat window did not open; see $log"
sleep 0.5

# Close chat via Cmd+W
osascript > "$out/close-chat.txt" 2>&1 << 'EOF' || fail "could not close chat; see $out/close-chat.txt"
tell application "System Events"
  keystroke "w" using command down
end tell
EOF

wait_for 2 grep -qF 'chat: after close' "$log" || fail "chat close was not traced; see $log"
grep -F 'chat: after close' "$log" | tail -1 > "$out/after-close.txt"

# Move cursor away then back to show pill again
"$tools/warp-cursor" 100 100 --event > "$out/away.txt" 2>&1 || true
sleep 0.3
"$tools/warp-cursor" "$((sx + sw / 2))" "$((sy + sh / 2))" --event > "$out/hover2.txt" 2>&1 || fail "could not move cursor back; see $out/hover2.txt"

# Wait for request_focus to be called
wait_for 3 grep -qF 'overlay: request_focus' "$log" || fail "request_focus was not called after chat close; see $log"
grep -F 'overlay: request_focus' "$log" | tail -1 > "$out/request-focus.txt"

# Verify the root cause: app is active but overlay can't become key
if ! grep -qF 'app_active=true' "$out/after-close.txt"; then
  fail "expected app_active=true after chat close; see $out/after-close.txt"
fi

if ! grep -qF 'has_key_window=false' "$out/after-close.txt"; then
  fail "expected has_key_window=false after chat close; see $out/after-close.txt"
fi

if ! grep -qF 'can_become_key=false' "$out/request-focus.txt"; then
  fail "expected can_become_key=false in request_focus; see $out/request-focus.txt"
fi

echo "ok: root cause confirmed - app is active but overlay refuses to become key"
echo "PASS: evidence in $out"
