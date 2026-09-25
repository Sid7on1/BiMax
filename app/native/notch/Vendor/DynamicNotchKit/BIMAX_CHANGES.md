# DynamicNotchKit in Bimax

Vendored from https://github.com/MrKai77/DynamicNotchKit at commit `cd0b3e52d537db115ad3a9d89601f20e0bee8d27`
(2026-09-25), MIT License — see `LICENSE`, which must stay with these files. Compiled into `bimax-notch` by
`app/scripts/build-notch.sh` with `swiftc`, not as a Swift package.

Changes from upstream:

1. `Views/NotchShape.swift`: the `#Preview` block removed (Xcode-only macro).
2. `Utility/EnvironmentValues+Extensions.swift`: `@Entry` replaced by hand-written `EnvironmentKey`s (macro).
3. `Views/NotchView.swift`, `Views/NotchlessView.swift`: `@State` replaced by `NotchMeasurements`, an
   `ObservableObject` added in `Utility/NotchMeasurements.swift` — in the macOS 27 SDK `@State` is a macro that only
   Xcode's SwiftUIMacros plugin expands, and Bimax builds its helpers with the Command Line Tools.
4. `DynamicNotchInfo/` and `Documentation.docc/` removed: Bimax draws its own content.
5. `Utility/DynamicNotchPanel.swift`: `.fullScreenAuxiliary` and `.ignoresCycle` added to the collection behaviour, so
   the notch shows over full-screen apps and stays out of the window cycle; `.stationary` replaced by `.transient`, so
   Mission Control hides it instead of the notch covering its Spaces bar.
6. `DynamicNotch/DynamicNotch.swift`, `Views/NotchView.swift`, `Views/NotchlessView.swift`,
   `Utility/DynamicNotchPanel.swift`: a published `contentFrame` (where the content is drawn), and the panel starts
   with `ignoresMouseEvents = true`. The panel is half the screen wide and tall and stays up while tasks run, so the
   host (`main.swift`) turns mouse events on only over the drawn content — the transparent rest can never take a
   menu bar or window click, whatever the window server does with transparent pixels.
7. `Views/NotchView.swift`, `Views/NotchlessView.swift`: the `.onHover` tracking removed. The panel is half the screen
   and SwiftUI's hover tracking made it handle every mouse move over that area even while it ignored clicks (1.8% of a
   core with the mouse moving there, measured 2026-09-26). The host decides open and closed from `contentFrame`.
