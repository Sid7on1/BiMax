# Seed Morph v2 — what was built

The brief is in [SEED_MORPH_BRIEF.md](SEED_MORPH_BRIEF.md); what BiMAX actually is, and what v1
already did, is in [AUDIT.md](AUDIT.md). This file is the implementation: what changed, why, and
what has been measured rather than assumed.

## The one architectural change

**v1 was a FLIP.** The destination was laid out at final size, inverted onto the seed with a
transform, and played to identity. Beautiful compositing, two defects that cannot be patched:

1. `border-radius` resolves *before* the transform, so a 22px corner on a box scaled by (0.07, 0.4)
   paints as a 1.5×9px ellipse. The corner could not be interpolated honestly — which is why v1
   hard-coded `999px → 22px` and let it distort.
2. Content had to be counter-scaled to survive, and a counter-scale is a resample.

**v2 animates the box's real geometry** — `x, y, width, height, radius` as five retargetable springs
on a `position: fixed`, `contain: layout paint` shell, with the content laid out once at destination
size and merely clipped by the growing shell. This is what Prompt 1 §13 asks for literally: *morph
the container geometry, then reveal destination content within that geometry*.

Three things fall out of that choice for free:

- **Corner-anchoring** (§6). With `x` and `width` as independent springs, a seed left of its
  destination has a left edge that travels 200px while its right edge travels 660px. The near edge
  stays hooked to the source without a rule saying so. Under centre+scale both edges move
  symmetrically and the effect has to be faked with `transform-origin`.
- **Honest radius** (§7). It is a number in px, so it interpolates. Measured: 22 → 14 with a maximum
  step of 1.21px per frame.
- **No counter-scale on the morph path.** Text is rendered at its final size on frame one.

## Files

| File | What it owns |
|---|---|
| `morph/geometry.ts` | Pure geometry: `MorphGeometry`, destination placement per kind, concentric radius, `radiusOf` (resolves `50%`/`999px`), progress, travel |
| `morph/spring-value.ts` | The retargetable spring — **analytic**, not Euler |
| `morph/tokens.ts` | Motion tokens v2, material states, size/distance grading, velocity deformation |
| `morph/controller.ts` | Five springs, one shared rAF, state machine, slow motion |
| `morph/paint.ts` | The write half of a frame, for a surface and for a region's clip |
| `morph/use-morph.ts` | The lifecycle: one controller per surface, open/close by retarget, re-measurement, paint subscription |
| `morph/MorphSurface.tsx` | React binding, overlay portal, `SeedPopover` |
| `morph/MorphRegion.tsx` | Structural regions: shell flies, region is revealed through it, overlay hands off to layout |
| `morph/SeedMenu.tsx` | A menu grown from its own trigger |
| `morph/use-seed.ts` | Seeds as *handles*, measured on demand; the latching intent seed |
| `morph/debug.tsx` | Dev overlay: source / destination / current / path / readouts |
| `ui/dialog.tsx` | Radix's focus trap, geometry driven by the morph |
| `ui/toolbar.tsx` | Toolbar priority tiers and the overflow menu |
| `design-preview/lab.tsx` | The Motion Lab |

`components/ui/motion.ts` (the spring → CSS `linear()` compiler) is **unchanged and still in use**.
It is the right tool wherever the destination is known at launch and never moves — press, hover,
selection, fades — because the browser composites the whole flight on the GPU and it keeps playing
through a main-thread stall. Prompt 1 §36: *do not create duplicate animation systems*. Only the
morph moved.

## Why the spring is analytic

The usual implementation steps `v += a·dt; x += v·dt`. That is *conditionally stable*: at the
stiffnesses here (up to ~620) it needs `dt` under ~88ms, and a single stalled frame past that makes
the spring **gain** energy. In an app that stalls the main thread to render streaming markdown, that
failure is routine and looks like a panel flinging itself off screen after a hitch.

The closed-form solution of a damped harmonic oscillator has no such limit. `step()` is exact for any
`dt`. Pinned in `morph.spring.test.ts` by the invariant an unstable integrator breaks — total energy
`½k·x² + ½v²` never increases — across stalls of 50ms, 200ms, 500ms, 1s and 4s. Stepping once by
100ms and sixty times by 1.67ms land on the same value to four decimal places.

## Springs

Every morph token sits at **ζ ≥ 0.82**. v1's morph used ζ 0.70, which overshoots ~12% on a control.
Prompt 2 §6 governs: this is a pointer-driven Mac app whose controls get clicked hundreds of times a
session, and an overshoot you notice on the first click is one you resent by the hundredth. Measured
overshoot at ζ 0.82 over 300px of travel: **under 5px**. Present as a settle, absent as a bounce.

`dismiss` is critically damped and stiffer than any opening token — an overshoot on close means the
panel briefly gets *bigger* after the user asked it to go away.

Grading (`gradeSpring`): ζ climbs toward critical and stiffness falls as the surface grows, because
overshoot is perceived as a *fraction* of the surface. The distance term is deliberately small —
12% more time over the longest travel. Prompt 1 §29 asks for distance to matter; Prompt 2 §8 caps
how much it may.

## What was measured, not assumed

All from the running harness with the real components.

**A flight** (bottom-right pill → popover, 500px of travel):

| | value |
|---|---|
| first frame | `761, 680.4, 44×44, r22` — the seed, exactly |
| radius | 22 → 14, max step **1.21px/frame** |
| max position step | 55px/frame |
| max width step | 33px/frame |
| material | thickness 5px → 7px, elevation 0.16 → 0.72 |
| deformation at speed | **1.002 / 1.005**, peak 2.6% (cap 3%) |

**The reverse morph** lands on the pill within **0.1px on every dimension**
(`650.7, 386.5, 151.3×26.3` against the pill's `650.8, 386.4, 151.2×26.3`), unmounts cleanly, and
Escape returns focus to the trigger.

**Frame pacing** under a synthetic main-thread load of 6ms every 16ms (Prompt 2 §85): median
**16.6ms**, p95 22ms, max 22.7ms, **zero frames over 33ms**. Animating real `width`/`height` on a
contained fixed element holds 60fps while the main thread is a third occupied.

**Reduce Motion**: total travel **15.2px** instead of ~130px, a real 94% → 100% geometry transition
rather than an appear, no overshoot, and the launch box still leans toward the seed. Prompt 2 §32
asks for continuity to survive, not for the animation to be switched off.

**Placement**: every window size in the test matrix (720×500 → 2560×1440, plus 1440×320 and 380×900)
× five seed corners × every destination kind, asserted inside its window in
`morph.geometry.test.ts` and drawn to scale in the Lab's placement matrix.

**Interruption**: close at 10/30/70%, reopen mid-close, A→B, resize mid-flight, and a seed that moved
or vanished while the surface was open — all in `morph.controller.test.ts`, which steps the driver
frame by frame because it has no timeline to wait on. The invariant behind them is asserted
directly: **no frame may teleport**, however the flight is interrupted.

## Defects found and fixed during validation

1. **Ghost surfaces.** Changing a surface's `kind` rebuilt its controller, and `dispose()` cannot
   unmount its own element — leaving a frozen surface in the DOM with nothing driving it. Measured
   in the Lab: two ghosts with every seed reporting `aria-expanded="false"`. Fixed by making `kind`
   a getter so the controller outlives every prop change, plus dropping a mounted surface whose
   controller never opened (its `close()` is a no-op, so the unmount callback was never coming).
2. **Dead space in menus.** A menu is exactly as tall as its rows; a fixed 280px popover holding
   160px of content reads as the animation having overshot. Added `fitHeight` — two pure placement
   passes and one layout read at open, because height must be measured at the real width.
3. **Readouts styled as disabled controls.** The loaded-model rows are the reason to open the model
   menu, and `disabled` drew the answer faintest — at the edge of legible in light mode.
   `SeedMenuReadout` states rather than acts: full contrast, no focus, no hover.

## Golden flow 2 — a control becoming the inspector (Phase G)

The second flow is not a bigger popover, and the interesting half is not the flight. Prompt 2 §46
and §47: *during* the transition a sidebar or inspector is a growing structural region, and *after*
it settles it is part of window layout and leaves the overlay. A surface that stays on the overlay
is a floating card that happens to be docked — its splitter does nothing and it sits above the
title bar.

`MorphRegion` does it without duplicating the destination's React tree, which matters because the
inspector holds live sessions, an xterm and a diff view; mounting a second copy for the duration of
a flight would double every effect it runs. Instead:

- the **region** is in the layout at its real width from the first frame, so neighbours reflow once
  and nothing swims (§77);
- an empty **glass shell** flies from the seed to the region's *measured* box — measured, not
  computed, because the real one is wherever the user dragged the splitter to, and measuring gets
  its real corner radius for free so nothing pops at the handoff;
- the region is **clipped to the shell's live geometry** and crossfaded in behind it, so the content
  is revealed by the growing container (§12, §13) rather than fading in beside it;
- at settle the shell unmounts and every driven style is *cleared*, not reset to a resting value.

Measured in the harness, through the real React path — open: shell mounted, region clipped to
`inset(19px 174.51px 238px 66.88px round 8px)` at opacity 0, the 8px being the trigger's own corner;
settled: **0 overlays**, region inline style **empty**; closing: shell back, `inset(0px)` at opacity
1, contracting; closed: region unmounted. `morph.region.test.ts` grades the frames in between —
the exposed rect equals shell ∩ region on every frame, the reveal never runs backwards, no inset is
ever negative, and the region empties *before* it contracts.

Both bars are on it (`App.tsx`), seeded from the intent tracker — so the inspector grows out of the
lane chip, the composer control, the dock or the title-bar toggle without any of them knowing about
it, and materialises in place when the engine raises it with nobody having pressed anything (§45).

## Migration (Phase I) — v1 is gone

Every surface is on v2 and `ui/seed-expand.tsx` has been deleted along with `ui/dropdown.tsx`. There
is one motion system again (§36):

| Surface | Was | Now |
|---|---|---|
| Model, task type, permission level, quality | `Dropdown` | `SeedMenu` |
| Appearance (title bar), branch switcher | `Dropdown` | `SeedMenu` |
| Seven dialogs, incl. the command palette | Radix + FLIP | Radix + morph driver — *revisited in Phase J below; five of the seven are now standard sheets* |
| Mac timeline detail | `SeedPanel` | `SeedPopover` |
| Sidebar, inspector | `SeedRegion` | `MorphRegion` — *seeded from the intent tracker here, from their own edge after Phase J* |

Two defects fell out of doing it, both invisible at 60fps:

1. **Radix's Portal renders `null` on its first commit**, so the commit that opens a dialog is one
   where its nodes do not exist. `resolve()` found nothing to measure and the destination fell back
   to a default — a 560×624 sheet holding 197px of content, flying smoothly to the wrong size. The
   driver now re-measures when its elements arrive; retargeting makes it invisible, because the
   springs are nowhere near the target one frame in. After the fix the same dialog settles at
   420×236 — its declared width, its content's height.
2. **`open()` on an already-open surface re-announced its own arrival.** `onSettled` is what moves
   focus into a menu and what tells a region to leave the overlay, so a spurious one yanks focus back
   to the first row under the user's hands. It now returns early when nothing has moved.

## Native chrome (Phase E)

| §  | Behaviour | How |
|---|---|---|
| §15 | `appearsActive` | Electron `focus`/`blur` → `data-window-active` on `<html>`; decorations ease off, never content |
| §14, §89 | User accent colour | `systemPreferences.getAccentColor()` → `--accent-system`, null when the platform has none |
| §30 | Reduce Transparency | `@media (prefers-reduced-transparency: reduce)` — veils go opaque, lens bands removed |
| §31 | Increase Contrast | `@media (prefers-contrast: more)` — borders, quiet text and focus rings at the token |
| §22 | Toolbar priority tiers | `ui/toolbar.tsx`: measured overflow, not breakpoints |

The two accessibility settings are read straight from Chromium rather than plumbed over IPC, and
both media queries were checked to actually *parse* in this Electron before being relied on — an
unsupported query is not an error, it is a block that silently never applies. Key-window state has
no CSS in Chromium (`:window-inactive` is WebKit's), so that one is plumbed.

The toolbar took three passes and each failure is worth keeping:

1. It was `shrink-0`, so the row was never squeezed and never learned it was short of room — the
   pressure landed on the project name instead.
2. Made shrinkable, it demoted exactly one tier and stopped: the observer only fires when the row's
   box changes, and demoting a tier that holds nothing changes nothing. It now re-measures on its
   own `depth`, which converges and terminates on React's bail-out.
3. Flex distributes a deficit *proportionally*, so the row kept losing its share after there was
   nothing left to demote — slicing 6px off the overflow button itself. Its floor is now its own
   content once everything demotable is demoted.

Honest result: at the app's real minimum window width (`minWidth: 720`) the tiers never need to
fire, even with a deep project path and a 51-character branch name, because the branch chip is
capped at 220px. The mechanism is verified where it does fire (458px, below any reachable window)
and nothing clips at any width. It exists so the next toolbar item is a priority decision rather
than a layout emergency.

## Re-allocation (Phase J) — the signature moved to where the brief puts it

Reported after the first build: *"every button should not be the seed, left and right panels should
come from left and right like a seed."* Both halves were right, and they are one job: the morph was
applied where §42 forbids it and absent where §75 asks for it.

### Dialogs

`ui/dialog.tsx` used to morph **every** dialog in the app, and defended it in its own header as
"the only version of 'every component has the same animation' that stays true". That is a signature
applied as a default, which is the thing §42 rules out. `motion` is now a prop and `standard` is
what it defaults to:

| Dialog | Motion | Why |
|---|---|---|
| Models | `seeded` | §42 names `model button→picker` as the case the morph exists for |
| Command palette | `materialize` | §45 — no seed from ⌘K, and none invented from a click either |
| Settings | `standard` | §67 |
| Trust Center | `standard` | §42 — permissions |
| Machine health, engine request | `standard` | §42 — alerts |
| Workspace sheet | `standard` | §42 — native sheets |

`standard` hands mounting back to Radix's `Presence` and enters on `anim-dialog-in` — the same
spring system (`ui/motion.ts`), compiled to a `linear()` and composited on the GPU. §36 asks for no
duplicate animation systems and this is not one; it is the half of the existing system that applies
when the destination is known at launch.

The palette is the interesting case. It stays on the driver, because only the driver gives it
`destinationFor`'s placement and a **live height target** (the sheet shrinks as the query filters,
rather than leaving a growing block of empty glass under the results) — but it is denied an origin.
Without that, the same surface flew from the toolbar or appeared in place depending on how it was
summoned, which is a motion that reports the input device.

### The bars

Both grow from **their own window edge** (`edgeOf`), not from the control that asked for them.
Prompt 1 §17 says a sidebar should not slide in from off-screen *if a visible control triggered it*,
and reading only that produced a 700px diagonal flight out of whichever of five controls happened to
be used. §75 is the governing line: hiding and unhiding a **persistent** sidebar is a structural
width transition; only *a small button creating a contextual region* is a Seed Morph. These bars are
persistent — splitters, remembered widths, opened dozens of times a session.

Because the seed shares three of the destination's four spans, the flight is a pure width
transition: the outer edge is stationary and only the inner one sweeps. §17 survives in the part
that matters — nothing translates, so this is not a finished panel sliding in; the panel is where it
will be for the whole flight and is *uncovered* by its own edge. `MorphRegion` still takes a `seed`
for a genuinely contextual region; no caller passes one.

`sidebar`/`inspector` therefore map to `structuralPane` (ζ = 1, reveal 0→0.5), which existed and had
no consumer. Honest note on what that bought: the overshoot difference is about **0.2px** at this
size, so it is not the reason. The reveal window is — under the old token the bar spent the first
40% of its transition as a widening pane of *empty* glass and then faded the panel up inside its own
final box, which is two animations where §12 asks for one.

### Menus

Six of the seven menus are **choosers** — model, quality, task lane, permission level, branch,
appearance — and §44 names those as the morph's own cases: the control states the current value and
the surface is that value at full size. The toolbar's overflow menu is a list of **commands**, so it
is `motion="standard"`: it keeps the anchoring, the fold home and the keyboard contract, and declines
only the journey. It is also the worst case for a flight, since it exists only when the window is
too narrow — it fires exactly when the user is short of room and hunting for a control.

### Two defects found on the way

1. **Reduce Motion flew home.** `launchGeometry` pinned the launch box near the destination, but
   `close()` targeted the seed outright — so a panel that appeared in place then crossed the whole
   window on the way out, which is the travel §32 asks to remove. `close()` now uses the same
   function as the launch, so the two cannot disagree.
2. **A surface with no origin shrank into a dot.** With no seed, the collapse targeted a 24×24 box
   at the surface's own centre. For ⌘K that is a 640px sheet imploding to a point. `MorphFrame` now
   publishes `seeded`, and an unseeded collapse fades on `dismiss`'s existing ramp instead. A seeded
   one still does not fade — it ends sitting exactly on its trigger, at that control's size and
   corner, so the unmount is invisible.

Graded in `morph.region.test.ts` (the outer edge stationary on every frame, both mirrors, nothing
moving vertically, content uncovered rather than faded in afterwards), `morph.geometry.test.ts`
(`edgeOf`, and that travel from an edge is reported as growth rather than as distance across the
window — otherwise `gradeSpring` would slow the bar for a journey it never makes) and
`morph.controller.test.ts` (`seeded` published, Reduce Motion symmetric, no origin ⇒ no journey).
The reveal test was checked against the old token and fails on it.

## Not done

- **`liveMorphCount()` has no production consumer** — it exists so the test lane can assert nothing
  is left running.
- **The morph is not exercised by an automated DOM test.** The controller, the geometry and the
  region's paint are graded frame by frame in the node lane; everything about mounting, portals and
  the handoff is verified by driving the real components in `design-preview` and reading the DOM
  back. That is how both defects above were found, and it is a manual step.
- **Phase H's live-app pass.** Every claim here was measured in the browser harness with the real
  components, not in a running Electron window: this session's browser pane could not paint, so
  there are no screenshots and no by-eye check at 0.25×. The geometry, the handoff and the tiers are
  measured; *how it looks* is not yet re-confirmed for the newly migrated surfaces.

  Worth being precise about what the harness can and cannot settle, because it is not "it is slow".
  The pane runs with `document.visibilityState === 'hidden'`, which has two consequences: `rAF` is
  throttled to roughly **one frame per 13 seconds**, so a driven morph cannot animate there at all;
  and the page's layout viewport is **0×0**, so every `vw`/`vh` clamp resolves to zero and a dialog
  that is 420px wide in the app measures 2px. Anything derived from layout is therefore fiction, and
  the honest reads are the ones that are not: which element is mounted, which classes and computed
  animations it carries, which inline properties the driver wrote, and whether a lifecycle completes
  (an `animationend` can be dispatched by hand to prove Radix's `Presence` is wired without waiting
  for a clock that is stopped). That is how the standard dialog's exit was confirmed here.

- **Jitter still has no verified cause.** The first hypothesis — a missing `contain: layout paint` —
  was measured and refuted (0.191ms/resize contained vs 0.184ms uncontained). For the reason above,
  frame pacing cannot be measured in this harness; it needs instrumenting in the real app.
