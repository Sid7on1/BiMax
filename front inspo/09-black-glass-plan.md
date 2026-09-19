# 09 — Black glass: the plan

Owner brief, 2026-09-19: match the dark-glass shell of the reference screenshot (Cursor) — "same
kind of front, same place of things". Two forks were decided by the owner and are recorded in §0.

> **Read `08-changes-applied.md` first.** Rounds 1 and 2 are done. This is round 3, and it is a
> **layout** change, not a colour change. See §1 for why.

## 0 — Owner decisions

1. **Full parity — empty canvas.** The welcome screen loses its headline, paragraph, CTA buttons and
   Recent Projects grid. Recents move into the sidebar under a `Projects` header.
2. **One accent, used once.** A single saturated colour, reserved for the one primary action on
   screen. Everything else stays neutral.

## 1 — The finding: we are already the material

The reference reads as "black glass". So do we. Measured tokens, Moonlight:

```
--color-bg   #0d0d0d          --glass-veil  rgba(17,17,19,0.40)
--color-ink  #f5f5f4          --glass-edge  rgba(255,255,255,0.09)
```
over `vibrancy: 'sidebar'`, `transparent: true`, `backgroundColor: '#00000000'`
(`app/src/main/index.ts:1117-1126`).

That is black-infused glass on a **system material**, which also means macOS 27's user opacity slider
reaches us automatically — Claude Desktop and Codex, both opaque, inherit nothing. **Do not re-colour
anything to chase the screenshot.** The gap is elsewhere:

| | reference | Bimax now |
|---|---|---|
| title bar | none; controls absorbed into the sidebar top strip and floating top-right | full-width `h-11` header with a bottom hairline |
| canvas | empty; one centered composer stack | 40px display headline, paragraph, two CTA rows, recents grid |
| section headers | sentence case, quiet, with trailing actions | `UPPERCASE`, `tracking-[0.09em]` |
| hairlines | ~one faint vertical | title bar bottom, sidebar right, sidebar footer top |
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

### 3.1 Dissolve the title bar
`TitleBar.tsx` stops being a full-width `<header>`. Its left cluster moves into `TaskSidebar`'s
existing top row (`TaskSidebar.tsx:119`, already the right position); its right cluster becomes a
floating no-background row over the canvas. Raise `trafficLightPosition` y `14 → ~22`
(`app/src/main/index.ts:1126`) so the lights sit on that row. **Pitch is 23pt, never 20.**

Removes `border-b border-line/80` — the last hairline gap G4 named.

### 3.2 Empty the canvas
`ProjectWelcome.tsx`: delete the marketing stack. Replace with a vertically centered column —
context selectors row → `Composer` → suggestion chips. Nothing else.

### 3.3 Recents into the sidebar
A `Projects` section in `TaskSidebar`, fed by the same recents source the welcome grid used. Header
carries a trailing `+`, as the reference's does. **Thread folders must not appear here** — only
`openProject()` records recents.

### 3.4 Sidebar rhythm
Sentence-case headers (drop `uppercase` and `tracking-[0.09em]`, keep `--color-faint`); trailing
action icons on header rows; account row in the footer; `border-t` on the footer replaced by value
contrast.

### 3.5 One accent
A new `--color-accent` / `--color-accent-ink` pair, one value per theme. Today **both themes are
fully monochrome on purpose** — `--color-moss`, `--color-amber` and `--color-rust` all resolve to
greys — so this is a real departure and must be spent exactly once per screen, on the primary
action. Candidates are not asserted here: pick them, then let `npm run check:glass-contrast` decide,
in both themes and under `prefers-contrast: more`.

### 3.6 Canvas falloff
One soft, non-animated luminance gradient on `.home-canvas`. This is what makes a nearly empty
canvas read as deliberate rather than unfinished. Single token, no animation, no per-frame cost.

## 4 — Explicitly not doing

- **No Liquid Glass private API.** Mutually exclusive with the `vibrancy` we have and depend on, and
  it would cost us the macOS 27 slider.
- **No motion changes.** B1 already cut snappy/bouncy/glass to 283/467/379ms against the solver, and
  the CSS is generated, not hand-typed. Re-tuning means changing the presets, which changes the feel.
- **No re-colour of the surface tokens.** See §1.

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

The owner's reference screenshot was a pasted temp file and was cleaned up before it could be
sampled, so **the reference's exact surface values are a visual reading, not a measurement**. If it
is re-saved, run `tools/measure.py` against it and correct §1's comparison table before relying on it.
