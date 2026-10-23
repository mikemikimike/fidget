# shellcheck shell=bash
# /proc and pointer helpers shared by the Linux benches. Rates read
# ${proc:-/proc}, so a test can point them at a fake tree.

# utime + stime in clock ticks. The fields after the last ')' skip a comm
# that holds spaces or parentheses.
proc_ticks() { # <pid>
  awk -F')' '{ split($NF, a, " "); print a[12] + a[13] }' "${proc:-/proc}/$1/stat"
}

proc_switches() { # <pid>
  awk '/^voluntary_ctxt_switches:/ { print $2 }' "${proc:-/proc}/$1/status"
}

# One "name pid ticks switches" line per name=pid, the start of a window.
proc_snapshot() { # <name=pid>...
  local target
  for target in "$@"; do
    printf '%s\t%s\t%s\t%s\n' "${target%%=*}" "${target#*=}" \
      "$(proc_ticks "${target#*=}")" "$(proc_switches "${target#*=}")"
  done
}

# For each snapshot line: name, pid, CPU% of one core and voluntary context
# switches per second since the snapshot, over a window of <seconds>. A process
# that exited in the window, such as a gst-plugin-scanner, has no row.
wakeup_rows() { # <snapshot file> <seconds> <clock ticks per second>
  local name pid ticks switches
  while IFS=$'\t' read -r name pid ticks switches; do
    [ -r "${proc:-/proc}/$pid/stat" ] || continue
    awk -v n="$name" -v p="$pid" -v t="$(($(proc_ticks "$pid") - ticks))" \
      -v v="$(($(proc_switches "$pid") - switches))" -v s="$2" -v hz="$3" \
      'BEGIN { printf "%s\t%s\t%.1f\t%.1f\n", n, p, 100 * t / hz / s, v / s }'
  done < "$1"
}

# Frame lines after line <from>, counted per animation (the name before #).
frame_counts() { # <log> <from>
  awk -v from="$2" 'NR > from && / frame: [0-9]+ / && match($0, / [a-z-]+#[0-9]+ /) {
      n[substr($0, RSTART + 1, index(substr($0, RSTART + 1), "#") - 1)]++ }
    END { for (a in n) printf "%s\t%d\n", a, n[a] }' "$1" | sort
}

park_pointer() {
  if [ -n "${DISPLAY:-}" ] && command -v xdotool > /dev/null 2>&1; then
    xdotool mousemove 2 2 > /dev/null 2>&1 || true
  fi
}

# The middle of the sprite box, top-left plus half the reported size, from the
# last Grounded or Perched frame after line $2. A climb or perch puts the feet on
# an edge, so the feet are not a safe aim, and a falling sprite has moved on.
sprite_center() {
  local log=$1
  local from=${2:-0}
  awk -v from="$from" '
    /overlay: [0-9]+ display.*sprite [0-9]+x[0-9]+/ {
      match($0, /sprite [0-9]+x[0-9]+/)
      split(substr($0, RSTART + 7, RLENGTH - 7), size, "x")
    }
    NR > from && /frame: [0-9]+ (Grounded|Perched) / { line = $0 }
    END {
      if (line == "" || size[1] == "") exit 1
      if (!match(line, /sprite\([-0-9]+,[-0-9]+\)/)) exit 1
      split(substr(line, RSTART + 7, RLENGTH - 8), corner, ",")
      printf "%d %d\n", corner[1] + size[1] / 2, corner[2] + size[2] / 2
    }
  ' "$log"
}
