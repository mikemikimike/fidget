#!/usr/bin/env bash
# Scenario: first-run-chat (X11)
# On screen: nothing on your display. A private 800x600 Xvfb display with
#   icewm and no compositor, as the AppImage catalog test runs it, and Fidget
#   launched three times as a standing BMO.
# Input: none.
# Duration: about 10 s; every wait gives up 3 s after its trigger.
# Grants: Xvfb, icewm, xdotool, xprop, xwininfo, ImageMagick, tesseract, the
#   fidget test binary, and curl unless a catalog checkout is given.
# Asserts: a first launch with no AI source opens Chat's landing as a normal
#   window, and the catalog's take-screenshot.sh and check-screenshot.sh pass
#   on it (#1730); a first launch with a Harness set opens no Chat; a second
#   launch with no source opens no Chat.
#
# Usage: first-run-chat.x11.sh --go <fidget binary> <fidget test binary> [appimage.github.io checkout]
# The binary may be an extracted AppImage's AppRun with this build as its
#   usr/bin/fidget. As of 2026-10, Debian 13's WebKitGTK 2.54 draws Chat
#   black with no compositor, so a bare build there fails.
# Without --go it prints this header, which is the takeover prompt, and exits 2.
set -euo pipefail

if [ "${1:-}" != --go ]; then
  sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0" || true
  exit 2
fi
usage="usage: first-run-chat.x11.sh --go <fidget binary> <fidget test binary> [catalog checkout]"
bin=${2:?$usage}
test_bin=${3:?$usage}
catalog=${4:-}
for tool in Xvfb icewm xdotool xprop xwininfo import convert identify tesseract file stdbuf flock; do
  command -v "$tool" > /dev/null 2>&1 || {
    echo "SKIP: $tool is not installed." >&2
    exit 2
  }
done
# Absolute: the Harness spawns in the data folder, so a relative path misses.
test_bin=$(cd "$(dirname "$test_bin")" && pwd)/$(basename "$test_bin")
root=$(cd "$(dirname "$0")/../.." && pwd)
. "$root/scripts/scenarios/wait-helpers.x11.sh"
out=$(mktemp -d "${TMPDIR:-/tmp}/fidget-scenario-first-run-chat-x11-$(date +%Y%m%d-%H%M%S)-XXXX")
results="$out/results.txt"
: > "$results"
started=()

fail() {
  echo "FAIL: $*" | tee -a "$results" >&2
  echo "evidence in $out" >&2
  exit 1
}
ok() { echo "ok: $*" | tee -a "$results"; }
# TERM to the tree of each process this run started, up to 3 s for all of them
# to exit, then kill -9 on what is left of those trees. Only by PID.
cleanup() {
  local tree=() p
  for p in "${started[@]}"; do mapfile -t -O "${#tree[@]}" tree < <(process_tree "$p"); done
  [ "${#tree[@]}" -gt 0 ] || return 0
  kill "${tree[@]}" 2> /dev/null || true
  wait_for_exit 3 "${tree[0]}" "${lock:-}" || kill -9 "${tree[@]}" 2> /dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The catalog's own scripts, unchanged. As of 2026-10 this is master.
if [ -z "$catalog" ]; then
  command -v curl > /dev/null 2>&1 || {
    echo "SKIP: curl is not installed and no catalog checkout was given." >&2
    exit 2
  }
  catalog="$out/catalog"
  mkdir -p "$catalog/code"
  at=https://raw.githubusercontent.com/AppImage/appimage.github.io/55438f6775cf2b973cfc565aec9f25e1ec81c432/code
  for f in take-screenshot.sh check-screenshot.sh; do
    curl -fsS --max-time 10 -o "$catalog/code/$f" "$at/$f" || fail "could not fetch the catalog's $f"
  done
fi
for f in take-screenshot.sh check-screenshot.sh; do
  [ -f "$catalog/code/$f" ] || fail "no code/$f in $catalog"
done

# The catalog's size (AppImage/appimage.github.io#10467).
exec {ready}< <(
  Xvfb -displayfd 1 -screen 0 800x600x24 -nolisten tcp 2> "$out/xvfb.log" &
  echo "pid $!"
  wait
)
read -r -t 3 _ xvfb <&"$ready" || fail "Xvfb did not start"
started+=("$xvfb")
read -r -t 3 n <&"$ready" || fail "Xvfb gave no display in 3 s; see $out/xvfb.log"
export DISPLAY=":$n"
# As the catalog's worker.sh exports them for WebKitGTK.
export WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1

root_events() { stdbuf -oL xprop -root -spy; }
root_prop_matches() { # <property> <ERE>
  wait_on_source 3 root_events grep -qEm1 "^$1\\(.*$2"
}
# The catalog's icewm preferences, in a HOME of its own.
mkdir -p "$out/icewm-home/.icewm"
printf 'ShowTaskBar = 0\nTaskBarAutoHide = 1\n' > "$out/icewm-home/.icewm/preferences"
wm=
start_icewm() {
  HOME="$out/icewm-home" icewm > "$out/icewm.log" 2>&1 &
  wm=$!
  started+=("$wm")
  root_prop_matches _NET_SUPPORTING_WM_CHECK 'window id' || fail "icewm did not start in 3 s"
}

frame='^[0-9]+ frame: '
closed='^[0-9]+ overlay: draft .* closed$'
landing='chat: first launch with no AI source'
served='^[0-9]+ chat-[^ ]+: opening served'
# <run name> <HOME> [env...]: start Fidget and wait until its overlay is ready.
# Setup posts the first-run Chat before the overlay's page can load.
launch() {
  local name=$1 home=$2
  run=$name
  shift 2
  mkdir -p "$home/.local/share/fidget"
  log="$home/.local/share/fidget/process.log"
  : > "$log"
  lock="$out/$name.lock"
  exec 9> "$lock"
  flock -n 9 || fail "$name: another run holds $lock"
  env HOME="$home" FIDGET_DIRECTOR_WAKE_SECS=600 FIDGET_TRACE_FRAMES=1 FIDGET_TRACE_BUBBLE=1 \
    FIDGET_CHARACTER=bmo FIDGET_CHARACTERS="$root/characters" "$@" \
    "$bin" > "$out/$name.app.log" 2>&1 &
  pid=$!
  started+=("$pid")
  exec 9>&-
  wait_for_trace 3 "$log" "$frame" || fail "$name: the Character did not draw in 3 s; see $log"
  wait_for_trace 3 "$log" "$closed" || fail "$name: the overlay never reported its pill in 3 s; see $log"
}
stop_app() {
  local tree=()
  mapfile -t tree < <(process_tree "$pid")
  kill "${tree[@]}" 2> /dev/null || true
  wait_for_exit 3 "$pid" "$lock" || fail "Fidget did not exit in 3 s"
  pid=
  cp "$log" "$out/$run.process.log"
}
# A mapped window of Fidget's that is not one of its "Fidget" windows
# (overlay, client leader, taskbar anchor). icewm's frames have no class.
chat_window() {
  local w
  for w in $(xdotool search --onlyvisible --classname '^fidget$' 2> /dev/null); do
    [ "$(xdotool getwindowname "$w" 2> /dev/null)" = Fidget ] && continue
    eval "$(xdotool getwindowgeometry --shell "$w")"
    # shellcheck disable=SC2153 # WIDTH comes from the eval above
    [ "$WIDTH" -gt 100 ] && echo "$w" && return 0
  done
  return 1
}
no_chat() { # <run name>
  ! grep -qE "$landing|$served| is open$" "$log" || fail "$1: Chat opened; see $log"
  ! chat_window > /dev/null || fail "$1: a Chat window is mapped"
}

# 1. First launch, no AI source: the catalog's run. Fidget starts before the
# window manager, as in worker.sh, which waits 10 s rather than for an event.
first="$out/first-home"
launch first "$first" env -u FIDGET_HARNESS -u FIDGET_DIRECTOR_API_KEY
wait_for_trace 3 "$log" "$served" || fail "first: Chat's landing was not served in 3 s; see $log"
chat_window > /dev/null || fail "first: no Chat window is mapped"
grep -qE "$landing" "$log" || fail "first: no first-run line in $log"
start_icewm
# Nothing gets focus here, so take-screenshot.sh crops to the largest window,
# the overlay, which is the whole screen. worker.sh's fit_main_window moves it
# to 0,0, where it already is.
check=$out/check.txt
catalog_passes() {
  (cd "$catalog" && bash code/take-screenshot.sh "$out/screenshot.png") > "$out/take.txt" 2>&1 || return 1
  (cd "$catalog" && bash code/check-screenshot.sh "$out/screenshot.png") > "$check" 2>&1 || return 1
  # A pass at 90% or more one colour is a mostly empty capture, not Chat.
  ! grep -q 'mostly empty' "$check"
}
# Chat repaints once icewm has framed it; worker.sh sleeps 2 s for that.
passed=0
wait_until 3 catalog_passes && passed=1
tee -a "$results" < "$out/take.txt"
tee -a "$results" < "$check"
[ "$passed" -eq 1 ] || fail "first: the catalog's check-screenshot.sh failed on $out/screenshot.png"
ok "first: Chat's landing is a mapped window and the catalog check passes"
stop_app

# 2. Second launch, still no AI source: settings.json exists, so no Chat.
launch second "$first" env -u FIDGET_HARNESS -u FIDGET_DIRECTOR_API_KEY
no_chat second
ok "second: a second launch opens no Chat"
stop_app

# 3. First launch with a Harness set: no Chat.
marks="$out/harness.log"
: > "$marks"
harness="$root/scripts/scenarios/fixture-harness.sh $test_bin script=slow count=$marks"
[ "$(wc -w <<< "$harness")" -eq 4 ] || fail "a path in the Harness line holds a space: $harness"
launch harness "$out/harness-home" FIDGET_HARNESS="$harness" FIDGET_DIRECTOR_API_KEY=x
no_chat harness
ok "harness: a first launch with a Harness set opens no Chat"
stop_app

echo "PASS: evidence in $out" | tee -a "$results"
