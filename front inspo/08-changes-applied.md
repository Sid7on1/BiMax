# Changes applied — 2026-09-12

Everything below is verified: 95 renderer tests pass, `tsc --noEmit` is clean, the harness builds,
and both new checkers exit 0.

---

## R1 — the design-preview harness runs again ✅

**Was:** four dead imports left by **d97018f** (the Computer Use archive separation) —
`LiveTarget`, `PermissionsPane`, `PermissionCoachOverlay`, `mac.session.model`. The documented way to
verify shell UI could not load at all.

- Deleted `design-preview/inspector.tsx` and `design-preview/permissions.tsx` — both previewed
  components that no longer exist in the product — and removed them from `main.tsx`'s `Page` union.
- **Root cause of the silence:** `tsconfig.json` includes only `src`, and electron-vite never touches
  `design-preview/`. **Neither `npm run typecheck` nor `npm run build` covered the harness.**
- Added **`npm run check:design-preview`** (`vite build` on the harness config) and wired it into
  `.github/workflows/ci.yml` after the app build.
- **Mutation-tested the gate in both directions.** First attempt injected an *unused* dead import and
  the gate passed — esbuild strips unused imports before resolution, so the test was invalid. With a
  *used* dead import (the real failure shape) it exits 1, and 0 once restored.
- Views are now addressable by hash (`#shell`, `#transcript`, …), so looking at one no longer means
  editing a source file.

## R4 — the real `Transcript` now has a preview ✅

**Corrected framing:** the gap was not "the chat preview is empty". `chat.tsx` is an `@ai-sdk/react`
mock for designing *streaming*, and says so — it deliberately is not the shipping transcript. The real
gap was that **`Transcript.tsx`, the largest surface in the app, had no preview at all.**

Added `design-preview/transcript.tsx`: the real component against an `EngineStore` and a fixture of
the rows that are hard to get right — a running tool call, a finished one, a **failed** one, a fenced
code block, a thought line, and a system error. Rendered in both themes.

## R3 — the accessibility paths are now proven, and two real defects fell out ✅

The OS toggle is SIP-protected, so the media features were driven through CDP
`Emulation.setEmulatedMedia`. All three fire, and **orthogonally** — each touches only its own concern:

| token | baseline | reduced-motion | reduced-transparency | contrast: more |
|---|---|---|---|---|
| `--dur-glass` | 379ms | **60ms** | 379ms | 379ms |
| `--glass-veil` | rgba(…,0.62) | — | **#101011** | — |
| `--app-veil` | rgba(…,0.86) | — | **#0d0d0d** | — |
| `--glass-lens-brightness` | 1.12 | — | **1** | — |
| `--color-line/dim/faint` | base | — | — | **boosted** |

### Defect 1 — a theme scope silently shadowed the accessibility overrides 🔴 fixed
`prefers-reduced-transparency` and `prefers-contrast` set their tokens on **`:root` only**, but
`.theme-moonlight` / `.theme-starlight` define those same tokens. On any element carrying a theme
class, the `:root` override is shadowed **for that whole subtree**.

Measured: under `prefers-contrast: more`, `:root` resolved `--color-dim` to the boosted
`color-mix(...)` while a themed element inside it still resolved `#b8b8b5`.

It works in the app today *only* because the theme class happens to live on `<html>`. The moment a
themed surface is nested — a light preview inside a dark app, or the harness showing both at once —
the accessible path stops applying, silently. **Fixed** by scoping both blocks to
`:root, .theme-moonlight, .theme-starlight`.

### Defect 2 — Increase Contrast did not actually reach AA 🔴 fixed
With the shadowing fixed, the remedy `styles.css` promises ("the Increase Contrast block … is what
answers it") was measurable for the first time — and it fell **just short**: the smallest quiet text
landed at **3.97, 4.29 and 4.47 : 1** against a 4.5 floor, in the one mode whose entire purpose is to
clear it. Raised the mixes from **88%/70% → 92%/82%**. All 64 nodes now clear their floor.

## B1 — motion: 20–29% fewer frames, identical character ✅

The CSS springs are **generated** from `simulateSpring()` and pasted, so the durations were not
hand-edited. The real cause was that `SETTLE_EPSILON`/`SETTLE_VELOCITY` were **size-blind**: 0.1% of
travel is a *ninth of a pixel* on a 120pt control, and 0.02/s is 0.04px per frame.

Added **`settleFor(diagonal)`** in `motion.ts` — a surface stops being drawn once it is within half a
pixel of target and moving under half a pixel per frame — threaded through `resolveSpring` (and its
cache key) from `springFor`, which already knew the diagonal.

| preset | was | now | peak (unchanged) |
|---|---|---|---|
| snappy | 354ms | **283ms** −20% | 1.2% |
| bouncy | 629ms | **467ms** −26% | 11.8% |
| glass | 533ms | **379ms** −29% | 3.8% |

**The physics is untouched** — same springs, same overshoot, only the invisible tail removed. CSS
regenerated from the project's own solver, not hand-typed.

Two test failures caught a real flaw in the first attempt, and both had the same cause: **below
control size, half a pixel is a larger fraction than the overshoot itself**, so the settle band
swallowed the bounce (snappy's overshoot is 1.2%; half a pixel of a 40pt button is 1.25%). The
threshold is now clamped to `[CONTROL_DIAGONAL, WINDOW_DIAGONAL]`, exactly like `sizeFactor` — which
also restored the scale-invariance the other test asserts.

Ceiling worth knowing: tuning the thresholds alone plateaus here. Going below ~283/467/379 means
changing the **presets**, which changes the feel — your call, not a cleanup.

## R2 — the contrast table is now re-runnable ✅

`npm run check:glass-contrast` (`app/scripts/check-glass-contrast.mjs`) renders the real components
over the harness's saturated gradient — harsher than any desktop picture — and asserts two properties
matching what `styles.css` actually commits to:

1. **primary ink clears AA at baseline** (currently worst **10.11:1**);
2. **everything clears AA under `prefers-contrast: more`** — the remedy the file promises.

Quiet text below AA at baseline is **reported, not failed**: that is a deliberate choice, documented
in `styles.css`. 26 nodes sit there today.

Run this on macOS 27, at both ends of the Liquid Glass slider. That is what R2 asked for and it is now
one command instead of a hand-measured table.

> The checker itself needed correcting twice, which is worth recording: it first asserted AA on *all*
> text (a gate that could only ever fail), and it parsed `color-mix()`'s `color(srgb 0.85 …)` floats
> on a 0–255 scale, which reported boosted text as black and made a working fix look like a
> catastrophic regression.

## B5 — icon audit (finding only, not fixed)

| | `CFBundleIconName` | `Assets.car` |
|---|---|---|
| Claude | `Claude` | 1.81 MB |
| Codex | `Icon` | 3.18 MB |
| **Bimax** | **(none)** | **(none)** |

Both reference apps are Electron and both ship a compiled `Assets.car` **and** declare
`CFBundleIconName` — what macOS 26+ needs to render the layered icon — keeping `electron.icns` only
as fallback. We ship the flat `.icns` alone, so on macOS 26 (and 27, which adds *more* glass layers to
icons) ours renders legacy while every neighbouring icon does not. **This also proves it is achievable
in Electron.** Next step: Icon Composer `.icon` → `Assets.car`, injected via the existing
`scripts/after-pack.cjs`, plus the `CFBundleIconName` key.

---

## Files changed
```
app/design-preview/inspector.tsx        deleted  (previewed a deleted component)
app/design-preview/permissions.tsx      deleted  (ditto)
app/design-preview/transcript.tsx       new      (the real Transcript + fixture)
app/design-preview/main.tsx             hash routing, dead panes removed, themed wrappers re-assert ink
app/src/renderer/src/components/ui/motion.ts   settleFor(diagonal), threaded through resolveSpring
app/src/renderer/src/styles.css         regenerated springs; a11y blocks scoped to theme classes;
                                        Increase Contrast mixes 88/70 → 92/82   (24 lines)
app/scripts/check-glass-contrast.mjs    new
app/package.json                        check:design-preview, check:glass-contrast
.github/workflows/ci.yml                harness gate after the app build
```
Nothing was committed. `styles.css` also carries pre-existing uncommitted work of yours
(workspace hero, capability banner) that was left untouched.

## Still open — your call
- **B2** `--app-veil` at 0.86 on glass-free screens: commit to visible translucency, or set it to
  `--color-bg`. Currently neither.
- **B4** macOS 27 wants **edge-to-edge sidebars** and **colour in sidebar icons**; our sidebar is a
  floating glass panel, which is the *Tahoe* idiom 27 moves away from.
- **B1 beyond the plateau** — changing the spring presets changes the feel.
- **B5 implementation** — Icon Composer pipeline.
- The **live** OS toggle for Reduce Motion / Reduce Transparency (SIP blocks the CLI; CDP emulation
  proved the CSS, not the Electron ↔ macOS wiring).

---

# Round 2 — 2026-09-12 (evening)

All four items that the first round left as "your call" were taken. Verified: 376/377 app tests pass
(the one failure is pre-existing and environment-dependent — see the end), `tsc --noEmit` clean, the
harness builds, and all four package gates pass on the artifact that is now installed in
`/Applications`.

## B1 — past the plateau: every stiffness doubled, **and the solver was wrong** ✅

Settling time goes as `1/√k` while overshoot depends on ζ alone, so doubling stiffness is the one
knob that shortens motion without touching character. Measured, at control size:

| preset | was | now |
|---|---|---|
| snappy | 283ms | **209ms** |
| bouncy | 467ms | **338ms** |
| glass  | 379ms | **271ms** |
| calm   | 417ms | **278ms** |
| `--dur-exit` | 210ms | **150ms** |

**But the premise had to be checked first, and it failed.** "Raising stiffness preserves overshoot"
is true of the physics and was *not* true of this solver. `simulateSpring` integrates with
semi-implicit Euler at `DT = 1/240`, which is only first-order accurate; the error appears as
numerical damping. Against the closed form `Mp = exp(-πζ/√(1-ζ²))`:

| preset | analytic | at 1/240 | at 1/4800 |
|---|---|---|---|
| snappy | 1.99% | **1.22%** | 1.94% |
| bouncy | 12.63% | 11.79% | 12.57% |
| glass | 4.60% | 3.85% | 4.55% |

So **39% of snappy's overshoot was being eaten before any of it reached CSS** — and the error scales
with stiffness, reaching 53% at k=1240. The knob you reach for to make a preset faster was quietly
draining its character. `DT` is now `1/4800`: every preset lands within 3% of the closed form, and
overshoot is now genuinely invariant under stiffness (1.94% at k=1240, 1.88% at k=4960), which is
what makes the doubling legitimate. It costs iterations and nothing else — the emitted `linear()` is
resampled to 24–120 stops regardless of `DT`, so the stylesheet does not grow.

Net effect: **shorter durations and slightly *more* bounce than before.** The presets now mean what
they say. 17/17 motion tests still pass — they assert properties, not pinned constants.

**New gate.** The `linear()` curves are compiled output that was being pasted by hand.
`npm run gen:motion` emits the block; `npm run check:motion` fails if the stylesheet and the solver
disagree, and is wired into CI. Mutation-tested in both directions: PASS before the preset change,
DRIFT (exit 1, naming all six tokens) after, PASS again once regenerated.

## B2 — the veil: committed to opaque ✅

`.app-surface` — the transcript, inspector and editor — was `--app-veil` at α 0.86 behind a 24px
`backdrop-filter`. **This file's own rule for glass already rejected that**: *"above ~0.68 the
translucency stops being perceptible and this is just a tinted panel."* At 0.86 it paid for a
full-surface backdrop filter on the largest regions in the app and bought 14% transmission nobody
reads as vibrancy — and it had to be switched off again for zoomed and full-screen windows. A
material that is imperceptible when it works and must be disabled when it cannot is not earning its
place on a reading surface.

What it *did* buy was a wallpaper tint on every reading surface, which is exactly how round 1 came to
measure these warm-neutral tokens as "cool" and conclude the palette was incoherent.

`.app-surface` is now `--color-bg`, the `--app-veil` token is deleted in all three places, and the
`[data-chrome='expanded']` override it needed is gone with it. **Glass is now only where it is
deliberate** — sidebar, dialogs, morph surfaces, all on `--glass-veil` at 0.62, below the knee and
genuinely translucent. The window stays transparent so those surfaces still have vibrancy to sample.

## B4 — edge-to-edge sidebar ✅, colour ❌ (and why)

**Edge-to-edge, with no layout change.** The title bar and the sidebar are already the same material;
what cut the left column in two was a single hairline — `.titlebar-shell { box-shadow: inset 0 -1px 0 }`
— running the full width of the window. That hairline belongs to the *content*, not to the bar. It
now sits on `.app-surface`, which is by definition every pane that is **not** the sidebar, so it
draws exactly the segment that should still be divided: from the sidebar's edge to the window's. The
sidebar now reads as one glass column the full height of the window, with the traffic lights on it —
the macOS 27 idiom, and already how Finder and Mail look on 26.

**Colour was declined, deliberately.** The palette is achromatic by design — `--color-ember` is
`#ededeb` and `--color-amber` is `#b9b9b4`, both greys — and the sidebar has no destination taxonomy
for a hue to encode (Search, New chat, a list of chats, App health). Per-item colours would be
decoration carrying no information.

**What the intent actually pointed at was real, though, and it was a defect.** macOS 27's complaint
is that sidebar icons are *drained*. Ours were on `text-faint`. Icons are non-text, so their floor is
3:1 (WCAG 1.4.11), and `faint` only just clears it:

| | vs solid surface | |
|---|---|---|
| moonlight `faint` | 4.54:1 | pass |
| **starlight `faint`** | **3.12:1** | barely |

…and `check:glass-contrast` puts that same starlight band at **~2.1:1 over windowed glass**. So in the
light theme the sidebar icons were *under* the non-text floor whenever the sidebar was actually
translucent. The three icon carriers (search, settings, nav items) are now `text-dim` — 6.04:1 in
starlight. The quiet *text* was left alone: that is a documented deliberate choice with Increase
Contrast as its stated remedy.

## B5 — the icon catalog pipeline ✅ (container), layered icon still needs Icon Composer

`scripts/make-app-icon-assets.mjs` compiles an asset catalog with `actool` and declares
`CFBundleIconName`, called from `after-pack.cjs` **before signing** (both are signed resources).
Shipping now: `Assets.car` 1.73 MB + `CFBundleIconName=AppIcon`, against Claude's 1.81 MB and
Codex's 3.18 MB. We were the only one of the three opted out; we no longer are.

**Measured what the reference app actually ships, rather than guessing.** `assetutil` on Claude's
catalog returns `IconGroup`, `IconImageStack`, `Icon Image`, plus named gradients and colours under
`Claude_Assets/` — i.e. a **layered Icon Composer document**, not an appiconset. Ours currently
compiles from `icon.png` into an `AppIcon.appiconset`: 10 renditions + a `MultiSized Image`, the
right container but a single flat layer, so it cannot parallax or re-tint per appearance.

The script **prefers `buildResources/Bimax.icon` when present** and only falls back to the flat path.
Icon Composer is a GUI app inside Xcode and its `icon.json` schema is not documented or sampled
anywhere on disk — synthesising one by hand would mean inventing a format and shipping something that
compiles and lies. So: author the `.icon` in Icon Composer once, drop it in `buildResources/`, and the
pipeline compiles it with no further change. That is the remaining step for a genuinely layered icon.

Icon compilation is non-fatal: a machine without Xcode logs a skip and ships the `.icns`, rather than
failing the build.

## Files changed this round
```
app/src/renderer/src/components/ui/motion.ts        DT 1/240 → 1/4800; all four stiffnesses doubled
app/src/renderer/src/styles.css                     regenerated springs; .app-surface opaque;
                                                    --app-veil deleted; titlebar hairline → content
app/src/renderer/src/components/TaskSidebar.tsx     icon carriers text-faint → text-dim
app/scripts/gen-motion-tokens.mjs                   new — emits/verifies the spring tokens
app/scripts/make-app-icon-assets.mjs                new — actool catalog + CFBundleIconName
app/scripts/after-pack.cjs                          installs the icon catalog before signing
app/package.json                                    gen:motion, check:motion
.github/workflows/ci.yml                            motion gate
```

## Two things found on the way — both resolved 2026-09-13

- **`app/scripts/screenshot-ui.mjs` is stale.** Its journey clicks a "Browse all sessions" button
  that no longer exists, so the full suite throws after two shots (`--quick` is unaffected). Same
  silently-dead-harness family as R1. It also needs `BIMAX_UI_CHROME` pointed at a real Chrome,
  because puppeteer's own browser was never downloaded.

  **Resolved: it should not have existed at all.** Phase 5 deleted it on 2026-08-09
  (`docs/product-reset/16_PHASE5_FRONTEND_RECORD.md`), together with `Dock`, `Sidebar` and `Footer`.
  That deletion was never committed, and the copy-based recovery of 2026-08-15 brought all of them
  back. Measured, it was worse than one button: **all 13 interactive steps missed**, and its `⌘J` step
  now *hides* the inspector, so every later lane shot was of a closed panel. It and the ten unreachable
  components it drove moved out of the repo to `~/Developer/bimax-archive` at their repo paths
  (byte-identical to `0b02ed3`; recorded in that folder's README).

  **Still open:** its replacement, `app/scripts/ui/journeys.mjs`, is stale too — **2 of 13 pass**
  (J1, R1). J2/J3 look for a "Changes" lane that is now Review, J4–J10 and J12 drive the archived
  Computer Use surfaces, and J11's "Browse all 5 models" is now "Browse all N available models".
  Neither harness is wired into `package.json` or CI.
- **`app/src/__tests__/local.models.test.ts` reads the real machine.** It asserts *no* servable local
  models, which is only true where Ollama is not running — this box now serves `all-minilm` and
  `qwen2.5:0.5b`, so it fails here and would pass on CI. Environment-dependent, unrelated to anything
  in this round, and the same family as the tests that once wrote the real config.

  **Resolved.** `HOME` already fenced the disk; the test now stubs `fetch`, which fences the network.
  The `servable` case was a loop over an array that is always empty once the network is fenced, so it
  now stands up a fake Ollama and asserts that exactly its listed model comes back. 4/4 pass on this
  machine with the real Ollama still serving.
