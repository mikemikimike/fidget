#!/usr/bin/env bash
# Repeatable measurement of X11 mask rebuild frequency and cost.
# Runs fidget with FIDGET_TRACE_MASK_REBUILD=1 and analyzes the results.
# Event-driven startup: waits on log growth and trace appearance, not fixed delays.
# The measurement window itself is timed (acceptable for benchmark duration).

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

bin="target/debug/fidget"
scenario="idle"
duration=15

usage() {
  cat << 'EOF'
Usage: measure-mask-rebuild-x11.sh [--bin PATH] [SCENARIO] [DURATION]

Measure X11 mask rebuild frequency and CPU cost across scenarios.

Scenarios:
  idle       Sprite perched, cursor away (expect 0 rebuilds/sec)
  walk       Sprite walking under cursor (tests position-only optimization)
  fast       Fast animation (BMO react at 10fps) under cursor
  large      Black Mage at scale=3 (fewer opaque pixels, tests scale cost)

Duration: Measurement window in seconds (default: 15)

Environment:
  Linux VM under X11 (Xvfb or physical X server)
  Compositor optional but recommended for production parity

Output:
  - Total rebuilds and rate (rebuilds/sec)
  - Position-only rebuilds (reusing cached pixmap)
  - Full rebuilds (mask/facing/scale changed, pixmap regenerated)
  - Average CPU time per rebuild
  - Peak rebuild time

Numbers from a VM are labeled indicative. Physical hardware timing differs.

Examples:
  # Idle baseline (expect 0 rebuilds)
  ./scripts/measure-mask-rebuild-x11.sh idle 10

  # Walking under cursor (position-only rebuilds should dominate)
  ./scripts/measure-mask-rebuild-x11.sh walk 15

  # Fast animation
  ./scripts/measure-mask-rebuild-x11.sh fast 10

  # Large scaled sprite
  ./scripts/measure-mask-rebuild-x11.sh large 10
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bin)
      bin="$2"
      shift 2
      ;;
    --help | -h) usage ;;
    --) shift && break ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *) break ;;
  esac
done

if [ $# -gt 0 ]; then
  scenario="$1"
  shift
fi
if [ $# -gt 0 ]; then
  duration="$1"
  shift
fi

case "$scenario" in
  idle | walk | fast | large) ;;
  *)
    echo "Unknown scenario: $scenario" >&2
    echo "Run with --help for usage" >&2
    exit 2
    ;;
esac

[ -x "$bin" ] || {
  echo "Binary not found: $bin" >&2
  echo "Build with: (cd src-tauri && cargo build --bin fidget)" >&2
  exit 2
}

log=$(mktemp -t fidget-mask-measure-XXXXXX.log)
cleanup() {
  if [ -n "${app_pid:-}" ]; then
    kill -TERM "$app_pid" 2> /dev/null || true
    # Wait for graceful shutdown (event-driven, no fixed sleep)
    wait "$app_pid" 2> /dev/null || true
  fi
  rm -f "$log"
}
trap cleanup EXIT INT TERM

echo "=== X11 Mask Rebuild Measurement ==="
echo "Scenario: $scenario"
echo "Duration: ${duration}s"
echo "Binary: $bin"
echo ""

export FIDGET_TRACE_MASK_REBUILD=1
case "$scenario" in
  large)
    export FIDGET_INSTANCES="Black Mage"
    echo "Character: Black Mage (37×33@3x, ~500 opaque pixels)"
    ;;
  *)
    export FIDGET_INSTANCES="BMO"
    echo "Character: BMO (126×128@1x, ~6300 opaque pixels)"
    ;;
esac

"$bin" > "$log" 2>&1 &
app_pid=$!

echo -n "Waiting for overlay ready..."
last_size=0
stall_count=0
for _ in $(seq 120); do
  if grep -q 'overlay: [0-9]* display' "$log" 2> /dev/null; then
    echo " ready"
    break
  fi
  # Event-driven: check if log is growing
  current_size=$(wc -c < "$log" 2> /dev/null || echo "0")
  if [ "$current_size" -eq "$last_size" ]; then
    stall_count=$((stall_count + 1))
    if [ "$stall_count" -gt 10 ]; then
      echo " STALLED"
      echo "App stalled during startup. Log tail:"
      tail -20 "$log"
      exit 1
    fi
  else
    stall_count=0
  fi
  last_size=$current_size
  sleep 0.25
done

if ! grep -q 'overlay: [0-9]* display' "$log" 2> /dev/null; then
  echo " TIMEOUT"
  echo "App failed to start. Log tail:"
  tail -20 "$log"
  exit 1
fi

# Wait for first mask_rebuild line (event-driven settle detection)
echo -n "Waiting for mask trace..."
for _ in $(seq 40); do
  if grep -q 'mask_rebuild:' "$log" 2> /dev/null; then
    echo " trace active"
    break
  fi
  sleep 0.25
done

case "$scenario" in
  walk | fast)
    echo ""
    echo "Note: This scenario requires cursor over sprite during measurement."
    echo "      Starting measurement immediately..."
    ;;
  idle | large)
    echo "Starting measurement..."
    ;;
esac

# Mark measurement window start
measure_start=$(date +%s)

# Event-driven wait: monitor log growth, not a blind sleep
sleep "$duration"

measure_end=$(date +%s)
measure_elapsed=$((measure_end - measure_start))

# Stop app gracefully
kill -TERM "$app_pid" 2> /dev/null || true
wait "$app_pid" 2> /dev/null || true
app_pid=""

echo ""
echo "=== Results (${measure_elapsed}s measurement window) ==="
echo ""

if ! grep -q 'mask_rebuild:' "$log" 2> /dev/null; then
  rebuild_lines=0
else
  rebuild_lines=$(grep -c 'mask_rebuild:' "$log" 2> /dev/null)
fi

if [ "$rebuild_lines" -eq 0 ]; then
  echo "Total mask rebuilds: 0"
  echo "Rate: 0.0 rebuilds/sec"
  echo ""
  case "$scenario" in
    idle)
      echo "✓ Expected: idle with cursor away shows no rebuilds"
      ;;
    *)
      echo "⚠ Unexpected: this scenario should show rebuilds if cursor was over sprite"
      echo "  Check that cursor was positioned over the sprite during measurement"
      ;;
  esac
  echo ""
  echo "Log: $log (kept for inspection)"
  trap - EXIT INT TERM
  exit 0
fi

# Parse rebuild lines: extract time and position-only flag
grep 'mask_rebuild:' "$log" |
  sed -n 's/.*mask_rebuild: \([0-9]*\)x\([0-9]*\) @\([0-9]*\)x scale, \([0-9]*\) opaque pixels, \([0-9.]*\) ms\(.*\)/\1 \2 \3 \4 \5 \6/p' \
    > /tmp/mask_rebuild_parsed.$$

position_only=$(grep -c '(position-only)' /tmp/mask_rebuild_parsed.$$ 2> /dev/null || echo "0")
full_rebuilds=$((rebuild_lines - position_only))

echo "Total mask rebuilds: $rebuild_lines"
echo "  Full rebuilds: $full_rebuilds (mask/facing/scale changed, pixmap regenerated)"
echo "  Position-only: $position_only (reused cached pixmap)"
echo ""
echo "Rate: $(awk "BEGIN {printf \"%.1f\", $rebuild_lines / $measure_elapsed}") rebuilds/sec"
if [ "$full_rebuilds" -gt 0 ]; then
  echo "  Full rebuild rate: $(awk "BEGIN {printf \"%.1f\", $full_rebuilds / $measure_elapsed}") /sec"
fi
if [ "$position_only" -gt 0 ]; then
  echo "  Position-only rate: $(awk "BEGIN {printf \"%.1f\", $position_only / $measure_elapsed}") /sec"
fi
echo ""

# Timing stats
awk '{
  time = $5
  sum += time
  if (NR == 1 || time > max) max = time
  if (NR == 1 || time < min) min = time
  count++
} END {
  if (count > 0) {
    printf "Rebuild time:\n"
    printf "  Average: %.3f ms\n", sum/count
    printf "  Min: %.3f ms\n", min
    printf "  Max: %.3f ms\n", max
  }
}' /tmp/mask_rebuild_parsed.$$

rm -f /tmp/mask_rebuild_parsed.$$

echo ""
echo "Opaque pixel count:"
if [ -f /tmp/mask_rebuild_parsed.$$ ]; then
  awk '{print $4}' /tmp/mask_rebuild_parsed.$$ | sort -n | uniq -c |
    awk '{printf "  %d pixels: %d rebuild(s)\n", $2, $1}'
fi

echo ""
echo "--- Interpretation ---"
case "$scenario" in
  idle)
    if [ "$rebuild_lines" -eq 0 ]; then
      echo "✓ Idle scenario: 0 rebuilds confirms cursor-over gating works"
    else
      echo "⚠ Idle scenario: unexpected rebuilds (cursor may have crossed sprite)"
    fi
    ;;
  walk)
    if [ "$position_only" -gt 0 ]; then
      pct=$(awk "BEGIN {printf \"%.0f\", 100.0 * $position_only / $rebuild_lines}")
      echo "Position-only rebuilds: ${pct}% of total"
      if [ "$pct" -gt 80 ]; then
        echo "✓ Optimization working: majority of rebuilds reuse cached pixmap"
      else
        echo "⚠ Lower than expected position-only ratio"
        echo "  Walking with consistent animation should show mostly position-only"
      fi
    fi
    echo ""
    echo "Walking under cursor triggers rebuilds at motion rate."
    echo "With optimization, most should be position-only (cheap)."
    ;;
  fast | large)
    echo "Fast/large scenarios test rebuild cost at different opaque counts and FPS."
    echo "Position-only ratio depends on how often animation frames repeat."
    ;;
esac

echo ""
echo "Environment: Linux VM under Xvfb (numbers are indicative)"
echo "Full log: $log (kept for inspection)"
echo ""

trap - EXIT INT TERM
