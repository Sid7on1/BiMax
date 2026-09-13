# Liquid Glass — the normative rules

**Retrieved 2026-09-12.** Reconstructed from Apple's HIG as reported by secondary sources (see
`SOURCES.md`); `developer.apple.com` could not be read directly. Treat as high-confidence but
**verify against the HIG before it becomes a hard gate**.

## What it is
A digital meta-material introduced across iOS/iPadOS/macOS/tvOS/watchOS/visionOS 26 that "dynamically
bends and shapes light", behaving like a lightweight liquid rather than imitating physical glass.
Organised in the HIG around **Hierarchy, Harmony, Consistency**.

## Where glass belongs

✅ **Use it on** static, top-level, floating chrome — toolbars, tab bars, modals, floating panels.

❌ **Do not use it on**
- **Content areas.** Never make the content surface glass.
- **Nested views.** Glass on a parent *and* a child is visual redundancy.
- **High-frequency scrolling regions and lists.**
- **Everything.** One primary glass sheet per view.

### The nesting law
> **Never stack glass on glass.** Nest controls on **solid fills** inside the glass sheet, not on more glass.

## Tinting
- Use **sparingly**, and only for **primary actions that need emphasis**.
- Do **not** tint every glass control just because the brand colour is blue/green/purple.
- "If everything is emphasized, nothing is emphasized."

## Legibility
- In **steady states** (e.g. first launch) **avoid intersections between content and glass** —
  reposition or scale content to keep separation rather than relying on the material to cope.
- The **Clear** variant is permanently more transparent than the adaptive **Regular** variant and
  **requires a dimming layer**; without one "legibility gets noticeably worse."

## Accessibility behaviour — non-negotiable
| Setting | Required behaviour |
|---|---|
| **Reduce Transparency** | Glass becomes **frostier** and obscures more of what is behind it |
| **Increase Contrast** | Foreground pushed toward pure white/black, plus a **subtle border around tap targets**, so text and icons stay readable over any backdrop |
| **Reduce Motion** | Minimise or eliminate animation. Explicitly disable or change **multi-axis motion, multi-speed motion, spinning, and vortex effects** |

Apple also runs **Reduced Motion evaluation criteria** through App Store Connect's accessibility
declarations — it is a reviewable property, not a nicety.

## Motion guidance
- Add motion **purposefully**; do not add motion for its own sake. "Gratuitous or excessive animation
  can distract people or make them feel disconnected."
- Commonly cited durations (HCI convention, reported alongside the HIG rather than an Apple-published table ❓):
  - **< 200ms** for light in-page interactions (a toggle)
  - **300–500ms** for full-view transitions with many elements
  - **100–500ms** overall as the usable band

> Measured against this band: Claude **0ms** (no animation at all), Codex **367ms** (one transition),
> **Bimax 433ms for a popover** — at the top of the "full page transition" band for what is a small
> menu, and roughly 2× the ≤200ms guidance for a light interaction.

## App icons (Icon Composer, macOS 26+)
- Icons are **rounded rectangles (squircles)**: one **required background layer** plus **up to four**
  layers above it.
- Each layer carries material properties: **specularity, transparency/frosting, drop shadow, blur**.
- **The system applies those effects.** Do **not** bake specular highlights, inter-layer drop shadows,
  bevels, blurs or glows into source artwork.
- Export layers as **SVG** where possible; PNG/raster only for unsupported SVG features.
- macOS 27 adds **more glass layers** to icons for detail and sharpness.

## What Golden Gate (27) changes about all this
See `REF-01`. Short version: a **user-controlled opacity slider**, **uniform window corner radii**,
**edge-to-edge sidebars**, **colour back in sidebar icons**, **unified toolbars** — and apps get it
**automatically, with no code change**, provided they use system materials rather than painting their own.
