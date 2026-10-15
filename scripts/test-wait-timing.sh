#!/usr/bin/env bash
# Proof timing test for wait_for_trace and wait_for_marks
# Writes a line at ~150ms and measures how long the wait takes to return
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
. "$root/scripts/scenarios/wait-helpers.x11.sh"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

log="$tmpdir/test.log"
marks="$tmpdir/marks.txt"
touch "$log" "$marks"

echo "Testing wait_for_trace..."
start_ms=$(($(date +%s%N) / 1000000))
(sleep 0.15 && echo "test pattern match" >> "$log") &
wait_for_trace 3 "$log" "test pattern" || {
  echo "FAIL: wait_for_trace timed out"
  exit 1
}
end_ms=$(($(date +%s%N) / 1000000))
elapsed_ms=$((end_ms - start_ms))
echo "wait_for_trace returned in ${elapsed_ms}ms (line appeared at ~150ms)"
if [ "$elapsed_ms" -gt 500 ]; then
  echo "FAIL: took more than 500ms (expected ~150-300ms)"
  exit 1
fi
echo "PASS: wait_for_trace is fast"

echo ""
echo "Testing wait_for_marks..."
start_ms=$(($(date +%s%N) / 1000000))
(sleep 0.15 && echo "marker pattern" >> "$marks") &
wait_for_marks 3 "$marks" "marker pattern" || {
  echo "FAIL: wait_for_marks timed out"
  exit 1
}
end_ms=$(($(date +%s%N) / 1000000))
elapsed_ms=$((end_ms - start_ms))
echo "wait_for_marks returned in ${elapsed_ms}ms (line appeared at ~150ms)"
if [ "$elapsed_ms" -gt 500 ]; then
  echo "FAIL: took more than 500ms (expected ~150-300ms)"
  exit 1
fi
echo "PASS: wait_for_marks is fast"

echo ""
echo "All timing tests passed"
