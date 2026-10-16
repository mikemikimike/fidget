#!/usr/bin/env bash
# Scenario: chat-close-pill-type (macOS)
# On screen: launches Fidget as BMO with a fixture Harness. The quick message
#   pill is opened by resting the cursor on the sprite, clicked, and typed into
#   three times: before Chat ever opens, after Chat is opened (double-click) and
#   closed (Cmd+W), and after Finder is brought forward. Fidget quits at the end.
# Input: cursor moves, clicks on the sprite and pill, Cmd+W, and typed words.
# Duration: about 10 s; each wait gives up 2-3 s after its trigger.
# Grants: Accessibility for the terminal that runs it.
# Asserts: each time, the pill's draft ends with the word typed (#1565).
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
  FIDGET_DIRECTOR_WAKE_SECS=600 \
  FIDGET_DIRECTOR_API_KEY=x FIDGET_TRACE_FRAMES=1 FIDGET_TRACE_BUBBLE=1 \
  FIDGET_CHARACTER=bmo FIDGET_CHARACTERS="$root/characters" \
  "$bin" > "$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2> /dev/null || true; pkill -f "count=$marks" || true' EXIT INT TERM

# The sprite's center, from the newest frame line, in global points.
sprite_center() {
  local sw sh sx sy
  read -r sw sh < <(sed -nE 's/.*sprite ([0-9]+)x([0-9]+);.*/\1 \2/p' "$log" | head -1) || fail "no sprite size in $log"
  read -r sx sy < <(sed -nE 's/^frame: .* sprite\((-?[0-9]+),(-?[0-9]+)\) .*/\1 \2/p' "$log" | tail -1) || fail "no frame line in $log"
  echo "$((sx + sw / 2)) $((sy + sh / 2))"
}

# Click the open pill's field and type <word>; the draft must end with it.
click_and_type() { # <word> <case>
  local at fx fy fw fh
  "$tools/ax" dump "$pid" Fidget frames > "$out/$2.ax.txt" 2>&1 || fail "$2: AX dump failed; see $out/$2.ax.txt"
  IFS=, read -r fx fy fw fh < <(sed -nE 's/^AXTextArea\|.*\|(-?[0-9]+,-?[0-9]+,[0-9]+,[0-9]+)$/\1/p' "$out/$2.ax.txt" | head -1) ||
    fail "$2: no pill field in $out/$2.ax.txt"
  at=$(lines "$log")
  "$tools/click-cursor" "$((fx + fw / 2))" "$((fy + fh / 2))" 1 > "$out/$2.click.txt" 2>&1 || fail "$2: could not click the pill"
  "$tools/ax" type "$pid" "$1" > "$out/$2.type.txt" 2>&1 || fail "$2: could not type"
  wait_after "$log" "$at" 2 "^overlay: draft .*text=\"[^\"]*$1\"" || fail "$2: \"$1\" never reached the pill (#1565); see $log"
  echo "ok: $2: the pill took \"$1\""
}

# Rest on the sprite; the pill opens after HOVER_DELAY_MS (1.5 s).
open_pill() { # <case>
  local at x y
  read -r x y < <(sprite_center)
  at=$(lines "$log")
  "$tools/warp-cursor" "$x" "$y" --event > "$out/$1.hover.txt" 2>&1 || fail "$1: could not move the cursor"
  wait_after "$log" "$at" 3 '^overlay: draft .*text=' || fail "$1: the pill did not open; see $log"
}

# 1. Before Chat ever opens. The frame trace is the trigger that the sprite is drawn.
wait_after "$log" 0 3 '^frame: ' || fail "no frame line; see $log"
open_pill before-chat
click_and_type one before-chat

# 2. Chat opened by a Summon, then closed.
read -r x y < <(sprite_center)
at=$(lines "$log")
"$tools/click-cursor" "$x" "$y" 2 > "$out/summon.txt" 2>&1 || fail "could not double-click the sprite"
wait_after "$log" "$at" 3 '^chat: chat-[^ ]+ is open$' || fail "Chat did not open; see $log"
at=$(lines "$log")
osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" \
  -e 'tell application "System Events" to keystroke "w" using command down' > "$out/close.txt" 2>&1 ||
  fail "could not press Cmd+W; see $out/close.txt"
wait_after "$log" "$at" 2 '^chat: chat-[^ ]+ is closed$' || fail "Chat did not close; see $log"
open_pill after-chat
click_and_type two after-chat

# 3. Another app in front while the pill is still open.
osascript -e 'tell application "Finder" to activate' > "$out/finder.txt" 2>&1 || fail "could not bring Finder forward"
click_and_type three other-app

echo "PASS: evidence in $out"
