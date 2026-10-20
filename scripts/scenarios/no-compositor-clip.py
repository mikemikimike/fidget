#!/usr/bin/env python3
"""X11 helpers for no-compositor-clip.x11.sh, on $DISPLAY.

root RRGGBB        paint the root that colour through a pixmap named in
                   _XROOTPMAP_ID, which picom draws and a solid colour it
                   does not, then stay until killed.
window RRGGBB W H  map a plain window of that colour and size at 0,0, print
                   its id, and stay until killed.
cm                 exit 0 when a compositor owns _NET_WM_CM_S0.
shot OUT RRGGBB X,Y,W,H...
                   capture the root to OUT and print the share of black pixels
                   overall and outside the sprite boxes, and of each box that
                   is art (neither black nor the desktop colour), then exit 0
                   when every box shows art and the rest is under 1% black.
"""
import ctypes
import sys
import time

BLACK = 16  # Channels all below this count as black.


def x11():
    x = ctypes.CDLL("libX11.so.6")
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]
    d = x.XOpenDisplay(None)
    if not d:
        sys.exit("cannot open $DISPLAY")
    return x, d


def window(colour, width, height):
    x, d = x11()
    x.XDefaultRootWindow.restype = ctypes.c_ulong
    x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x.XCreateSimpleWindow.restype = ctypes.c_ulong
    x.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong] + [ctypes.c_int] * 2 + [ctypes.c_uint] * 3 + [ctypes.c_ulong] * 2
    x.XMapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x.XFlush.argtypes = [ctypes.c_void_p]
    w = x.XCreateSimpleWindow(d, x.XDefaultRootWindow(d), 0, 0, width, height, 0, 0, int(colour, 16))
    x.XMapWindow(d, w)
    x.XFlush(d)
    print(hex(w), flush=True)
    while True:
        time.sleep(3600)


def root(colour):
    x, d = x11()
    c = ctypes
    for name, res, args in [
        ("XDefaultRootWindow", c.c_ulong, [c.c_void_p]),
        ("XDefaultScreen", c.c_int, [c.c_void_p]),
        ("XDisplayWidth", c.c_int, [c.c_void_p, c.c_int]),
        ("XDisplayHeight", c.c_int, [c.c_void_p, c.c_int]),
        ("XDefaultDepth", c.c_int, [c.c_void_p, c.c_int]),
        ("XCreatePixmap", c.c_ulong, [c.c_void_p, c.c_ulong, c.c_uint, c.c_uint, c.c_uint]),
        ("XCreateGC", c.c_void_p, [c.c_void_p, c.c_ulong, c.c_ulong, c.c_void_p]),
        ("XSetForeground", c.c_int, [c.c_void_p, c.c_void_p, c.c_ulong]),
        ("XFillRectangle", c.c_int, [c.c_void_p, c.c_ulong, c.c_void_p, c.c_int, c.c_int, c.c_uint, c.c_uint]),
        ("XSetWindowBackgroundPixmap", c.c_int, [c.c_void_p, c.c_ulong, c.c_ulong]),
        ("XClearWindow", c.c_int, [c.c_void_p, c.c_ulong]),
        ("XInternAtom", c.c_ulong, [c.c_void_p, c.c_char_p, c.c_int]),
        ("XChangeProperty", c.c_int, [c.c_void_p, c.c_ulong, c.c_ulong, c.c_ulong, c.c_int, c.c_int, c.c_void_p, c.c_int]),
        ("XFlush", c.c_int, [c.c_void_p]),
    ]:
        getattr(x, name).restype, getattr(x, name).argtypes = res, args
    r, screen = x.XDefaultRootWindow(d), x.XDefaultScreen(d)
    width, height = x.XDisplayWidth(d, screen), x.XDisplayHeight(d, screen)
    pixmap = x.XCreatePixmap(d, r, width, height, x.XDefaultDepth(d, screen))
    gc = x.XCreateGC(d, pixmap, 0, None)
    x.XSetForeground(d, gc, int(colour, 16))
    x.XFillRectangle(d, pixmap, gc, 0, 0, width, height)
    x.XSetWindowBackgroundPixmap(d, r, pixmap)
    x.XClearWindow(d, r)
    atom = x.XInternAtom(d, b"_XROOTPMAP_ID", 0)
    value = c.c_ulong(pixmap)
    x.XChangeProperty(d, r, atom, 20, 32, 0, c.byref(value), 1)  # XA_PIXMAP, PropModeReplace
    x.XFlush(d)
    print("painted", flush=True)
    while True:
        time.sleep(3600)


def composited():
    x, d = x11()
    x.XInternAtom.restype = ctypes.c_ulong
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XGetSelectionOwner.restype = ctypes.c_ulong
    x.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    return x.XGetSelectionOwner(d, x.XInternAtom(d, b"_NET_WM_CM_S0", 0)) != 0


def shot(out, desktop, boxes):
    import os
    from PIL import ImageGrab

    img = ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).convert("RGB")
    img.save(out)
    pixels = img.load()
    desktop = tuple(bytes.fromhex(desktop))
    inside = set()
    art = []
    for left, top, width, height in boxes:
        box = {(x, y) for x in range(max(left, 0), min(left + width, img.width)) for y in range(max(top, 0), min(top + height, img.height))}
        inside |= box
        drawn = sum(1 for x, y in box if pixels[x, y] != desktop and not all(c < BLACK for c in pixels[x, y]))
        art.append(100 * drawn / len(box) if box else 0)
    total = img.width * img.height
    black = outside_black = 0
    for y in range(img.height):
        for x in range(img.width):
            if all(c < BLACK for c in pixels[x, y]):
                black += 1
                outside_black += (x, y) not in inside
    outside = 100 * outside_black / (total - len(inside))
    boxes_text = ", ".join(f"{share:.1f}%" for share in art)
    print(f"black {100 * black / total:.1f}%, outside the sprites {outside:.1f}% black, sprite boxes {boxes_text} art")
    return outside < 1 and all(share > 10 for share in art)


if __name__ == "__main__":
    command, args = sys.argv[1], sys.argv[2:]
    if command == "root":
        root(args[0])
    elif command == "window":
        window(args[0], int(args[1]), int(args[2]))
    elif command == "cm":
        sys.exit(0 if composited() else 1)
    elif command == "shot":
        sys.exit(0 if shot(args[0], args[1], [tuple(map(int, box.split(","))) for box in args[2:]]) else 1)
    else:
        sys.exit(__doc__)
