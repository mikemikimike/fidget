#!/usr/bin/env bash
# CPU% of one core and voluntary context switches/s on Linux, for the fidget
# tree and each --watch name=pid (X server, WM, compositor), read from /proc over
# one window. The caller provides DISPLAY or WAYLAND_DISPLAY.
# ponytail: /proc counters, not powertop or cpuidle residency. They need no root
# and run in a container, but miss interrupt wakeups and C-states. Use powertop
# on bare metal that has /sys/devices/system/cpu/cpu0/cpuidle.
set -euo pipefail

usage() {
  echo "Usage: $0 <baseline|idle|walking|chat|pill> --bin PATH [--seconds N] [--out DIR] [--watch name=pid]..." >&2
  exit 2
}
scenario="" bin="" seconds=60 out="" watch=()
while [ $# -gt 0 ]; do
  case "$1" in
    baseline | idle | walking | chat | pill) scenario=$1 && shift ;;
    --bin) bin=$2 && shift 2 ;;
    --seconds) seconds=$2 && shift 2 ;;
    --out) out=$2 && shift 2 ;;
    --watch) watch+=("$2") && shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$scenario" ] || usage
[ "$scenario" = baseline ] || [ -x "$bin" ] || usage
root=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/scenarios/helpers/wait-helpers.sh
. "$root/scripts/scenarios/helpers/wait-helpers.sh"
# shellcheck source=scripts/bench-linux-helpers.sh
. "$root/scripts/bench-linux-helpers.sh"
out=${out:-$(mktemp -d /tmp/fidget-wakeups-XXXXXX)}
mkdir -p "$out/home/.local/share/fidget"
log="$out/home/.local/share/fidget/process.log"
: > "$log"
# An existing settings file is not a first launch, which would open Chat.
echo '{"first_run_tour_shown": true}' > "$out/home/.local/share/fidget/settings.json"
pid=""
focus="$out/focus.pid" # the xmessage window that walking focuses, while it is up
cleanup() {
  stop_fidget
  [ ! -s "$focus" ] || kill "$(cat "$focus")" 2> /dev/null || true
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*; evidence in $out" >&2
  exit 1
}
# ponytail: walking and the pill run on X11 only. Wayland gives fidget no
# frontmost app to wake the Director, and headless weston has no seat to hover
# with. A compositor with a virtual pointer and focus events would lift this.
case "$scenario" in
  walking | pill) [ -n "${DISPLAY:-}" ] || fail "$scenario needs X11: Wayland gives fidget no focus change or pointer to trigger it" ;;
esac

# One copy of BMO that plays only <behavior>, untriggered. [walks] replaces its
# play list with that many 600 ms walk Primitives, so it walks the whole window.
# ponytail: walk-only is not pure walking. Every wall contact is a climb and a
# fall, so the 2026-10-23 window was 67% walk and 26% climb. A Character setting
# that turns the sprite at a wall would make it pure walking.
character() { # <behavior> [walks]
  local dir="$out/characters"
  mkdir -p "$dir" && cp -R "$root/characters/bmo" "$dir/"
  awk -v keep="[behaviors.$1]" -v walks="${2:-0}" '/^\[/ { section = $0 }
    /^weight = / && section ~ /^\[behaviors\./ && section != keep { $0 = "weight = 0" }
    /^when = / && section == keep { next }
    /^play = / && section == keep && walks > 0 {
      $0 = "play = [\"walk\""; for (i = 1; i < walks; i++) $0 = $0 ", \"walk\""; $0 = $0 "]" }
    1' "$root/characters/bmo/character.manifest" > "$dir/bmo/character.manifest"
  echo "$dir"
}

# Opening or closing a window changes the frontmost app, which wakes the
# Director within a second instead of on its 20 s timer.
# ponytail: a focus change, not a direct trigger, so walking needs X11 and
# xmessage, and each change maps a window in the sample. A way to start a
# Behavior from outside fidget would replace it.
toggle_focus() {
  if [ -s "$focus" ]; then
    kill "$(cat "$focus")" && : > "$focus"
  else
    xmessage -geometry +0+0 "fidget wakeups bench" > /dev/null 2>&1 &
    echo $! > "$focus"
  fi
  echo "$(date +%s.%N) focus" >> "$out/focus.log"
}
# Reaching the display's side ends a walk with a climb and a fall, and the
# sprite would stand idle until the timer. Each first idle frame wakes it again.
keep_walking() {
  local line moved=""
  while IFS= read -r line; do
    case "$line" in
      *" frame: "*" idle#"*) [ -z "$moved" ] || toggle_focus && moved="" ;;
      *" frame: "*) moved=1 ;;
    esac
  done
}

sample() {
  local targets=("${watch[@]}") p from
  if [ -n "$pid" ]; then
    for p in $(process_tree "$pid" | tac); do targets+=("$(cat "/proc/$p/comm")=$p"); done
  fi
  proc_snapshot "${targets[@]}" > "$out/before.tsv"
  from=$(wc -l < "$log")
  sleep "$seconds" # the measurement window, not a wait for state
  {
    printf 'process\tpid\tcpu_pct\tvoluntary_per_s\n'
    wakeup_rows "$out/before.tsv" "$seconds" "$(getconf CLK_TCK)"
  } > "$out/result.tsv"
  frame_counts "$log" "$from" > "$out/frames.txt"
  cat "$out/result.tsv" "$out/frames.txt"
}

[ "$scenario" = baseline ] && sample && exit 0
if [ "$scenario" = walking ]; then
  # 5/3 walks a second at 600 ms each, for the window plus 5 s of startup.
  chars=$(character walk "$(((seconds + 5) * 5 / 3 + 1))")
else
  chars=$(character fidget)
fi
park_pointer # a pointer left on the sprite would hover it
open_chat=""
[ "$scenario" != chat ] || open_chat=1
env -u FIDGET_DIRECTOR_API_KEY HOME="$out/home" FIDGET_TRACE_FRAMES=1 FIDGET_TRACE_BUBBLE=1 \
  FIDGET_CHARACTERS="$chars" FIDGET_INSTANCES=BMO FIDGET_HOVER_DELAY_MS=300 \
  ${open_chat:+FIDGET_OPEN_CHAT=1} "$bin" > "$out/app.log" 2>&1 &
pid=$!
wait_for_trace 3 "$log" ' overlay: [0-9]+ display' || fail "fidget did not come up"
# Each window starts at the first idle frame on the floor, after the landing.
wait_for_trace 3 "$log" 'frame: [0-9]+ (Grounded|Perched) .* idle#' || fail "no idle frame after landing"
case "$scenario" in
  chat) wait_for_trace 3 "$log" 'chat: .* is open' || fail "Chat did not open" ;;
  walking)
    # The sprite climbs to y=64 at either side, and (2, 2) would hover it there.
    read -r width _ < <(xdotool getdisplaygeometry)
    xdotool mousemove "$((width / 2))" 2
    walks=$(line_count "$log" ' walk#')
    toggle_focus
    wait_for_count 3 "$log" ' walk#' "$walks" || fail "no walk within 3 s of the focus change"
    follow 0 "$log" | keep_walking &
    ;;
  pill)
    read -r x y < <(sprite_center "$log") || fail "no sprite position"
    drafts=$(line_count "$log" 'overlay: draft .* text=')
    xdotool mousemove "$x" "$y"
    wait_for_count 3 "$log" 'overlay: draft .* text=' "$drafts" || fail "the pill did not open"
    ;;
esac
sample
[ "$scenario" != walking ] || echo "focus changes, the first included: $(wc -l < "$out/focus.log")"
[ "$scenario" != pill ] || ! grep 'overlay: draft' "$log" | tail -1 | grep -q closed || fail "the pill closed in the window"
