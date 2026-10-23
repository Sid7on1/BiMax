# Computer Use — open phases and measured findings

Written 2026-08-18 at the end of a long repair session. Everything here is either MEASURED on this
machine or explicitly marked as a hypothesis. Pick up from any section independently.

Harness: `scratchpad/audit2.ts` (pattern below) — construct `BimaxComputerRuntime` in-process, call
open/observe per app, report element count, NAMED count, actionable count, the tree truncation
notice, and `details.perception.scanCaps`. One line per app to extend.

---

## Measured baseline (2026-08-18, after the truncation fix)

| app | open | observe | elements | named | unnamed | actionable |
|---|---|---|---|---|---|---|
| Music | 7.3s | 1.5s | 60 | 54 | 10% | 58 |
| **Spotify** | 4.5s | 0.9s | **1** | 1 | 0% | **0** |
| WhatsApp | 2.6s | 1.0s | 31 | 31 | 0% | 30 |
| Notion | 3.0s | 0.8s | 60 | 60 | 0% | 60 |
| System Settings | 2.4s | 0.9s | 60 | 36 | **40%** | 58 |
| Finder | 2.3s | 0.9s | 60 | 41 | **32%** | 58 |
| Safari | 2.6s | 1.0s | 22 | 18 | 18% | 18 |

Two facts that shape everything else:
- `open` costs 2.3–7.3s; `observe` costs ~1s. Redundant open/switch chains dominate latency, not
  the model.
- The 60-element ceiling on four apps is the escalated cap (120 → 600) doing its job. Before the
  fix these were 33/55 with truncation notices.

---

## P0 — packaged-provider session retirement (locally resolved deterministically 2026-08-22)

**Symptom (live):** every `mac_control` action fails with "session … has ended; call start_session".
The model reported it as a concrete blocker and fell back to AppleScript.

**Falsified, with evidence — do not re-test these:**
- NOT the runtime: 10 consecutive in-process calls (status, apps, open, 4× observe, app switch) all
  healthy.
- NOT idle reaping: idle gaps of 45s, 90s and 150s all survived cleanly.

**Therefore:** it is specific to the packaged `bimax-mac-capability` provider process reached over
MCP, session id `mac-provider-<pid>`. Reproduce ACROSS that boundary; in-process tests cannot see it.

Revival already exists and looks correct: `app/src/capabilities/mac/transport.ts` —
`isRetiredSessionError()` (~line 81) and two `start_session` re-issues (~lines 241, 302). Either it
is not firing on this path, or the session is retired again immediately after revival.

**Phase 1 result:** the native provider does not use that compatibility transport. Its
`NativeToolCoordinator` now recreates a `session_not_found` task session and retries a read once,
discarding every old snapshot authority. Mutations are never retried. The compiled MCP provider
passed 10 sequential reads, deterministic native-service retirement, and provider restart through
one logical `mac_control`. The original live packaged symptom still needs a rebuilt-app/TCC rerun;
the deterministic result is not silently upgraded into live-app evidence.

---

## P2 — background execution (the ChatGPT gap)

`defaultDelivery()` returns foreground unless `computerVisible === false`, so every action fronts the
app and steals the screen. Background exists and `computerPip: true` already gives the small live
preview.

The catch, documented in `noteBackgroundViability()`: some apps expose NO clickable accessibility
element while inactive, and with `computerVisible:false` the window is read by on-screen text
recognition only. The comment also records that auto-switching to foreground was tried twice and was
wrong both times.

**Shape of the real fix:** a per-app viability contract — background by default, detect
non-viability from the tree, fall forward only for apps that genuinely cannot do it. Not a flag flip.

---

## P3 — nothing verifies that an action worked

**2026-08-22 packaged-native correction:** the Phase 2 logical adapter now requires a typed
postcondition before every accepted mutation, derives only exact app/value/window defaults, and
grades fresh native read-back. A bare `outcome:performed` returns
`postcondition_unverified`; click/type without `expect` stop before effect. The compiled arm64
provider fixture and two false-success mutants are preserved in
`24_CU_PHASE2_DETERMINISTIC_COMPLETION_RECORD.md`.

This closes P3 only for mutations already accepted by the packaged-native logical adapter.
Physical, menu, visual-recovery and programmatic adapter mutations, plus live packaged-app proof,
remain Target. The historical diagnosis below describes the compatibility UI/run that motivated
the correction; it is no longer the packaged-native contract.

In that historical compatibility UI, every action read "Not confirmed — not requested". That was literal:
`postcondition: receipt?.postcondition ?? 'not requested'` — the model never sends `expect`, so no
action is ever proven. A genuinely failed action reports `missed`; a refused one returns `ok:false`.

**Historical diagnosis, retained.** The last compatibility attempt to measure it was invalidated because the CU session
was dead for the whole run. One clean run distinguishes three different fixes:

| what a clean run shows | what P3 actually is |
|---|---|
| few actions, labelled clicks | P1 was the whole story → skip to P2 |
| many clicks, now labelled | targeting/ranking → semantic scorer |
| clicks land, state unchanged | real verification gap → build the postcondition contract |

---

## P4 — no learning across runs

Same request from scratch every time. The learning substrate was previously measured as starved:
0 claims, 17 errors, 1 lifetime harness patch; the miner cannot see loop-level pathologies.

**User's own proposal, and it is the right one:** record the successful action sequence per
(app, intent) and replay it as a hint next time. "Text mom on Messages" should collapse from ~38
actions to ~4.

---

## P6 — live conformance is environmental; deterministic routing gate added 2026-08-22

`phase2:check` failed the same three live assertions (semanticPerformed, physicalPerformed,
stopBeforeEffect) immediately after install and passed on retry — three separate times in one day.
Both runs are committed each time rather than only the green one. Until this is trustworthy, it
cannot be used as evidence that P2 or P3 worked. Fix before relying on it.

**Phase 1 result:** `cu:phase1:check` removes live TCC/application state from the routing/session
release gate and uses a deterministic no-input native protocol fixture. The existing live
conformance matrix remains separate and must preserve red and green attempts; it is still required
for Product-ready claims.

---

## Spotify / zero-AX windows — diagnosed, change REVERTED

`const degraded = windowElements.length === 0;` counts ENTRIES. A lone AXWindow is an entry, so a
window publishing only structural chrome scores healthy while exposing nothing clickable. Spotify:
1 element, 0 actionable, `degraded:false`.

This is NOT an app fact. `resolveObservedHandle` already applies the correct rule and says why:
"counts ACTIONABLE handles, not entries … a lone AXWindow registers an index".

Changing it to `windowElements.every(structural)` works — `degraded` flips true and the summary
correctly tells the model "NO element indexes or tokens — target by query or x/y". **But it fails two
existing tests** (`tracks the active execution surface on open and clears it on close`, and
`click occlusion gate › moves the Live Preview out of the way rather than refusing`). Those encode
behaviour that depends on the old classification and must be understood before the change lands.

Second half, and the larger piece: even when flagged, the vision path does not SYNTHESISE targets —
`foveated: {triggered:false, ocrTextRegions:0}`. Flagging is not enough; something has to turn the
screenshot into targetable regions.

---

## Method note

Exercising the tools directly found in one run what several failed-run autopsies missed, including a
fix of mine that shipped as dead code with 5 green unit tests. Truncation is counted in NODES; the
driver returns ELEMENTS. Prefer direct tool exercise over reverse-engineering transcripts.

---

# P7 — the menu/keyboard action surface (DO THIS FIRST)

Added 2026-08-18 after research + live measurement. This outranks everything above it.

## The measurement that motivates it

Spotify's WINDOW exposes 1 element, 0 actionable. Spotify's MENU BAR, same app, same moment:

```
$ osascript -e 'tell application "System Events" to tell process "Spotify" \
    to get name of every menu bar item of menu bar 1'
Apple, Spotify, File, Edit, View, Playback, Window, Help

$ ... every menu item of menu 1 of menu bar item "Playback" ...
Play, Next, Previous, Seek Forward, Seek Backward, Shuffle, Repeat, Volume Up, Volume Down
```

Every command the failing runs were trying to reach by guessing pixels is a NAMED, semantic,
AX-addressable menu item. No vision model required.

**The runtime has no menu support at all.** `grep -rn "menu_bar\|menuBar" desktop.runtime.ts` returns
nothing outside comments. This is an unwired surface, not a fallback used badly. The codebase has
separately measured the menu bar at ~380 nodes, so its richness was known and never acted on.

## Why menus beat vision for a large class of tasks

- Fast: one cheap AX query, no model inference.
- Accurate: exact command names — no coordinate guessing, no OCR error.
- Verifiable: AXPress on a menu item succeeded or it did not.
- Background-friendly: a menu command does not require fronting the window.
- Near-universal on macOS: apps are expected to populate a menu bar, unlike window AX.

Competitors lean on vision largely because BROWSERS have no menu bar. On macOS there is a
structured surface the web does not have. Use it.

## Scope for the build

1. Enumerate the target app's menu bar as a first-class observation surface.
2. Expose a semantic action: activate a menu command by name/path (e.g. `Playback > Next`).
3. Harvest each item's keyboard equivalent — pressing the shortcut is often faster and does not
   open menus visually. This is exactly how keyboard-only Mac users operate.
4. Prefer menus for commands (play, pause, new, save, find, close) and keep element clicking for
   content selection (a specific row, a specific message).

## STATUS 2026-08-19 — built, wired into the runtime, live-verified

`src/computer/menu.surface.ts` (the surface) + `src/computer/menu.ladder.ts` (the rung decision) +
`src/__tests__/computer.menu.surface.test.ts` / `computer.menu.ladder.test.ts` (48 tests). Wired into
`observeTarget` and exposed as the `menu_activate` verb. All four scope items above are done.

### The pre-build confirmation the handoff asked for — menus ARE uniformly rich

| app | top menus | items | named | with shortcut | window elements (for contrast) |
|---|---|---|---|---|---|
| **Spotify** | 8 | 101 | 75 | 45 | **1 element, 0 targetable** |
| WhatsApp | 9 | 109 | 87 | 53 | 31 (healthy — NOT a blind app) |
| Notion | 8 | 95 | 71 | 41 | 60 |
| Finder | 8 | 176 | 139 | 92 | 60 |

### Reading the tree: three access patterns, and the fast one is a trap

| pattern | Finder | Safari | correct? |
|---|---|---|---|
| per-item attribute reads | 11,981ms | 17,279ms | yes |
| bulk PLURAL attribute reads | 627ms | — | **NO — silently misaligned** |
| `properties of every menu item` | **365ms** | **438ms** | yes ← what ships |

`name of every menu item` DROPS nameless separators while `enabled of every menu item` keeps them, so
the lists have different lengths (Finder's Apple menu: names=15, enabled=21) and index `i` means a
DIFFERENT item in each. It mis-assigns enabled state and shortcuts while looking healthy.
`value of attribute … of every menu item` is worse: it returns only items that HAVE the attribute
(5 of 21) and throws outright on some menus. `properties of every menu item` returns one aligned
record per item — 176 for Finder's 176 entries. **33x faster than per-item, and correct.**

Parallelising across menus was measured SLOWER (529ms vs 237ms): System Events serialises AX access,
so extra processes only add spawn cost. Key equivalents are NOT in `properties`, so they stay lazy
(~170ms for the one command being used).

### Encodings that silently corrupt a naive implementation (all measured)

1. **Invisible bidi marks.** WhatsApp titles are U+200E + name (`e2808e 4368617473`).
   `menu item "Chats"` fails -1728; 11 of 12 items in its View menu are affected.
2. **`missing value` becomes a literal string.** AppleScript's `as text` coerces an unset attribute
   into `"missing value"`. This passed 24 green unit tests and was caught only by a live run:
   separators survived as commands named "missing value", and Notion's `Print…` rendered `⌘MISSING VALUE`.
3. **Modifier bit 3 is inverted** — set means Command is ABSENT, so mods=0 is ⌘.
4. **Modifiers alone never imply a shortcut** (`Print…` is mods=0 with no character).
5. **Arrow/function keys are private-use CHARACTERS, not glyphs** — Finder's Enclosing Folder is
   U+F700, Spotify's Next is U+F703. **No glyph attribute was set on a single item across five apps**,
   so a Carbon glyph table would have shipped as dead code.
6. **Names are not unique, atomic, or stable.** Finder's Go menu has THREE "Enclosing Folder" items;
   Safari's History contains "Monday, August 17, 2026" (commas inside a name). **Everything is
   addressed by INDEX PATH**, never by name — which also makes it locale-proof.

### Safety, learned from what the surface actually offered

- **The Apple menu is dropped whole.** It is the system's, not the app's, and it puts Shut Down /
  Restart / Log Out one fuzzy match from any intent containing "close" or "quit".
- **`Services` is dropped.** macOS injects it into every app; on Spotify it filled the first five
  offers and buried `Playback > Next`.
- **Destructive commands are excluded from fuzzy matching.** Anchored patterns were not enough:
  Spotify offered "Reset App Data and Restart" and "Disable Hardware Acceleration and Restart",
  neither of which starts with a dangerous verb.
- **Disabled commands are refused before dispatch**, and the refusal says whether activation state
  explains it — measured, Finder has 47/156 commands enabled in the background against 75/155
  frontmost, while TextEdit barely moves (33 → 36). The surface never fronts an app silently; that
  was tried twice on this codebase and was wrong both times.

### The perception ladder (`menu.ladder.ts`), wired into `observeTarget`

AX tree → menu bar → vision. Measured end-to-end through the runtime:

- **Finder**: 57 targetable / 28 named rows → `ax_tree`; the menu walk is never paid.
- **Spotify**: 0 targetable → `menu_bar`, 27 enabled commands offered.

The rung test is **TARGETABLE (non-structural)**, not `ACTIONABLE_AX_ROLES`. That distinction broke
the ladder once: Finder's content is `AXRow`/`AXCell`, which are in neither the actionable nor the
structural set, so an "actionable" test called a window of 28 named files blind and handed it to the
menu bar. A lone AXWindow is structural and still scores zero, which is the Spotify case.

This also sidesteps the reverted `degraded` bug below without touching it: the ladder reads
targetable count, not entry count, so Spotify routes correctly while `degraded:false` stays as-is and
the two tests that blocked that change still pass.

### Verified live

- `View > Zoom In` activated on **Spotify** end-to-end through the runtime, chosen from the
  observation's own `menu` list, addressed by index path.
- Finder's path bar toggled with the effect **confirmed by end state** — the item renames itself
  (`Show → Hide`), settling after 748/1157/1134ms. A caller that re-reads immediately sees the OLD
  title and wrongly concludes the click missed.
- `confirmed: null` is reported for non-toggle commands: the command ran, its title is simply not a
  postcondition. That is NOT a failure and is never reported as one.

### The limit, stated plainly

**Menus are COMMANDS, not CONTENT.** Spotify's menu can play, pause, skip and change volume; it
cannot click a specific song. WhatsApp's menu can open Chats; it cannot pick one conversation. The
blind-app *command* problem is solved; the blind-app *content* problem is not, and that is what
P7.5 (type-to-search + focus navigation) and P8 (vision) exist for.

**Second honest caveat:** because the menu rung almost always returns something, vision still never
runs. The untested floor was not fixed — it was moved one rung further away.

---

## CORRECTION 2026-08-19 — the Spotify premise does NOT reproduce

The measurement that motivated all of P7 — "Spotify's window publishes 1 element and 0 actionable
controls" — **no longer reproduces**. Measured today through the runtime, cold, on the first observe:

```
elements=60  targetable=64  named=56  tier=ax_tree
roles: AXWebArea:1 AXButton:18 AXStaticText:18 AXRow:8 AXCell:6 AXTable:1 AXLink:1 AXComboBox:1
labels: "Skip to main content", "Go back", "Go forward", "Home", "Search", "What do you want to play?"
```

Spotify is a CEF app and publishes a **web** accessibility tree, like a browser. It is rich when the
app has a real, rendered window.

What produced the "1 element" reading is almost certainly WINDOW READINESS, not AX opacity. Measured
alongside: a freshly launched, backgrounded Spotify has **no window at all** (`count of windows` = 0,
System Events -1719), and System Events reports `entire contents` = 0 for it even while the driver
reads 60 elements. So the blind observation was of an app that had not finished producing a window.

**Consequences, stated plainly:**
- The flagship justification for the menu rung is weaker than recorded. Menus remain correct, fast
  and useful — and remain the only surface when a tree is genuinely absent — but "Spotify is blind"
  should not be quoted as the motivating fact until it is re-measured on a cold, windowed app.
- `AXFocusedUIElement` returning MISSING for Spotify/Notion/ChatGPT/Claude was measured while those
  apps were in the same questionable state. That result needs re-running with a real window present
  before "focus navigation does not work" is treated as settled.
- The three diseases table's "structural blindness / Spotify: 1 element, 0 actionable" row is
  therefore UNCONFIRMED, not established.

The general lesson matches an existing one in this codebase: an empty AX tree is often a statement
about WHEN you looked, not about the app. Re-observe with a real window before concluding opacity.

---

# P8 — a vision floor, only for what P7 and AX cannot reach

## Why a floor is needed at all

Our architecture has a single point of failure competitors do not have: AX is the ONLY source of a
target list, and when it is empty we stop. Measured: forcing Spotify to `degraded:true` produced the
honest message "NO element indexes or tokens" and then `foveated:{triggered:false, ocrTextRegions:0}`
— we label the window unusable and give up. OpenAI's CUA treats screenshots as primary and
DOM/accessibility as enrichment, which is why it works anywhere.

The universal property to build:

> Every observation must yield a targetable element list. AX (and now menus) are the cheap, precise
> paths when available; a vision detector is the guaranteed path when they are not. Neither is
> optional.

## OmniParser — what it actually is, and the shipping constraints

CORRECTION to a natural assumption: OmniParser is NOT just YOLO. It is two models —
`icon_detect` (YOLOv8) for boxes, plus `icon_caption` (a fine-tuned **Florence-2**, a transformer)
to describe what each box does. The transformer cost lives in the labelling half, not the detection
half.

| concern | measured/reported |
|---|---|
| Availability | Open-source download (HuggingFace `microsoft/OmniParser-v2.0`), not API-key-only. Also hosted on Replicate if an API is preferred. |
| **License** | `icon_detect` (v2) is **AGPL** — a real hazard for a shipped commercial app. `icon_caption` is MIT. v3's detector moved to MIT-licensed YOLOv9. **Get legal review before shipping.** |
| Speed | 0.6s/frame on A100, 0.8s on a 4090. **CPU is multi-second per frame — explicitly too slow for an interactive agent loop.** Target machine here is an 8GB MacBook Air. |
| Size | Detector is tiny (**6.1 MB** as OpenVINO). The Florence-2 captioner is the bulk (~1 GB) — this is what would bloat the DMG. |

Practical read: detector-only is small, fast and license-checkable, but yields UNLABELLED boxes —
which is the same anonymity problem Finder (32% unnamed) and System Settings (40% unnamed) already
have. Captioning is what makes boxes nameable, and captioning is the expensive, heavy, AGPL-adjacent
part. Decide that trade deliberately.

Also consider Apple's own on-device vision (Vision framework text recognition) before importing a
Python/PyTorch stack: it ships with macOS, costs nothing in DMG size, and the runtime already has
OCR plumbing (`ocrTextRegions`) that currently reports 0.

---

# Correcting one premise: AX is NOT being removed

Measured on this machine, macOS 26.5:

```
Spotify: manualCode -25205 (attributeUnsupported), enhancedCode -25208 (illegalArgument)
Music:   manualCode -25205,                        enhancedCode -25208
```

What is refused is `AXEnhancedUserInterface` — an UNDOCUMENTED opt-in for forcing apps to publish
richer trees. Accessibility itself powers VoiceOver and is legally load-bearing; Apple is not
removing it. Spotify's menu bar answered fully over AX moments later.

So do not plan for AX's death. Plan for AX being **incomplete**, which is a different and far more
tractable problem — and which P7 largely solves.

---

# The three diseases (do not conflate them)

| failure | measured | cure |
|---|---|---|
| Structural blindness | Spotify: 1 element, 0 actionable | P7 menus, then P8 vision |
| Truncation | Music 33 / Notion 55, cut at 120 nodes | FIXED 2026-08-18 (read the driver's `truncated at N nodes` marker) |
| Anonymity | System Settings 40% unnamed, Finder 32% | P7 menus for commands; captioning or OCR for content |

Lumping these together is why past fixes became the next app's headache.

---

# Sources

- Computer use — OpenAI API: https://developers.openai.com/api/docs/guides/tools-computer-use
- Introducing Operator — OpenAI: https://openai.com/index/introducing-operator/
- OmniParser — Microsoft: https://microsoft.github.io/OmniParser/
- OmniParser paper: https://arxiv.org/pdf/2408.00203
- OmniParser v2 weights: https://huggingface.co/microsoft/OmniParser-v2.0
- Icon detection/captioning models: https://deepwiki.com/microsoft/OmniParser/2.2-icon-detection-and-captioning-models
- OmniParser + OpenVINO: https://docs.openvino.ai/2024/notebooks/omniparser-with-output.html
- DOM vs screenshots: https://fazm.ai/blog/how-ai-agents-see-your-screen-dom-vs-screenshots

---

# Suggested order for the next session

**2026-08-20 correction:** the old first item below is no longer current. The working tree now wires
the retained Menu capability into `app/src/capabilities/mac`; no second Terminal- or DMG-specific CU
copy was created or removed. The implementation classifies temporal AX readiness instead of
permanently labelling Spotify AX-poor, exposes menus as a command-intent adapter, keeps vision
eligible whenever requested content is absent semantically, and treats menu search as the
transaction open search → type → reobserve → ground result → select → verify. Menu mutations use
the same acting, serialization, takeover, receipt and post-action evidence path as other mutations.

The 2026-08-20 WhatsApp trace also produced two contract fixes: model observations now expose one
canonical element handle instead of inviting `elementToken + elementIndex`, and typing resolves
only editable controls before delivery, preventing a button whose value merely contains the word
“message” from outranking the `AXTextArea` composer. Background-capable semantic actions are the
default, and the exact-window nonactivating ScreenCaptureKit Live Target is wired into packaging.

These changes are **Implemented and locally unit-Measured**. They remain short of Product-ready
until a packaged app run preserves evidence for Spotify cold launch, stable AX, search-result
selection and forced AX-opaque vision, plus WhatsApp recipient selection, composer mutation, send,
exact postcondition, continuous Live Target frames, and proof that Bimax stayed frontmost.

1. Run and preserve those packaged journeys; do not upgrade from local implementation evidence.
2. **P0 session death** across the packaged provider boundary (in-process is exonerated).
3. **P6 conformance flakiness** — until it is trustworthy it cannot prove P2 or P3 worked.
4. Complete the **P8 vision floor** with detector-first measurement for semantically absent content.
5. Extend the Phase 2 postcondition grader to accepted physical, menu and visual-recovery mutations,
   then continue P4 learning only from receipt-backed journeys.

---

## 2026-08-20 general ladder + installed build status

The current implementation and package no longer encode a particular app as an AX-poor class or a
special runtime route. AX readiness belongs to a window observation and can recover after cold
launch; Menu adapts command intent but never stands in for content; and the existing visual path
remains eligible whenever the requested content is not represented semantically. App names remain
only where a historical measurement or regression fixture needs provenance.

Menu activation and Menu-opened search now share the acting mutex, takeover guard, background
delivery policy, action receipts and post-action evidence path. Background Menu delivery measures
the human's frontmost app before and after the mutation, restores it if the target stole focus, and
does not claim completion after a foreground violation. Search now has six required stages — open,
type, reobserve, ground, select and verify — and stops before any stage whose recipient or expected
state is not proven.

The general packaged fixture is preserved at
`app/benchmarks/computer-use/results/phase2/run-2026-08-20T13-53-53.109Z/report.json`; every asserted
semantic, physical, visual, stop, temporal-readiness, content-policy, transaction, foreground and
M02 exact-state row passed. The full local test result is 94 suites / 1,103 tests. The corrected
local packaging path also rebuilt an arm64 bundle from source and passed strict nested signature
and package-component verification. That source-equivalent candidate is installed at
`/Applications/Bimax.app`, while the prior build remains recoverable at
`/Applications/Bimax.app.backup-20260820-192506`.

Status remains **Implemented and locally Measured**, not Product-ready. Broad live-app evidence,
continuous mini-window UI proof, clean-Mac TCC, Developer ID/hardened-runtime signing, notarization,
and physical visual action without an honest foreground escalation remain **Target**. No claim is
made that macOS permits arbitrary pixel input into a background window.
