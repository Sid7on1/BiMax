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

## P0 — the session ends after every action (packaged provider only)

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

Every action in the UI reads "Not confirmed — not requested". That is literal:
`postcondition: receipt?.postcondition ?? 'not requested'` — the model never sends `expect`, so no
action is ever proven. A genuinely failed action reports `missed`; a refused one returns `ok:false`.

**Undiagnosed, deliberately.** The last attempt to measure it was invalidated because the CU session
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

## P6 — the conformance gate is flaky

`phase2:check` failed the same three live assertions (semanticPerformed, physicalPerformed,
stopBeforeEffect) immediately after install and passed on retry — three separate times in one day.
Both runs are committed each time rather than only the green one. Until this is trustworthy, it
cannot be used as evidence that P2 or P3 worked. Fix before relying on it.

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

1. **P7 menu/keyboard surface** — largest win, no model, no license, no download.
2. **P0 session death** across the packaged provider boundary (in-process is exonerated).
3. **P6 conformance flakiness** — until it is trustworthy it cannot prove P2 or P3 worked.
4. **P8 vision floor** — detector-first; measure before adding the captioner.
5. P2 background, P3 verification, P4 learning.
