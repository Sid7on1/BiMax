# 09 — Black glass: the plan

Owner brief, 2026-09-19: match the dark-glass shell of the reference screenshot (Cursor) — "same
kind of front, same place of things". Two forks were decided by the owner and are recorded in §0.

> **Read `08-changes-applied.md` first.** Rounds 1 and 2 are done. This is round 3.
>
> 🔴 **CORRECTED 2026-09-19 after measuring Cursor directly** (`10-cursor/NOTES.md`). The first
> version of this plan said the change was layout-only because "we are already that material." The
> material *class* is right; the **values are not**, and the correction is load-bearing — see §1.
> A third change was also added: **the top strip goes** (§3.0).

## 0 — Owner decisions

1. **Full parity — empty canvas.** The welcome screen loses its headline, paragraph, CTA buttons and
   Recent Projects grid. Recents move into the sidebar under a `Projects` header.
2. **One accent, used once.** A single saturated colour, reserved for the one primary action on
   screen. Everything else stays neutral.

## 1 — The finding, corrected by measurement

Cursor was measured directly on 2026-09-19 (`10-cursor/NOTES.md`; two invalid attempts are recorded
there, because each would have given a confident wrong answer).

**The owner's reading is right, and it runs opposite to how it looks.** In Cursor the **sidebar is
the glass** — it transmits the wallpaper's warmth at its edges, `#1d1a18` against a `#1a1a1a` base,
r−b +5..+7 — while the **canvas is the tinted one**: `#151515`, flat to the level across **999pt**
of width with `sd = 0.0` over a backdrop that changes from sky to architecture.

So "more tint on the canvas, less on the panels" is exactly what it is doing.

### What was wrong before

The first pass said "we are already that material, do not re-colour anything." Same capture method
on both apps:

| | sidebar | canvas | step |
|---|---|---|---|
| Cursor | `#232425` (35) | `#1a1a1a` (26) | **+9 levels** |
| Bimax | `#323334` (50) | `#0d0d0d` (13) | **+37 levels** |

Our canvas is **half** Cursor's luminance and our sidebar-to-canvas step is **4×** theirs. We have
the right material and the right *direction* — `vibrancy: 'sidebar'` already makes the panel the
translucent one — at the wrong magnitude. **There is a value change to make**, and it is the single
biggest reason the two apps do not read alike.

### What is still true from the first pass

We are on a **system material**, so macOS 27's user opacity slider reaches us for free. Claude
Desktop and Codex, both fully opaque, inherit nothing. Do not trade that away for the
`NSGlassEffectView` private API.

### The rest of the gap is still restraint

| | Cursor | Bimax now |
|---|---|---|
| title bar | **none — canvas and sidebar both reach y=0** | full-width `h-11` strip with a hairline under it |
| sidebar→canvas | no divider; a 5-level value step | `border-r` hairline and a 37-level step |
| canvas | empty; one centered composer, 606pt wide | headline, paragraph, two button rows, recents grid |
| section headers | sentence case, quiet | `UPPERCASE`, `tracking-[0.09em]` |
| accent | one saturated colour, once | `--color-ember` near-white, everywhere |

## 2 — macOS 27 constraints this has to satisfy

From `05-apple/REF-01` and Golden Gate reporting (Apple's own doc pages render client-side and
cannot be fetched; this is secondary sourcing and is marked as such in `SOURCES.md`):

- **Sidebars are edge-to-edge, not floating.** Our sidebar should lose its right border in favour of
  value contrast — which is also what the reference does, and what §3.1 does anyway.
- **Sidebar icons get colour back** (removed in Tahoe). Relevant to the one accent in §3.5.
- **Corner radii become uniform.** Never hardcode a window radius; for our own painted surfaces,
  pick one scale and hold it.
- **The opacity slider only reaches apps on system materials.** We qualify. Keep it that way — this
  is the argument against ever swapping `vibrancy` for the `NSGlassEffectView` private API, which is
  mutually exclusive with it.

## 3 — The changes

### 3.0 Remove the top strip — the headline change
Owner: *"remove this upper strip, make the canvas and panels reach the top, which makes it look like
the flow."* Measured on Cursor: the canvas reaches `y=0`, and the first ~100pt carries a slight
translucent bleed (b−r +6 → +1) that fades out. Nothing sits on top of the surfaces.

Ours is a `h-11` (44pt) `<header>` with `border-b border-line/80` spanning the full width, above
both the sidebar and the canvas. It goes. Both surfaces run to `y=0`; the traffic lights sit *in*
the sidebar and the right-hand controls float *over* the canvas. This is also what macOS 27's
edge-to-edge sidebar asks for.

### 3.1 Retune the tint hierarchy
The one value change, and the measured one:
- lift the canvas from `#0d0d0d` toward Cursor's `#151515`;
- compress the sidebar-to-canvas step from **37 levels to ~9**, keeping the sidebar the lighter,
  more transmissive surface;
- drop the `border-r` between them — at a 9-level step a hairline is redundant, and neither Cursor
  nor the reference apps draw one.

Re-run `check:glass-contrast` afterwards: lifting the canvas changes every contrast ratio measured
against it, and quiet text is already sitting below AA at baseline by deliberate choice.

### 3.2 Dissolve the title bar
`TitleBar.tsx` stops being a full-width `<header>`. Its left cluster moves into `TaskSidebar`'s
existing top row (`TaskSidebar.tsx:119`, already the right position); its right cluster becomes a
floating no-background row over the canvas. Raise `trafficLightPosition` y `14 → ~22`
(`app/src/main/index.ts:1126`) so the lights sit on that row. **Pitch is 23pt, never 20.**

Removes `border-b border-line/80` — the last hairline gap G4 named.

### 3.3 Empty the canvas
`ProjectWelcome.tsx`: delete the marketing stack. Replace with a vertically centered column —
context selectors row → `Composer` → suggestion chips. Nothing else.

### 3.4 Recents into the sidebar
A `Projects` section in `TaskSidebar`, fed by the same recents source the welcome grid used. Header
carries a trailing `+`, as the reference's does. **Thread folders must not appear here** — only
`openProject()` records recents.

### 3.5 Sidebar rhythm
Sentence-case headers (drop `uppercase` and `tracking-[0.09em]`, keep `--color-faint`); trailing
action icons on header rows; account row in the footer; `border-t` on the footer replaced by value
contrast.

### 3.6 One accent
A new `--color-accent` / `--color-accent-ink` pair, one value per theme. Today **both themes are
fully monochrome on purpose** — `--color-moss`, `--color-amber` and `--color-rust` all resolve to
greys — so this is a real departure and must be spent exactly once per screen, on the primary
action. Candidates are not asserted here: pick them, then let `npm run check:glass-contrast` decide,
in both themes and under `prefers-contrast: more`.

### 3.7 Canvas falloff
One soft, non-animated luminance gradient on `.home-canvas`. This is what makes a nearly empty
canvas read as deliberate rather than unfinished. Single token, no animation, no per-frame cost.

## 4 — Explicitly not doing

- **No Liquid Glass private API.** Mutually exclusive with the `vibrancy` we have and depend on, and
  it would cost us the macOS 27 slider.
- **No motion changes.** B1 already cut snappy/bouncy/glass to 283/467/379ms against the solver, and
  the CSS is generated, not hand-typed. Re-tuning means changing the presets, which changes the feel.
- **No re-colour of the *hues*.** The neutral ramp stays. §3.1 changes two surface
  *luminances* and the step between them, which is a different thing and is measured.

## 5 — Verification

1. `app/design-preview` — real components, stubbed IPC, every theme × window state at once.
   **Not** by launching Electron.
2. `npm run check:glass-contrast` — primary ink clears AA at baseline; everything clears AA under
   `prefers-contrast: more`. Run it for the new accent in both themes.
3. `npm run check:motion` and `npm run check:design-preview`.
4. Material test: capture → move the window → re-capture → **plus a same-position control**
   (`tools/measure.py`). A control that is not 0 means the backdrop animates and the test proves
   nothing.
5. Chrome metrics from pixels, not source: traffic-light pitch 23pt, and never a hardcoded window
   radius.

## 6 — Not measured

Cursor's live window **was** measured (`10-cursor/NOTES.md`), which supersedes the first pass's
visual reading. What remains unproven there: whether Cursor's canvas is strictly opaque or merely
tinted past the point of distinguishability. The move test would settle it and could not be run —
AX enumeration is unavailable to this terminal. The design consequence is the same either way.
