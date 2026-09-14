# Competitive source ledger

## Context audit and feature research — checked 2026-09-14

[Record 51](../51_CONTEXT_UPGRADE_AUDIT.md) records inspected source at `333329f`, 25 passing Bun
tests, a reproduced 26/33 local benchmark and controlled adversarial probes. A budget mutant
survives both supplied suites and preserves the benchmark score. This qualifies earlier local
C0/C1 completion claims; no live-provider, installed-app or competitive result was measured.

[Record 52](../52_NOVEL_FEATURE_RECOMMENDATIONS.md#sources) records the checked primary-source
bibliography: Cursor rules/search/security; Claude Code memory/context/hooks/checkpoints; Codex CLI;
Aider maps/modes/testing; Cline checkpoints/compaction; the current Devin Desktop destination of
Windsurf's memories documentation; OpenCode configuration; Stryker mutant classification; and
Zeller/Hildebrandt's original reduction research. These establish adjacent capabilities and known
algorithms, not market-wide absence. All ten proposed product contracts remain Target. No external
source code or dependency was imported.


## Failure visibility — inspected 2026-09-12

Owner-supplied `../../RETRIEVAL_TOOL_AUDIT.md` is the investigation input; its live-provider results
were not rerun or promoted into new measurements. Record 45 uses inspected local embeddings,
reranking, CodeIndex/SQLite/VectorStore, tool factory/Governor, MCP client/manager, AgentLoop,
protocol host/wire queue, CLI print and Desktop main/reducer/rendering code. Controlled HTTP,
filesystem, MCP and scripted-model faults provide the new evidence. No competitor source,
external dependency or contemporary provider claim was introduced.


## Workflow evidence implementation — inspected 2026-09-10

Record 42 uses local `file.tool.ts`, `search.tool.ts`, `fsWalk.ts`, `tool.factory.ts`,
`tool.workflow.ts`, `file-state-cache.ts` and `epistemic.ledger.ts`. The former workflow file-read
path could return mtime-cached content; directory traversal silently skipped unreadable directories
and stopped at its file cap. Actual-byte capture and explicit workflow completeness now address
those evidence gaps. Existing ephemeral correctness statistics are not promoted into immutable
proof; cross-system code/test claim integration remains Target. No new external dependency or
competitor code reuse. The earlier Bazel and replay references remain design background only.

## Tool-workflow feature exploration — checked 2026-09-10

- [Anthropic: advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
  describes tool discovery and programmatic orchestration. Those mechanisms alone are not evidence
  of novelty; Bimax's proposals should be assessed on verified behavior and integration.
- [Bazel: remote caching](https://bazel.build/remote/caching) binds actions to inputs, commands,
  outputs and environment. This informs a proposed incrementally invalidated workflow/evidence
  graph; safe reuse still requires Bimax-specific input completeness and invalidation tests.
- [rr](https://rr-project.org/) documents deterministic record/replay for Linux processes. It
  inspires a proposed tool-boundary replay debugger, not an rr dependency or a claim of equivalent
  instruction-level replay on macOS. Model and external results would be recorded fixtures.

These are design references, not implemented Bimax features or evidence of market uniqueness.

## Tool result contracts — checked 2026-09-10

[MCP tools specification, 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx)
documents structuredContent and outputSchema validation, with serialized text for compatibility.
This supports record 41's proposed typed search-result extension; it does not establish that Bimax
currently implements that output contract. The shipped slice uses inspected local tool.factory,
args.validate, tool.schedule, file/search tools and the existing deferred registry. No dependency
upgrade, external code reuse or competitor performance claim.

## Renderer subscriptions — checked 2026-09-08

[React: useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore) requires
cached immutable snapshots and stable subscribe functions with cleanup. Applied to stage 3c
in record 34 using the installed React 18.3.1 API; no dependency upgrade. Local reducer and
Virtuoso source informed integration. Eight regressions, five caught mutants and a simulated-IPC
browser fixture support the bounded claim; latency and installed-product qualification remain Target.

## Major-lab research recheck — accessed 2026-09-08, Asia/Kolkata

Full methods/limits, local findings and E1–E5 transfer experiments are in
`../33_REFACTOR_RECHECK_AND_RESEARCH.md`; amendments are applied to plan 32 and P01.

| Primary source | Version/type | Decision informed; limit |
|---|---|---|
| [Google Research / DeepMind / MIT: Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v3) | Paper v3, 2026-04-08 | Task-aware coordination with a single-agent control; empirical thresholds are not Bimax constants |
| [DeepMind / Berkeley: Scaling LLM Test-Time Compute Optimally](https://arxiv.org/html/2408.03314v1) | Paper v1, 2024-08-06 | Compare bounded repair/search budgets; math and fine-tuned-model findings are not coding guarantees |
| [Microsoft Research and collaborators: LLMLingua-2](https://arxiv.org/html/2403.12968v2) | Paper v2, 2024-08-12 | Optional compression ablation with overhead and fidelity checks; protect exact operational data |
| [Google Research: Sufficient Context](https://arxiv.org/html/2411.06037v3) | Paper v3, 2025-04-23 | Separate evidence availability from model use; evaluate answer coverage as well as accuracy |
| [OpenAI: SWE-Lancer](https://arxiv.org/html/2502.12115v4) | Paper v4, 2025-05-29 | Independent hidden user-flow graders; benchmark task payouts do not predict Bimax savings |
| [Anthropic: multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Engineering report, 2025-06-13; not a paper | Include coordination/copied-context costs; parallel research is not equivalent to concurrent edits |

Selected literature, not an exhaustive survey. No competitor code/model was copied, no paper
performance multiplier is adopted, and no new Product-ready/Win claim follows. The retained local
checks establish existing module behavior and two rollback defects; optimization remains Target.

## Coding and cowork performance architecture — checked 2026-09-07

Recorded with the 2026-09-08 refactor plan in `../32_FAST_CODE_AND_COWORK_REFACTOR_PLAN.md`.
These sources constrain proposed implementations; they do not establish a Bimax speedup or Win.

| First-party source | Verified constraint | Plan consequence |
|---|---|---|
| [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance) | Profile running code, defer unnecessary initialization, and avoid blocking main/renderer work | Measure critical paths; preserve security initialization while making optional work lazy |
| [Node writable streams](https://nodejs.org/api/stream.html#event-drain) | A false return from write requires waiting for drain before producing more buffered writes | Bound the NDJSON output path and test slow consumers; preserve event order and controls |
| [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore) | External-store snapshots must be immutable and retain identity when unchanged; subscriptions should be stable | Evaluate domain subscriptions without replacing the entire renderer stack |
| [SQLite WAL](https://sqlite.org/wal.html) | Readers can coexist with a writer, but there is one writer at a time; WAL requires same-host shared memory and does not work on network filesystems | Use one storage writer and crash-tested settings; do not treat a synced database as team collaboration |

Local source inspection on working tree `65725a3` found existing bounded tool scheduling,
subagent capacity leases, manifest-based code indexing with cooperative yields, Virtuoso,
content-hash corpus deduplication and dynamically imported office writers. Proposed work extends
those foundations. Repeated discovery, broad stream state, observer-ledger write failure semantics
and the transaction empty-file sentinel are code observations; their latency/incident frequency
was not measured. The worktree includes pre-existing uncommitted composer changes.

The missing capability matrix and absent `tui/` directory are explicit historical-audit conflicts
in plan 32. No competitor feature claim was refreshed or inferred for this optimization program.
Validation performed for the plan is source/document inspection and reference/diff checks only.

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
| [Apple `SystemLanguageModel`](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel) and [availability](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.property) (rechecked 2026-08-23) | Apple's on-device model spans macOS 26 and 27 model versions, while readiness varies by eligible device/region/model state and must be checked at runtime | Phase 7 accepts an app-owned availability probe, not an OS-version guess; disabling the optional layer leaves deterministic CU complete |
| [Apple App Intents](https://developer.apple.com/documentation/AppIntents/app-intents) (rechecked 2026-08-23) | Apps expose structured, parameterized actions to Shortcuts/system experiences and receive completion results | Phase 6 evaluates only fixed manifest operations with bounded parameters; model-authored JXA/script/command payloads are rejected |
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

## Step 3.7 Flash provider continuity

Accessed 2026-08-28 after the installed Bimax app returned HTTP 410 for a greeting. The live,
authenticated API response is the serving-authority evidence; provider marketing/catalog pages are
discovery evidence only and must not override a failed request.

| Source | Current evidence | Bimax consequence |
|---|---|---|
| [NVIDIA Step 3.7 Flash build page](https://build.nvidia.com/stepfun-ai/step-3.7-flash/build) plus a secret-safe authenticated request to `integrate.api.nvidia.com/v1` | The public page still described `stepfun-ai/step-3.7-flash`, while the live chat endpoint returned RFC 7807 HTTP 410 stating that the model reached end of life on 2026-08-28T08:00:00Z; NVIDIA's authenticated model list contained no StepFun id | Treat the NVIDIA route as retired. Preserve the RFC 7807 `detail` field instead of allowing the OpenAI-compatible client to reduce it to `410 status code (no body)` |
| [OpenRouter: StepFun Step 3.7 Flash](https://openrouter.ai/stepfun/step-3.7-flash) | Current provider page and API slug are `stepfun/step-3.7-flash` | Map the Mac app's exact model family to the OpenRouter wire id only when OpenRouter is selected and keyed |
| [StepFun quickstart](https://platform.stepfun.ai/docs/en/quickstart/overview) and [chat API](https://platform.stepfun.ai/docs/en/api-reference/chat/chat-completion-create) | The direct OpenAI-compatible base URL is `https://api.stepfun.ai/v1`; the direct model id is `step-3.7-flash` | Add a first-class StepFun credential/provider route and keep the key in the existing Electron-main Keychain boundary |

Local evidence: three bounded live NVIDIA request shapes returned the same 410 end-of-life problem,
and an authenticated `/models` query returned no StepFun model. No key or response payload outside
the model/status/detail fields was preserved. OpenRouter and direct StepFun availability remain
unverified from this machine until the user supplies one of those provider keys; this is not a live
successful-answer claim, a Computer Use completion, Product-ready status, or a competitive Win.

## Kimi K3 NVIDIA migration

Accessed 2026-08-29 after the owner directed Bimax to retire StepFun from product routing and make
Kimi K3 the default. The authenticated serving inventory establishes availability only; it does not
establish response latency, tool fidelity, Computer Use quality, Product-ready status, or a Win.

| Source | Current evidence | Bimax consequence |
|---|---|---|
| Secret-safe authenticated `GET https://integrate.api.nvidia.com/v1/models` | The active NVIDIA account returned 83 unique ids, including `moonshotai/kimi-k3`, and no StepFun id. Response rows exposed only `id`, `object`, `created`, and `owned_by`; they did not expose trustworthy capability tags, parameter counts, or release dates, and the sampled `created` value was identical across unrelated models | Remove StepFun from active provider/default routing; use the exact NVIDIA Kimi K3 id; keep live membership as availability truth and source recommendation metadata separately from publisher model cards |
| [NVIDIA Kimi K3 model page](https://build.nvidia.com/moonshotai/kimi-k3/playground) and [NVIDIA API reference](https://docs.api.nvidia.com/nim/re/reference/moonshotai-kimi-k3) | NVIDIA documents native text/image input, tool/function calls, structured output, always-on reasoning, configurable `low`/`high`/`max` effort, a 1,048,576-token context window, and the requirement to replay the complete assistant message including `reasoning_content` and `tool_calls` across tool rounds | Add an exact Kimi K3 capability profile, omit unsupported generic sampling fields, default unspecified effort to `low`, preserve replay-required reasoning only, and count it in context pressure |
| [NVIDIA Nemotron 3.5 Lightning model card](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard), [Muse Glimmer model card](https://build.nvidia.com/meta/muse-glimmer-30b/modelcard), and [Laguna XS 2.1 model card](https://build.nvidia.com/poolside/laguna-xs-2.1/modelcard) | Publisher cards provide model-specific parameter scale, release date, input modality and tool/reasoning claims that the live inventory endpoint omits | Curate recommendation membership and display metadata independently from live availability; mark unmeasured routes `avoidAutoSelect` instead of converting publisher claims into Bimax qualification |
| Installed local manual-alpha package, 2026-08-29 | Recompiled the arm64 engine, rebuilt and locally signed the complete Desktop bundle, installed it at `/Applications/Bimax.app`, and passed the package/signature gate against that exact installed path. The installed `app.asar` SHA-256 is `68015fc7b013857671228c65568d3b67582cd74bf7328793edbf922b03e46ea7`; the bundled engine SHA-256 is `2fa184b0e07db7f0d0a66cbade5a40b9dde65a0cb21fc840595ed229e88e3825`. Fresh app UI inspection showed 83 NVIDIA models served; Kimi K3 recommended in Work and Vision; fast, plain models first in Quick; parameters/release dates/tags in recommendation rows; Browse all expanding uncurated live ids; and a Quick search returning `openai/gpt-oss-120b`. Existing Work selection remained DeepSeek while migrated Quick/Vision resolved to Mistral/Kimi, proving model slots are no longer app-locked | Treat the installed local build as current for owner testing. This proves packaging, catalogue projection and visible selection only; it is not Developer-ID/notarized distribution, a successful Kimi task, a Computer Use completion, Product-ready status, or a Win |

Local qualification boundary: one authenticated catalogue request succeeded. Bounded completion and
streaming probes produced no model payload within 60 seconds on this key; a separate default-effort
attempt was interrupted after more than 120 seconds without a response. Those are provider-route
availability/latency observations, not a model-quality failure and not a valid task evaluation.
Kimi K3 is now the owner-selected default, while coding reliability, tool fidelity, screenshot
grounding, real-app Computer Use and latency remain Target pending healthy repeated runs.

## Coding and knowledge-work ideation refresh — 2026-09-07

Owner request: suggest ambitious features combining the experience of Codex, Claude Code,
ChatGPT Work, and Claude Cowork. This is exploratory product advice, not an implementation or
approval to reactivate Computer Use. The 2026-09-02 code-only boundary remains current.

| First-party source, accessed 2026-09-07 | Documented baseline | Ideation consequence |
|---|---|---|
| [ChatGPT Work getting started](https://learn.chatgpt.com/docs/get-started-with-work) | Files, plugins and approved tools support reviewable briefs, decks, analyses and workflows; local and cloud execution have distinct capabilities | Artifact creation and long-running work are established comparison points; explore consistency across a mission's deliverables |
| [Codex app introduction](https://openai.com/index/introducing-the-codex-app/) | Isolated worktrees, parallel task threads, in-thread review, skills and scheduled automations | Parallel agents alone are insufficient differentiation; explore measurable alternative implementations and durable task state |
| [Claude Code overview](https://code.claude.com/docs/en/overview) | Repository edits, commands, verification, MCP, skills, hooks, memory, parallel agents and scheduled work | Preserve coding depth while exploring broader workflows; do not treat a model selector or subagents as a unique advantage |
| [Claude Cowork product guide](https://claude.com/blog/the-claude-cowork-product-guide) | Local files, connected apps, citations, subagents, long-running work and scheduled tasks | Explore linked code/research/document outputs with inspectable sources and completion checks |

Candidate Targets discussed: durable missions, dependency-aware artifact updates, alternative
implementation comparison, independent falsification, source-linked decision memory, workflow
recipes, budgeted background work, reviewable rollback and resumable provider handoff. These are
proposals, with no claim of novelty, implementation, measured quality, Product-ready status or Win.
Broad knowledge-work scope would require a subsequent product-boundary decision.

Repository context: current README, reset record 30, frontend plan 04, architecture 05, acceptance
gates 08 and gap register were read directly. Dataless research files were consulted through Git
HEAD, including competitive README/02/04, repo audit 01, examples 03, split runbook 06, owner vision
and C01/R01 journeys. Referenced competitive/03_CAPABILITY_MATRIX.md is absent from both the
working tree and HEAD; no matrix findings were inferred. Verification for this refresh is source
inspection only, with no product execution or competitive evaluation.

## Learning-loop evidence — 2026-09-09

- Local first-party source: `src/telemetry/trace.ts`, trace producer in
  `src/core/agent.loop.ts`, and `src/mind/{episode.recorder,epistemic.ledger,policy.arms,stats,harness.tuner,harness.lab.eval,event.ledger}.ts`.
  Current traces record confidence and execution status, but lack mutation paths, verifier scopes,
  request/response recordings and policy assignments. Read-only SQLite inspection found no ledger
  events; WAL/main-file size alone was not used as proof of emptiness.
- Local corpus: 15 `.bimax/traces/*.jsonl` files, 59,454 unique spans, input SHA-256s in
  [`evidence/2026-09-09-learning-loop/report.json`](evidence/2026-09-09-learning-loop/report.json).
  Record 35 distinguishes observational import from replay and from causal experimental evidence.
- Statistical primary source, checked 2026-09-09:
  [Newcombe (1998), interval estimation for the difference between independent proportions](https://pubmed.ncbi.nlm.nih.gov/9595617/),
  DOI `10.1002/(SICI)1097-0258(19980430)17:8<873::AID-SIM779>3.0.CO;2-I`.
  Combines Wilson intervals for independent binomial proportions. The new PolicyArms API uses the
  uncorrected square-and-add form for fixed-propensity binary samples. It does not certify sample
  independence or convert missing/nonrandomized history into a treatment effect. The corpus effect
  and CI are unavailable. Existing Wilson 95% default is a statistical convention, not a tuned
  empirical threshold.

## Live outcome sensor — 2026-09-09

Local source and actual execution, no new external claims: `src/mind/outcome.sensor.ts`, production
calls in `src/core/agent.loop.ts`, string-array export in `src/telemetry/trace.ts`, and
`src/mind/learning.proof.ts`. Evidence and source hashes:
[`2026-09-09-live-learning/manifest.json`](evidence/2026-09-09-live-learning/manifest.json).
Two fresh controlled real-tool runs independently reopen with one resolved claim and nine
hash-valid SQLite events each. These are scripted actions with real file/shell execution, not
model-quality or policy-effect experiments. The raw diagnostic output, before/after state,
span links, source mutants and limitations are preserved. No archive was mined this run.

## Background learning execution — 2026-09-09

Source: `src/core/shell.tasks.ts`, `src/mind/background.evidence.ts`, the AgentLoop/BashTool origin
handoff, and `src/mind/epistemic.ledger.ts`. Preserved local evidence:
[background-learning manifest](evidence/2026-09-09-background-learning/manifest.json).
Five controlled real-tool runs were independently reopened: named failure (source/bundled) resolves
one captured claim; no-file failure, cancellation and an intervening write resolve none. A first
probe observed unchanged bytes/inode/mtime with changed ctime; its cause is unverified. The guard
therefore uses content hash, inode and modification time, not ctime. See record 37 for the exact
limitations, failed attempts, mutants and remaining Targets. No new external/platform claim.

## Computer Use return strategy — checked 2026-09-13

These sources support [record 46](../46_COMPUTER_USE_RETURN_AND_THREADS_STRATEGY.md), a Target strategy.
No benchmark score, current rival superiority or universal novelty claim is imported.

| Source | Inspected evidence | Bounded use |
|---|---|---|
| [Anthropic computer use documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | Host executes desktop tool calls; webpage-only tasks have a separate browser surface; observations can carry prompt injection | Separate browser/native execution and keep host authority; no Bimax performance inference |
| [Apple SCContentSharingPicker](https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker) | System-provided capture picker and stream selection configuration | Prefer supported system capture selection; minimum-OS and fallback qualification still required |
| [MCP tools, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Tool discovery/call contract and host control/security considerations | Generic capability seam; MCP is not an OS sandbox |
| [OSWorld-MCP](https://arxiv.org/abs/2510.24563) | Research benchmark studies tool invocation and GUI operations together | Evaluate hybrid routing; does not demonstrate a Bimax benefit |

Local evidence: current manager/storage/broker/supervisor/sandbox source hashes and six probes in
`../evidence/2026-09-13-threads-audit/results.json`; external archive at
`/Users/vishsiddharth/Developer/bimax-archive/`; native logical adapter and input interlock inspected.
Archive instructions disagree with actual external layout and historical package records. Current
source wins for this audit; native rebuild and provenance qualification remain Target.

## Feature ideation references — checked 2026-09-14

Owner-requested research for additional feature ideas. Inspected paper abstracts, official project
documentation and repository READMEs; no full-paper replication, code execution, license clearance,
or competitive evaluation. These are mechanisms to explore, not evidence of Bimax implementation,
market uniqueness or performance. All proposed combinations remain **Target**. Existing code-only
gates remain active; native observation/control proposals require a separate Desktop-owned slice.

| Primary source | Bounded evidence and proposed use |
|---|---|
| [DynaSaur paper](https://arxiv.org/abs/2411.01747), [official repository](https://github.com/adobe-research/dynasaur) | Dynamic programmatic action creation and reuse; inspiration for promoting tested task helpers into reusable personal capabilities. No automatic self-improvement or latency claim. |
| [Proactive Agent paper](https://arxiv.org/abs/2410.12361), [official repository](https://github.com/thunlp/ProactiveAgent) | Proactive task prediction and accepted/rejected assistance; inspiration for an opt-in repeated-friction detector. User acceptance and interruption cost need local evaluation. |
| [Pare](https://arxiv.org/abs/2604.00842) | Evaluates proactive assistants with simulated active users; supports testing intervention timing, not assuming that observation implies permission. |
| [Sketch-n-Sketch tutorial](https://ravichugh.github.io/sketch-n-sketch/tutorial/02.html), [repository](https://github.com/ravichugh/sketch-n-sketch) | Direct manipulation of computed output can imply multiple program updates; inspiration for constrained result-to-source editing with visible alternatives. General cross-app inversion is not established. |
| [AppWorld](https://arxiv.org/abs/2407.18901) | Controllable app environment for interactive coding-agent evaluation; inspiration for bounded rehearsal against fixture state, not a complete clone of a user's Mac. |
| [WebArena repository](https://github.com/web-arena-x/webarena), [Generative Agents](https://arxiv.org/abs/2304.03442) | Functional web-task evaluation and simulated behavior respectively; inspiration for synthetic exploratory testers. Such agents cannot certify real-user usability or conversion. |
| [Microsoft UFO](https://github.com/microsoft/UFO) | Desktop/device orchestration research reference; possible inspiration for cross-surface semantic handoff. Windows implementation is not a qualified Mac executor. |
| [Screenpipe](https://github.com/screenpipe/screenpipe) | Local computer-history infrastructure reference; inspiration for explicit, scoped task provenance. Continuous capture is not required or enabled by this proposal. |
| [Apple FastVLM](https://github.com/apple-aiml-research/ml-fastvlm) | Official vision-language implementation; candidate for bounded visual interpretation experiments. No Bimax device latency, energy, privacy or grounding claim follows. |

Guidance: product-reset README, product examples/frontend plan, Mac Buddy vision, record 46,
competitive README/rival studies/model-independent strategy/gap register, and acceptance gates.
The previously recorded missing capability matrix remains unresolved. Only this source ledger was
updated; no product capability or gap status changed. Verification: primary-source URL inspection
and review of the appended record; no runtime tests warranted for this documentation-only entry.

### Long-running agent follow-up — checked 2026-09-14

Inspected [Anthropic's Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
(published 2025-11-26). The article reports incremental work, explicit feature requirements,
persisted handoff artifacts and end-to-end browser checks as responses to context loss and premature
completion. It explicitly says compaction alone is insufficient. Use as support for evaluating
durable Bimax missions with independently checked milestones; it does not prove Bimax reliability,
general Mac automation, or that multiple agents outperform one. Proposed mission features remain
**Target**. Record 46's queue/restart/storage findings remain audit evidence, not newly reproduced
results. No runtime or product-status changes; verification was source inspection only. Existing
acceptance gates and the missing capability matrix/topology conflicts remain unresolved.


## RAG and context compiler research — checked 2026-09-14

See [record 47, research ledger](../47_RAG_AND_CONTEXT_COMPILER_UPGRADE.md#7-research-and-inspected-open-source-ledger)
for exact primary-source URLs, inspected paper versions, pinned code links, applicability and limits.
The research covers LongMemEval, HippoRAG 2, Recursive Language Models, Sufficient Context,
Lin–Bilmes submodular summarization, and Build Systems à la Carte verifying traces. Five upstream
repositories were inspected: HippoRAG, RLM, Aider, Graphiti and QMD. Their exact commits, file hashes
and license metadata are preserved in
[evidence manifest](evidence/2026-09-14-context-audit/upstream-index.json). No upstream code was
executed or incorporated. Paper benchmark results are not transferred to Bimax.

Local evidence: eight synthetic audit limitations reproduced under Bun, source hashes preserved;
56 existing focused tests passed. Initial Node FTS5 failures are retained as invalid SQLite probe
results. All compiler mechanisms remain **Target**, with no measured quality or competitive claim.
Guidance and unresolved missing capability-matrix/topology documentation are recorded in record 47.
