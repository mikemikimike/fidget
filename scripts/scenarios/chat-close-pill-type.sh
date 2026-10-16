#!/usr/bin/env bash
# Scenario: chat-close-pill-type (macOS)
# On screen: launches Fidget as BMO with a fixture Harness. Chat opens by
#   itself and is closed with Cmd+W. The cursor then rests on the sprite until
#   the quick message pill opens, clicks into its field, and types "hello".
#   Fidget quits when it ends.
# Input: one cursor move, one click on the pill field, Cmd+W, and five keys.
# Duration: about 5 s; each wait gives up 2-3 s after its trigger.
# Grants: Accessibility for the terminal that runs it.
# Asserts: after Chat closes, the pill's draft reads "hello" (#1565).
#
# Usage: chat-close-pill-type.sh --go <fidget binary> <fidget test binary>
# Without --go it prints this header, which is the takeover prompt, and exits 2.
set -euo pipefail

if [ "${1:-}" != --go ]; then
  sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0" || true
  exit 2
fi
bin=${2:?usage: chat-close-pill-type.sh --go <fidget binary> <fidget test binary>}
test_bin=${3:?usage: chat-close-pill-type.sh --go <fidget binary> <fidget test binary>}
# Absolute: the Harness spawns in the data folder, so a relative path misses.
test_bin=$(cd "$(dirname "$test_bin")" && pwd)/$(basename "$test_bin")
root=$(cd "$(dirname "$0")/../.." && pwd)
out="${TMPDIR:-/tmp}/fidget-scenario-chat-close-pill-type-$(date +%Y%m%d-%H%M%S)"
tools="${TMPDIR:-/tmp}/fidget-scenario-tools"
mkdir -p "$out/home/Library/Application Support/fidget" "$tools"
log="$out/app.log" marks="$out/harness.log"
: > "$marks"
echo '{"first_run_tour_shown": true}' > "$out/home/Library/Application Support/fidget/settings.json"

fail() {
  echo "FAIL: $*" >&2
  echo "evidence in $out" >&2
  exit 1
}

[ "$tools/ax" -nt "$root/scripts/ax-settings.swift" ] || swiftc -O "$root/scripts/ax-settings.swift" -o "$tools/ax"
[ "$tools/warp-cursor" -nt "$root/scripts/warp-cursor.swift" ] ||
  swiftc -O "$root/scripts/warp-cursor.swift" -o "$tools/warp-cursor"
[ "$tools/click-cursor" -nt "$root/scripts/click-cursor.swift" ] ||
  swiftc -O "$root/scripts/click-cursor.swift" -o "$tools/click-cursor"

# Each wait starts at its trigger, reads only lines written after it, and
# gives up when the watchdog kills the grep.
lines() { wc -l < "$1"; }
wait_after() { # <file> <line count> <seconds> <ERE>
  local grep_pid dog ok=0
  tail -n +"$(($2 + 1))" -F "$1" 2> /dev/null | grep -qEm1 -- "$4" &
  grep_pid=$!
  {
    sleep "$3"
    kill "$grep_pid" 2> /dev/null
  } &
  dog=$!
  wait "$grep_pid" || ok=1
  kill "$dog" 2> /dev/null || true
  return "$ok"
}

# FIDGET_HARNESS splits on whitespace, so no path in it may hold a space.
harness="$root/scripts/scenarios/fixture-harness.sh $test_bin script=scenario-thinking count=$marks"
[ "$(wc -w <<< "$harness")" -eq 4 ] || fail "a path in the Harness line holds a space: $harness"

env HOME="$out/home" \
  FIDGET_HARNESS="$harness" \
  FIDGET_DIRECTOR_WAKE_SECS=1 \
  FIDGET_DIRECTOR_API_KEY=x FIDGET_TRACE_FRAMES=1 FIDGET_TRACE_BUBBLE=1 \
  FIDGET_CHARACTER=bmo FIDGET_CHARACTERS="$root/characters" \
  "$bin" > "$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2> /dev/null || true; pkill -f "count=$marks" || true' EXIT INT TERM

# The first wake is the trigger; its turn opens Chat and replies.
wait_after "$marks" 0 3 '^asked$' || fail "no wake reached the Harness; see $log"
wait_after "$marks" 0 3 '^replied$' || fail "the Harness never replied; see $marks"

at=$(lines "$log")
osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" \
  -e 'tell application "System Events" to keystroke "w" using command down' > "$out/close.txt" 2>&1 ||
  fail "could not press Cmd+W; see $out/close.txt"
wait_after "$log" "$at" 2 '^chat: chat-[^ ]+ is closed$' || fail "Chat did not close; see $log"

# The newest frame line says where the sprite is drawn, in global points.
read -r sw sh < <(sed -nE 's/.*sprite ([0-9]+)x([0-9]+);.*/\1 \2/p' "$log" | head -1) || fail "no sprite size in $log"
read -r sx sy < <(sed -nE 's/^frame: .* sprite\((-?[0-9]+),(-?[0-9]+)\) .*/\1 \2/p' "$log" | tail -1) || fail "no frame line in $log"
at=$(lines "$log")
"$tools/warp-cursor" "$((sx + sw / 2))" "$((sy + sh / 2))" --event > "$out/hover.txt" 2>&1 || fail "could not move the cursor; see $out/hover.txt"
# The pill opens after a 1.5 s rest on the sprite.
wait_after "$log" "$at" 3 '^overlay: draft .*text=""' || fail "the pill did not open; see $log"

"$tools/ax" dump "$pid" Fidget frames > "$out/pill.ax.txt" 2>&1 || fail "AX dump failed; see $out/pill.ax.txt"
IFS=, read -r fx fy fw fh < <(sed -nE 's/^AXTextArea\|.*\|(-?[0-9]+,-?[0-9]+,[0-9]+,[0-9]+)$/\1/p' "$out/pill.ax.txt" | head -1) ||
  fail "no pill field in $out/pill.ax.txt"
at=$(lines "$log")
"$tools/click-cursor" "$((fx + fw / 2))" "$((fy + fh / 2))" 1 > "$out/click.txt" 2>&1 ||
  fail "could not click the pill field; see $out/click.txt"
"$tools/ax" type "$pid" hello > "$out/type.txt" 2>&1 || fail "could not type; see $out/type.txt"
wait_after "$log" "$at" 2 '^overlay: draft .*text="hello"' || fail "typed text never reached the pill (#1565); see $log"

echo "ok: the pill took \"hello\" after Chat closed"
echo "PASS: evidence in $out"
