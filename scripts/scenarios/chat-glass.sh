#!/usr/bin/env bash
# Scenario: chat-glass (macOS)
# On screen: launches Fidget as BMO with the Glass Chat design and a fixture
#   Harness. Chat opens by itself, one screenshot of the Chat window is taken,
#   and Fidget quits.
# Input: none.
# Duration: a few seconds, 25 s at most.
# Grants: Screen Recording and Accessibility for the terminal that runs it.
# Asserts: the Chat panel is as see-through as the Glass design says. The
#   capture keeps the window's alpha, so an opaque window reads 255 however its
#   pixels look. The design's darkest stack is the panel gradient's .74 under
#   the log's .34 plate, about .83, so the median alpha must stay under 220.
#
# Usage: chat-glass.sh --go <fidget binary> <fidget test binary>
# Without --go it prints this header, which is the takeover prompt, and exits 2.
set -euo pipefail

if [ "${1:-}" != --go ]; then
  sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0" || true
  exit 2
fi
bin=${2:?usage: chat-glass.sh --go <fidget binary> <fidget test binary>}
test_bin=${3:?usage: chat-glass.sh --go <fidget binary> <fidget test binary>}
# Absolute: the Harness spawns in the data folder, so a relative path misses.
test_bin=$(cd "$(dirname "$test_bin")" && pwd)/$(basename "$test_bin")
root=$(cd "$(dirname "$0")/../.." && pwd)
. "$root/scripts/scenarios/wait-helpers.mac.sh"
out="${TMPDIR:-/tmp}/fidget-scenario-chat-glass-$(date +%Y%m%d-%H%M%S)"
tools="${TMPDIR:-/tmp}/fidget-scenario-tools"
mkdir -p "$out/home/Library/Application Support/fidget" "$tools"
echo '{"first_run_tour_shown": true, "chat_ui": "glass"}' \
  > "$out/home/Library/Application Support/fidget/settings.json"
log="$out/app.log" marks="$out/harness.log"
: > "$marks"

fail() {
  echo "FAIL: $*" >&2
  echo "evidence in $out" >&2
  exit 1
}

[ -x "$tools/window-id" ] || swiftc -O "$root/scripts/scenarios/window-id.swift" -o "$tools/window-id"
[ "$tools/pixel-alpha" -nt "$root/scripts/scenarios/pixel-alpha.swift" ] ||
  swiftc -O "$root/scripts/scenarios/pixel-alpha.swift" -o "$tools/pixel-alpha"
build_ax_events

# FIDGET_HARNESS splits on whitespace, so no path in it may hold a space.
harness="$root/scripts/scenarios/fixture-harness.sh $test_bin script=scenario-thinking count=$marks"
[ "$(wc -w <<< "$harness")" -eq 4 ] || fail "a path in the Harness line holds a space: $harness"

start_ms=$(now_ms)
env HOME="$out/home" \
  FIDGET_HARNESS="$harness" \
  FIDGET_DIRECTOR_WAKE_SECS=1 \
  FIDGET_DIRECTOR_API_KEY=x FIDGET_CAPTURABLE=1 \
  FIDGET_CHARACTER=bmo FIDGET_CHARACTERS="$root/characters" \
  "$bin" > "$log" 2>&1 &
pid=$!
trap 'stop_fidget; pkill -f "count=$marks" || true' EXIT INT TERM

wait_for_marks 10 "$marks" '^asked$' || fail "no wake reached the Harness; see $log"
wait_for_ax 10 "$pid" "$tools/window-id" "$pid" BMO || fail "Chat did not open"
# The page paints after the window maps.
sleep 1
screencapture -x -o -l "$("$tools/window-id" "$pid" BMO)" "$out/chat.png"
alpha=$("$tools/pixel-alpha" "$out/chat.png")
[ "$alpha" -lt 220 ] || fail "Glass Chat is too opaque: median alpha $alpha of 255; see $out/chat.png"
echo "ok: median alpha $alpha of 255"
echo "PASS: evidence in $out ($(($(now_ms) - start_ms))ms)"
