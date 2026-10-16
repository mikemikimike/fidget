#!/usr/bin/env bash
# Scenario wrapper (macOS): runs every automated macOS leaf, one after another,
#   as one GUI takeover.
# On screen: each leaf launches its own Fidget/BMO with a fixture Harness and
#   quits it before the next starts.
# Input: real synthetic clicks where a leaf needs them (the sprite, the
#   landing's link, Chat's title and composer). Hands off while it runs.
# Duration: about 2-3 min for all of them, 10 min at most.
# Grants: Screen Recording and Accessibility for the terminal that runs it.
# Isolation: TMPDIR points under <evidence dir> for the whole run, and each leaf
#   runs Fidget with a private HOME there.
# Asserts: each leaf's own checks. Prints one line per leaf with its result and
#   duration, then a summary. Exit 1 if any leaf failed.
# Manual: codex-sign-in-link and hero-gif need a person (a sign-in, the
#   throws); pass --manual to add them at the end. antigravity-sign-in also
#   needs its agy_acp_server.par, so it runs on its own.
#
# Usage: run-all.sh --go <fidget binary> <fidget test binary> <evidence dir> [--manual]
# Without --go it prints this header, which is the takeover prompt, and exits 2.
set -uo pipefail

if [ "${1:-}" != --go ]; then
  sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0" || true
  exit 2
fi
usage="usage: run-all.sh --go <fidget binary> <fidget test binary> <evidence dir> [--manual]"
bin=${2:?$usage}
test_bin=${3:?$usage}
evidence=${4:?$usage}
manual=
[ "${5:-}" = --manual ] && manual=1
here=$(cd "$(dirname "$0")" && pwd)
bin=$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")
test_bin=$(cd "$(dirname "$test_bin")" && pwd)/$(basename "$test_bin")

# <leaf> <takes the test binary: 1 or 0> <time limit in seconds>
leaves=(
  "thinking-row 1 60"
  "chat-level 1 60"
  "chat-header-narrow 1 60"
  "launcher-dies-at-startup 1 90"
  "landing-link-click 0 60"
  "sign-in-button 1 60"
  "question-bubble 1 90"
  "streaming-bubble 1 60"
  "control-click-menu 1 90"
  "poke-mid-climb 0 120"
  "chat-perch 1 150"
)
[ -z "$manual" ] || leaves+=("codex-sign-in-link 0 1200" "hero-gif 1 180")

run="$evidence/scenarios-macos-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$run/tmp"
export TMPDIR="$run/tmp/"
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }

# chat-perch runs on prebuilt helpers; build them before its turn, not in it.
bash "$here/chat-perch.sh" --prepare > "$run/chat-perch.prepare.txt" 2>&1 ||
  echo "note: chat-perch --prepare failed; see $run/chat-perch.prepare.txt"

pass=0 failed=0 skipped=0
start=$(now_ms)
for entry in "${leaves[@]}"; do
  read -r name wants limit <<< "$entry"
  args=(--go "$bin")
  [ "$wants" = 1 ] && args+=("$test_bin")
  t0=$(now_ms)
  # A leaf's own traps quit its Fidget; the limit only guards a hung leaf.
  bash "$here/$name.sh" "${args[@]}" > "$run/$name.out.txt" 2>&1 &
  leaf=$!
  (
    sleep "$limit"
    pkill -TERM -P "$leaf" 2> /dev/null
    kill -TERM "$leaf" 2> /dev/null
  ) > /dev/null 2>&1 &
  guard=$!
  wait "$leaf"
  code=$?
  kill "$guard" 2> /dev/null
  wait "$guard" 2> /dev/null
  case $code in
    0) status=PASS pass=$((pass + 1)) ;;
    2) status=SKIP skipped=$((skipped + 1)) ;;
    *) status=FAIL failed=$((failed + 1)) ;;
  esac
  last=$(grep -E '^(PASS|FAIL|SKIP)' "$run/$name.out.txt" | tail -1)
  echo "$status $name ($(($(now_ms) - t0))ms) $last"
done
echo "summary: $pass passed, $failed failed, $skipped skipped in $(($(now_ms) - start))ms; evidence in $run"
[ "$failed" -eq 0 ]
