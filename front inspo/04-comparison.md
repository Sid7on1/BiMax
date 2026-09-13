# Claude · Codex · Bimax — side by side

All values measured on macOS 26.5.2, dark mode, Reduce Motion **off**. See `00-METHOD.md`.

## Material — the headline

| | Claude | Codex | **Bimax** |
|---|---|---|---|
| Translucent? | **No** — pixel-identical over a sky→buildings wallpaper swing | **No** — pixel-identical, verified windowed over wallpaper | **Yes, ~5%** |
| Evidence | `#111111` / `#151515` unchanged at every sample height | `#181818` unchanged at every sample point | interior shifts ≤4 levels/channel when the window moves; same-position control Δ=**0** |

**Two of three reference-class agent apps ship zero translucency.** We are the only one carrying the
cost of vibrancy, and we get an effect too weak to perceive.

## Colour temperature — both commit, we don't

| | Claude | Codex | **Bimax** |
|---|---|---|---|
| Surfaces | **warm** `#111111` `#151515` `#20201f` | **cool** `#25292e` sidebar, `#161616` body | **cool** `#191f2d` `#1a1d21` |
| Text | **warm** `#f0efec` / `#898782` | **neutral** `#ffffff` / `#a3a3a3` | **warm** `#f5f5f4` / `#b8b8b5` / `#7c7c79` |
| Coherent? | ✅ warm throughout | ✅ cool throughout | ❌ **warm text on cool surfaces** |

## Sidebar strategy — opposite, and both work

| | Claude | Codex |
|---|---|---|
| Fill vs body | **darker** (`#111111` < `#151515`) | **lighter** (`#25292e` > `#161616`) |
| Temperature | warm | cool |
| Width | 414pt (drag-resizable, ⌘B) | 320pt |

There is no law here. The law is **commit to one**.

## Separators — nobody draws hairlines but us

| | Claude | Codex | **Bimax** |
|---|---|---|---|
| Sidebar ↔ content | none — value contrast only | none | — |
| Titlebar ↔ body | none | none — one uninterrupted `#181818` | **top highlight `#474c57` + bottom border `#2d3340`** |

## Composer — opposite decisions

| | Claude | Codex |
|---|---|---|
| Size | 687 × 60pt | 881 × 116pt |
| Fill | `#20201f` | `#2a2a2a` |
| Model/effort toolbar | **outside, below**, on the page background, no container | **inside** the composer box |
| Context chips | above the composer | inside, as a permission state (`⚠ Full access`) |

## Content measure

| | Claude | Codex |
|---|---|---|
| Strategy | fill the pane, fixed **48pt** gutters | **cap at 881pt and centre** (~295pt gutters at 1470pt) |

## Motion — the finding that should drive the redesign

| transition | Claude | Codex | **Bimax** |
|---|---|---|---|
| popover / menu open | **0ms** (1 frame) | — | **433ms**, with measured overshoot |
| sidebar collapse | **0ms** (1 frame) | close **367ms** ease-out / open **0ms** | not measured |
| modal open | **0ms** (1 frame) | — | not measured |
| only periodic motion | caret blink 500ms | — | — |

Claude's perceived quality comes from **typography, spacing, a committed warm ramp and restraint** —
it animates nothing. Codex animates exactly one direction of one control.

**We animate a small menu for 433ms with spring overshoot**, against a ≤200ms convention for a light
interaction. Our morph system is more sophisticated than anything either competitor ships — and its
measured output is the least conventional of the three.

## System metrics confirmed by cross-checking

| | Claude | Bimax | conclusion |
|---|---|---|---|
| traffic light pitch | **23.00pt** | **23.00pt** | a **macOS 26 system metric** (classic macOS was 20pt), not an app choice |
| traffic light diameter | 12pt | 12pt | system |
| traffic light centre y | 34.2pt | 26.5pt | **an app choice** (`trafficLightPosition`) |
| window corner radius | ~11–12pt, squircle tail | not measured | consistent with Tahoe's *compact* radius for a **titlebar-only** window; Tahoe gives toolbar windows a larger radius, and macOS 27 makes them uniform |
