#!/usr/bin/env bash
# Scenario: chat-close-pill-type (macOS)
# On screen: launches Fidget as BMO with a fixture Harness that holds its first
#   turn, so nothing opens Chat by itself. First TextEdit takes the keyboard
#   and the sprite is clicked with no pill open; typing must stay in TextEdit.
#   Then the quick message pill is opened by resting the cursor on the sprite
#   and typed into with no click: before Chat ever opens, after Chat is opened
#   (double-click) and closed (Cmd+W), and with TextEdit in front. Then the
#   pill is closed by Enter, by Escape, and by clicking TextEdit through a
#   transparent part of the overlay; after each, typing must land in TextEdit.
#   Fidget quits.
# Input: cursor moves, clicks, Cmd+W, Enter, Escape, and typed words.
# Duration: about 20 s; every step gives up 3 s after its trigger.
# Grants: Accessibility for the terminal that runs it.
# Asserts: a sprite click leaves the word in TextEdit with no pill draft, and
#   each pill that opens takes the typed word with no click (#1565), and each
#   way of closing it hands the keyboard back to TextEdit.
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
. "$root/scripts/scenarios/wait-helpers.mac.sh"
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

# Runs a helper tool, stopping it and its children after <seconds>, so a
# stuck osascript or AX call cannot hang the run.
capped() { # <seconds> <command...>
  local secs=$1 cmd dog status=0
  shift
  "$@" &
  cmd=$!
  (
    sleep "$secs"
    process_tree "$cmd" | xargs kill 2> /dev/null
  ) 2> /dev/null &
  dog=$!
  wait "$cmd" || status=$?
  process_tree "$dog" | xargs kill 2> /dev/null || true
  return "$status"
}

# Runs <command> as the trigger, then waits for one more <ERE> line in <file>.
wait_for_next() { # <seconds> <file> <ERE> <command...>
  local secs=$1 file=$2 pattern=$3 before
  shift 3
  before=$(line_count "$file" "$pattern")
  capped 3 "$@" > /dev/null 2>&1 || fail "could not run $*"
  wait_for_count "$secs" "$file" "$pattern" "$before"
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
trap 'stop_fidget; pkill -f "count=$marks" || true' EXIT INT TERM

frame='^[0-9]+ frame: '
draft='^[0-9]+ overlay: draft .*text='

# Startup: the launch is the trigger for the first drawn frame.
wait_for_count 3 "$log" "$frame" 0 || fail "no frame within 3 s of launch; see $log and $out/app.log"

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

# Leave the sprite and come back; the pill opens after HOVER_DELAY_MS (1.5 s)
# and takes the caret by itself.
open_pill() { # <case>
  sprite_center
  capped 3 "$tools/warp-cursor" "$((cx + 4 * sw))" "$cy" --event > /dev/null 2>&1 || fail "$1: could not move the cursor away"
  wait_for_next 3 "$log" "$draft" "$tools/warp-cursor" "$cx" "$cy" --event ||
    fail "$1: the pill did not open; see $log"
}

# Type <word> with no click; the open pill's draft must end with it.
type_into_pill() { # <word> <case>
  wait_for_next 3 "$log" "${draft}\"[^\"]*$1\"" "$tools/ax" type "$pid" "$1" ||
    fail "$2: \"$1\" never reached the pill (#1565); see $log"
  echo "ok: $2: the pill took \"$1\" with no click"
}

# 1. No pill open, TextEdit holds the keyboard: a sprite click must not take it.
# Typing and leaving finish well inside the 1.5 s hover that would open a pill.
capped 3 osascript -e 'tell application "TextEdit"' -e 'make new document' -e 'activate' -e 'end tell' \
  > "$out/textedit.txt" 2>&1 || fail "could not open a TextEdit document"
sprite_center
capped 3 "$tools/click-cursor" "$cx" "$cy" 1 > "$out/sprite-click.txt" 2>&1 || fail "could not click the sprite"
capped 3 "$tools/ax" type "$pid" four > /dev/null 2>&1 || fail "could not type"
capped 3 "$tools/warp-cursor" "$((cx + 4 * sw))" "$cy" --event > /dev/null 2>&1 || fail "could not move the cursor away"
typed() { [ "$(capped 3 osascript -e 'tell application "TextEdit" to get text of document 1')" = four ]; }
wait_until 3 typed || fail "a sprite click took the keyboard from TextEdit; see $log"
! grep -qE "${draft}\"[^\"]*four\"" "$log" || fail "a sprite click sent typing to Fidget; see $log"
echo "ok: a sprite click left typing in TextEdit"

# 2. Before Chat ever opens.
open_pill before-chat
type_into_pill one before-chat

# 3. Chat opened by a Summon, then closed.
sprite_center
wait_for_next 3 "$log" '^[0-9]+ chat: chat-[^ ]+ is open$' "$tools/click-cursor" "$cx" "$cy" 2 ||
  fail "Chat did not open; see $log"
wait_for_next 3 "$log" '^[0-9]+ chat: chat-[^ ]+ is closed$' osascript \
  -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" \
  -e 'tell application "System Events" to keystroke "w" using command down' ||
  fail "Chat did not close; see $log"
open_pill after-chat
type_into_pill two after-chat

# 4. TextEdit in front when the pill opens. A minimized Chat lets the pill back.
sprite_center
wait_for_next 3 "$log" '^[0-9]+ chat: chat-[^ ]+ is open$' "$tools/click-cursor" "$cx" "$cy" 2 ||
  fail "Chat did not reopen; see $log"
wait_for_next 3 "$log" '^[0-9]+ chat: chat-[^ ]+ is minimized$' "$tools/ax" minimize "$pid" BMO true ||
  fail "Chat did not minimize; see $log"
capped 3 osascript -e 'tell application "TextEdit" to activate' > "$out/textedit-front.txt" 2>&1 || fail "could not bring TextEdit forward"
open_pill other-app
type_into_pill three other-app

# TextEdit's text ends with <word>; re-checked on each new log line.
textedit_ends() { case "$(capped 3 osascript -e 'tell application "TextEdit" to get text of document 1')" in *"$1") ;; *) return 1 ;; esac }
# After the pill closes, <word> typed with no click must land in TextEdit.
typing_back_in_textedit() { # <word> <case>
  capped 3 "$tools/ax" type "$pid" "$1" > /dev/null 2>&1 || fail "$2: could not type"
  wait_until 3 textedit_ends "$1" || fail "$2: \"$1\" did not reach TextEdit after the pill closed; see $log"
  ! grep -qE "${draft}\"[^\"]*$1\"" "$log" || fail "$2: the pill kept the keyboard; see $log"
  echo "ok: $2: typing went back to TextEdit"
}
closed='^[0-9]+ overlay: draft .* closed$'

# 5. Enter sends the pill's line and closes it; the keyboard goes back to TextEdit.
wait_for_next 3 "$log" "$closed" "$tools/ax" key "$pid" return || fail "enter: the pill did not close; see $log"
typing_back_in_textedit six enter

# 6. Escape closes the pill the same way.
open_pill escape
type_into_pill seven escape
wait_for_next 3 "$log" "$closed" "$tools/ax" key "$pid" escape || fail "escape: the pill did not close; see $log"
typing_back_in_textedit eight escape

# 7. A click on TextEdit through a transparent part of the overlay closes the
# pill, and typing follows the click.
open_pill click-away
type_into_pill nine click-away
bounds=$(capped 3 osascript -e 'tell application "TextEdit" to get bounds of window 1') || fail "no TextEdit window bounds"
IFS=', ' read -r left top right bottom <<< "$bounds"
wait_for_next 3 "$log" "$closed" "$tools/click-cursor" "$(((left + right) / 2))" "$(((top + bottom) / 2))" 1 ||
  fail "click-away: the pill did not close; see $log"
typing_back_in_textedit ten click-away

echo "PASS: evidence in $out"
