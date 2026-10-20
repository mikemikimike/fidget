#!/usr/bin/env python3
"""X11 helpers for no-compositor-clip.x11.sh, on $DISPLAY.

window RRGGBB W H  map a plain window of that colour and size at 0,0, print
                   its id, and stay until killed.
cm                 exit 0 when a compositor owns _NET_WM_CM_S0.
shot OUT X Y W H   capture the root to OUT and print the share of black pixels
                   overall and outside the sprite box, and of the box that is
                   not black, then exit 0 when the box shows art and the rest
                   is under 1% black.
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


def composited():
    x, d = x11()
    x.XInternAtom.restype = ctypes.c_ulong
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XGetSelectionOwner.restype = ctypes.c_ulong
    x.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    return x.XGetSelectionOwner(d, x.XInternAtom(d, b"_NET_WM_CM_S0", 0)) != 0


def shot(out, left, top, width, height):
    import os
    from PIL import ImageGrab

    img = ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).convert("RGB")
    img.save(out)
    pixels = img.load()
    total = black = inside = inside_art = 0
    for y in range(img.height):
        for x in range(img.width):
            dark = all(c < BLACK for c in pixels[x, y])
            total += 1
            black += dark
            if left <= x < left + width and top <= y < top + height:
                inside += 1
                inside_art += not dark
    outside, outside_black = total - inside, black - (inside - inside_art)
    share = lambda part, whole: 100 * part / whole if whole else 0
    print(f"black {share(black, total):.1f}%, outside the sprite {share(outside_black, outside):.1f}% black, sprite box {share(inside_art, inside):.1f}% drawn")
    return share(outside_black, outside) < 1 and share(inside_art, inside) > 5


if __name__ == "__main__":
    command, args = sys.argv[1], sys.argv[2:]
    if command == "window":
        window(args[0], int(args[1]), int(args[2]))
    elif command == "cm":
        sys.exit(0 if composited() else 1)
    elif command == "shot":
        sys.exit(0 if shot(args[0], *map(int, args[1:5])) else 1)
    else:
        sys.exit(__doc__)
