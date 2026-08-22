# Competitive source ledger

Accessed 2026-08-08 unless noted. First-party sources are preferred. Product documentation changes
quickly; re-open every source before publishing an external comparison.

## Hermes Agent

| Source | What it supports |
|---|---|
| [Feature overview](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview/) | skills, memory, checkpoints, cron, subagents, programmatic calls, browser, MCP, routing/fallback, plugins, ACP |
| [Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop/) | shared core/state, chat/files/artifacts/terminal/review/worktrees/profiles, backend process boundary |
| [Tools and toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/) | capability categories and gated toolsets |
| [Nous product page](https://nousresearch.net/hermes-agent/) | supported surfaces, positioning, distribution |
| Local `/Users/vishsiddharth/Desktop/hermes-agent` at `ce6dd1a65f4b6b20b1f3b31f75184a3e26583488` | core/edge policy, cache invariants, execute_code, gateway, current Desktop architecture/design |

Local files read: root `AGENTS.md`, `apps/desktop/AGENTS.md`, `apps/desktop/DESIGN.md`, and targeted
source searches. No Hermes source was copied in this research change.

## OpenAI ChatGPT and Codex

| Source | What it supports |
|---|---|
| [ChatGPT desktop app](https://learn.chatgpt.com/docs/app) | one desktop command center, projects/files/browser/apps/plugins, ChatGPT Work and Codex entry |
| [Computer Use](https://learn.chatgpt.com/docs/computer-use) | app-only plugin, macOS permissions, allowed apps, background Mac tasks, cross-app workflows |
| [Long-running work](https://learn.chatgpt.com/docs/long-running-work) | goal contract, pause/resume/edit, verification criteria |
| [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) | local coding loop, permissions, review, structured automation |
| [Code review](https://learn.chatgpt.com/docs/code-review) | review scopes and app/CLI/IDE surfaces |
| [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) | parallel isolated chats and local/worktree handoff |
| [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | subagent visibility, steering, inherited permissions |
| Local `/Users/vishsiddharth/Desktop/codex` at `53d06e24ea318a963812030fa8fed1bd0fc42d42` | Rust core, sandbox/approval architecture, app-server threads/events/skills/MCP |

OpenAI product docs were restricted to official OpenAI/ChatGPT sources. The proprietary native
Computer Use implementation is not present in the open Codex checkout and is not a copy source.

## OpenCode

| Source | What it supports |
|---|---|
| [Introduction](https://opencode.ai/docs/) | TUI, desktop, IDE, open-source coding agent |
| [Providers](https://opencode.ai/docs/providers/) | 75+ providers and local models |
| [Agents](https://opencode.ai/docs/agents/) | primary/subagents and permission overrides |
| [Permissions](https://opencode.ai/docs/permissions/) | resource/tool/command permission patterns and loop guard |
| [Agent Skills](https://opencode.ai/docs/skills/) | SKILL.md discovery and permissions |
| [Server](https://opencode.ai/docs/server/) | headless OpenAPI server and TUI client/server architecture |
| [MCP](https://opencode.ai/docs/mcp-servers/) | external tool integration |
| [LSP](https://opencode.ai/docs/lsp/) | editor/language intelligence |

No local OpenCode checkout was found in the supplied Desktop paths; only current official docs and
the first-party GitHub repository were treated as source.

## Claude Code

| Source | What it supports |
|---|---|
| [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) | interactive/print/resume, JSON streams, permissions and MCP |
| [Subagents](https://code.claude.com/docs/en/sub-agents) | custom/built-in agents, background behavior, models/tools/skills/hooks/MCP/memory/worktrees |
| [Hooks](https://code.claude.com/docs/en/hooks-guide) | lifecycle automation |
| [Checkpointing](https://code.claude.com/docs/en/checkpointing) | reversible agent changes |
| [Agent teams](https://code.claude.com/docs/en/agent-teams) | coordinated parallel sessions |

## Cursor

| Source | What it supports |
|---|---|
| [CLI usage](https://docs.cursor.com/en/cli/using) | resume, review, approvals, MCP/rules, structured non-interactive mode |
| [Headless mode](https://docs.cursor.com/en/cli/headless) | scripting and JSON/stream-JSON events |
| [Background agents](https://docs.cursor.com/background-agent) | isolated remote agents, follow-up, takeover, branch handoff |
| [Web and mobile](https://docs.cursor.com/en/background-agent/web-and-mobile) | remote launch, collaboration, desktop handoff |
| [Checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints) | local snapshots of agent edits |

## Zed and supporting patterns

| Source | What it supports |
|---|---|
| [Zed agents](https://zed.dev/docs/ai/agents) | native, external ACP, and terminal harness separation |
| [External agents](https://zed.dev/docs/ai/external-agents) | process/auth/config boundary and thread import |
| [Parallel agents](https://zed.dev/docs/ai/parallel-agents) | multi-project threads and worktree lifecycle |
| [ACP](https://zed.dev/acp) | open agent/client interoperability |
| [Raycast AI Extensions](https://manual.raycast.com/ai/ai-extensions) | narrow named tools and visible approval model |
| [Raycast AI Commands](https://manual.raycast.com/ai/ai-commands) | contextual Accessibility request pattern |
| [Warp Blocks](https://docs.warp.dev/terminal/blocks) | command/output as a reusable evidence object |

## Bimax evidence read

- `docs/product-reset/01_CURRENT_REPO_AUDIT.md`
- `docs/product-reset/08_ACCEPTANCE_GATES.md`
- `docs/BIMAX_UPSTREAM_HARVEST_PLAN_2026-08-02.md`
- `docs/BIMAX_CU_PORTING_LEDGER.md`
- `docs/COMPUTER_USE_ARCHITECTURE_AUDIT_2026-07-31.md`
- `docs/INFRA_2026_BACKLOG.md`
- `docs/FEATURES.md`
- current source paths named in `05_GAP_REGISTER.md`

The current Bimax worktree was not modified outside `docs/product-reset/` by this research pass.

## Owner sections 28 and 29 platform research

The deep primary-source ledger, architecture decisions and journey contracts are centralized in
`../11_SECTIONS_28_29_RESEARCH_AND_DELIVERY_PLAN.md`. It covers Apple Endpoint Security, System and
Network Extensions, FSEvents, code signing/notarization, SIP/SSV/XProtect, provenance-based anomaly
research, ExtensionFoundation/XPC, TUF/Sigstore/SLSA/OSV, Agent Skills/MCP, Xcode and Android
simulators, Virtualization, MLX/Core ML/PyTorch MPS, ProcessInfo/memory/network signals, Metal frame
policy and Reduce Motion.

These sources support Targets and constraints, not competitive Wins. No rival comparison or broad
security/performance claim was added from this research.

## Model Context Protocol provider boundary

Accessed 2026-08-09. These current first-party sources guided Phase 4's engine/Desktop seam:

| Source | What it supports |
|---|---|
| [MCP 2026-07-28 tools specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx) | `tools/list`, `tools/call`, JSON Schema inputs, structured content and list-change capability |
| [MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture) | host/client/server roles and local stdio process lifecycle |
| [TypeScript SDK client documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md) | dynamic discovery/calls through the official client rather than provider-specific engine imports |

The retained local contract is
`app/benchmarks/computer-use/contracts/mac-provider-tools.sample.json`. This supports a bounded
local provider claim only; it is not evidence of a general extension marketplace or remote MCP
security model.

## Complete owner-vision research map

`../12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md` maps all 37 distinct owner-vision chapters to
primary leads, algorithms, examples, falsification experiments and search prompts. New source areas
include Apple Metal device/working-set capabilities, ProcessInfo power/thermal state, responsiveness
and MetricKit, Network path, Homebrew/Python/Xcode/Docker structured environment sources,
Tree-sitter/LSP/Git editing contracts, OSWorld 2.0 and visual-grounding research, OpenSSF/OSV and
package-confusion research, and algorithm-selection/autotuning literature.

The map is an implementation-research index. It does not establish a competitor comparison,
Product-ready capability, or Win.

## Phase 5 frontend reset — interaction and accessibility sources

Accessed 2026-08-09, before any Phase 5 code was written. The existing research already carried the
product-level references (`../03_PRODUCT_EXAMPLES.md`, `examples/REFERENCE_MATRIX.md`); what it did
not carry was current first-party guidance for the two shapes Phase 5 actually builds — a
projects/tasks sidebar and a contextual evidence inspector — nor for the motion constraint.

| Source | Retrieved | What it supports | What it changed in the implementation |
|---|---|---|---|
| [Apple HIG: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) (page dated 2026-06-08) | 2026-08-09 | a sidebar navigates "areas of your app or top-level collections of content"; no more than two levels of hierarchy; group with disclosure; let people hide it but not by default; **"avoid putting critical information or actions at the bottom of a sidebar. People often relocate a window in a way that hides its bottom edge."** | The six implementation tools left the sidebar (they were panels, not collections). It is now exactly two levels: project → task threads, grouped Current/Earlier. Trust Center is reachable from the title bar and ⌘⇧T as well as the sidebar row, because the old build had Support and Settings only at the bottom edge. |
| [Apple HIG: Split views](https://developer.apple.com/design/human-interface-guidelines/split-views) | 2026-08-09 | first-party precedent for an inspector pane beside a main canvas (Keynote); set sensible min/max pane sizes so the divider stays visible; **"provide multiple ways to reveal hidden panes"** — toolbar button or menu command including a keyboard shortcut; prefer the 1pt thin divider | The evidence inspector is a resizable pane with declared min/max (300–56%) rather than an icon rail plus a dock. It has a title-bar toggle, a close control and ⌘J; every lane also has a palette entry. Dividers stayed 1pt. |
| [ChatGPT: Computer Use](https://learn.chatgpt.com/docs/computer-use) | 2026-08-09 | the current shipped competitor states which app is being controlled, keeps an always-allowed list, documents scoped background macOS work, and promises **"you can stop the task or take over your computer at any time"** | Confirms the Live Target contract is table stakes, not a differentiator: app + exact window, background/foreground per action, and a takeover control that is always reachable (⌘⇧P, task header, inspector). Bimax's addition over this is the per-action end-state receipt and the evidence age. |
| [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) | 2026-08-09 | `reduce` means minimise non-essential motion — the vestibular triggers are "scaling or panning large objects"; the documented approach is to **replace** motion with a muted alternative, not to delete all feedback | `styles.css` previously set `animation: none` plus `transition-duration: 0.01ms !important` on everything, which removed state feedback entirely. Transform-based entrances now collapse to a short opacity fade and only continuous decoration stops. |

Stored material: `../examples/PHASE5_FRONTEND_REFERENCES.md` records the observations and the
decision each one drove. Deterministic renderer artifacts live at
`app/benchmarks/ui/results/phase5/` (journey reports) and `app/benchmarks/ui/screenshots/`
(supported-window-size regression images). The same results folder also stores distinct
`electron-*` records for the built Electron main/preload/supervisor/compiled-provider boundary;
their native target is an explicitly named safe fixture, not a live-app performance sample.

These sources support interaction and accessibility decisions only. No competitive Win, and no
performance or hardware claim, is derived from them.

## Phase 7 macOS release hardening

Accessed 2026-08-09 before changing the release path. These are platform constraints, not evidence
that the current artifact passed them.

| Source | What it supports | Implementation consequence |
|---|---|---|
| [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution?changes=_5) | Developer ID signing precedes notary submission; a successful result produces a ticket that can be stapled | Stable script signs/submits/staples the app before constructing and submitting/stapling the DMG. A local signature is not called notarization. |
| [Apple: Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues) | valid Developer ID Application identity, secure timestamp, hardened runtime, and no debug-only entitlements are baseline requirements | Stable path refuses missing/mismatched nested Developer ID teams and verifies the hardened bundle before upload. |
| [Electron: Security checklist](https://www.electronjs.org/docs/latest/tutorial/security) | context isolation, sandboxing, restricted navigation/new windows, sender validation, and narrow permission handling remain release requirements | Phase 7 preserves the existing security boundary and adds only a no-argument, user-save-dialog export. |
| [Electron: Context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) | expose narrow methods rather than raw `ipcRenderer` | Export is one typed method; filesystem/process authority stays in main. |
| [Electron: Updating applications](https://www.electronjs.org/docs/latest/tutorial/updates) and [autoUpdater API](https://www.electronjs.org/docs/latest/api/auto-updater/) | macOS auto-update requires a signed application | Manual alpha gets a verified transactional manual installer; signed update remains a stable Target. |
| [Electron: Process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox) | sandboxed renderers move privileged work behind IPC | Diagnostic assembly/writing stay in main and renderer receives only `saved/cancelled/failed`. |

Stored local evidence: `../evidence/phase7-local-2026-08-09.json` and
`../18_PHASE7_RELEASE_HARDENING_RECORD.md`. It supports a local arm64 manual-alpha candidate only,
not a public release, Intel build, clean-Mac result, stable channel, or competitive Win.

## Trust Center, native drag and motion hardening

Accessed 2026-08-11 before changing the Trust Center, permission coach, model catalogue and shared
dialog/button motion. These are current first-party platform and interaction constraints; they do
not establish fresh-Mac TCC success or a competitive Win.

| Source | What it supports | Implementation consequence |
|---|---|---|
| [Apple HIG: Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos) and [Settings](https://developer.apple.com/design/human-interface-guidelines/settings) | Mac utilities should expose clear hierarchy and native platform behavior; settings describe user-adjustable app choices, while macOS privacy grants remain system-owned | Trust Center reports live, responsible-host permission readings and opens the exact System Settings pane; it never draws fake grant switches. Required Control Mac grants are separated from optional access. |
| [Apple HIG: Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | Modal work should be focused and avoid unnecessary depth or prolonged nested interaction | Trust Center and Model catalogue each have one fixed header, one scrolling body and one fixed footer. The nested two-scrollbar Trust Center was removed. |
| [Apple HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion) and [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | Motion should clarify state and feedback, remain brief and coherent, and provide a reduced-motion alternative | Dialogs use short opacity/scale entrances, buttons use bounded press feedback, and Reduce Motion removes sheen/scale in favor of opacity feedback. No permanent decorative loop was added. |
| [Apple HIG: Drag and drop](https://developer.apple.com/design/human-interface-guidelines/drag-and-drop) | A drag source should be visibly draggable, the destination should remain clear, and a non-drag alternative should exist | The compact coach names the exact tile, keeps System Settings as the visible destination, supplies Back to Bimax, and never substitutes a fake toggle for a macOS grant. |
| [Electron: Native File Drag & Drop](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop/) and [`webContents.startDrag`](https://www.electronjs.org/docs/latest/api/web-contents#contentsstartdragitem) | A native drag begins in the main process and the drag item requires a file path plus a non-empty icon on macOS | The permission coach resolves the exact responsible host/service bundle and guarantees a non-empty generated raw-bitmap icon before starting the native drag. The main sheet hides so it cannot cover System Settings. A local 2026-08-11 crash report showed `app.getFileIcon()` trapping in AppKit `NSImage` on Electron 43.3.0/macOS 26.5.2, and a 2026-08-12 packaged run showed SVG/PNG data URLs decoding empty, so native/file/codec icon lookup was removed from this path. These are local observations, not broad Electron compatibility claims. |
| [Electron: `BrowserWindow`](https://www.electronjs.org/docs/latest/api/browser-window) | Window show/hide/focus and always-on-top behavior are main-process responsibilities | Electron main owns the permission-coach window choreography and restores Bimax only when the coach closes or the user chooses Back. |
| [Apple: Keychain Services](https://developer.apple.com/documentation/security/keychain-services) and [Electron: `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) | Passwords and keys belong in protected credential storage; on macOS Electron's encrypted storage key is kept in Keychain | Provider API keys are encrypted in main, persisted with private filesystem modes, decrypted only for engine spawn, redacted from IPC recordings, and never sent on NDJSON. |

Local evidence: `app/src/main/__tests__/manual-alpha.trust.test.ts` and the fully green/mutation-aware
renderer record `app/benchmarks/ui/results/phase5/run-2026-08-11T16-02-32-205Z/report.json` (including
J4, J9, J10, J11 and the model-gating J12). Exact-hash local approval is an alpha bridge only: it neither proves builder
identity nor bypasses Accessibility, Screen Recording or any other macOS permission.

Local follow-up evidence, 2026-08-12: the user-controlled `Bimax Drag Verified` native drop reached
System Settings, followed by
`~/Library/Logs/DiagnosticReports/Bimax Drag Verified-2026-08-12-002835.ips` (`SIGTRAP` during
AppKit application reopen) and bounded coach lifecycle logs. The corrected local build passed J4
with M1–M5 rejection, the 64×64 raw-bitmap Electron smoke, 3 focused suites / 9 tests, production
build and strict deep ad-hoc verification. This is a local regression record, not a new external
source and not evidence for clean-Mac TCC, Developer ID, notarization or Product-ready status.

## Computer Use grand-stack verification

Accessed 2026-08-22 before correcting the external grand-stack drafts or changing provider
registration. These sources support research cards and platform constraints; they do not establish
Bimax Measured/Product-ready status or a competitive Win.

| Source | What it supports | Constraint carried into Bimax |
|---|---|---|
| [Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility) and [PR #38102](https://github.com/electron/electron/pull/38102) | `AXManualAccessibility` is Electron's programmatic third-party accessibility switch; PR #38102 fixed its old apparent-failure behavior | Retain the existing one-attempt-per-pid helper path; do not add a duplicate Swift owner or treat historical false failure as the current API contract |
| [Apple ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos) and [SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager) | Desktop-independent single-window filtering and one-shot screenshot APIs exist | Availability is a platform fact; occlusion support and latency remain Bimax measurements |
| [Apple Shortcuts CLI guide](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac) | `shortcuts run` accepts input/output; a shortcut that asks for input pauses | A provider wrapper needs a timeout and visible user-input blocker; the guide does not prove silent consent behavior |
| [Apple Foundation Models updates](https://developer.apple.com/documentation/Updates/FoundationModels) and [macOS 27 overview](https://developer.apple.com/macos/whats-new/) | macOS 27 beta-era dynamic profiles, model protocol, multimodal prompting, OCR/barcode tools, `fm`, Python and updated model behavior | Optional, capability-detected experiment only; base CU continues on macOS 13 without it |
| [Apple FastVLM research](https://machinelearning.apple.com/research/fastvlm-efficient-vision-encoding) and [official repository](https://github.com/apple/ml-fastvlm) | Research baseline and Apple-Silicon-compatible 0.5B/1.5B/7B artifacts | Candidate grounder; licensing, quality, resource and device gates precede adoption |
| [VPI-Bench](https://arxiv.org/abs/2506.02456) and [WASP](https://arxiv.org/abs/2504.18575) | Visual/web prompt injection remains high-rate in author evaluations | Screen/AX/OCR text is untrusted evidence; add adversarial end-state fixtures |
| [CaMeLs Can Use Computers Too](https://arxiv.org/abs/2601.09923) | Upfront branching-plan isolation gives control-flow integrity but branch steering remains | Typed trusted plan plus auditable branches; regex screening alone is insufficient |
| [CoAct-1](https://arxiv.org/abs/2508.03923) | Hybrid GUI/programmatic delegation improves the authors' OSWorld success and step count | Direct engine shell would violate Bimax's current CU gate; any programmatic path stays provider/broker-owned |
| [Agent Workflow Memory](https://arxiv.org/abs/2409.07429) and [OpenCUA](https://arxiv.org/abs/2508.09123) | Workflow induction and computer-use trajectory pipelines are credible research directions | Replay remains a hint with fresh validation; trajectory retention/export requires privacy controls |
| [WebDreamer](https://arxiv.org/abs/2411.06559), [Agent JIT Compilation](https://arxiv.org/abs/2605.21470), and [Scaling Agents for Computer Use](https://arxiv.org/abs/2510.02250) | Model-based planning, typed invariant protocols, scheduling and trajectory judges improve author baselines | Later experiments only; deterministic postconditions and serial mutation remain hard floors |
| [MacArena](https://arxiv.org/abs/2606.06560) | 421 verified tasks across 50 macOS apps; AIWILD workshop at ICML 2026 | Candidate external comparator; do not label it ICML main-track or replace Bimax's frozen release denominator |
| [Cua Driver contracts](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/contracts.mdx) and [repository](https://github.com/trycua/cua) | The project documents best-effort background macOS delivery and MCP contracts | Competitive evidence only; its private-SPI implementation requires independent license/provenance/distribution review and is not a Bimax copy source |

Local implementation evidence, 2026-08-22: `../24_CU_PHASE2_DETERMINISTIC_COMPLETION_RECORD.md`
and `../evidence/cu-phase2-local-2026-08-22.json` record the deterministic compiled-provider
postcondition gate and its two false-success mutants. This is not a new external source, live-app
evidence, Product-ready status, or a competitive Win.

Phase 3/4 local follow-up, 2026-08-22:
`../25_CU_PHASE3_PERCEPTION_AND_LATENCY_RECORD.md` and
`../26_CU_PHASE4_UNTRUSTED_OBSERVATION_RECORD.md` record the deterministic full-snapshot/readiness
gate, separate protocol-fixture latency buckets, authenticated pre-observation branch graph, six
killed scope-widening mutants, and one usable bidi benign control. These are local implementation
records derived from the external research constraints above; they add no new external fact and do
not establish live-app performance, broad injection robustness, Product-ready status, or a Win.
