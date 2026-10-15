# shellcheck shell=bash
# Shared wait helpers for X11 scenario leaves.
# Source this file to get wait_for_trace, wait_for_marks, wait_for_file,
# and wait_for_ax_dump functions that wait on actual events instead of
# fixed sleeps.

# Wait for a trace line pattern in the app log (fast timeout: 2-3s)
# Returns immediately when the pattern appears
wait_for_trace() { # <seconds> <log file> <pattern>
  local timeout=$1 log=$2 pattern=$3 tail_pid grep_pid result deadline fifo
  if [ -n "${pid:-}" ]; then
    kill -0 "$pid" 2> /dev/null || return 1
  fi
  if [ -f "$log" ] && grep -qE "$pattern" "$log" 2> /dev/null; then
    return 0
  fi
  deadline=$(($(date +%s) + timeout))
  fifo=$(mktemp -u)
  mkfifo "$fifo"
  tail -s 0.05 -F "$log" > "$fifo" 2> /dev/null &
  tail_pid=$!
  grep -qEm1 "$pattern" < "$fifo" &
  grep_pid=$!
  result=1
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$grep_pid" 2> /dev/null; then
      wait "$grep_pid" 2> /dev/null && result=0 || result=1
      break
    fi
    sleep 0.01
  done
  kill "$grep_pid" "$tail_pid" 2> /dev/null || true
  wait "$grep_pid" "$tail_pid" 2> /dev/null || true
  rm -f "$fifo"
  return "$result"
}

# Wait for a marker file to contain a pattern (fast timeout: 2-3s)
# Returns immediately when the pattern appears
wait_for_marks() { # <seconds> <marks file> <pattern>
  local timeout=$1 marks=$2 pattern=$3 tail_pid grep_pid result deadline fifo
  if [ -n "${pid:-}" ]; then
    kill -0 "$pid" 2> /dev/null || return 1
  fi
  if [ -f "$marks" ] && grep -qE "$pattern" "$marks" 2> /dev/null; then
    return 0
  fi
  deadline=$(($(date +%s) + timeout))
  fifo=$(mktemp -u)
  mkfifo "$fifo"
  tail -s 0.05 -F "$marks" > "$fifo" 2> /dev/null &
  tail_pid=$!
  grep -qEm1 "$pattern" < "$fifo" &
  grep_pid=$!
  result=1
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$grep_pid" 2> /dev/null; then
      wait "$grep_pid" 2> /dev/null && result=0 || result=1
      break
    fi
    sleep 0.01
  done
  kill "$grep_pid" "$tail_pid" 2> /dev/null || true
  wait "$grep_pid" "$tail_pid" 2> /dev/null || true
  rm -f "$fifo"
  return "$result"
}

# Wait for a file to exist (fast timeout: 2-3s)
# Returns immediately when the file appears
wait_for_file() { # <seconds> <file path>
  local timeout=$1 file=$2 dir fname deadline
  if [ -n "${pid:-}" ]; then
    kill -0 "$pid" 2> /dev/null || return 1
  fi
  [ -f "$file" ] && return 0
  dir=$(dirname "$file")
  fname=$(basename "$file")
  if command -v inotifywait > /dev/null 2>&1; then
    timeout "$timeout" inotifywait -q -e create,moved_to "$dir" 2> /dev/null |
      grep -qF "$fname"
  else
    deadline=$(($(date +%s) + timeout))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      [ -f "$file" ] && return 0
      [ -n "${pid:-}" ] && ! kill -0 "$pid" 2> /dev/null && return 1
      sleep 0.1
    done
    return 1
  fi
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

# Answer a permission ask by clicking the named button (Allow or Reject)
# Waits for the Chat window to appear, then presses the button
# Uses polling at 200ms: AX queries are expensive and have no event mechanism
answer_permission() { # <pid> <button name>
  local wpid=$1 button=$2
  local deadline
  deadline=$(($(date +%s) + 3))
  # shellcheck disable=SC2154
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if python3 "${root}/scripts/ax-window-linux.py" dump "$wpid" "BMO" 2> /dev/null | grep -q "button|$button"; then
      python3 "${root}/scripts/ax-window-linux.py" press "$wpid" "BMO" "$button" 2> /dev/null && return 0
    fi
    sleep 0.2
  done
  return 1
}

# Check the last frame for a state pattern
in_state() { # <log> <state pattern>
  grep '^frame: ' "$1" 2> /dev/null | tail -1 | grep -qE " ($2) "
}
