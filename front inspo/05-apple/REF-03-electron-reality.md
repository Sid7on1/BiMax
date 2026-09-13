# What an Electron app can actually do on macOS 26/27

**Retrieved 2026-09-12.** This is the layer that decides what we can ship. Our stack: **Electron 43.3.0**
(Chromium ~140), React 18, Tailwind v4.

## 1. Native Liquid Glass: possible, via a private API, with a hard conflict

`NSGlassEffectView` is the real thing. It is reachable from Electron through
[`electron-liquid-glass`](https://github.com/Meridius-Labs/electron-liquid-glass).

```js
const id = liquidGlass.addView(win.getNativeWindowHandle(), {
  cornerRadius: 12,        // px, default 0
  tintColor: '#RRGGBBAA',  // optional
  opaque: false,           // default
})
```

**Requirements**: macOS 26+ · Electron 30+ · Node 22+ (we satisfy all three).
Non-macOS platforms get safe no-ops. Falls back to `NSVisualEffectView` below macOS 26.

### The constraints that actually matter

| Constraint | Consequence for us |
|---|---|
| 🚨 **`vibrancy` must be OFF** | `NSVisualEffectView` and `NSGlassEffectView` compete for the same compositor layer and produce **corrupted, blurry** output. **`main/index.ts:379/385/836` currently sets `vibrancy`.** These two paths are mutually exclusive — pick one. |
| **`transparent: true` required** | Changes window behaviour; also needs `setWindowButtonVisibility(true)` to keep traffic lights. |
| **Apply after `did-finish-load`** | Glass must be attached once content has loaded. |
| **Private API** | Undocumented, may break on any macOS update, and **may affect App Store review**. |
| **Glass sits *behind* web content** | So the renderer must actually be transparent where you want glass to show. Our renderer paints opaque surfaces — that is precisely why our current vibrancy is invisible. |
| `unstable_*` variants | `setVariant` (0–15, 19), `setScrim`, `setSubdued` — author says **do not use in production**. |

## 2. Reading the user's accessibility and theme state

**Main process — `nativeTheme`:**

| property | platform | use |
|---|---|---|
| `shouldUseDarkColors` | all | dark mode |
| `prefersReducedTransparency` | **all** | ← the one that gates glass |
| `shouldUseHighContrastColors` | macOS, Windows | increase contrast |
| `shouldUseInvertedColorScheme` | macOS, Windows | |
| `shouldDifferentiateWithoutColor` | **macOS** | don't encode meaning in colour alone |
| `themeSource` | all | `'system' \| 'light' \| 'dark'` override |

Listen to `nativeTheme.on('updated', …)` — but note the docs describe `updated` as firing for dark
colours / high contrast / inverted scheme; ❓ do not assume it fires for
`prefersReducedTransparency` without testing.

**Renderer — CSS media queries** (all supported in Chromium 140 / Electron 43):

```css
@media (prefers-reduced-motion: reduce)        { /* … */ }
@media (prefers-reduced-transparency: reduce)  { /* Chrome 118+ */ }
@media (prefers-contrast: more)                { /* … */ }
@media (prefers-color-scheme: dark)            { /* … */ }
```

✅ **We already have all four** in `app/src/renderer/src/styles.css`
(lines 1057, 1138, 1164, 1245, 1249) — ahead of where I expected us to be.

## 3. The three honest options for our material

| | what it is | cost | what we get |
|---|---|---|---|
| **A. Fully opaque** | drop `vibrancy`, paint deterministic surfaces | none — *removes* code | Exactly what Claude and Codex ship. Reproducible tokens, no legibility risk, no accessibility branch needed for transparency. **Loses all Golden Gate material improvements** (we'd be painting our own surfaces). |
| **B. Real vibrancy, committed** | keep `vibrancy`, make the renderer genuinely transparent where the material should show | must design for a variable backdrop; must handle Reduce Transparency; contrast must hold over anything | A real macOS material that inherits system behaviour. Golden Gate's slider then applies to us for free. |
| **C. Native Liquid Glass** | `electron-liquid-glass`, `vibrancy: false`, `transparent: true` | private API, App Store risk, breakage risk each macOS release | The actual macOS 26/27 material. |
| ~~D. What we ship today~~ | vibrancy on, renderer paints ~95% opaque over it | all of B's cost | **~5% of the effect. Nobody can see it, and our surface tokens are not reproducible.** |

**D is not a strategy, it is an unfinished migration.** The decision is A or B (C only if the App
Store is not a constraint and we accept per-release breakage).

Note the asymmetry Golden Gate creates: from 14 Sept 2026, apps on system materials get better
readability, uniform radii and a user opacity slider **for free**. Apps that paint their own surfaces —
Claude, Codex, and us — get none of it, and must hand-maintain the equivalent.
