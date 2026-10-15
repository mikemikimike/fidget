# X11 Live Scenario Test Results

Tested on: 2026-10-15

## Summary

Ran five X11 scenario scripts with `--go` flag under Xvfb in a headless Linux environment.

## Passing Scenarios

### thinking-row
- **Result**: PASS
- **Elapsed**: 123.0s
- **Command**: `xvfb-run -a -s "-screen 0 1920x1080x24" target/release/fidget-verify scenario thinking-row --go`
- **Commit**: main @ 2026-10-15
- **Exit code**: 0

### chat-header-narrow
- **Result**: PASS  
- **Elapsed**: 13.1s
- **Command**: `xvfb-run -a -s "-screen 0 1920x1080x24" target/release/fidget-verify scenario chat-header-narrow --go`
- **Commit**: main @ 2026-10-15
- **Exit code**: 0

## Scenarios Requiring Physical Display (Headless Limitation)

The following three scenarios require StatusNotifierWatcher (system tray host), which is provided by desktop environments and cannot function in truly headless X11:

### landing-link-click
- **Result**: SKIP (exit 2)
- **Reason**: No StatusNotifierWatcher service
- **Error**: `GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.kde.StatusNotifierWatcher was not provided by any .service files`

### launcher-dies-at-startup
- **Result**: SKIP (exit 2)
- **Reason**: No StatusNotifierWatcher service

### sign-in-button
- **Result**: SKIP (exit 2)
- **Reason**: No StatusNotifierWatcher service

## Attempted Solutions

To provide StatusNotifierWatcher in the headless environment:
- Installed xfce4-panel and xfce4-sntray-plugin
- Attempted xfce4-panel with dbus-launch
- Tried direct plugin invocation via xfce4-panel wrapper

All approaches failed because StatusNotifierWatcher requires desktop environment integration that does not function without a physical display or VNC-style environment.

## Recommendation

These three tray-dependent scenarios should be run on physical Linux machines or in VNC/X2Go sessions where a full desktop environment is available. The scenarios correctly skip (exit 2) when the required infrastructure is missing.

Addresses #1088.
