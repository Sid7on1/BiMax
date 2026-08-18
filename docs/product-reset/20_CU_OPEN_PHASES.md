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
