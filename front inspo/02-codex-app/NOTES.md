# Codex (ChatGPT.app) — front-end teardown

**Build** 26.903.71938 · `com.openai.codex` · Chromium 152.0.7977.83 ("Codex Framework") · Sparkle updater
**Observed on** macOS 26.5.2, logical desktop 1470×956 @2×
**Method** identical to the Claude teardown: 2× stills + 60fps recordings analysed per-frame in numpy.

> **Window state caveat.** Codex was in **native macOS fullscreen** (`AXFullScreen=true`, 1470×923 at
> y=33, menu bar shown) plus a separate 1470×33 `AXUnknown` overlay window at (0,0) — almost certainly
> the busy bar (`Resources/busy-bar.asar`). Its missing traffic lights are macOS hiding them in
> fullscreen, **not** a design decision. For the material test I temporarily un-fullscreened and floated
> it over wallpaper, then **restored it to fullscreen exactly as found**.

---

## 1. Material — same answer as Claude

**Codex is 100% opaque.** Floated at 900×620 over a wallpaper running from bright sky to dark
architecture, the fill never moves:

| sample y | x=20pt | x=450pt | x=870pt |
|---|---|---|---|
| 40pt | `#181818` | `#181818` | `#181818` |
| 120pt | `#181818` | `#181818` | `#181818` |
| 320pt | `#181818` | `#181818` | `#181818` |
| 420pt | `#181818` | `#181818` | `#181818` |
| 600pt | `#181818` | (composer) | `#181818` |

**Two out of two reference apps use no vibrancy, no translucency, no Liquid Glass.**

## 2. Surface ramp — cool-tinted, and inverted vs Claude

| role | value | note |
|---|---|---|
| page / body | `#181818`, content area `#161616`–`#171717` | neutral |
| **sidebar** | **`#25292e`** | **cool** (B>G>R) and **lighter** than the body |
| sidebar edge | `#34383d` | |
| code block | `#242424` | |
| composer fill | `#2a2a2a` | |
| scrollbar | `#3c3c3c`, 8pt wide | |

**Text**: body **`#ffffff` pure white** · meta/secondary `#a3a3a3` · placeholder `#5f5f5f`.

> This is the sharpest contrast with Claude. Claude's sidebar is **darker and warm** (`#111111` under a
> `#151515` body, text `#f0efec`). Codex's sidebar is **lighter and cool** (`#25292e` over `#161616`,
> text `#ffffff`). Two coherent systems that resolve the same problem in opposite directions — so
> "sidebar darker" is not a law, but *committing to one* is.

## 3. Chrome & layout

- **No hairline anywhere.** Top bar and body are the same `#181818`, with no separator between them
  (scanned y=0..70pt: one uninterrupted fill).
- Top bar controls, all centred on **y=27.4pt**:

  | control | centre x |
  |---|---|
  | sidebar toggle | 26.2pt |
  | new / compose | 66.8pt |
  | folder / project | 120.2pt |
  | title text | from ~146pt |

  Right side: `Share`, list icon, panel icon.
- **Sidebar 320pt** wide.
- **Content column ≈ 881pt, centred**, with symmetric ~295pt gutters in a 1470pt window — i.e. Codex
  caps its measure and centres it. Claude instead lets content fill the pane with a fixed 48pt gutter.
- **Composer 881 × 116pt**, fill `#2a2a2a`, and the toolbar (`+ · Full access · ⟳ · GPT-6 Astra Light ⌄ · mic · ●`)
  is **inside** the composer box. Claude puts the equivalent row **outside and below**. Opposite calls.

## 4. Motion — measured, and asymmetric

60fps, per-frame difference energy, noise floor 0.

| transition | result |
|---|---|
| sidebar **open** | **single frame** — instant, no animation |
| sidebar **close** | **~367ms, animated** — 22 frames, energy decaying monotonically (167→204→200→195→188→171→154→130→89→50→21→~0) = a **decelerating / ease-out** curve |

The close is a genuine **cross-fade of the sidebar plus a reflow of the content column** (see the
frame montage: sidebar text fades while the centred column re-centres), not a width slide.

> **Codex animates one direction of one control and nothing else I could trigger.** Combined with
> Claude animating nothing at all, neither app relies on motion for perceived quality.

## 5. Component anatomy

- **Sidebar** — `Codex ⌄` product menu at top; primary actions (`New chat`, `Pull requests`,
  `Scheduled`, `Plugins`, `Explore`); a **Projects** group; a conversation list with the active row
  highlighted; a **Recents** group with a `Show more` affordance; account row pinned at the bottom.
- **Top bar** — icon cluster left, project/folder + title + `…` overflow, actions right.
- **Turn** — a collapsible `Worked for 16m 46s ›` run summary above the answer; markdown body;
  **code block card** with a language header (`</> Bash`) and copy/expand icons in the header;
  inline citation chips as blue links; a per-message action row (copy / retry / branch) plus timestamp.
- **Composer** — one large rounded rect containing the placeholder *and* the full toolbar, with a
  permission state (`⚠ Full access`) surfaced in orange right in the composer, a model selector,
  and a filled circular primary send button.

## 6. Open items
- Light mode not captured.
- Type ramp not measured.
- Hover/press/focus states not sampled.
- Windowed (non-fullscreen) chrome — traffic-light inset and corner radius — not measured, so the
  23pt traffic-light pitch seen in Claude is still unconfirmed as a system metric.

## Evidence
`codex-01-main.png` · `codex-02-sidebar-open.png` · `codex-03-sidebar-close-frames.png`
(annotated −33…+367ms) · `codex-04-windowed-over-wallpaper.png` (the material test)
