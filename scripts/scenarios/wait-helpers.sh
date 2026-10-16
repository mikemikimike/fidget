# shellcheck shell=bash
# Shared wait helpers for the macOS scenario leaves (the plain `*.sh` ones).
# Source this file after setting `root`, `tools` and, once Fidget runs, `pid`.
#
# Not wait-helpers.x11.sh: that one streams through `tail -s 0.05 -F`, and
# BSD tail on macOS has no -s, so every wait there timed out unless its line
# was already written. These poll the file every 50 ms with grep instead, and
# return the moment the line is there.

# True when Fidget is gone. With no pid yet, nothing to watch.
_fidget_gone() { [ -n "${pid:-}" ] && ! kill -0 "$pid" 2> /dev/null; }

# Deadline arithmetic in tenths of a second; timeouts are whole seconds.
_now_ds() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 10'; }

# Wait until some line of the file matches an extended regex (fast timeout:
# 2-3 s). Returns 0 the moment it does, 1 on timeout or once Fidget exits.
wait_for_line() { # <seconds> <file> <pattern>
  local deadline
  deadline=$(($(_now_ds) + ${1%.*} * 10))
  while :; do
    [ -f "$2" ] && grep -qE -- "$3" "$2" 2> /dev/null && return 0
    _fidget_gone && return 1
    [ "$(_now_ds)" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}

# Wait for a trace line pattern in process.log or the app log (2-3 s).
wait_for_trace() { wait_for_line "$@"; } # <seconds> <log file> <pattern>

# Wait for a marker file from the fixture Harness to hold a pattern (2-3 s).
wait_for_marks() { wait_for_line "$@"; } # <seconds> <marks file> <pattern>

# Wait for a file to exist (2-3 s).
wait_for_file() { # <seconds> <file path>
  local deadline
  deadline=$(($(_now_ds) + ${1%.*} * 10))
  until [ -f "$2" ]; do
    _fidget_gone && return 1
    [ "$(_now_ds)" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}

# Wait until a command succeeds, for state with no file to watch: an AX
# dump, a window id, a spawn count. Polls every 100 ms; AX queries cost that.
wait_until() { # <seconds> <command...>
  local deadline
  deadline=$(($(_now_ds) + ${1%.*} * 10))
  shift
  until "$@" > /dev/null 2>&1; do
    _fidget_gone && return 1
    [ "$(_now_ds)" -lt "$deadline" ] || return 1
    sleep 0.1
  done
}

# Wait for a window's Accessibility dump to match a pattern (2-3 s).
wait_for_ax_dump() { # <seconds> <pid> <window title> <pattern>
  local tmp rc
  tmp=$(mktemp)
  # shellcheck disable=SC2154 # tools is the leaf's.
  wait_until "$1" _ax_dump_has "$2" "$3" "$4" "$tmp"
  rc=$?
  rm -f "$tmp"
  return "$rc"
}
# shellcheck disable=SC2154 # tools is the leaf's.
_ax_dump_has() { "$tools/ax" dump "$1" "$2" > "$4" 2>&1 && grep -qE -- "$3" "$4"; }

# Answer a permission ask by pressing its button (Allow or Reject) in Chat,
# so a fixture that asks never holds the scene.
answer_permission() { # <pid> <button name> [window title]
  wait_until 3 "$tools/ax" press-button "$1" "$2" 1 "${3:-BMO}"
}

# Seed a private HOME's Fidget settings with the first-run tour marked shown.
# Extra JSON members go in as-is: seed_settings "$home" '"hide_in_fullscreen": false'.
seed_settings() { # <home> [extra members]
  local dir="$1/Library/Application Support/fidget"
  mkdir -p "$dir"
  printf '{"first_run_tour_shown": true%s}\n' "${2:+, $2}" > "$dir/settings.json"
}

# Milliseconds since the epoch; BSD date has no %N.
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
