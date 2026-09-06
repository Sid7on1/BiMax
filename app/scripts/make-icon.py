#!/usr/bin/env python3
"""
Build the Bimax app/DMG icon from the brand artwork.

Supersedes make-icon.mjs, which drew the old procedural two-orbits mark in headless Chrome. That
script is retired: it wrote the same buildResources/icon.png this one does, so leaving it in place
meant any `node app/scripts/make-icon.mjs` silently reverted the brand icon.

macOS does not round app icons for you — whatever is in the file is what the Dock shows. The brand
artwork is a full-bleed black square, so it is composited into the house tile geometry the previous
icon already used (840px tile inset 92px inside a 1024px canvas, 202px corner radius) with
transparency outside the tile. Same geometry as before means the icon keeps its optical size next
to every other Dock icon instead of reading as an oversized hard-edged square.

Emits both:
  buildResources/icon.png   — 1024x1024, what electron-builder converts per target
  buildResources/icon.icns  — built here rather than left to electron-builder, so the exact
                              rasterisation at every size is reviewable in the repo

electron-builder picks up buildResources/icon.* automatically for the app, and `dmg.icon` defaults
to the app icon, so this one artefact covers both surfaces the brand icon has to appear on.

Usage: python3 app/scripts/make-icon.py
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

CANVAS = 1024
TILE = 840
INSET = (CANVAS - TILE) // 2   # 92
RADIUS = 202

# Supersample the mask so the rounded corners are smooth rather than stair-stepped.
SS = 4

HERE = Path(__file__).resolve().parent
BUILD_RESOURCES = HERE.parent / "buildResources"
SOURCE = BUILD_RESOURCES / "icon-source.png"
ICON_PNG = BUILD_RESOURCES / "icon.png"
ICON_ICNS = BUILD_RESOURCES / "icon.icns"

# The sizes `iconutil` requires; anything missing makes it refuse the whole iconset.
ICONSET = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]


def build_canvas() -> Image.Image:
    """The brand artwork scaled into the house tile, rounded, on a transparent 1024 canvas."""
    if not SOURCE.exists():
        sys.exit(f"missing brand artwork: {SOURCE}")

    art = Image.open(SOURCE).convert("RGBA")
    if art.width != art.height:
        # Centre-crop to square first; scaling a non-square source would distort the mark.
        side = min(art.width, art.height)
        left = (art.width - side) // 2
        top = (art.height - side) // 2
        art = art.crop((left, top, left + side, top + side))
    art = art.resize((TILE, TILE), Image.LANCZOS)

    mask = Image.new("L", (TILE * SS, TILE * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, TILE * SS - 1, TILE * SS - 1), radius=RADIUS * SS, fill=255
    )
    mask = mask.resize((TILE, TILE), Image.LANCZOS)

    # Intersect with any alpha the artwork already carries, so a transparent source stays transparent.
    art.putalpha(Image.composite(art.getchannel("A"), Image.new("L", (TILE, TILE), 0), mask))

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(art, (INSET, INSET), art)
    return canvas


def main() -> None:
    canvas = build_canvas()
    canvas.save(ICON_PNG, format="PNG")
    print(f"wrote {ICON_PNG}  ({CANVAS}x{CANVAS})")

    if not shutil.which("iconutil"):
        print("iconutil not found — skipping .icns (electron-builder will convert icon.png itself)")
        return

    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for name, size in ICONSET:
            canvas.resize((size, size), Image.LANCZOS).save(iconset / name, format="PNG")
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(ICON_ICNS)],
            check=True,
        )
    print(f"wrote {ICON_ICNS}  ({len(ICONSET)} representations)")


if __name__ == "__main__":
    main()
