# macOS 27 "Golden Gate" — what actually changes

**Retrieved 2026-09-12.** Machine under study runs **macOS 26.5.2 (25F84)**, i.e. Tahoe — *not* Golden Gate.

> ⚠️ **Sourcing honesty.** `developer.apple.com` renders its documentation and HIG client-side, so the
> fetcher returns only page titles. **Nothing below was read directly off an Apple page.** It is
> reconstructed from Apple's release-notes text as quoted by secondary outlets, plus developer
> write-ups. Quotes attributed to Apple are Apple's wording *as reported*. Items needing a first-party
> read are marked ❓. See `SOURCES.md`.

## Timeline

| | |
|---|---|
| Announced | **WWDC 2026, 9 June 2026** — named by Craig Federighi |
| Public release | **14 September 2026** — *two days after this research* |
| Predecessor | macOS 26 "Tahoe", which introduced Liquid Glass (WWDC25, 9 June 2025) |

## The story: Golden Gate is a Liquid Glass *walk-back*

Tahoe shipped Liquid Glass and drew sustained criticism for readability. Golden Gate is the correction,
and Apple said so openly — the changes were explicitly driven by user feedback.

Apple's own release-note wording:

> "Updates to Liquid Glass improve readability, and a new slider lets you customize how it looks,
> from ultra-clear to fully tinted."

> "Uniform toolbars, edge-to-edge sidebars, and more detailed app icons."

### The changes

| Area | Tahoe (26) | Golden Gate (27) |
|---|---|---|
| **Glass opacity** | fixed | **User slider**, System Settings › Appearance › Liquid Glass, "ultra-clear" → "fully tinted" |
| **Window corner radius** | **Not uniform** — windows *with* a toolbar get an exaggerated radius wrapping concentrically around the glass toolbar; titlebar-only windows keep a compact radius | **Uniform across apps**, and less dramatic |
| **Sidebars** | floating, with shadowing | **Edge-to-edge**, shadowing removed |
| **Sidebar icons** | colour removed | **Colour restored** |
| **Toolbars** | varied | **Unified**, "to make text headings and groups of controls more legible" |
| **App icons** | layered Liquid Glass | **More** glass layers baked in, for detail and sharpness; still a squircle |
| **Depth** | — | darkened edges + brighter specular highlights; **HDR** used for depth |
| **Window shadow** | — | improved, so the active window is more distinguishable |
| **Menu bar** | — | menu bar items gain icons |

### The single most important fact for us

> **Apps pick these changes up automatically on macOS 27 — no code change, no recompile.**
> The system-wide refinements extend to third-party apps.

So the Golden Gate improvements are *free* to any app that uses system materials — and **entirely
unavailable to an app that paints its own opaque surfaces**, which is what both Claude and Codex do,
and effectively what we do too.

Caveat worth knowing: reporting notes there is **no true "ultra-clear"** on the slider — even its
clearest setting is less transparent than the original WWDC25 Liquid Glass.

## Developer-facing changes (AppKit, macOS 27)

Native AppKit API, so **none of this is reachable from an Electron renderer**. Recorded for completeness.

- **`NSRefreshController`** — pull-to-refresh for `NSScrollView`.
- **`NSToolbarItemGroup.role`** + `NSToolbarItemGroupRole` enum — semantic role tagging for toolbar groups.
- **`NSSegmentedControl.role`** + `NSSegmentedControlRole` enum — including a **`tabs`** role for
  segmented controls used as tab navigation.
- **`NSTextSelectionManager`** — standard text-selection interactions (click, drag, shift-click,
  double/triple-click for word/line/paragraph) delivered to an `NSView` via `NSGestureRecognizer`s
  instead of overriding `mouseDown`/`mouseDragged`/`mouseUp`.
- **`NSMenu` hides all menu item symbol images by default**; new `NSMenuItem.preferredImageVisibility`
  to opt back in.
- **`NSControl.Events`** — UIControl-style event type.
- **`NSView.beginDraggingSession(items:gesture:source:)`** — start a drag from a gesture recognizer.
- **`Observable` support** — views update automatically from Observable model changes.
- **Direction of travel**: Apple is pushing AppKit away from manual event tracking loops toward gesture
  recognizers, partly to support Sidecar touch input from iPadOS 27.

❓ Not yet confirmed first-party: whether any API exposes the user's Liquid Glass slider position to
apps; the exact corner-radius values; whether `NSGlassEffectView` became public in 27.
