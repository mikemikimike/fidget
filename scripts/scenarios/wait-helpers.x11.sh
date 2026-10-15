# shellcheck shell=bash
# Shared wait helpers for X11 scenario leaves.
# Source this file to get wait_for_trace, wait_for_marks, wait_for_file,
# and wait_for_ax_dump functions that wait on actual events instead of
# fixed sleeps.

# Wait for a trace line pattern in the app log (fast timeout: 2-3s)
# Returns immediately when the pattern appears
wait_for_trace() { # <seconds> <log file> <pattern>
  local timeout=$1 log=$2 pattern=$3
  [ -n "${pid:-}" ] && kill -0 "$pid" 2> /dev/null || return 1
  if [ -f "$log" ] && grep -qE "$pattern" "$log" 2> /dev/null; then
    return 0
  fi
  timeout "$timeout" tail -F "$log" 2> /dev/null | grep -qEm1 "$pattern"
}

# Wait for a marker file to contain a pattern (fast timeout: 2-3s)
# Returns immediately when the pattern appears
wait_for_marks() { # <seconds> <marks file> <pattern>
  local timeout=$1 marks=$2 pattern=$3
  [ -n "${pid:-}" ] && kill -0 "$pid" 2> /dev/null || return 1
  if [ -f "$marks" ] && grep -qE "$pattern" "$marks" 2> /dev/null; then
    return 0
  fi
  timeout "$timeout" tail -F "$marks" 2> /dev/null | grep -qEm1 "$pattern"
}

# Wait for a file to exist (fast timeout: 2-3s)
# Returns immediately when the file appears
wait_for_file() { # <seconds> <file path>
  local timeout=$1 file=$2
  [ -n "${pid:-}" ] && kill -0 "$pid" 2> /dev/null || return 1
  [ -f "$file" ] && return 0
  timeout "$timeout" sh -c "while ! [ -f '$file' ]; do sleep 0.1; done" 2> /dev/null
}

# Wait for an accessibility dump to match a pattern (fast timeout: 2-3s)
# This polls because AX dumps are expensive queries with no event mechanism
wait_for_ax_dump() { # <seconds> <pid> <window title> <pattern>
  local timeout=$1 wpid=$2 title=$3 pattern=$4
  local deadline tmp
  deadline=$(($(date +%s) + timeout))
  tmp=$(mktemp)
  # shellcheck disable=SC2154
  while [ "$(date +%s)" -lt "$deadline" ]; do
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
    sleep 0.2
  done
  rm -f "$tmp"
  return 1
}

# Check the last frame for a state pattern
in_state() { # <log> <state pattern>
  grep '^frame: ' "$1" 2> /dev/null | tail -1 | grep -qE " ($2) "
}
