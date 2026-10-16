#!/usr/bin/env bash
# Scenario: chat-close-pill-type (macOS)
# On screen: launches Fidget, opens Chat, closes Chat, shows the pill, types.
#   Asserts that the typed text appears in the pill after chat closes.
# Input: automated cursor movement, one click, and simulated typing.
# Duration: 3-8 s total.
# Grants: Accessibility for the terminal that runs it.
# Asserts: After chat closes, typing into the pill produces draft updates.
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

# shellcheck source=wait-helpers.mac.sh
. "$root/scripts/scenarios/wait-helpers.mac.sh"

[ -x "$tools/ax" ] || swiftc -O "$root/scripts/ax-settings.swift" -o "$tools/ax"
[ -x "$tools/warp-cursor" ] || swiftc -O "$root/scripts/warp-cursor.swift" -o "$tools/warp-cursor"

start=$(date +%s)

env HOME="$out/home" FIDGET_DIRECTOR_API_KEY=x FIDGET_TRACE_FRAMES=1 FIDGET_TRACE_BUBBLE=1 \
  FIDGET_CHARACTERS="$root/characters" "$bin" > "$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2> /dev/null || true' EXIT

# Wait for overlay to appear
wait_for_trace 3 "$log" '^overlay: ' || fail "no overlay appeared; see $log"

# Get sprite position and move cursor to show the pill
read -r sx sy < <(sed -nE 's/^frame: .* sprite\((-?[0-9]+),(-?[0-9]+)\) .*/\1 \2/p' "$log" | tail -1) || fail "no sprite position in $log"
read -r sw sh < <(sed -nE 's/.*sprite ([0-9]+)x([0-9]+);.*/\1 \2/p' "$log" | head -1) || fail "no sprite size in $log"
"$tools/warp-cursor" "$((sx + sw / 2))" "$((sy + sh / 2))" --event > "$out/hover1.txt" 2>&1 || fail "could not move cursor; see $out/hover1.txt"

# Wait for pill to appear (bubble: quick trace)
wait_for_trace 2 "$log" 'bubble: quick' || fail "pill did not appear; see $log"

# Click "Open chat" button
"$tools/ax" click "$pid" Fidget "Open chat" > "$out/open-chat.txt" 2>&1 || fail "could not click Open chat; see $out/open-chat.txt"
wait_for_trace 2 "$log" 'chat: ' || fail "chat window did not open; see $log"

# Close chat via Cmd+W
osascript > "$out/close-chat.txt" 2>&1 << 'EOF' || fail "could not close chat; see $out/close-chat.txt"
tell application "System Events"
  keystroke "w" using command down
end tell
EOF

wait_for_trace 2 "$log" 'chat: after close' || fail "chat close was not traced; see $log"

# Move cursor away then back to show pill again
"$tools/warp-cursor" 100 100 --event > "$out/away.txt" 2>&1 || true
sleep 0.2
"$tools/warp-cursor" "$((sx + sw / 2))" "$((sy + sh / 2))" --event > "$out/hover2.txt" 2>&1 || fail "could not move cursor back; see $out/hover2.txt"

# Wait for pill to appear again
wait_for_trace 2 "$log" 'bubble: quick' || fail "pill did not reappear after chat close; see $log"

# Type "hello" into the pill
osascript > "$out/type.txt" 2>&1 << 'EOF' || fail "could not type; see $out/type.txt"
tell application "System Events"
  keystroke "hello"
end tell
EOF

# Wait for the draft to be reported with the typed text
wait_for_trace 3 "$log" 'overlay: draft.*text="hello"' || {
  echo "FAIL: typed text was not reported in draft; pill focus failed after chat close" >&2
  echo "See $log for full trace" >&2
  exit 1
}

elapsed=$(($(date +%s) - start))
echo "ok: typed text appeared in pill after chat close (${elapsed}s)"
echo "PASS: evidence in $out"
