# shellcheck shell=bash
# Shared wait core for the macOS and X11 scenario leaves. Each wait starts at
# its trigger, returns as soon as its event lands, and gives up after the
# seconds it is given (2-3 s at the call sites). A dead Fidget ($pid) fails it.

# Milliseconds since the epoch. BSD date has no %N, so ask perl, which ships
# with macOS.
now_ms() {
  perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'
}

fidget_alive() {
  [ -z "${pid:-}" ] || kill -0 "$pid" 2> /dev/null
}

# Wait for a line matching an extended regex to land in a file. Re-reads the
# file every 20 ms: a grep that cheap behaves the same on BSD and GNU tools,
# where tail -F would fall back to a 1 s poll on some file systems.
wait_for_line() { # <seconds> <file> <pattern>
  local seconds=$1 file=$2 pattern=$3 deadline
  deadline=$(($(now_ms) + seconds * 1000))
  while :; do
    grep -qE "$pattern" "$file" 2> /dev/null && return 0
    fidget_alive || return 1
    [ "$(now_ms)" -lt "$deadline" ] || return 1
    sleep 0.02
  done
}

# Wait for a trace line in the app log or process.log.
wait_for_trace() { # <seconds> <log file> <pattern>
  wait_for_line "$@"
}

# Wait for a line in the fixture Harness marks file.
wait_for_marks() { # <seconds> <marks file> <pattern>
  wait_for_line "$@"
}

# Wait for a file to exist. macOS has no inotifywait, so this polls at 50 ms.
wait_for_file() { # <seconds> <file path>
  local seconds=$1 file=$2 deadline
  deadline=$(($(now_ms) + seconds * 1000))
  while :; do
    [ -f "$file" ] && return 0
    fidget_alive || return 1
    [ "$(now_ms)" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}

# Check the last frame trace line for a state pattern.
in_state() { # <log> <state pattern>
  grep '^frame: ' "$1" 2> /dev/null | tail -1 | grep -qE " ($2) "
}

# Wait until a command succeeds, for state with no line or file to follow
# (a window id, a window layer, an Accessibility frame). Polls at 50 ms.
wait_until() { # <seconds> <command...>
  local seconds=$1 deadline
  shift
  deadline=$(($(now_ms) + seconds * 1000))
  until "$@" > /dev/null 2>&1; do
    fidget_alive || return 1
    [ "$(now_ms)" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}

# Wait until a file holds more than <count> lines matching a pattern, for a
# line that repeats (a second minimize, a second Poke). Take the count before
# the trigger.
wait_for_count() { # <seconds> <file> <pattern> <count before the trigger>
  wait_until "$1" more_lines "$2" "$3" "$4"
}

# True when a file holds more than <count> lines matching a pattern.
more_lines() { # <file> <pattern> <count>
  [ "$(line_count "$1" "$2")" -gt "$3" ]
}

# Lines matching a pattern in a file so far, for wait_for_count.
line_count() { # <file> <pattern>
  grep -cE "$2" "$1" 2> /dev/null || true
}

# Fidget and every process under it, deepest first. The Harness runs in its
# own process group, so killing Fidget alone leaves it (and npx, codex-acp or
# the fixture) behind.
process_tree() { # <pid>
  local child
  for child in $(pgrep -P "$1" 2> /dev/null); do process_tree "$child"; done
  echo "$1"
}

# Cleanup for an EXIT/INT/TERM trap: stop Fidget's whole tree.
stop_fidget() {
  [ -n "${pid:-}" ] || return 0
  process_tree "$pid" | xargs kill 2> /dev/null || true
}
