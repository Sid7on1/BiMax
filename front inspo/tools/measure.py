#!/usr/bin/env python3
"""Pixel-truth helpers for the front-end study. All --pt outputs are LOGICAL points (capture is 2x)."""
import sys, json
from PIL import Image
import numpy as np

def load(p): return Image.open(p).convert("RGB")
def hexof(t): return "#%02x%02x%02x" % tuple(int(v) for v in t[:3])

def px(path, x, y):
    """Colour at a native-pixel coordinate."""
    return hexof(load(path).getpixel((x, y)))

def scanrow(path, y, x0=0, x1=None, minrun=2):
    """Walk a horizontal line; report each colour change and how wide each band is."""
    im = np.asarray(load(path)); h, w, _ = im.shape
    x1 = w if x1 is None else x1
    out, start, cur = [], x0, tuple(im[y, x0])
    for x in range(x0 + 1, x1):
        c = tuple(im[y, x])
        if c != cur:
            if x - start >= minrun:
                out.append({"x": start, "w": x - start, "x_pt": start/2, "w_pt": (x-start)/2, "hex": hexof(cur)})
            start, cur = x, c
    out.append({"x": start, "w": x1 - start, "x_pt": start/2, "w_pt": (x1-start)/2, "hex": hexof(cur)})
    return out

def scancol(path, x, y0=0, y1=None, minrun=2):
    im = np.asarray(load(path)); h, w, _ = im.shape
    y1 = h if y1 is None else y1
    out, start, cur = [], y0, tuple(im[y0, x])
    for y in range(y0 + 1, y1):
        c = tuple(im[y, x])
        if c != cur:
            if y - start >= minrun:
                out.append({"y": start, "h": y - start, "y_pt": start/2, "h_pt": (y-start)/2, "hex": hexof(cur)})
            start, cur = y, c
    out.append({"y": start, "h": y1 - start, "y_pt": start/2, "h_pt": (y1-start)/2, "hex": hexof(cur)})
    return out

def radius(path, cx, cy, bg, quadrant="tl", maxr=80):
    """Corner radius in LOGICAL pt: walk the 45-deg diagonal from the corner until we leave bg."""
    im = np.asarray(load(path)); bg = bg.lstrip("#")
    bgt = tuple(int(bg[i:i+2], 16) for i in (0, 2, 4))
    dx, dy = (1, 1) if quadrant == "tl" else (-1, 1) if quadrant == "tr" else (1, -1) if quadrant == "bl" else (-1, -1)
    for r in range(maxr * 2):
        y, x = cy + dy * r, cx + dx * r
        if not (0 <= y < im.shape[0] and 0 <= x < im.shape[1]): break
        if tuple(im[y, x]) != bgt:
            # diagonal distance d -> radius ~= d / (sqrt(2)-1) ... use inscribed-circle relation
            return {"diag_px": r, "radius_pt_est": round(r / (2 ** 0.5 - 1) / 2, 1)}
    return {"diag_px": None}

def crop(path, x, y, w, h, out):
    load(path).crop((x, y, x + w, y + h)).save(out); return out

if __name__ == "__main__":
    cmd = sys.argv[1]
    args = sys.argv[2:]
    if cmd == "px": print(px(args[0], int(args[1]), int(args[2])))
    elif cmd == "scanrow": print(json.dumps(scanrow(args[0], int(args[1]), *(int(a) for a in args[2:])), indent=0))
    elif cmd == "scancol": print(json.dumps(scancol(args[0], int(args[1]), *(int(a) for a in args[2:])), indent=0))
    elif cmd == "crop": print(crop(args[0], *(int(a) for a in args[1:5]), args[5]))
    elif cmd == "radius": print(json.dumps(radius(args[0], int(args[1]), int(args[2]), args[3], args[4])))
