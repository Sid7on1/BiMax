# Gaps — ranked, each stated as a broken property

> 🔴 **SUPERSEDED IN PART — read `07-evaluation.md` first.**
> A second pass that read the code and ran the design-preview harness found that **G1 and G3 below are
> wrong** and **G4 is overstated**. The first pass measured only the welcome screen, which contains no
> glass surface at all, so it sampled `--app-veil` (α 0.86) and mistook the user's blue wallpaper
> showing through intended vibrancy for a cool colour token. G2, G5, G6 and G7 stand.

Each entry names the **property that should hold**, the **measured observation**, and the
**evidence**. No fix is prescribed here — that is the reset session's job. Ranked by how much the
decision downstream depends on it.

---

## ~~G1 — Our material is an unfinished migration~~ ❌ WRONG (see 07-evaluation.md)
**Corrected:** the vibrancy is deliberate and correct (`backgroundColor:'#00000000'` with a comment naming this exact trap), the glass transmits 37–43 levels, and secondary text clears WCAG AA in all four theme × chrome states. What follows measured `--app-veil`, not `--glass-veil`.

### original text (kept for the record)

**Property.** A surface token renders the same colour regardless of what is behind the window; or, if
translucency is intended, it is visibly and deliberately translucent.
**Observed.** Neither. `main/index.ts:379/385/836` sets `vibrancy`, and it *is* compositing, but the
renderer paints over it: interior pixels shift by **≤4 levels per channel** when the window moves
(mean |Δ| 3.05 at 20pt inset), against a **same-position control of exactly 0**. Too weak to read as
glass; strong enough that our surface colours are not reproducible.
**Cost.** We pay all of vibrancy's price — GPU compositing, legibility risk, a Reduce-Transparency
branch to maintain — for ~5% of the effect.
**Evidence.** `03-bimax-current/NOTES.md` §1. Contrast: Claude and Codex are pixel-identical over the
same wallpaper swing.
**Decision required.** Opaque (A) or committed translucency (B) — see `05-apple/REF-03` §3. Note that
`vibrancy` and native Liquid Glass are **mutually exclusive**; enabling both yields corrupted output.

## G2 — Motion runs ~2× the convention, and 180ms of it is invisible
**Property.** A light interaction settles within ~200ms; no animation continues past the point where
it can be perceived.
**Observed.** The appearance menu takes **433ms** to reach a pixel-identical settled state, with
**non-monotonic convergence** (1.606 → 2.202 → 2.192 → decay) — measured spring overshoot from
`seedPopover: { stiffness: 520, ratio: 0.82 }`. From +400ms only **932 pixels** are still changing:
the last ~180ms is sub-perceptual but still composites every frame — on an 8GB machine that is pure cost.
**Reference.** Claude: **0ms** for the same class of interaction. Codex: 367ms for its one animation.
**Evidence.** `03-bimax-current/NOTES.md` §4; `01-claude-app/NOTES.md` §5.
**Note.** This is not "our motion system is bad" — it is unusually well-reasoned. It is calibrated to
a target neither competitor is aiming at.

## ~~G3 — Warm text on cool surfaces~~ ❌ WRONG (see 07-evaluation.md)
**Corrected:** the tokens are warm-neutral and coherent (`--color-bg #0d0d0d` … `--color-ink #f5f5f4`). The cool cast was the blue-sky wallpaper transmitting through the intended vibrancy.

### original text (kept for the record)

**Property.** A neutral ramp commits to one temperature.
**Observed.** Text is warm (`#f5f5f4`, `#b8b8b5`, `#7c7c79`, R>G>B); surfaces are cool
(`#191f2d`, `#1a1d21`, B>G>R). Claude is warm throughout, Codex cool throughout; we are split.
**Consequence.** Chrome reads subtly "off" with no single element to blame.
**Evidence.** `04-comparison.md` §Colour temperature.

## G4 — We draw hairlines that macOS-native apps don't ⚠️ OVERSTATED
**Corrected:** both edges are token-driven and intentional (`--silver-rim`, and `.titlebar-shell{box-shadow:inset 0 -1px 0 var(--glass-edge)}`). Glass surfaces have rims; the reference apps have none because they have no glass. Only vestigial if we abandon glass.

### original text (kept for the record)

**Property.** Surface separation is achieved the way the platform does it.
**Observed.** Our title bar has a `#474c57` top highlight **and** a `#2d3340` bottom border. Claude has
**no** separator between sidebar and content (value contrast alone) and none under the chrome; Codex's
top bar and body are one uninterrupted `#181818`.
**Evidence.** `04-comparison.md` §Separators.

## G5 — Golden Gate arrives 14 Sept 2026 and we inherit none of it
**Property.** Platform-level design improvements reach the app without work.
**Observed.** macOS 27 gives apps a user opacity slider, uniform window corner radii, edge-to-edge
sidebars, unified toolbars and richer icons **automatically, with no recompile** — but only for apps on
system materials. We paint our own surfaces, so we inherit nothing and must hand-maintain equivalents.
(Claude and Codex are in the same position; this is a chance to differentiate, not a defect we alone have.)
**Evidence.** `05-apple/REF-01`.

## G6 — Reduced-motion is wired but never proven to fire
**Property.** An accessibility path is verified end-to-end, not just present in source.
**Observed.** The wiring is real — `use-morph.ts:89` and `MorphSurface.tsx:181` inject
`reducedMotion: prefersReducedMotion` into the live controller, and `styles.css` has genuine
`prefers-reduced-motion` (×2), `prefers-reduced-transparency` and `prefers-contrast: more` blocks.
**But it was never exercised**: `com.apple.universalaccess` is SIP-protected, so the toggle test could
not run from the CLI.
**Why this matters here.** This codebase's recorded failure mode is precisely *correct code on an
unreachable path* — a model picker that saved and reloaded config while every request used the boot
model; an AX hit-test dead on every path but two. Presence in source is not evidence.
**Action.** Toggle Reduce Motion and Reduce Transparency in System Settings and re-measure. Cheap, and
it converts an assumption into a fact.

## G7 — Our own workspace is unmeasured
**Property.** The surfaces users spend their time in are the ones we baseline.
**Observed.** Only the **welcome/no-project** state was captured. `Composer`, `Transcript`, `Sidebar`,
`DiffView`, `CommandPalette` — the actual product — have no baseline. Both competitors were studied in
their working state; we were studied on our splash screen.
**Action.** Capture via `app/design-preview` (real components, stubbed IPC) rather than booting the engine.

---

## Not gaps — things we already do better than expected
- **Four** accessibility media queries in `styles.css` (`prefers-reduced-motion` ×2,
  `prefers-reduced-transparency`, `prefers-contrast: more`). I have no evidence either competitor
  handles Reduce Transparency, because neither has anything transparent to reduce.
- A physically-grounded spring system with damping ratios, size grading and distance softening, and a
  dedicated `reducedMotion` token (ζ=1.0, ~120ms) that keeps continuity instead of cutting motion dead —
  which is exactly what the HIG asks for.
- A warm text ramp essentially identical in intent to Claude's.

## Still unmeasured across all three
Type ramps · hover/press/focus states · light mode · Codex windowed chrome · our window corner radius.
