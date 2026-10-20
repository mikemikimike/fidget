#!/usr/bin/env bash
# Scenario: no-compositor-clip (X11)
# On screen: nothing on your display. A private 800x600 Xvfb display with
#   xfwm4 (compositing off), a plain window and Fidget as a standing BMO;
#   picom starts and stops partway through.
# Input: none.
# Duration: about 3 s; every wait gives up 3 s after its trigger.
# Grants: Xvfb, xfwm4, xsetroot, xprop, picom and python3 with Pillow.
# Asserts: with no compositor the screen shows the desktop, not black, around
#   the Character (#1699); picom starting changes nothing; picom stopping
#   brings back the clip.
#
# Usage: no-compositor-clip.x11.sh --go <fidget binary>
# Without --go it prints this header, which is the takeover prompt, and exits 2.
set -euo pipefail

if [ "${1:-}" != --go ]; then
  sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0" || true
  exit 2
fi
bin=${2:?usage: no-compositor-clip.x11.sh --go <fidget binary>}
for tool in Xvfb xfwm4 xsetroot xprop picom python3 stdbuf flock; do
  command -v "$tool" > /dev/null 2>&1 || {
    echo "SKIP: $tool is not installed." >&2
    exit 2
  }
done
python3 -c 'from PIL import ImageGrab' 2> /dev/null || {
  echo "SKIP: python3 has no Pillow." >&2
  exit 2
}
root=$(cd "$(dirname "$0")/../.." && pwd)
. "$root/scripts/scenarios/wait-helpers.x11.sh"
helper="$root/scripts/scenarios/no-compositor-clip.py"
out=$(mktemp -d "${TMPDIR:-/tmp}/fidget-scenario-no-compositor-clip-x11-$(date +%Y%m%d-%H%M%S)-XXXX")
mkdir -p "$out/home/.local/share/fidget" "$out/characters"
log="$out/home/.local/share/fidget/process.log" results="$out/results.txt"
: > "$log"
: > "$results"
echo '{"first_run_tour_shown": true}' > "$out/home/.local/share/fidget/settings.json"
started=()

fail() {
  echo "FAIL: $*" | tee -a "$results" >&2
  echo "evidence in $out" >&2
  exit 1
}
ok() { echo "ok: $*" | tee -a "$results"; }
lock="$out/run.lock"
exec 9> "$lock"
flock -n 9 || fail "another run holds $lock"
# TERM to the tree of each process this run started, up to 3 s for all of them
# to exit, then kill -9 on what is left of those trees. Only by PID.
cleanup() {
  local tree=() p
  exec 9>&-
  for p in "${started[@]}"; do mapfile -t -O "${#tree[@]}" tree < <(process_tree "$p"); done
  [ "${#tree[@]}" -gt 0 ] || return 0
  kill "${tree[@]}" 2> /dev/null || true
  wait_for_exit 3 "${tree[0]}" "$lock" || kill -9 "${tree[@]}" 2> /dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

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

root_events() { stdbuf -oL xprop -root -spy; }
root_prop_matches() { # <property> <ERE>
  wait_on_source 3 root_events grep -qEm1 "^$1\\(.*$2"
}
xfwm4 --compositor=off > "$out/xfwm4.log" 2>&1 &
started+=($!)
root_prop_matches _NET_SUPPORTING_WM_CHECK 'window id' || fail "xfwm4 did not start in 3 s"
! python3 "$helper" cm || fail "a compositor owns _NET_WM_CM_S0 before the run"
# After xfwm4, which paints the root its own colour as it starts.
xsetroot -solid '#3a6ea5'
# Smaller than the display: a full-display window would hide the Character as full screen.
exec {plain}< <(
  python3 "$helper" window a5703a 600 400 &
  echo "$!"
  wait
)
read -r -t 3 plain_pid <&"$plain" || fail "the plain window did not start"
started+=("$plain_pid")
read -r -t 3 plain_window <&"$plain" || fail "the plain window did not map"
root_prop_matches _NET_CLIENT_LIST "$(printf '0x%x' "$plain_window")" || fail "xfwm4 did not manage the plain window"

cp -R "$root/characters/bmo" "$out/characters/"
sed -E '/^play = /s/"walk"/"idle"/g' "$root/characters/bmo/character.manifest" > "$out/characters/bmo/character.manifest"
env HOME="$out/home" FIDGET_DIRECTOR_WAKE_SECS=600 FIDGET_TRACE_FRAMES=1 \
  FIDGET_CHARACTER=bmo FIDGET_CHARACTERS="$out/characters" \
  "$bin" > "$out/app.log" 2>&1 &
pid=$!
started+=("$pid")
exec 9>&-

frame='^[0-9]+ frame: '
wait_for_trace 3 "$log" "$frame.* (Grounded|Perched) " || fail "the Character did not land in 3 s; see $log"
read -r sw sh < <(sed -nE 's/.* overlay: .*sprite ([0-9]+)x([0-9]+);.*/\1 \2/p' "$log" | head -1) || fail "no sprite size in $log"
read -r sx sy < <(grep -E "$frame" "$log" | tail -1 | sed -E 's/.* sprite\((-?[0-9]+),(-?[0-9]+)\).*/\1 \2/') || fail "no sprite position in $log"
uncomposited() { ! python3 "$helper" cm; }
clipped() { # <capture name>
  python3 "$helper" shot "$out/$1.png" "$sx" "$sy" "$sw" "$sh" > "$out/$1.txt"
}
expect_clipped() { # <case>
  wait_until 3 clipped "$1" || fail "$1: $(cat "$out/$1.txt"); see $out/$1.png"
  ok "$1: $(cat "$out/$1.txt")"
}

# 1. No compositor: the overlay shows only what it draws.
expect_clipped no-compositor

# 2. picom starting mid-run changes nothing on screen.
picom --backend xrender > "$out/picom.log" 2>&1 &
picom_pid=$!
started+=("$picom_pid")
wait_until 3 python3 "$helper" cm || fail "picom did not take _NET_WM_CM_S0 in 3 s; see $out/picom.log"
expect_clipped picom

# 3. picom stopping brings back the clip.
kill "$picom_pid"
wait "$picom_pid" 2> /dev/null || true
wait_until 3 uncomposited || fail "_NET_WM_CM_S0 still has an owner after picom exited"
expect_clipped picom-stopped

echo "PASS: evidence in $out" | tee -a "$results"
