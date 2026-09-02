# Frontend plan

> **Superseded scope, 2026-09-02:** both frontends are code-only agentic IDE surfaces. The Control
> Mac lane, Trust Center permission journey, Live Target, takeover controls, and native Mac action
> receipts below are historical evidence and must not be exposed or shipped. See
> `30_CODE_ONLY_AGENTIC_IDE_RESET_RECORD.md`.

## Product 1: Bimax Terminal

Promise: **the coding agent that finishes work in the terminal you already use.** Mac-only support at
launch, even if the engine remains internally portable.

### Default surface

1. Transcript: user requests, concise agent updates, tool/evidence blocks.
2. Composer: text, `@` context, slash commands, current autonomy.
3. Task strip: plan progress, elapsed time, and one clear state (`working`, `needs you`, `verified`).
4. Review on demand: changed files, per-file diff, test evidence, accept/reject/checkpoint.

Remove from the Terminal product:

- `/computer`, CU permissions, capture, PiP, grants, rollout and trust-service menus;
- computer posture in the footer and protocol snapshots;
- embedded CU driver, native service, bridge, live PiP, and desktop helper;
- the idea that Terminal can switch to Messages/Finder and drive them.

Keep diagnostics behind one command (`/doctor`) rather than permanent UI. Keep subagents, map, and
memory as commands or contextual views; do not make them compete with the current task.

### Terminal quality bar

- useful first paint under one second on a warm machine;
- no permission prompts at launch;
- resize, paste, Unicode, scrollback, interrupt, resume, and diff review fully keyboard usable;
- clean install contains one terminal executable and its licensing manifest;
- `bimax --json` and NDJSON/stream output documented and tested.

## Product 2: Bimax for Mac

Promise: **give Bimax a task, watch the evidence, step in when it matters.** It codes and it can
operate Mac apps, but computer operation exists only here.

### Information architecture

```text
┌ Tasks / Projects ┬ Current task ──────────────────────┬ Evidence ─────────────┐
│ Project A        │ user + agent conversation          │ contextual inspector │
│  • active task   │ plan and approval cards            │                      │
│  • older task    │ concise tool/action blocks         │ Code: diff/tests     │
│ Project B        │                                    │ Mac: live target +   │
│                  │ composer + attachments             │ action receipts      │
└──────────────────┴────────────────────────────────────┴──────────────────────┘
```

The left side navigates projects and tasks only. Review, Files, Terminal, Agents, Map, Memory and
Health stop being seven peer destinations. The right inspector is contextual:

- coding task: Changes, Files, Terminal, Tests;
- Mac task: Live Target, Action Timeline, Verification;
- contextual-security task: Findings, Causal Evidence, Proposed Correction, Rollback;
- environment task: Inventory, Proposed Changes, Capabilities, Verification;
- ML task: Model, Architecture, Experiments, Comparisons, Export;
- mixed task: Evidence tabs appear only after that evidence exists;
- diagnostics: a single Support/Diagnostics sheet.

These are contextual inspector states, not new permanent navigation destinations. The integrated
Bimax IDE is this task/evidence workspace plus the existing editor, diff, terminal, git and review
components; it does not require a greenfield editor engine.

### Composer

One composer across modes. The app infers the lane from the request and shows a visible chip:
`Code` or `Control Mac`. The user can correct it before execution. Keep three understandable control
levels:

- Ask before changes;
- Work automatically in this project;
- Custom rules.

Internal names like general/explore/sketch/code/beast, rollout modes, drivers, and fallback names do
not belong in the default UI.

### Computer-use experience

Before a Control Mac instruction reaches the engine, Desktop must prove a compatible model route:
the active provider has a credential, the provider's bounded live catalogue confirms the Work
model, and either Work or the dedicated Vision slot accepts screenshots. If any part is unknown,
the instruction waits in a dedicated **Models for Control Mac** window; coding remains available.
Provider credentials are configured from that window, stored through the main process in macOS
Keychain-backed encryption, and never cross renderer-to-engine NDJSON.

The Live Target inspector always shows:

- app and exact window being operated;
- whether Bimax is observing in background or temporarily taking foreground control;
- last verified state and age of that evidence;
- Pause / Take Control / Resume;
- a readable action timeline (`Opened Messages`, `Selected Mom`, `Typed “hi”`, `Sent`, `Verified`).

Raw JSON, element handles, coordinates, AX/OCR source, retries, and fallback codes are inside a
Diagnostics disclosure. Normal users see intent and evidence, not plumbing.

Foreground switching must be honest. Semantic Accessibility actions may happen without bringing the
target forward. Physical keyboard/mouse actions may require the target app to become frontmost. The
UI says this before the action and restores Bimax afterward when possible; it never markets all
computer use as background.

### Trust Center and first CU task

Code tasks enter immediately. The first Control Mac task opens a short contextual Trust Center:

1. Explain what Bimax will observe; **Continue** opens the Screen Recording request.
2. Detect the result and explain what Bimax will operate; **Continue** opens Accessibility settings.
3. Run a harmless live check, show the exact responsible app, and return to the waiting task.
4. If the build is manual-install alpha, show its artifact digest and current exact-hash approval.

When System Settings requires an item to be added, the compact permission coach is the real native
drag source. It names and drags the exact responsible host or `BimaxCuService` bundle, keeps the
destination visible in front, and provides an explicit return to Bimax. The app reports the host and
native-service grants separately; a green Electron host row cannot make native Computer Use ready.

The Trust Center remains available later with grants, permission status, revoke instructions, app
version, engine version, native-service version, and a diagnostic export. Owner sections 28 and 29
extend it with optional intelligence sensors and capability packages:

- each sensor shows purpose, data classes, scope, retention, owner binary/extension, last use,
  evidence gaps, disable/delete and macOS revoke instructions;
- each capability shows digest, publisher/provenance, permissions, dependencies, project/task
  activation, health, update/revocation and rollback;
- a finding shows the causal path and expectation mismatch before its severity;
- a correction card shows exact mutation, before-state snapshot, approval scope, postcondition and
  rollback; model-generated explanation is visibly separate from deterministic policy;
- environment preparation is a reviewable diff. Missing software never turns into a surprise
  global install;
- Computer Use remains a Desktop-owned optional capability and retains its existing contextual TCC
  flow. Code needs none of these permissions.

### Visual direction

Use the implemented **Starlight / Moonlight** foundation: Starlight is white, pearl and silver;
Moonlight is black, graphite and silver. Keep Inter/SF typography and strong transcript typography.
The identity is the exact text `BiMAX`—no glyph, badge, monogram or decorative logo. Remove the
ornamental theme set and dense status footer for v1.
Prioritize hierarchy, spacing, state animation, and native Mac behavior:

- standard hidden-inset title bar, menus, shortcuts, resizable/hideable sidebar;
- one stepped silver hierarchy; state remains explicit in labels and symbols rather than hue alone;
- 150–220 ms state transitions; never animate continuous agent text or terminal output;
- light and dark modes first; extra themes can return only if users ask;
- every icon has a label or tooltip and every primary path is keyboard reachable.

Transcript tool activity uses one quiet inline disclosure language: intent, state, elapsed time and
agent first; arguments, raw output and receipts only when expanded. Tool calls do not become a
second card system competing with user and assistant turns.

This follows Apple's guidance to use Mac space for fewer nested levels, support window/sidebar
customization, and avoid overcrowded toolbars.

Sources:

- [Apple HIG: Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/)
- [Apple HIG: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Apple HIG: Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
