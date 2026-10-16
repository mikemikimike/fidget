#!/usr/bin/env bash
# Scenario: chat-close-pill-type (macOS)
# On screen: launches Fidget as BMO with a fixture Harness that holds its first
#   turn, so nothing opens Chat by itself. The quick message pill is opened by
#   resting the cursor on the sprite, clicked, and typed into: before Chat ever
#   opens, after Chat is opened (double-click) and closed (Cmd+W), and with
#   Finder in front. Last, TextEdit takes the keyboard, the sprite (not the
#   pill) is clicked, and typing must stay in TextEdit. Fidget quits at the end.
# Input: cursor moves, clicks, Cmd+W, and typed words.
# Duration: about 15 s; every step gives up 3 s after its trigger.
# Grants: Accessibility for the terminal that runs it.
# Asserts: each pill draft ends with the word typed (#1565), and a sprite click
#   leaves the word in TextEdit with no pill draft.
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
data="$out/home/Library/Application Support/fidget"
mkdir -p "$data" "$tools"
# The app's stderr goes to process.log in its data folder, one timestamp per line.
log="$data/process.log" marks="$out/harness.log"
: > "$marks"
: > "$log"
echo '{"first_run_tour_shown": true}' > "$data/settings.json"

fail() {
  echo "FAIL: $*" >&2
  echo "evidence in $out" >&2
  exit 1
}

# Kills <pid> and everything under it.
kill_tree() { # <pid>
  local child
  for child in $(pgrep -P "$1" 2> /dev/null); do kill_tree "$child"; done
  kill "$1" 2> /dev/null || true
}

# Runs <command>, killing it and its children after <seconds>.
capped() { # <seconds> <command...>
  local secs=$1 cmd dog status=0
  shift
  "$@" &
  cmd=$!
  (
    sleep "$secs"
    kill_tree "$cmd"
  ) 2> /dev/null &
  dog=$!
  wait "$cmd" || status=$?
  kill_tree "$dog"
  return "$status"
}

# Blocks until <file> holds <count> lines matching <ERE>, fed by tail -F.
count_reaches() { # <file> <ERE> <count>
  local fifo tailer status=0
  fifo=$(mktemp -u "$out/fifo.XXXXXX")
  mkfifo "$fifo"
  tail -n +1 -F "$1" > "$fifo" 2> /dev/null &
  tailer=$!
  [ "$(grep -cEm "$3" -- "$2" < "$fifo")" -ge "$3" ] || status=1
  kill "$tailer" 2> /dev/null || true
  rm -f "$fifo"
  return "$status"
}

# Shaped like #1564's shared helper so the swap is one source line.
wait_for_count() { # <seconds> <file> <ERE> <count>
  capped "$1" count_reaches "$2" "$3" "$4"
}
matches() { grep -cE -- "$2" "$1" || true; }
# Waits for one more <ERE> line than <file> holds now.
wait_for_next() { # <seconds> <file> <ERE> <command...>
  local secs=$1 file=$2 pattern=$3 before
  shift 3
  before=$(matches "$file" "$pattern")
  capped 3 "$@" > /dev/null 2>&1 || fail "could not run $*"
  wait_for_count "$secs" "$file" "$pattern" "$((before + 1))"
}

build_tool() { # <name> <source>
  [ "$tools/$1" -nt "$2" ] || swiftc -O "$2" -o "$tools/$1" || fail "could not build $1"
}
build_tool ax "$root/scripts/ax-settings.swift"
build_tool warp-cursor "$root/scripts/warp-cursor.swift"
build_tool click-cursor "$root/scripts/click-cursor.swift"

# FIDGET_HARNESS splits on whitespace, so no path in it may hold a space.
# `slow` holds the first turn, so a startup wake neither speaks nor opens Chat.
harness="$root/scripts/scenarios/fixture-harness.sh $test_bin script=slow count=$marks"
[ "$(wc -w <<< "$harness")" -eq 4 ] || fail "a path in the Harness line holds a space: $harness"

env HOME="$out/home" \
  FIDGET_HARNESS="$harness" \
  FIDGET_DIRECTOR_WAKE_SECS=600 \
  FIDGET_DIRECTOR_API_KEY=x FIDGET_TRACE_FRAMES=1 FIDGET_TRACE_BUBBLE=1 \
  FIDGET_CHARACTER=bmo FIDGET_CHARACTERS="$root/characters" \
  "$bin" > "$out/app.log" 2>&1 &
pid=$!
trap 'kill_tree "$pid"; pkill -f "count=$marks" || true' EXIT INT TERM

frame='^[0-9]+ frame: '
draft='^[0-9]+ overlay: draft .*text='

# Startup: the launch is the trigger for the first drawn frame.
wait_for_count 3 "$log" "$frame" 1 || fail "no frame within 3 s of launch; see $log and $out/app.log"

# Sets cx, cy to the sprite's center, from the newest frame line.
sprite_center() {
  local size at
  size=$(sed -nE 's/.*sprite ([0-9]+)x([0-9]+);.*/\1 \2/p' "$log" | head -1)
  at=$(sed -nE 's/^[0-9]+ frame: .* sprite\((-?[0-9]+),(-?[0-9]+)\) .*/\1 \2/p' "$log" | tail -1)
  if [ -z "$size" ] || [ -z "$at" ]; then fail "no sprite size or position in $log"; fi
  read -r sw sh <<< "$size"
  read -r sx sy <<< "$at"
  cx=$((sx + sw / 2)) cy=$((sy + sh / 2))
}

# Rest on the sprite; the pill opens after HOVER_DELAY_MS (1.5 s).
open_pill() { # <case>
  sprite_center
  wait_for_next 3 "$log" "$draft" "$tools/warp-cursor" "$cx" "$cy" --event ||
    fail "$1: the pill did not open; see $log"
}

# Sets fx, fy to the open pill field's center.
pill_field() { # <case>
  local rect
  capped 3 "$tools/ax" dump "$pid" Fidget frames > "$out/$1.ax.txt" 2>&1 || fail "$1: AX dump failed; see $out/$1.ax.txt"
  rect=$(sed -nE 's/^AXTextArea\|.*\|(-?[0-9]+,-?[0-9]+,[0-9]+,[0-9]+)$/\1/p' "$out/$1.ax.txt" | head -1)
  [ -n "$rect" ] || fail "$1: no pill field in $out/$1.ax.txt"
  IFS=, read -r fx fy fw fh <<< "$rect"
  fx=$((fx + fw / 2)) fy=$((fy + fh / 2))
}

# Click the open pill's field and type <word>; the draft must end with it.
click_and_type() { # <word> <case>
  pill_field "$2"
  capped 3 "$tools/click-cursor" "$fx" "$fy" 1 > "$out/$2.click.txt" 2>&1 || fail "$2: could not click the pill"
  wait_for_next 3 "$log" "${draft}\"[^\"]*$1\"" "$tools/ax" type "$pid" "$1" ||
    fail "$2: \"$1\" never reached the pill (#1565); see $log"
  echo "ok: $2: the pill took \"$1\""
}

# 1. Before Chat ever opens.
open_pill before-chat
click_and_type one before-chat

# 2. Chat opened by a Summon, then closed.
sprite_center
wait_for_next 3 "$log" '^[0-9]+ chat: chat-[^ ]+ is open$' "$tools/click-cursor" "$cx" "$cy" 2 ||
  fail "Chat did not open; see $log"
wait_for_next 3 "$log" '^[0-9]+ chat: chat-[^ ]+ is closed$' osascript \
  -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" \
  -e 'tell application "System Events" to keystroke "w" using command down' ||
  fail "Chat did not close; see $log"
open_pill after-chat
click_and_type two after-chat

# 3. Another app in front while the pill is still open.
capped 3 osascript -e 'tell application "Finder" to activate' > "$out/finder.txt" 2>&1 || fail "could not bring Finder forward"
click_and_type three other-app

# 4. TextEdit holds the keyboard; a sprite click must not take it.
capped 3 osascript -e 'tell application "TextEdit"' -e 'make new document' -e 'activate' -e 'end tell' \
  > "$out/textedit.txt" 2>&1 || fail "could not open a TextEdit document"
sprite_center
capped 3 "$tools/click-cursor" "$cx" "$cy" 1 > "$out/sprite-click.txt" 2>&1 || fail "could not click the sprite"
capped 3 "$tools/ax" type "$pid" four > /dev/null 2>&1 || fail "could not type"
typed() { [ "$(osascript -e 'tell application "TextEdit" to get text of document 1')" = four ]; }
until_typed() { until typed; do :; done; }
capped 3 until_typed || fail "sprite click took the keyboard from TextEdit; see $log"
! grep -qE "${draft}\"[^\"]*four\"" "$log" || fail "a sprite click sent typing to the pill; see $log"
echo "ok: a sprite click left typing in TextEdit"

echo "PASS: evidence in $out"
