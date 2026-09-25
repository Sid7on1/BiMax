# God's Land — research

**Date: 2026-09-25. Status: research; nothing is built.** Sources were read on this date. Three reference repositories
were cloned (shallow, outside the repository, not vendored) and their window, event and drop code was read. Platform
facts that change between macOS releases are marked **re-check on this Mac** where the plan depends on them.

## 1. What exists already (prior art)

| Project | What it is | License | Reuse verdict |
|---|---|---|---|
| [boring.notch](https://github.com/TheBoredTeam/boring.notch) (~10.9k★, macOS 14+) | The most popular notch app: media controls, calendar, a **file shelf with AirDrop**, HUD replacement, hover-to-open | **GPL-3.0** | **Study only. Do not copy code** — GPL would bind Bimax. Techniques below are described in our own words |
| [NotchDrop](https://github.com/Lakr233/NotchDrop) (~2.1k★) | Drag files to the notch, AirDrop from it, retention (default 1 day). Credited by boring.notch for its first shelf | **MIT** | Reusable with its copyright notice kept |
| [DynamicNotchKit](https://github.com/MrKai77/DynamicNotchKit) (~460★, macOS 13+) | Swift package: present SwiftUI content from the notch, hover behaviours, and an automatic **floating style on Macs without a notch** | **MIT** | Reusable with notice; the closest to a building block |
| [DynamicNotch](https://github.com/jackson-storm/dynamicnotch), NotchKit, NotchPill | Other notch surfaces | not checked | Not used |
| [Maccy](https://github.com/p0deje/Maccy) | The reference open-source clipboard manager; ignores password-manager clips by default | MIT (per its repo) | Behaviour reference |
| macOS 26 **Spotlight clipboard history** (⌘Space then ⌘4) | Built in: text and images, 30 min / 8 h / 7 days (26.1+), local | — | **The baseline God's Land must beat.** Its gaps, per [this review](https://dev.to/jrw0ng/macos-tahoe-has-built-in-clipboard-history-heres-what-its-still-missing-for-developers-2026-4eko): no exclusions of its own, no lock on the panel, no pinning, plain text only and entries over ~16k characters dropped, two keystrokes, and **no API or per-copy hooks** — no JSON formatting, no transforms |

**What the reference code shows (read, not copied):**

- **The window.** NotchDrop: a borderless `NSWindow` above the menu bar (`level = .statusBar + 8`), clear background, no
  shadow, `collectionBehavior = [.fullScreenAuxiliary, .stationary, .canJoinAllSpaces, .ignoresCycle]` — so it shows on
  every Space and over full-screen apps, which is the owner's "Universal Space Bridge" for free. boring.notch uses an
  `NSPanel` at `.mainMenu + 3`, sized to the open notch (640 × 190 pt plus shadow room), not a full-width strip.
- **Notch geometry.** Width = screen width − `auxiliaryTopLeftArea.width` − `auxiliaryTopRightArea.width`; height =
  `safeAreaInsets.top`; a display has a notch when `safeAreaInsets.top > 0`. The built-in display is found with
  `CGDisplayIsBuiltin`. Without a notch, both fall back to a ~150 × 28 pt pill.
- **Hover.** A global + local `NSEvent` monitor for `.mouseMoved`; entering the notch rect "pops" it, leaving closes it.
  A click outside the open panel closes it.
- **Detecting a file drag before it arrives.** boring.notch records the **drag pasteboard's** (`NSPasteboard(name:
  .drag)`) `changeCount` on mouse-down, and on `.leftMouseDragged` treats a changed count as "something is being
  dragged" — then opens the notch as a drop target. This is what makes "the notch opens its mouth" possible.
- **Drops.** SwiftUI `.onDrop(of: [.fileURL, .url, .utf8PlainText, .plainText, .data, .image])`.
- **Haptics.** `NSHapticFeedbackManager.defaultPerformer.perform(...)` on pop, throttled to one per 0.5 s.
- **What to avoid.** boring.notch loads the private SkyLight framework to show on the lock screen. Private API breaks
  across macOS updates and is not for Bimax.

## 2. Platform facts the design depends on

| Need | Fact | Source | Consequence |
|---|---|---|---|
| Notch shape | `NSScreen.safeAreaInsets`, `auxiliaryTopLeftArea`, `auxiliaryTopRightArea` | [Apple](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets), [Apple](https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytopleftarea-uglc) | Exact placement is public API |
| Electron at the notch | Electron closed its notch-area request as **not planned** | [electron#31478](https://github.com/electron/electron/issues/31478) | God's Land is a **native Swift helper**, like Bimax's voice helper, not an Electron window |
| Liquid Glass | `NSGlassEffectView` (macOS 26+) with `cornerRadius`, `tintColor`; `NSGlassEffectContainerView` **merges nearby glass shapes**. SwiftUI: `.glassEffect()`, `GlassEffectContainer`, `glassEffectID(_:in:)` morphs one glass shape into another | [Apple](https://developer.apple.com/documentation/appkit/nsglasseffectview), [Apple](https://developer.apple.com/documentation/swiftui/glasseffectcontainer/), [Create with Swift](https://www.createwithswift.com/morphing-glass-effect-elements-into-one-another-with-glasseffectid/) | **The droplet and the pour are native glass merges**, not a hand-written shader. Bimax's app minimum is macOS 13: below 26 use `NSVisualEffectView` and the gooey technique below |
| Gooey / metaball shapes | Blur the shapes together, then an alpha threshold snaps the overlap back into one crisp liquid edge; in SwiftUI a `Canvas` with `.alphaThreshold` + `.blur` | [Effect.Labs](https://effect-labs.com/en/pages/blog/blood-goo-metaballs-canvas.html), [iBeer metaballs gist](https://gist.github.com/twostraws/cefe067d5e60366f1d00b93e6b24603b) | Meniscus stretch and neck-snap for macOS 13–25 and for the neck itself |
| Fluid motion | Motion starts from the current value, inherits the gesture's velocity, projects momentum, and can be grabbed and reversed at any moment; springs make that natural | [WWDC18 "Designing Fluid Interfaces"](https://developer.apple.com/videos/play/wwdc2018/803/) | Every motion in 00/01 must be interruptible — now a rule, not a nicety |
| Haptics | Only three patterns: **generic, alignment, levelChange** | [Apple](https://developer.apple.com/documentation/appkit/nshapticfeedbackmanager/feedbackpattern), [Eidinger](https://blog.eidinger.info/haptics-on-apple-platforms) | "Heavy files feel heavier" and a "viscous roll" are **not possible**. Map: alignment = snap to a drop zone, levelChange = pressure steps and clipboard detents, generic = pop |
| Pressure | Force Touch pressure and stage arrive as events **in the app's own window** | [Apple support](https://support.apple.com/en-us/102309), [Force Touch](https://en.wikipedia.org/wiki/Force_Touch) | **Press-harder-to-reveal works** — inside God's Land's own panel |
| Cursor "gravity well" | No public API changes pointer speed for other apps | — | Replace with a larger hover zone and the notch reaching 3 px toward the cursor (that half is only drawing) |
| Ambient light | No public ambient-light API | — | Use light/dark appearance and time of day |
| Global mouse monitoring | Global monitors for mouse events work without a permission; **key** events need Accessibility | Apple `NSEvent` docs (re-check on this Mac) | Hover and drag detection need no prompt |
| Reading the clipboard | Since macOS 15.4 `NSPasteboard.accessBehavior`; programmatic reads outside a user paste are set to **prompt**. New `detect` methods reveal the *kinds* of data without reading it | [Tsai](https://mjtsai.com/blog/2025/05/12/pasteboard-privacy-preview-in-macos-15-4/), [lapcat](https://lapcatsoftware.com/articles/2025/5/3.html), [FB17587626](https://github.com/feedback-assistant/reports/issues/655) | Clipboard history needs the user's one-time **Allow** in Privacy & Security. Reports differ on whether enforcement is on by default — **re-check on this Mac** with `defaults write <bundle> EnablePasteboardPrivacyDeveloperPreview -bool yes` |
| Password-manager clips | [nspasteboard.org](https://nspasteboard.org/): `org.nspasteboard.ConcealedType` (obfuscate, don't store in plain text), `TransientType` (never record), `AutoGeneratedType` | [nspasteboard.org](https://nspasteboard.org/) | Honour all three from day one; mark our own secret copies Concealed |
| Hiding from screen share | Since macOS 15, ScreenCaptureKit captures the composited framebuffer and **ignores `NSWindow.sharingType = .none`**; Apple says there is no public API to prevent capture | [Apple forums](https://developer.apple.com/forums/thread/792152), [tauri#14200](https://github.com/tauri-apps/tauri/issues/14200) | Secrets cannot be hidden *from* a share. They are **masked by default** and revealed only while held; there is no reliable general "is sharing" signal either |
| Global paste trigger (Ghost Paste) | Knowing the user pressed ⌘V in another app needs a key monitor: **Input Monitoring** or Accessibility | Apple `NSEvent` docs | Ghost Paste as designed needs a new permission — **owner decision** (see plan) |
| Seeing a web page's upload field | Needs Accessibility (reading another app's UI) | — | Belongs to the Computer Use return (record 61 §6), parked |

## 3. Research that backs the ideas

| Paper / work | Finding | Used for |
|---|---|---|
| Stylos, Myers, Faulring — [**Citrine: providing intelligent copy-and-paste**](https://www.cs.cmu.edu/~faulring/papers/citrine-uist04.pdf) (UIST 2004) | Parse the structure in copied text (contacts, appointments, citations) and paste many fields in one operation | Entity-aware clipboard cards; the ancestor of Ghost Paste |
| Tata et al. — [**Quick Access: Building a Smart Experience for Google Drive**](https://dl.acm.org/doi/10.1145/3097983.3098048) (KDD 2017), [blog](http://ai.googleblog.com/2017/03/quick-access-in-drive-using-machine.html) | Predicting the next file **halved** the time users spent locating files; features are a fine-grained time series of opens/edits plus context such as upcoming meetings | The Predictive tab: recency/frequency time series first, a learned model only after that baseline is measured |
| [Improving Recommendation Quality in Google Drive](https://dl.acm.org/doi/10.1145/3394486.3403341) (KDD 2020) | The follow-up on the same product | Same |
| Dumais et al. — **Stuff I've Seen** (SIGIR 2003) | In re-finding, people forget item details but remember **context**; "last modified date" was the most used cue | "Search by vague memory": index when, which app, which task and which files were nearby — not only content |
| [What do people recall about their documents?](https://dl.acm.org/doi/10.1145/1216295.1216319) (IUI 2007) | What users actually remember about their files | Which cues the search box accepts |
| [Searching Personal Collections](https://arxiv.org/pdf/2412.12330) (2024), [Indaleko: The Unified Personal Index](https://arxiv.org/pdf/2602.20507) (2026) | Recent surveys/systems for personal search across sources | Design of the local index; not adopted until read in full |
| Chang & Ungar — *Animation: from cartoons to the user interface* (UIST 1993) | Solidity, exaggeration and reinforcement make interface motion legible | The owner's physical metaphors are in this tradition |

## 4. Reusable data and code (license-checked)

| Source | Content | License | How |
|---|---|---|---|
| [gitleaks `config/gitleaks.toml`](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) | 160+ credential rules: regex + entropy + keywords | **MIT** | Secret detection on the shelf; copy the rules we use with the notice |
| [ClearURLs rules `data.min.json`](https://github.com/ClearURLs/Rules/blob/master/data.min.json) | Tracking-parameter rules per site | **LGPL-3.0+** | **Do not bundle.** Start from our own short list of the well-known generic parameters (`utm_*`, `fbclid`, `gclid`, `mc_eid`, …); an optional runtime download is a later decision |
| NotchDrop, DynamicNotchKit | Notch window, geometry, hover, notchless fallback | **MIT** | Reuse with notices, or reimplement; decided in stage 1 of the plan |
| boring.notch | Shelf, drag detector, window | **GPL-3.0** | Study only |

## 5. Corrections to the first feasibility guesses (01 §5)

- **Pressure reveal:** confirmed possible, in our own panel.
- **Weighted haptics:** confirmed not possible; three patterns only.
- **Hiding secrets during a screen share:** worse than guessed — neither hiding nor reliable detection is available
  since macOS 15. Mask by default instead.
- **Clipboard history:** needs the pasteboard permission, which the first guesses did not mention.
- **Ghost Paste:** needs Input Monitoring or Accessibility, which the first guesses did not mention.
- **The droplet:** easier than guessed on macOS 26 — `GlassEffectContainer` merging is the native form of the effect.

## Sources

Every link above was opened on 2026-09-25. Repositories cloned for reading: `TheBoredTeam/boring.notch`,
`Lakr233/NotchDrop`, `MrKai77/DynamicNotchKit` (shallow clones in a scratch directory; nothing vendored).
