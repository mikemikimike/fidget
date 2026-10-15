# Shared wait helpers for X11 scenario leaves.
# Source this file to get wait_for_trace, wait_for_log_line, wait_for_file,
# wait_for_marks, wait_for_ax_dump, and in_state functions that wait on actual
# events instead of fixed sleeps.

# Wait for a trace line pattern in the app log (fast timeout: 2-3s)
wait_for_trace() { # <seconds> <log file> <pattern>
  local timeout=$1 log=$2 pattern=$3 n=$((timeout * 10))
  until grep -qE "$pattern" "$log" 2> /dev/null; do
    [ -n "${pid:-}" ] && kill -0 "$pid" 2> /dev/null || return 1
    n=$((n - 1))
    [ "$n" -gt 0 ] || return 1
    sleep 0.1
  done
}

# Wait for a marker file to contain a pattern (fast timeout: 2-3s)
wait_for_marks() { # <seconds> <marks file> <pattern>
  local timeout=$1 marks=$2 pattern=$3 n=$((timeout * 10))
  until grep -qE "$pattern" "$marks" 2> /dev/null; do
    [ -n "${pid:-}" ] && kill -0 "$pid" 2> /dev/null || return 1
    n=$((n - 1))
    [ "$n" -gt 0 ] || return 1
    sleep 0.1
  done
}

# Wait for a file to exist (fast timeout: 2-3s)
wait_for_file() { # <seconds> <file path>
  local timeout=$1 file=$2 n=$((timeout * 10))
  until [ -f "$file" ]; do
    [ -n "${pid:-}" ] && kill -0 "$pid" 2> /dev/null || return 1
    n=$((n - 1))
    [ "$n" -gt 0 ] || return 1
    sleep 0.1
  done
}

# Wait for an accessibility dump to match a pattern (fast timeout: 2-3s)
# Returns success when the pattern matches
wait_for_ax_dump() { # <seconds> <pid> <window title> <pattern>
  local timeout=$1 wpid=$2 title=$3 pattern=$4
  local n=$((timeout * 10)) tmp
  tmp=$(mktemp)
  while [ "$n" -gt 0 ]; do
    if python3 "${root}/scripts/ax-window-linux.py" dump "$wpid" "$title" > "$tmp" 2> /dev/null; then
      if grep -qE "$pattern" "$tmp"; then
        rm -f "$tmp"
        return 0
      fi
    fi
    kill -0 "$wpid" 2> /dev/null || {
      rm -f "$tmp"
      return 1
    }
    n=$((n - 1))
    [ "$n" -gt 0 ] || break
    sleep 0.1
  done
  rm -f "$tmp"
  return 1
}

# Check the last frame for a state pattern
in_state() { # <log> <state pattern>
  grep '^frame: ' "$1" 2> /dev/null | tail -1 | grep -qE " ($2) "
}
