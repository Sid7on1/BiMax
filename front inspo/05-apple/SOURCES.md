# Sources — all retrieved 2026-09-12

## Primary (Apple) — ATTEMPTED AND FAILED
`developer.apple.com` serves its docs and HIG through client-side rendering; the fetcher receives only
the page title. These still need a first-party read (a real browser, or Apple's PDF/Design Resources):

- https://developer.apple.com/design/human-interface-guidelines/materials — returned title only
- https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes — returned title only
- https://developer.apple.com/design/human-interface-guidelines/foundations/motion — not retrieved
- https://developer.apple.com/videos/play/wwdc2025/219/ — "Meet Liquid Glass" (video, not fetched)
- https://developer.apple.com/videos/play/wwdc2025/361/ — "Create icons with Icon Composer" (video, not fetched)

**Everything attributed to Apple below is Apple's wording as quoted by a secondary source.**

## Secondary — actually read
- https://9to5mac.com/2026/09/09/macos-27-golden-gate-here-are-apples-full-release-notes/ — Apple's release-note text
- https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/ — itemised Liquid Glass changes in 27
- https://mjtsai.com/blog/2026/06/18/appkit-in-macos-27/ — AppKit API changes in macOS 27
- https://lapcatsoftware.com/articles/2026/3/1.html — Tahoe's non-uniform window corner radius (no numbers published)
- https://www.techradar.com/computing/mac-os/macos-27-golden-gate-announced-at-wwdc-2026-heres-everything-you-need-to-know
- https://www.cultofmac.com/news/liquid-glass-changes-ios-27-macos-27

## Implementation sources — read
- https://github.com/Meridius-Labs/electron-liquid-glass/blob/main/README.md — Electron NSGlassEffectView bindings, API + caveats
- https://www.electronjs.org/docs/latest/api/native-theme — nativeTheme properties
- https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-transparency
- https://developer.chrome.com/blog/css-prefers-reduced-transparency — shipped Chrome 118

## Measured on this machine (strongest evidence in this folder)
Not a citation — first-party measurement. See `../01-claude-app/NOTES.md`,
`../02-codex-app/NOTES.md`, `../03-bimax-current/NOTES.md`. Numbers there were sampled from
pixels at 2× and from 60fps captures, not read from any document.
