# shellcheck shell=bash
# macOS wait helpers: the shared core plus Accessibility waits and tour seeding.
# Source after setting root and tools (holding the built `ax`), then set pid.
# shellcheck source=wait-helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/wait-helpers.sh"

# True when an Accessibility dump of a window matches a pattern.
ax_dump_matches() { # <pid> <window title> <pattern>
  # shellcheck disable=SC2154
  "$tools/ax" dump "$1" "$2" 2> /dev/null | grep -qE "$3"
}

# Wait for an Accessibility dump to match a pattern. AX has no change event a
# shell can block on, so the dump runs again on each new app log line.
wait_for_ax_dump() { # <seconds> <pid> <window title> <pattern>
  wait_until "$1" ax_dump_matches "$2" "$3" "$4"
}

# Answer a permission ask by pressing its button (Allow or Reject) in Chat,
# which takes the Character's name. Gives up after 3 s.
answer_permission() { # <pid> <button name> [Chat window title]
  local wpid=$1 button=$2 title=${3:-BMO}
  wait_for_ax_dump 3 "$wpid" "$title" "^AXButton\|$button\|" || return 1
  "$tools/ax" press-button "$wpid" "$button" 1 "$title" > /dev/null 2>&1
}

# Seed settings so the first-run tour counts as shown and never covers the
# windows a scenario reads. <home> is the private HOME the scenario launches
# Fidget with.
seed_tour_shown() { # <home>
  mkdir -p "$1/Library/Application Support/fidget"
  echo '{"first_run_tour_shown": true}' > "$1/Library/Application Support/fidget/settings.json"
}
