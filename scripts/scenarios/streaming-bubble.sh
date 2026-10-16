#!/usr/bin/env bash
# Scenario: streaming-bubble (macOS)
# On screen: launches Fidget as BMO with a fixture Harness that answers its
#   first wake one word at a time. Three screenshots of the region around the
#   sprite and its bubble: two while the reply streams, one after it lands.
#   Fidget quits when the scenario ends.
# Input: none.
# Duration: a few seconds, 20 s at most.
# Grants: Screen Recording and Accessibility for the terminal that runs it.
# Asserts: the bubble grows word by word with `talk` playing, never shows the
#   Behavior name, and ends on the whole line.
#
# Usage: streaming-bubble.sh --go <fidget binary> <fidget test binary>
# Without --go it prints this header, which is the takeover prompt, and exits 2.
set -euo pipefail

if [ "${1:-}" != --go ]; then
  sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0" || true
  exit 2
fi
bin=${2:?usage: streaming-bubble.sh --go <fidget binary> <fidget test binary>}
test_bin=${3:?usage: streaming-bubble.sh --go <fidget binary> <fidget test binary>}
# Absolute: the Harness spawns in the data folder, so a relative path misses.
test_bin=$(cd "$(dirname "$test_bin")" && pwd)/$(basename "$test_bin")
root=$(cd "$(dirname "$0")/../.." && pwd)
. "$root/scripts/scenarios/wait-helpers.sh"
out="${TMPDIR:-/tmp}/fidget-scenario-streaming-bubble-$(date +%Y%m%d-%H%M%S)"
tools="${TMPDIR:-/tmp}/fidget-scenario-tools"
mkdir -p "$out/home" "$tools"
seed_settings "$out/home"
log="$out/app.log" marks="$out/harness.log"
: > "$marks"

fail() {
  echo "FAIL: $*" >&2
  echo "evidence in $out" >&2
  exit 1
}

[ "$tools/ax" -nt "$root/scripts/ax-settings.swift" ] || swiftc -O "$root/scripts/ax-settings.swift" -o "$tools/ax"

# FIDGET_HARNESS splits on whitespace, so no path in it may hold a space.
harness="$root/scripts/scenarios/fixture-harness.sh $test_bin script=scenario-streaming count=$marks"
[ "$(wc -w <<< "$harness")" -eq 4 ] || fail "a path in the Harness line holds a space: $harness"

start_ms=$(now_ms)
env HOME="$out/home" \
  FIDGET_HARNESS="$harness" \
  FIDGET_DIRECTOR_WAKE_SECS=1 \
  FIDGET_DIRECTOR_API_KEY=x FIDGET_CAPTURABLE=1 FIDGET_TRACE_FRAMES=1 \
  FIDGET_CHARACTER=bmo FIDGET_CHARACTERS="$root/characters" \
  "$bin" > "$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2> /dev/null || true; pkill -f "count=$marks" || true' EXIT INT TERM

# The bubble is at most 260 points wide and sits above the head, so the
# region is centred on the sprite and reaches well above it.
region() {
  local sw sh sx sy
  read -r sw sh < <(sed -nE 's/.*sprite ([0-9]+)x([0-9]+);.*/\1 \2/p' "$log" | head -1) || fail "no sprite size in $log"
  read -r sx sy < <(sed -nE 's/^frame: .* sprite\((-?[0-9]+),(-?[0-9]+)\) .*/\1 \2/p' "$log" | tail -1) || fail "no frame trace in $log"
  echo "$((sx + sw / 2 - 160)),$((sy - 190)),320,$((sh + 200))"
}

# <name> <text the bubble must hold> [text it must not hold yet] [animation]
capture() {
  screencapture -x -R "$(region)" "$out/$1.png"
  "$tools/ax" dump "$pid" Fidget > "$out/$1.ax.txt" 2>&1 || fail "$1: AX dump failed; see $out/$1.ax.txt"
  grep -qF "$2" "$out/$1.ax.txt" || fail "$1: the bubble does not hold '$2'; see $out/$1.ax.txt"
  if [ -n "${3:-}" ] && grep -qF "$3" "$out/$1.ax.txt"; then
    fail "$1: the bubble already holds '$3'; see $out/$1.ax.txt"
  fi
  ! grep -qE '^AXStaticText\|[^|]*\|greet' "$out/$1.ax.txt" || fail "$1: the Behavior name showed in the bubble"
  if [ -n "${4:-}" ]; then
    grep -E '^frame: ' "$log" | tail -1 | grep -qF " $4#" || fail "$1: the sprite is not playing $4; see $log"
  fi
  echo "ok: $1"
}

# Each mark is when the Harness sent a word; the wait after it is for the
# overlay to draw it.
wait_for_marks 3 "$marks" '^word 2$' || fail "no streamed turn reached the Harness; see $log"
wait_for_ax_dump 2 "$pid" Fidget 'Watch these' || fail "early: the bubble never drew 'Watch these'; see $log"
capture early "Watch these" "arrive" talk
wait_for_marks 3 "$marks" '^word 5$' || fail "the stream stalled; see $log"
wait_for_ax_dump 2 "$pid" Fidget 'Watch these words arrive one' || fail "mid: the bubble never drew 'Watch these words arrive one'; see $log"
capture mid "Watch these words arrive one" "time." talk
wait_for_marks 3 "$marks" '^spoken$' || fail "the reply never ended; see $log"
wait_for_ax_dump 2 "$pid" Fidget 'Watch these words arrive one at a time\.' || fail "landed: the bubble never drew the whole line; see $log"
capture landed "Watch these words arrive one at a time."
echo "PASS: evidence in $out ($(($(now_ms) - start_ms))ms)"
