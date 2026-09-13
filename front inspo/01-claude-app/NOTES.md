# Claude Desktop — front-end teardown

**Build** 1.40609.1 · Electron · `com.anthropic.claudefordesktop` · bundle 823 MB
**Observed on** macOS 26.5.2 (25F84), built-in Liquid Retina, logical desktop 1470×956 @2×
**Window under test** 1200×800pt at (82,45)
**Method** `screencapture` stills at 2× + 60fps `ffmpeg avfoundation` screen recordings, analysed per-frame in numpy. Every number below is sampled from pixels; anything I could not measure is marked *observed*.

> **Baseline is clean.** `reduceMotion=0`, `reduceTransparency` unset, `increaseContrast` unset,
> `NSAutomaticWindowAnimationsEnabled` unset (on), `AppleInterfaceStyle=Dark`.
> This matters: the motion findings below are a design choice, not an accessibility override.

---

## 1. Material — the headline finding

**Claude Desktop is 100% opaque. No vibrancy, no translucency, no Liquid Glass.**

Verified rather than assumed: the window sits over a wallpaper that runs from bright blue sky at the
top to dark architecture at the bottom. Sampling the same nominal surface down the window:

| sample y | sidebar x=20pt | content x=1150pt |
|---|---|---|
| 20pt | `#111111` | `#151515` |
| 150pt | `#111111` | `#151515` |
| 350pt | `#111111` | `#151515` |
| 550pt | `#111111` | `#151515` |
| 750pt | `#111111` | `#151515` |

Pixel-identical throughout. A vibrant surface would have shifted with the backdrop.

## 2. Surface ramp — warm-tinted neutrals

Not grey. R > G > B on nearly every step; the composer fill is the clearest tell (`#20201f`).

| role | value |
|---|---|
| sidebar background | `#111111` |
| content background | `#151515` |
| settings modal — nav | `#141414` |
| settings modal — body | `#171717` |
| card | `#212121` |
| stat tile | `#373737` |
| chip | `#2d2d2d` |
| composer fill | `#20201f` |
| segmented track / active segment | `#1d1d1d` / `#343434` |
| modal scrim | app `#111111` → `#070707` ⇒ **black @ ~59%** |

**Text**: primary `#f0efec` (warm off-white — deliberately *not* `#fff`) · secondary & placeholder
`#898782` · group label `#c3c2b8` · icon stroke `#6a6a65` · toggle accent ≈ `#2c6ccb`.

## 3. Window & chrome

- Corner radius ≈ **11–12pt**, and the corner profile has the long tail of a **squircle**, not a circular arc.
- `titleBarStyle` hidden/inset — **content runs to the very top**, there is no titlebar band.
- Traffic lights: **12pt diameter, 23pt centre pitch**, centre line y=34pt from window top, red centre x=33pt.
  ⚠️ 23pt pitch is not the classic 20pt. Cross-check against Codex and Bimax before attributing this to macOS 26.
- Chrome row (all centred on y=34.2pt, measured by connected-component analysis):

  | control | centre x | size |
  |---|---|---|
  | sidebar toggle | 138.0pt | 17 × 17.5pt |
  | back | 172.5pt | 14 × 12.5pt |
  | forward | 207.2pt | 14 × 12.5pt |
  | segmented control (Chat ⇄ Code) | 352.0pt | **100 × 39.5pt** |

## 4. Layout

- Sidebar **414pt** wide (34.5% of a 1200pt window), drag-resizable, toggle **⌘B**.
- **No hairline between sidebar and content.** Separation is pure value contrast (`#111111` vs `#151515`).
  There is a 1px edge in the chrome band only.
- Content horizontal gutter ≈ **48pt** each side.
- Composer **687 × 60pt**. Stat tiles 61.5pt tall with a 6.5pt row gap.

## 5. Motion — measured, and the most decision-relevant result

Recorded at 60fps and analysed by per-frame difference energy. Noise floor was 0, so a real fade
would have shown as a ramp across frames. Nothing did.

| transition | result |
|---|---|
| sidebar collapse | **not animated** — 414pt → 0 in **one frame (16.7ms)**, ~167ms after the click |
| sidebar expand | **not animated** — single frame |
| model picker popover open | **single frame**, no fade / scale / slide |
| settings modal open | **single frame** (809k diff), then ~83ms of low-energy residue = async content paint, not a transition |
| text caret | blinks on a **500ms** period — the only periodic animation in the app |

The 183ms "burst" around the sidebar toggle turned out to be the **tooltip** ("Hide sidebar ⌘B /
Drag to resize") dismissing, with the layout snap as the final frame — not an easing curve.

> **Claude Desktop earns its quality with typography, spacing, a warm neutral ramp and restraint.
> It does not animate state transitions at all.** This directly challenges the premise that a
> bespoke spring/morph system is what makes an agent app feel premium.

## 6. Component anatomy

- **Sidebar** — full-width filled "New" row; nav rows with 16pt line icons; `Beta` badge pill;
  collapsible "More"; workspace row with inline `+ / search / filter` icons; grouped lists under
  quiet uppercase-ish group labels with hairline circle bullets; account row pinned at the bottom
  (avatar, name · plan, chevron).
- **Segmented control** — 2 icon segments, active segment filled `#343434` on `#1d1d1d` track.
- **Stat card** — text tabs (active = pill) at left, range segmented (All / 30d / 7d) right-aligned,
  4×2 stat tile grid (small muted label over larger value), contribution heatmap, playful caption.
- **Composer** — one rounded rect with the return-key affordance *inside* on the right. Context chips
  (`Local`, `No folder`) sit **above** it; the model/effort toolbar (`Auto + mic ⌄ | Opus 5 High ○`)
  sits **below and outside** it, directly on the page background with no container.
- **Model popover** — rows with right-aligned **numeric shortcut hints (1–4)**, a `Default` pill,
  checkmark on the active row, a `More models ›` submenu row, then a section label and a toggle row.
- **Settings modal** — near-full-bleed sheet with **its own** left nav + search field and a close ✕;
  setting rows are title + description + right-aligned switch; dropdowns and live code-preview panes.

## 7. Open items
- Light-mode palette not yet captured.
- Type ramp (sizes/weights) not yet measured.
- Hover/press/focus states not yet sampled.
- Traffic-light 23pt pitch: system metric or app-specific? Cross-check pending.

## Evidence
`claude-01-home.png` · `claude-02-model-popover.png` · `claude-03-settings-modal.png` ·
`claude-04-sidebar-collapse-frames.png` (annotated frames at −50…+183ms)
