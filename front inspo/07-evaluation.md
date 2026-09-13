# Bimax front end — evaluation against the reference docs

> ✅ **EVERYTHING IN THIS DOCUMENT IS DONE — see `08-changes-applied.md`.**
> Round 1 closed R1–R4, B1 and B5-as-audit. Round 2 (same day, evening) took the four items left as
> "your call": B1 past the plateau, B2 veil, B4 sidebar, B5 pipeline. Two defects surfaced that this
> evaluation did not predict — the spring solver was losing 39% of `snappy`'s overshoot to its
> integration step, and sidebar icons sat under the 3:1 non-text floor in the light theme.
> Also corrected in that document: **B3 was wrong** (the transcript is already capped by
> `.reading-column`), and R3 turned up two real defects the evaluation had not predicted.

Evaluated 2026-09-12 against `05-apple/REF-01…03`, `04-comparison.md`, and the two skills.
This pass read the **code and the design-preview harness**, not just the welcome screen — which is
why it **corrects two findings** from the first round.

---

## Verdict first

The Bimax front end is **better engineered than the first pass concluded**, and better than either
reference app on the axes Apple actually gates: contrast, accessibility fallbacks, and theming.
The problems that remain are **not** "our design is wrong" — they are:

1. the tool that verifies front-end work **doesn't run**,
2. the glass is calibrated against a material **macOS 27 changes in two days**, and
3. motion durations are tuned to a target neither the platform nor the competition uses.

---

## ⚠️ Corrections to the first round

Two gaps in `06-gaps.md` were **wrong**, and both would have sent the redesign the wrong way.

### G1 "our material is an unfinished migration" — **WRONG as stated**

The first pass measured only the **welcome screen**, which contains **no glass surface at all**
(`.liquid-glass` appears only in `dialog.tsx`, `MorphRegion.tsx`, `MorphSurface.tsx`). What I measured
was `--app-veil` (α **0.86**), not `--glass-veil` (α **0.62**) — a different token doing a different job.

The vibrancy is **deliberate and correct**. `main/index.ts` sets `backgroundColor: '#00000000'` with a
comment that names this exact trap: *"macOS paints the vibrancy material behind the web contents, so
any opaque window background hides it completely."* They already hit and fixed it.

Measured in the harness, over a synthetic gradient (harsher than a real desktop):

| panel | fill | transmission (spread down panel) | secondary-text contrast |
|---|---|---|---|
| moonlight **glass** | `#4a313a` | **43 levels** | **5.86:1** ✅ AA |
| moonlight solid | `#101011` | 1 level | 9.56:1 ✅ |
| starlight **glass** | `#e2ccd1` | **37 levels** | **4.92:1** ✅ AA |
| starlight solid | `#f3f3f1` | 2 levels | 6.73:1 ✅ |

The glass genuinely transmits, and **even `--color-dim` clears WCAG AA in all four states**. The α 0.62
choice is documented with its own measured contrast table and a stated rationale for the knee. This is
the most rigorous part of the codebase.

### G3 "warm text on cool surfaces" — **WRONG**

The tokens are **warm-neutral and coherent**: `--color-bg #0d0d0d`, `--color-raise #171717`,
`--color-ink #f5f5f4`, `--color-dim #b8b8b5`, `--color-faint #7c7c78`. Nothing is blue.

The cool cast I measured (`#191f2d`) was **the user's blue-sky wallpaper transmitting through the
intended vibrancy**. That is the design working, not a token inconsistency. **No action.**

### G4 "we draw hairlines the reference apps don't" — **softened**

The edges are token-driven and intentional: `--silver-rim` (styles.css:246) and
`.titlebar-shell { box-shadow: inset 0 -1px 0 var(--glass-edge) }` (1221). Glass surfaces *have* rims —
Apple's do too. Claude and Codex have no edges because they have no glass. Only becomes vestigial
**if** we abandon glass.

---

## REQUIRED — something is broken, or will break

### R1. The design-preview harness does not run 🔴
`app/design-preview` — the documented way to verify shell UI without booting Electron — **fails to
load**. Four dead imports, all Computer-Use leftovers deleted in **d97018f** ("separate Computer Use,
the terminal TUI and the website out of the build"):

| missing module | imported by |
|---|---|
| `components/LiveTarget` | `inspector.tsx` |
| `components/PermissionsPane` | `permissions.tsx` |
| `components/PermissionCoachOverlay` | `permissions.tsx` |
| `mac.session.model` | `inspector.tsx` |

Two of the six preview panes (`inspector`, `permissions`) preview components that **no longer exist in
the product**. The other four (`chat`, `models`, `motion`, `lab`) are clean and work — verified by
stubbing the dead ones, which made the whole harness render correctly.

**Fix:** delete `inspector.tsx` and `permissions.tsx` and drop them from `main.tsx`'s `Page` union.

**This is the third instance of the same pattern.** The archive separation also killed
`packaging.sidecar.test.ts` (ENOENT, per memory, "third recurrence, still not run by any gate").
**No gate runs the harness**, so it broke silently and stayed broken.
**Add one**: a CI step that boots the vite config and fails on a module-resolution error is ~5 lines.

### R2. The glass is calibrated against a material macOS 27 replaces 🔴
`--glass-veil: 0.62` was chosen from a measured contrast table against **macOS 26 Tahoe's** vibrancy.
macOS 27 Golden Gate (**14 Sept 2026 — two days away**) changes that material *and* hands users an
**opacity slider from "ultra-clear" to "fully tinted"**, which apps inherit automatically.

Our thinnest margin is **starlight glass at 4.92:1 against a 4.5 floor — 9% headroom**. If the user's
slider (or 27's material) makes the backdrop clearer or brighter, that margin is gone and secondary
text drops below AA.

**Action:** re-run the contrast table on macOS 27 across the slider's range before shipping to 27
users. Their own table already exists in `styles.css:63–70` — re-measure it, don't re-derive it.

### R3. The accessibility paths have never been exercised 🟠
The code is genuinely good — Reduce Motion tones down rather than strips (transform entrances become a
120ms fade, springs neutered **at the token** so later CSS is covered, `* { transition-duration: 60ms }`);
Reduce Transparency swaps veils to solid, kills the lens, **keeps** edges and elevation for hierarchy,
and removes two `backdrop-filter` passes; Increase Contrast fixes borders at the token and boosts
`--color-dim`/`--color-faint`, focus outline to 3px.

**But none of it has ever been observed running.** `com.apple.universalaccess` is SIP-protected, so it
could not be toggled from the CLI. Given this codebase's signature failure — correct code on an
unreachable path — presence in source is not evidence.
**Action:** toggle both in System Settings, re-capture the four harness states, confirm the veils
actually go solid and the springs actually flatten.

### R4. The chat preview renders empty 🟡
`ChatPreview` shows an empty box plus a "Send next message" button — so `Composer` and `Transcript`,
the two surfaces users spend all their time in, **cannot be looked at** without clicking through.
Seed it with a few messages by default. (Part of R1's cleanup.)

---

## BENEFICIAL — real payoff, but a judgment call

### B1. Bring motion durations toward the platform convention ⭐ highest value
Declared in `styles.css:342–355`:

| token | duration | overshoot | vs ≤200ms convention |
|---|---|---|---|
| `--dur-exit` | 210ms | — | ~at budget ✅ |
| `--dur-snappy` | **354ms** | 1.2% | 1.8× |
| `--dur-glass` | **533ms** | 3.8% | 2.7× |
| `--dur-bouncy` | **629ms** | 11.8% | 3.1× |

Measured live, the appearance menu takes **433ms** to a pixel-identical settle, and convergence is
non-monotonic (visible overshoot). Claude: **0ms**. Codex: 367ms for its one animation.

In fairness: these are *settle* times including a sub-perceptual tail, and `--ease-bouncy`'s 11.8% is
applied to small controls, which their own `morph/tokens.ts` explicitly argues is correct
("`bouncy` keeps the character at ~12% on a control"). The system is well-reasoned.

The issue is the **target**, not the craft. From +400ms only **932 pixels** are still changing — that
last ~180ms is invisible and still composites every frame, on an 8GB heavy-swap machine.
**Suggestion:** cut the settle tail (raise the settle epsilon) and pull `--dur-glass`/`--dur-bouncy`
toward 250–350ms. Keep the springs; keep the character; stop paying for frames nobody sees.

### B2. Decide what `--app-veil` is for
On surfaces with **no glass** (the whole welcome screen), α 0.86 buys a faint, wallpaper-dependent
tint — measured ≤4 levels/channel, invisible as an effect but enough to make surface colours
non-reproducible and to shift the app's apparent hue with the user's desktop picture.
**Either** commit (make it visibly translucent like the glass panels) **or** set it to `--color-bg` and
let glass be the only translucent thing. Right now it is neither.

### ~~B3. Cap the transcript measure~~ ❌ WRONG — already capped
**Corrected:** `.reading-column { max-width: clamp(640px, 88vw, 1180px) }` is applied to all 10 row
types in `Transcript.tsx`, plus `.composer-column`. I grepped for Tailwind `max-w-*` utilities and
missed the CSS class. The only live question is whether the 1180px ceiling is too wide (Claude ~690pt,
Codex 881pt) — a tuning call, not a defect.

### original text (kept for the record)

`Transcript.tsx` has **no max-width**; the only `max-w-*` in the composer is a 190px chip. Codex caps
its column at **881pt and centres it**; Claude uses a fixed 48pt gutter against a 414pt sidebar. On a
wide display our lines will run the full pane, which is the single most common readability regression
in a chat UI. Cheap to fix, disproportionate payoff.

### B4. Free wins from macOS 27 we can take
No window-level `border-radius` is hardcoded (only `.browser-frame` 14px and form controls) — good, we
won't fight 27's uniform radius. Worth adopting deliberately:
- **Edge-to-edge sidebars** and **unified toolbars** are 27's direction; our sidebar is already a
  floating glass panel, which is the *Tahoe* idiom 27 moves away from.
- **Colour returns to sidebar icons** in 27 — ours are monochrome.

### B5. Icon audit
macOS 26+ wants a layered Icon Composer icon (background + ≤4 layers) with **no baked-in** speculars,
bevels or shadows; 27 adds more glass layers. `Icon Composer` is installed on this machine. Unverified
whether our `.icns` is layered or a flat legacy export — worth 10 minutes.

---

## NOT recommended

- **Don't adopt native Liquid Glass** (`electron-liquid-glass` / `NSGlassEffectView`). It is a
  **private API** with App Store risk and per-release breakage, and it **requires `vibrancy: false`** —
  which would tear out the sidebar material that currently works and passes AA in both themes. Our CSS
  glass already achieves the effect with a documented contrast budget. The delta does not justify it.
- **Don't strip motion to match Claude's 0ms.** Motion isn't the defect; duration is. And our
  Reduce Motion handling is better than anything I could observe in either competitor.
- **Don't "fix" the colour temperature.** Corrected above — the tokens are already coherent.
- **Don't go fully opaque to match the reference apps.** Their opacity is a *choice*, not a standard,
  and ours is the only one of the three that would inherit macOS 27's improvements. Committing harder
  to glass is at least as defensible as abandoning it.

---

## Still open
- `Composer` / `Transcript` / `DiffView` / `CommandPalette` visually unmeasured (blocked by R1+R4).
- Type ramp not measured for any of the three apps.
- Hover / press / focus states not sampled.
- Whether macOS 27 exposes the user's glass-slider position to apps (❓ unconfirmed).
