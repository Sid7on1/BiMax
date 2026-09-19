# 11 — Round 3 applied: the black-glass shell

Owner brief across 2026-09-19. Measured on the running window over a **bright** wallpaper, which is
the condition that exposes surface defects; a window-layer capture hides all of them.

> Round 1 and 2 are `08-changes-applied.md`. The Cursor teardown this round is measured against is
> `10-cursor/NOTES.md`, and the plan is `09-black-glass-plan.md`.

## The three rules this round established

1. **One alpha, many tints.** The step between two surfaces must not depend on the wallpaper. With
   alphas of 0.82/0.72/0.62 the sidebar sat 11 levels above the canvas over a dark backdrop and
   **36** over a bright one — the same join, three times the contrast, which reads as a drawn line.
   Every surface now shares an alpha (or sits within 0.06 of its neighbour), and the difference is
   carried by the tint colour, which is backdrop-independent.
2. **No per-surface `backdrop-filter`.** The window is `vibrancy: 'sidebar'`, so macOS diffuses
   behind the whole web contents. Any surface that adds its own blur averages the backdrop into a
   flat field, and a flat field beside a canvas showing the wallpaper's structure is what reads as
   *opaque*. 28px was obvious; 12px was still wrong in the same direction; zero is right.
3. **Separation by value, never by a rule.** No borders, no rim lights, no inner glows, no specular
   top lines between surfaces. An edge is drawn only when it is information — focus, drag-over.

## What was removed, and what it actually was

| Reported as | Actually |
|---|---|
| "a border on the upper strip" | `inset 0 1px 0 var(--glass-sheen)` — a 1px rgba(255,255,255,0.16) line on `.sidebar-shell` and `.evidence-studio` |
| "a weird border on the side panel" | three things: the varying-alpha step, `.glass-lens::before` (an 8px `brightness(1.12)` ring), and `inset 0 0 30px` inner glow brightening the perimeter |
| "white lines around components" | `--glass-sheen` at 0.16, plus `--color-line` at 52 against a 26 canvas |
| "the right panel is opaque" | its own `backdrop-filter`, and a header painted as a 62% `--color-raise` slab with a rule under it |
| "settings isn't black tinted" | `.liquid-glass` painted every dialog with `--glass-veil`, the **sidebar's** tint — the lightest of the three |
| "a white half-circle in the canvas" | `.home-canvas` had four painted washes, incl. `radial-gradient(ellipse at 50% 0%, ink 5%)` |
| the 1px bright line at a pane join | `bg-transparent` on the resize `Separator`. The window is transparent, so a 1px column painting nothing is a 1px **hole** to the wallpaper — measured as a 60-luminance spike between surfaces at 30 |

## Measured, at the sidebar/canvas join, over the bright wallpaper

**37.3 → 13.7 → 9.7 → 5.0.** The canvas/right-pane join finished at **1.7**. Cursor's is +9.

## The token set

`--app-veil` canvas · `--pane-veil` side panes · `--glass-veil` sidebar · `--float-veil` every
dialog, menu and popover · `--raise-veil` the large raised surfaces · plus `--*-solid` stand-ins for
the expanded-window and Reduce-Transparency paths, which must preserve the windowed hierarchy.
(`--glass-solid` did not: at 16 it sat ten levels *below* the canvas, so going full screen flipped
the sidebar from the lightest surface to the darkest.)

Reduce Transparency and Increase Contrast now densify **all** the veils. Before, they touched only
`--glass-veil`, which after this change would have applied the setting to the smallest surface and
skipped the two largest.

## Contrast

Improved throughout, and the biggest single win was equalising **Starlight**, which was still on the
old varying-alpha scheme (0.46 sidebar against an 0.88 canvas):

worst primary ink **7.11 → 11.46:1**; quiet-below-AA **36 → 34**. `npm run check:glass-contrast`.

## Also in this round

The title bar was deleted (`TitleBar.tsx` → `SidebarChrome` + `CanvasChrome`, both painting
nothing); the embedded browser lane was removed to the archive; the canvas top row is empty; the two
grey text strips bracketing the composer are gone, with the shortcut line kept `sr-only` as the
textarea's `aria-describedby`; 14 dead `.browser-*` CSS rules were deleted.

## Not done

The empty canvas with a centred composer, recents into the sidebar, sentence-case section headers
and the one accent — all four remain Target from `09-black-glass-plan.md`. Small controls keep solid
fills on purpose (Apple: no glass on glass). No installed-app or packaged run; everything here is
the dev window.
