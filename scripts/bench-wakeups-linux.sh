#!/usr/bin/env bash
# Idle wakeups on Linux (#432): CPU% of one core and voluntary context switches/s
# for the fidget tree and any --watch name=pid (X server, WM, compositor), read
# from /proc over one window. The caller provides DISPLAY or WAYLAND_DISPLAY.
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
out=${out:-$(mktemp -d /tmp/fidget-wakeups-XXXXXX)}
mkdir -p "$out/home/.local/share/fidget"
log="$out/home/.local/share/fidget/process.log"
: > "$log"
# An existing settings file is not a first launch, which would open Chat.
echo '{"first_run_tour_shown": true}' > "$out/home/.local/share/fidget/settings.json"
pid=""
cleanup() {
  [ -n "$pid" ] || return 0
  local tree
  mapfile -t tree < <(pgrep -P "$pid")
  kill "${tree[@]}" "$pid" 2> /dev/null || true
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*; evidence in $out" >&2
  exit 1
}

# One copy of BMO that plays only <behavior>, untriggered: idle holds still, walk walks.
character() { # <behavior>
  local dir="$out/characters"
  mkdir -p "$dir" && cp -R "$root/characters/bmo" "$dir/"
  awk -v keep="[behaviors.$1]" '/^\[/ { section = $0 }
    /^weight = / && section ~ /^\[behaviors\./ && section != keep { $0 = "weight = 0" }
    /^when = / && section == keep { next }
    1' "$root/characters/bmo/character.manifest" > "$dir/bmo/character.manifest"
  echo "$dir"
}
# Event-driven on log lines: fails after 3 s with no line, or [budget] s
# (default 3) after the first frame line (the app is up) without a match.
wait_log() { # <ERE> [budget]
  local line deadline="" budget=${2:-3}
  while IFS= read -r -t 3 line; do
    [[ $line =~ $1 ]] && return 0
    [[ -z $deadline && $line == *" frame: "* ]] && deadline=$((SECONDS + budget))
    [[ -z $deadline || $SECONDS -lt $deadline ]] || return 1
  done < <(tail -s 0.05 --pid="$pid" -n +1 -F "$log" 2> /dev/null)
  return 1
}
pointer() { [ -z "${DISPLAY:-}" ] || xdotool mousemove "$1" "$2"; }

ticks() { awk '{ sub(/.*\) /, ""); split($0, f, " "); print f[12] + f[13] }' "/proc/$1/stat"; }
switches() { awk '/^voluntary_ctxt_switches/ { print $2 }' "/proc/$1/status"; }
sample() {
  local targets=("${watch[@]}") p name hz t0=() v0=() i
  if [ -n "$pid" ]; then
    targets+=("fidget=$pid")
    for p in $(pgrep -P "$pid"); do targets+=("$(cat "/proc/$p/comm")=$p"); done
  fi
  for i in "${!targets[@]}"; do
    p=${targets[$i]#*=}
    t0[i]=$(ticks "$p") v0[i]=$(switches "$p")
  done
  local start
  start=$(wc -l < "$log")
  sleep "$seconds" # the measurement window, not a wait for state
  hz=$(getconf CLK_TCK)
  printf 'process\tpid\tcpu_pct\tvoluntary_per_s\n' > "$out/result.tsv"
  for i in "${!targets[@]}"; do
    name=${targets[$i]%%=*} p=${targets[$i]#*=}
    awk -v n="$name" -v p="$p" -v t="$(($(ticks "$p") - t0[i]))" -v v="$(($(switches "$p") - v0[i]))" \
      -v s="$seconds" -v hz="$hz" 'BEGIN { printf "%s\t%s\t%.1f\t%.1f\n", n, p, 100 * t / hz / s, v / s }' >> "$out/result.tsv"
  done
  tail -n +"$((start + 1))" "$log" | grep -oE ' frame: .* [a-z]+#' | grep -oE '[a-z]+#$' | sort | uniq -c > "$out/frames.txt" || true
  cat "$out/result.tsv" "$out/frames.txt"
}

[ "$scenario" = baseline ] && sample && exit 0
behavior=fidget
[ "$scenario" = walking ] && behavior=walk
chars=$(character "$behavior")
pointer 2 2 # a pointer left on the sprite would hover it
env -u FIDGET_DIRECTOR_API_KEY HOME="$out/home" FIDGET_TRACE_FRAMES=1 FIDGET_TRACE_BUBBLE=1 \
  FIDGET_CHARACTERS="$chars" FIDGET_INSTANCES=BMO FIDGET_HOVER_DELAY_MS=300 \
  ${FIDGET_OPEN_CHAT:+FIDGET_OPEN_CHAT=1} "$bin" > "$out/app.log" 2>&1 &
pid=$!
landed='frame: [0-9]+ (Grounded|Perched) '
case "$scenario" in
  idle) wait_log "$landed" || fail "no landing" && pointer 2 2 ;;
  # StaticDirector picks a Behavior once per WAKE_EVERY (20 s), at a random phase.
  walking) wait_log ' walk#' 21 || fail "no walk frame" && pointer 2 2 ;;
  chat)
    wait_log 'chat: .* is open' || fail "Chat did not open"
    wait_log "$landed" || fail "no landing" && pointer 2 2
    ;;
  pill)
    wait_log "$landed" || fail "no landing"
    read -r w h < <(sed -nE 's/.*overlay: .*sprite ([0-9]+)x([0-9]+);.*/\1 \2/p' "$log" | head -1)
    read -r x y < <(grep -E "$landed" "$log" | tail -1 | sed -E 's/.* sprite\((-?[0-9]+),(-?[0-9]+)\).*/\1 \2/')
    pointer 2 2 && pointer "$((x + w / 2))" "$((y + h / 2))"
    wait_log 'overlay: draft .* text=' || fail "the pill did not open"
    ;;
esac
sample
[ "$scenario" != pill ] || ! grep 'overlay: draft' "$log" | tail -1 | grep -q closed || fail "the pill closed in the window"
