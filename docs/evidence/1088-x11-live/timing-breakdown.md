# X11 Live Scenario Timing Breakdown

**Environment:** Cursor Cloud Agent headless VM, Xvfb :99 @ 1920x1080x24, session D-Bus via dbus-launch, python3-pyatspi, pre-built release binaries.

## Results

**thinking-row:** 3.7s (average of 3 runs: 3739ms, 3705ms, 3698ms)

**chat-header-narrow:** 4.5s (single run)

## Tray trio, 2026-10-23

**Environment:** the shared Debian 13 box, Xvfb :88 @ 1920x1080x24, xfwm4
with compositing off, a dbus-launch session bus, `at-spi-bus-launcher`, and
`ayatana-indicator-application-service` as the StatusNotifierWatcher (the
same watcher `e2e-linux.yml` starts). Debug binaries from `cargo build -p
fidget -p fidget-verify` and `cargo test -p fidget --no-run`.

Each leaf ran through `fidget-verify scenario <name> --go`. Times are the
leaf's own `PASS (… ms)`, launch to last assertion.

| Leaf | Runs | Exit | Times (ms) |
|---|---|---|---|
| `landing-link-click`, before this fix (`a826fc1`) | 6 | 1 every run | n/a; FAIL "Chat shows no Codex needs npx landing" |
| `landing-link-click`, with the login-shell stub | 5 | 0 | 2364, 2306, 2306, 2438, 2415 |
| `launcher-dies-at-startup` | 4 | 0 | 5398, 5373, 5529, 5455 |
| `sign-in-button` | 4 | 0 | 2753, 2704, 2587, 2648 |

The tray works here. Ayatana registers the item at
`/org/ayatana/NotificationItem/<id>`, and `…/Menu` under it returns the whole
tray menu over dbusmenu, Chat… through Quit. #1556 queried the default
`/StatusNotifierItem` path and got an empty node, so the watcher in that run
most likely kept the sender and dropped the path. That run did not record
which watcher it used, so this is inferred.
