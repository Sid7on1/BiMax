# Bimax (ours) — front-end baseline

**Build** `/Applications/Bimax.app` · Electron 43.3.0 · React 18 · Tailwind v4 (CSS-first, no config file)
**Renderer** 53 `.tsx` components · **one** `styles.css` (1287 lines) · Radix for `Dialog` only ·
lucide-react · react-virtuoso · react-resizable-panels · xterm · **no animation library** — motion is
hand-rolled (`ui/motion.ts` 307 lines + `ui/morph/*` with its own spring solver)
**Window under test** 1180×800pt at (145,33) · welcome/no-project state

---

## 1. Material — we are the only one of the three that is translucent, and barely

`main/index.ts:373–388` sets `vibrancy`, `visualEffectState`, `titleBarStyle`, `trafficLightPosition`.
**The vibrancy does reach the pixels — but at roughly 5% strength.**

Proven with a move test plus a control:

| comparison | mean \|Δ\| | pixels >6 | max |
|---|---|---|---|
| same position, 1.2s apart | **0.00** | 0.0% | **0** |
| same position, 40s apart | **0.00** | 0.0% | **0** |
| window moved (145,33) → (10,120) | 6.67 | 15.2% | 732 |

The control proves nothing animates on its own, so every difference is backdrop bleed. Localising it:
83% of the large deltas sit within 12pt of the window edge (shadow + rounded corners), but the
**interior still shifts by up to 4 levels per channel** (inset 20pt+: mean 3.05, max 13).

> **Broken property.** A surface token should render the same colour regardless of what is behind the
> window — or, if translucency is intended, it should be visibly and deliberately translucent.
> Ours is neither: too weak for anyone to read as glass, strong enough that our surface colours are
> not reproducible. We pay the whole cost of vibrancy (GPU compositing, legibility risk, a
> Reduce-Transparency path to maintain) for an effect nobody can see.
>
> Compare: Claude `#111111` and Codex `#181818` are **pixel-identical** over the same wallpaper swing.

## 2. Palette — warm text on cool surfaces

| role | value | note |
|---|---|---|
| top bar | `#191f2d` | strongly **blue** |
| top bar top highlight | `#474c57` | a hairline we draw |
| top bar bottom border | `#2d3340` | another hairline we draw |
| page (top) → (bottom) | `#1a1d21` → `#131313` | a vertical gradient |
| card | `#1b1b1c` | near-neutral |
| primary button | `#ededeb` fill | near-white |

**Text**: primary `#f5f5f4` · body `#b8b8b5` · muted `#7c7c79` — a **warm** ramp, very close in spirit
to Claude's `#f0efec`/`#898782`.

> **Inconsistency**: our text ramp is warm (R>G>B) while our surfaces are cool (B>G>R, `#191f2d`).
> Claude commits to warm throughout; Codex commits to cool throughout. We mix, which is why our
> chrome can read slightly "off" without an obvious cause.

> **Borders**: we draw a top highlight *and* a bottom border on the title bar. Neither Claude nor
> Codex draws any hairline at all — they separate surfaces with value alone.

## 3. Traffic lights — question resolved

| app | pitch | diameter |
|---|---|---|
| Claude | **23.00pt** | 12pt |
| Bimax | **23.00pt** | 12pt |

Identical across two independent apps ⇒ **23pt centre pitch is the macOS 26 system metric**, not
something either app chose. (Classic macOS was 20pt.) Worth confirming against Apple's docs, but the
empirical cross-check is already decisive. Our traffic-light centre line sits at y=26.5pt; Claude's at
y=34.2pt — that difference *is* a choice (`trafficLightPosition`).

## 4. Motion — we animate far more than either reference app

Theme/appearance menu open, 60fps, measured as distance-to-settled over the menu region:

| t | mean \|Δ\| vs settled | pixels still changing |
|---|---|---|
| +67ms | 3.016 | 92,447 |
| +100ms | 2.276 | 56,452 |
| +133ms | 1.606 | 38,445 |
| **+167ms** | **2.202** | **44,992** ← rises again |
| +200ms | 2.192 | 46,012 |
| +267ms | 1.310 | 35,913 |
| +367ms | 0.297 | 21,747 |
| +400ms | 0.014 | 932 |
| **+433ms** | **0.000** | **0** |

- **433ms to a pixel-identical settled state.**
- Convergence is **non-monotonic** (1.606 → 2.202 → 2.192 → decay) = measured **spring overshoot**,
  consistent with `seedPopover: { stiffness: 520, ratio: 0.82 }` in `morph/tokens.ts`.
- The seed morph is real and visible: a small rounded "seed" near the palette button expands into the
  menu (frames at −17ms and +33ms), and content reveals *during* the expansion — at +33ms the third
  row's description has not appeared yet.

**Against the reference apps:**

| | Claude | Codex | **Bimax** |
|---|---|---|---|
| popover / menu open | **0ms** (single frame) | — | **433ms**, with overshoot |
| sidebar collapse | **0ms** (single frame) | 367ms ease-out (close only; open 0ms) | not measured |
| modal open | **0ms** (single frame) | — | not measured |
| periodic | caret 500ms | — | — |

## 5. Accessibility wiring — present, and better than I expected

`styles.css` carries real `@media` blocks for `prefers-reduced-motion` (×2), **`prefers-reduced-transparency`**
and **`prefers-contrast: more`**. `morph/tokens.ts` defines a dedicated `reducedMotion` token
(stiffness 1100, ζ=1.0, ~120ms — a fast settle, deliberately *not* "no motion").

Crucially the flag is wired into the **live** path, not only tests: `use-morph.ts:89` and
`MorphSurface.tsx:181` both inject `reducedMotion: prefersReducedMotion` into the controller.

⚠️ **Not yet verified end-to-end.** `com.apple.universalaccess` is SIP-protected so Reduce Motion
cannot be toggled from the CLI; the live toggle test is deferred to the implementation session.
Given this codebase's history of correct code on unreachable paths, that test should actually be run.

## 6. Layout (welcome state)
Top bar 50pt tall · hero left-aligned at x=182pt · primary button `#ededeb` fill with dark label ·
`RECENT PROJECTS` cards in a 2-column grid, card fill `#1b1b1c`.
Main workspace (Composer / Transcript / Sidebar) **not yet captured** — the welcome state was the
only surface reachable without opening a project and starting the engine.

## 7. Open items
- Capture the real workspace: `Composer`, `Transcript`, `Sidebar`, `DiffView`, `CommandPalette`.
  Prefer `app/design-preview` (real components, stubbed IPC) over launching the engine.
- Light mode ("Starlight") not captured.
- Reduce Motion / Reduce Transparency live toggle test.
- Window corner radius not measured.

## Evidence
`bimax-01-home.png` · `bimax-02-theme-menu-frames.png` (−17…+417ms) ·
`bimax-03-moved-window-material-test.png`
