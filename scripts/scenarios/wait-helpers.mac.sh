# shellcheck shell=bash
# Shared wait helpers for macOS scenario leaves.
# Source this file to get wait_for_trace and wait_for_file functions that
# wait on actual events instead of fixed sleeps.

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
  tail -F "$log" > "$fifo" 2> /dev/null &
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
  local timeout=$1 file=$2 deadline
  if [ -n "${pid:-}" ]; then
    kill -0 "$pid" 2> /dev/null || return 1
  fi
  [ -f "$file" ] && return 0
  deadline=$(($(date +%s) + timeout))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ -f "$file" ] && return 0
    [ -n "${pid:-}" ] && ! kill -0 "$pid" 2> /dev/null && return 1
    sleep 0.1
  done
  return 1
}
