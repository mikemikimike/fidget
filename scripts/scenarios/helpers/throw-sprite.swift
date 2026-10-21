// Throws the sprite: a real press at a top-left-origin point, a fast drag of dx
// points, then the release, so the app sees a Grab and a Throw.
// A slow cross-display carry takes optional steps and per-step seconds, which
// stretch the drag so the release has no throw velocity left. Defaults keep the
// original 8 fast steps.
// Usage: swift scripts/scenarios/helpers/throw-sprite.swift x y dx [steps] [sleep]

import AppKit

let args = CommandLine.arguments
guard (4...6).contains(args.count), let x = Double(args[1]), let y = Double(args[2]),
    let dx = Double(args[3])
else {
    FileHandle.standardError.write(Data("usage: throw-sprite.swift x y dx [steps] [sleep]\n".utf8))
    exit(2)
}
let steps = args.count >= 5 ? (Int(args[4]) ?? 0) : 8
let sleepSecs = args.count >= 6 ? (Double(args[5]) ?? 0) : 0.012
guard steps > 0, sleepSecs > 0 else {
    FileHandle.standardError.write(Data("steps and sleep must be positive\n".utf8))
    exit(2)
}
guard let source = CGEventSource(stateID: .combinedSessionState) else {
    FileHandle.standardError.write(Data("could not create CGEventSource\n".utf8))
    exit(1)
}

func post(_ type: CGEventType, _ point: CGPoint) {
    CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?
        .post(tap: .cghidEventTap)
}

let start = CGPoint(x: x, y: y)
CGWarpMouseCursorPosition(start)
post(.mouseMoved, start)
Thread.sleep(forTimeInterval: 0.12)
post(.leftMouseDown, start)
// A drag past DRAG_THRESHOLD makes this a Grab; the hold lets the press land first.
Thread.sleep(forTimeInterval: 0.15)
var point = start
for step in 1...steps {
    point = CGPoint(x: x + dx * Double(step) / Double(steps), y: y - 10 * Double(step) / Double(steps))
    post(.leftMouseDragged, point)
    Thread.sleep(forTimeInterval: sleepSecs)
}
post(.leftMouseUp, point)
print("threw from (\(Int(x)),\(Int(y))) by \(Int(dx))")
