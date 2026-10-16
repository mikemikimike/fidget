#!/usr/bin/env python3
"""Wait for a Fidget window's AT-SPI tree to match a pattern.

Checks once, then again on each AT-SPI change event from PID (children,
names, text, states, new windows), and exits 0 on the first match or 1 when
SECONDS pass. Nothing polls: the GLib main loop sleeps until an event.

Usage:
  ax-wait-linux.py PID TITLE SECONDS PATTERN

Exit 2 when pyatspi is missing.
"""

import contextlib
import importlib.util
import io
import os
import re
import sys

EVENTS = (
    "object:children-changed",
    "object:property-change:accessible-name",
    "object:text-changed",
    "object:state-changed",
    "object:bounds-changed",
    "window:create",
    "window:activate",
)


def load_dumper():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ax-window-linux.py")
    spec = importlib.util.spec_from_file_location("ax_window_linux", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv):
    if len(argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    pid, title, seconds, pattern = int(argv[1]), argv[2], float(argv[3]), re.compile(argv[4])
    try:
        import pyatspi
        from gi.repository import GLib
    except ImportError:
        print("pyatspi is not installed", file=sys.stderr)
        return 2
    ax = load_dumper()

    def matches():
        desktop = pyatspi.Registry.getDesktop(0)
        window = ax.find_window(desktop, pid, title)
        if window is None:
            return False
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ax.dump(window, False)
        return any(pattern.search(line) for line in out.getvalue().splitlines())

    if matches():
        return 0
    found = []

    def on_event(event):
        try:
            if event.host_application.get_process_id() != pid:
                return
        except Exception:
            return
        if not found and matches():
            found.append(True)
            pyatspi.Registry.stop()

    def give_up():
        pyatspi.Registry.stop()
        return False

    pyatspi.Registry.registerEventListener(on_event, *EVENTS)
    GLib.timeout_add(int(seconds * 1000), give_up)
    pyatspi.Registry.start()
    return 0 if found or matches() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
