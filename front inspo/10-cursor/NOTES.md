# Cursor teardown — measured 2026-09-19, macOS 27

Window `Cursor Agents`, id 3744, 1280×800pt (2560×1600px, 2×), over the owner's photographic
wallpaper. Captured with `screencapture`; Bimax's own Computer Use is disabled (record 30) and was
not used or reactivated.

## Method, and the two attempts that were invalid

Both failures are recorded because each would have produced a confident wrong answer.

1. **Alpha from `screencapture -l<id>` is not material evidence.** The window-layer capture reports
   `a=1.000` for every pixel of Cursor — and *also* for Bimax, which is definitely translucent. The
   layer capture flattens the composite. The control caught it.
2. **The move test could not be run, and the same-position control failed.** AX enumeration is
   unavailable to this terminal (`-1719`), so the window could not be moved. A same-position control
   1s apart returned mean |Δ| 28.2 — because focus had returned to the terminal and the second
   capture framed *the terminal*, not Cursor. Classic occluder invalidation.

What worked instead: **spatial uniformity over a varying backdrop.** A surface that reads identical
to the level across 999pt of width, with zero within-patch variance, while the wallpaper behind it
changes from sky to architecture, is not transmitting that backdrop.

## Measured

| region | value | evidence |
|---|---|---|
| **canvas** | `#151515` (21,21,21) | flat to the level across **999pt** of width and at 5 heights; `sd = 0.0` |
| **sidebar** | `#1a1a1a` (26,26,26) base | **warm cast at the left edge**: `#1d1a18` at x=0–100pt, r−b = **+5..+7**, decaying to neutral by x≈102pt |
| **sidebar width** | **260pt** (x=0…520px) | band scan, row y=600pt |
| **sidebar → canvas** | **no divider**, a 5-level value step | `#1a1a1a` → `#151515` directly at x=260pt |
| **composer** | `#212121` (33,33,33), **606pt** wide (x=467…1074pt) | band scan, row y=430pt |
| **top edge** | canvas reaches **y=0**; blue bleed b−r **+6 → +1** over the first 100pt | column scan at x=800pt |

## What this means

**The owner's reading is correct, and it is the opposite way round from how it looks.**

- The **sidebar is the glass**: it transmits the wallpaper's warmth at its edges. Less tint.
- The **canvas is the tinted one**: dead flat `#151515` over a varying backdrop. More tint.
- There is **no title bar strip**. The canvas and the sidebar both run to `y=0`, and the top ~100pt
  carries a slight translucent bleed that fades out. This is what makes it read as one continuous
  surface rather than a window with a lid on it.

## Cursor vs Bimax, same capture method (window layer, so comparable to each other)

| | sidebar | canvas | step |
|---|---|---|---|
| Cursor | `#232425` (35) | `#1a1a1a` (26) | **+9 levels** |
| Bimax | `#323334` (50) | `#0d0d0d` (13) | **+37 levels** |

Bimax's canvas is **half** Cursor's luminance, and Bimax's sidebar-to-canvas step is **4×** as large.
The material *class* is already right — we are glass on the sidebar, via `vibrancy: 'sidebar'`. The
**values** are not.

## Not established

Whether Cursor's canvas is strictly opaque or merely tinted far enough to be indistinguishable. The
move test would settle it and could not be run. The design consequence is identical either way.
