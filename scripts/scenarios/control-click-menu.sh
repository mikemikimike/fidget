#!/usr/bin/env bash
# Scenario: control-click-menu (macOS)
# On screen: launches Fidget as BMO with a fixture Harness. The scenario finds
#   the sprite, sends a Control-click to its centre, waits for the menu to
#   appear, and reads its items. One screenshot of the open menu, cropped to
#   the menu's bounds.
#   Fidget quits when the scenario ends.
# Input: one Control-click on the sprite (synthetic, via CGEvent), held while
#   the menu is read; Escape closes the menu before the release.
# Duration: a few seconds, 10 s at most.
# Grants: Screen Recording and Accessibility for the terminal that runs it.
# Asserts: the Control-click lands as Menu, and the open menu's Accessibility
#   items include Chat…, Settings… and Quit.
#
# Usage: control-click-menu.sh --go <fidget binary> <fidget test binary>
# Without --go it prints this header, which is the takeover prompt, and exits 2.
set -euo pipefail

if [ "${1:-}" != --go ]; then
  sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0" || true
  exit 2
fi
bin=${2:?usage: control-click-menu.sh --go <fidget binary> <fidget test binary>}
test_bin=${3:?usage: control-click-menu.sh --go <fidget binary> <fidget test binary>}
test_bin=$(cd "$(dirname "$test_bin")" && pwd)/$(basename "$test_bin")
root=$(cd "$(dirname "$0")/../.." && pwd)
. "$root/scripts/scenarios/wait-helpers.mac.sh"
out="${TMPDIR:-/tmp}/fidget-scenario-control-click-menu-$(date +%Y%m%d-%H%M%S)"
tools="${TMPDIR:-/tmp}/fidget-scenario-tools"
mkdir -p "$out/home" "$tools"
seed_tour_shown "$out/home"
log="$out/app.log"

fail() {
  echo "FAIL: $*" >&2
  echo "evidence in $out" >&2
  exit 1
}

[ -x "$tools/window-id" ] || swiftc -O "$root/scripts/scenarios/window-id.swift" -o "$tools/window-id"
[ "$tools/ax" -nt "$root/scripts/ax-settings.swift" ] || swiftc -O "$root/scripts/ax-settings.swift" -o "$tools/ax"

harness="$root/scripts/scenarios/fixture-harness.sh $test_bin script=nop"
[ "$(wc -w <<< "$harness")" -eq 3 ] || fail "a path in the Harness line holds a space: $harness"

start_ms=$(now_ms)
env HOME="$out/home" \
  FIDGET_HARNESS="$harness" \
  FIDGET_DIRECTOR_WAKE_SECS=3600 \
  FIDGET_DIRECTOR_API_KEY=x FIDGET_CAPTURABLE=1 FIDGET_TRACE_FRAMES=1 \
  FIDGET_CHARACTER=bmo FIDGET_CHARACTERS="$root/characters" \
  "$bin" > "$log" 2>&1 &
pid=$!
trap 'stop_fidget; pkill -f "script=nop" || true' EXIT INT TERM

# The overlay spans the display, so its centre is not the sprite. The newest
# frame trace line says where the sprite is drawn, in global points.
wait_for_trace 3 "$log" '^frame: .* sprite\(' || fail "Fidget traced no frame; see $log"
# A click on a walking sprite lands where it was, so wait for it to rest.
wait_for_rest "$log" || fail "the sprite never came to rest; see $log"
read -r w h < <(sed -nE 's/.*sprite ([0-9]+)x([0-9]+);.*/\1 \2/p' "$log" | head -1) || fail "no sprite size in $log"
read -r x y < <(sed -nE 's/^frame: .* sprite\((-?[0-9]+),(-?[0-9]+)\) .*/\1 \2/p' "$log" | tail -1) || fail "no frame trace in $log"
cx=$((x + w / 2))
cy=$((y + h / 2))
echo "ok: sprite at ($x,$y) size ${w}x${h}, centre ($cx,$cy)"

# Hold the Control-down while the menu is read: a release before the menu
# tracks lands on the overlay as a Poke. Escape closes it, then the release.
menu_dump="$out/menu.ax.txt"
swift - "$pid" "$cx" "$cy" "$out/menu.png" > "$menu_dump" 2>&1 << 'SWIFT' || fail "no open menu in the AX tree; see $menu_dump"
import AppKit
import ApplicationServices

let args = CommandLine.arguments
guard let pid = pid_t(args[1]), let x = Double(args[2]), let y = Double(args[3]) else { exit(2) }
let point = CGPoint(x: x, y: y)
func mouse(_ type: CGEventType) {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    event?.flags = .maskControl
    event?.post(tap: .cghidEventTap)
}
func key(_ code: CGKeyCode) {
    for down in [true, false] {
        CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)?.post(tap: .cghidEventTap)
    }
}
// A synthetic mouse event with no Control key pair behind it leaves the
// session's Control flag set, and every later synthetic click inherits it.
// One flagless move through the HID state is what clears it (#1503).
// ponytail: no macOS event marks a session flag change, so the read below
// repeats every 20 ms for at most a second. It costs that second only on a
// machine where the state never settles; drop it for a notification if one
// ever arrives.
func clearFlags() {
    if let source = CGEventSource(stateID: .hidSystemState),
        let at = CGEvent(source: nil)?.location,
        let moved = CGEvent(
            mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: at,
            mouseButton: .left)
    {
        moved.flags = []
        moved.post(tap: .cghidEventTap)
    }
    // The state settles a beat after the event, so give it one before saying.
    let deadline = Date().addingTimeInterval(1)
    func sessionFlags() -> CGEventFlags { CGEventSource.flagsState(.combinedSessionState) }
    while sessionFlags().contains(.maskControl) && Date() < deadline { usleep(20_000) }
    if sessionFlags().contains(.maskControl) {
        FileHandle.standardError.write(
            "input-state: session flags \(sessionFlags().rawValue) still carry Control\n"
                .data(using: .utf8)!)
    }
}
func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &out) == .success ? out : nil
}

// The items and the frame of the popped-up menu. It is no child of the
// application element, but AXMenuOpened hands it over, and its own children
// are the rows it draws.
func children(_ element: AXUIElement) -> [AXUIElement] {
    (value(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
func menuTitles(_ element: AXUIElement?) -> [String] {
    guard let element else { return [] }
    var titles: [String] = []
    func walk(_ node: AXUIElement) {
        for child in children(node) {
            if value(child, kAXRoleAttribute) as? String == "AXMenuItem",
                let title = value(child, kAXTitleAttribute) as? String, !title.isEmpty
            {
                titles.append(title)
            }
            walk(child)
        }
    }
    walk(element)
    return titles
}
// AXPosition and AXSize are the menu element's own attributes, so the
// rectangle it draws in needs no window list.
func elementFrame(_ element: AXUIElement?) -> CGRect? {
    guard let element,
        let posValue = value(element, kAXPositionAttribute),
        let sizeValue = value(element, kAXSizeAttribute)
    else { return nil }
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(posValue as! AXValue, .cgPoint, &origin),
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size),
        size.width > 0, size.height > 0
    else { return nil }
    return CGRect(origin: origin, size: size)
}
// AXMenuOpened carries the menu it opened, so both the frame and the items
// come from that element and the window list is not polled (#1503).
var opened: AXUIElement?
// Wait on AXMenuOpened / AXMenuClosed from the app, never a sleep: the run
// loop returns on the notification, or after the seconds given.
var seen: Set<String> = []
var observer: AXObserver?
AXObserverCreate(pid, { _, element, name, _ in
    let name = name as String
    if name == kAXMenuOpenedNotification { opened = element }
    seen.insert(name)
}, &observer)
if let observer {
    let app = AXUIElementCreateApplication(pid)
    for name in [kAXMenuOpenedNotification, kAXMenuClosedNotification] {
        AXObserverAddNotification(observer, app, name as CFString, nil)
    }
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
}
func waitFor(_ name: String, seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while !seen.contains(name) && Date() < deadline {
        CFRunLoopRunInMode(.defaultMode, deadline.timeIntervalSinceNow, true)
    }
}
mouse(.leftMouseDown)
waitFor(kAXMenuOpenedNotification, seconds: 3)
let rect = elementFrame(opened)
let items = menuTitles(opened)
// The two ways the element can disappoint, named in the dump rather than left
// to a bare exit code.
if opened == nil {
    FileHandle.standardError.write("no menu element 3s after the Control-click\n".data(using: .utf8)!)
} else if items.isEmpty {
    FileHandle.standardError.write("the menu element carries no items\n".data(using: .utf8)!)
}
// The menu's own bounds, never the display: evidence can end up attached to a
// public PR, and the rest of the screen is the owner's.
if let rect {
    let shot = Process()
    shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    shot.arguments = ["-x", "-R", "\(Int(rect.minX)),\(Int(rect.minY)),\(Int(rect.width)),\(Int(rect.height))", args[4]]
    try? shot.run()
    shot.waitUntilExit()
}
key(53)
// Release only once the menu has closed, so the release cannot pick a row.
waitFor(kAXMenuClosedNotification, seconds: 2)
mouse(.leftMouseUp)
clearFlags()
items.forEach { print($0) }
exit(items.isEmpty ? 1 : 0)
SWIFT

wait_for_trace 2 "$log" '^verbs: .*\[Menu\]' || fail "the Control-click did not land as Menu; see $log"
echo "ok: the Control-click landed as Menu"
! grep -q '^input-state:' "$menu_dump" || fail "the Control-click left the session's Control flag set; see $menu_dump"

for item in "Chat…" "Settings…" "Quit"; do
  grep -qxF "$item" "$menu_dump" || fail "no '$item' in the menu; see $menu_dump"
  echo "ok: the menu holds $item"
done

echo "PASS: evidence in $out ($(($(now_ms) - start_ms))ms)"
