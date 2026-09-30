# 63 — Master flaw list: triage and fixes

The list below the line is the 2026-09-28 read-only audit, kept verbatim. This section records what checking it against
the code found and what was done, starting 2026-09-29 on `feat/sovereign-retrieval-and-layout-extraction`. Status words
follow `competitive/README.md`: everything here is **Implemented and locally verified** unless it says otherwise; none
of it is Measured on a live provider or in the installed app yet.

## What the check found

About a third of the list does not hold against the current code, and some of it describes the product before
record 55 (the engine inside Electron):

- **A1 "sandbox off by default" — not a flaw in the app.** Every engine the app starts is a Bimax Thread, the main
  project window included (`startEngine` → `threads.create(root, '', 'project')`), and every Thread engine gets
  `BIMAX_THREAD_ROOT`, which switches the sandbox on (`isSandboxEnabled`). Writes are held to the folder; reads and
  network stay open as record 54 states. Only an engine run by hand outside the app has it off.
- **A2/A4 `POST /events` and JWT-in-query** lived in `src/api/webhook.receiver.ts`, which nothing has booted since
  2026-06-19 and nothing imported. Removed, not patched: the engine opens no inbound port.
- **B6–B12 (headless-engine costs)** are mostly stale: since record 55 there is one app, the engine is built from this
  repository and hosted in a `utilityProcess`, and the app imports the protocol types directly, so a contract change
  breaks the typecheck instead of drifting. What remains true is a process boundary with NDJSON over it, and a supervisor.
- **C20–C23 "duplicates"** are separate jobs with similar names: the model catalogue (`models.ts`), the provider and
  key pool (`provider.ts`), message types (`llm.provider.ts`), quick-vs-work tier (`model.router.ts`), picture-vs-text
  slot (`task.router.ts`); the settings file (`config.ts`) vs the credential file (`env.loader.ts`); the transcript
  writer vs resume vs the store. Nothing was merged. Two folders next to them were simply dead (below).
- **D33** the notch and voice helpers are not committed (`app/.gitignore` has `/voice/` and `/notch/`).
- **D35 `app/src/phase9/`** is live: `App.tsx`, `main/index.ts`, `main/engine.ts`, Settings and Machine Health use it.
- **D36 `app/design-preview/`** is the UI check harness (`npm run check:design-preview`), not a shadow app.
- **E40** there are no empty `catch {}` blocks; there are 415 catches holding only a comment. Most are deliberate
  best-effort observers, so they were not blanket-logged; the named ones were fixed.
- **G49** `docs/DEVELOPER_ID_RELEASE.md` is the live runbook: record 59 found Developer ID is required for the App
  Intents extension to register, not only for Gatekeeper. **G51** God's Land is the owner's current notch feature.

## Done

| Item | Result | Commit |
|---|---|---|
| A2, A4 | `src/api/` archived; `express`, `express-rate-limit` dropped | `a4d827d`, `7a7b3b6` |
| A3 | One secret rule set (gitleaks port + NVIDIA + URL password + plain `sk-…` provider keys) in `src/security/secret.scan.ts`, shared by the app's notch and the engine. The engine scrubs the session transcript, archived tool output, mind episodes, the agent log, the execution ledger and the crash log before they reach disk; the live turn is untouched. Pattern-based: a secret of a shape no rule knows still passes | `4e224d8` |
| A5 | Web and MCP output reaches the model inside `<untrusted source="…">`, explained in the system prompt; fence look-alikes in the text are renamed. One channel list drives the fence and the existing taint cut, which stays the enforcement | `6f2a02c` |
| E40 | `base.persona.ts`: fifteen silent stanzas → one table; a failing block is left out and logged once. Pictures that cannot be attached say why | `06d0bb9` |
| D30–D32, D34, D37–D39, C25, C27, G46–G48, G50 (part), H55 (part), H58 | Moved to `~/Developer/bimax-archive` at their repo paths, `cmp`-verified; `SECURITY_INSTALL.md` and the gap register updated for the retired manual-alpha channel | `a4d827d`, `d2357f7` |
| C20–C23 (dead parts) | `src/config/` (EnvValidator) and `src/auth/` (CLI login) had no importers; archived with `ensureJwtSecret` and `jsonwebtoken` | `868ee7b` |

**Found on the way, not on the list:**
- The daily-journal prompt block (PR4) was built every turn and placed in no prompt segment, so it never reached the
  model, while its policy arm logged decisions for it. Now in the turn context; a test fails if any built section is
  left unplaced (`06d0bb9`).
- The execution ledger's prefix rule had no word boundary: "task-runner-20260929" was stored as "ta[redacted]" (`4e224d8`).
- `fatal-crash.log` was written into the working directory, i.e. the person's project folder (`4e224d8`).
- Saving any key rewrote `~/.breakglass/.env` from `dotenv.parse`, erasing every comment and re-writing quoted values
  bare; it now changes one line (`aa53e49`).

**Verification that ran:** engine and app `tsc --noEmit`, engine `bun build`, app `electron-vite build`; new tests
(9 redaction, 13 fence incl. one through the real `AgentLoop`, 3 prompt-block, 1 image-reason, 4 env-line); 30
mutants across the five fixes, all killed (three survived first and got a test each); related suites green (34 suites /
413 tests around the writers, 20 / 138 around the loop, persona and taint, 9 / 122 persona and multimodal). The full
Jest suite was not run in this pass. Nothing has been exercised in the installed app yet.

**C13, `app/src/main/index.ts` (3,186 → 2,724 lines, in progress).** Six slices, each behaviour-neutral, each with
the first tests its code ever had: `conversation.share.ts` (N4 export/share), `workspace.ipc.ts` (git, files, editor
save, sessions, terminal), `organize.window.ts` (FL2/FL3), `night.runner.ts` (FL5), `schedule.runner.ts` (repeating
tasks), `diagnostics.ipc.ts` (supervisor, diagnostics export, evidence). Modules register channels through an `IpcGate`
(`ipc.gate.ts`) built from `secureHandle`/`secureOn`, and the guarded-channel security test now scans every
main-process file (it read only `index.ts`) and requires every `register*Ipc` call to get exactly that gate. Also:
start-up had no `.catch()`, so a throw left a windowless app with no reason; it now shows the error and writes
`<userData>/startup-error.log` (`d01cdbb`). App suite 896 → 918 tests, all passing.

**Installed 2026-09-29** from `d01cdbb` with `build-local-mac.sh` (four package gates PASS, 3 App Intents actions,
`codesign --verify --deep --strict` ok, bundled engine byte-identical to `app/engine/index.js`); the previous app
(built from the retired Hindsight branch) is at `~/Developer/bimax-archive/apps/Bimax.app.before-flawlist-20260929`.
Live: a window in ~1 s, no start-up error, the welcome screen's recent projects listed; opening a project through ⌘O
started its engine, which indexed the folder, and the Files panel listed it through the moved `workspace.ipc.ts`.
Not exercised live: a model turn, export/share, Organize, a night shift or a schedule run (each is unit-tested).

**God files split, 2026-09-30.** Each split moves code as is, and each got tests for the parts it made; mutants were
run against every split and the survivors got a test. Not rebuilt or installed since.

| Item | Result | Commit |
|---|---|---|
| C15, E41, E42 (part) | `llm.adapter.ts` 1,442 → 1,016: `chat.stream.reader.ts`, `llm.errors.ts` (the adapter's own errors are types; the key pool asks the error instead of matching its wording), `provider.quirks.ts`. The three copies of the key/budget/error bookkeeping had drifted (one leaked a budget reservation); one `completeOnce()` now. Three unused completions archived | `9d5f9e9` |
| C14 | `agent.loop.ts` 1,565 → 1,113: the 1,230-line `execute()` is a sequence of named phases; `agent.run.state.ts`, `agent.tool.round.ts`, `tool.outcome.observers.ts` | `0ac64c1` |
| C19 | `headless.entry.ts` 799 → 204: six parts (recovery, continuation, handlers, heartbeat, boot, onboarding), each returning its stop. Split, not deleted: record 64 found it is the session wiring the monolith still needs. The onboarding's `graph_changed` listener was never removed; it is now | `68f0505`, `1f91775` |
| C16, E43 (the `send()` example) | `thread.manager.ts` 1,154 → 1,020: `thread.budget.ts` (the live-engine memory budget, the idle TTL, and the one rule for which idle engine may be stopped, now a plain function) and `thread.environment.ts` (what a Thread's engine starts with). `receive()` and `send()` are named steps (`holdApproval`, `takeReply`, `cancelTurn`, …). Nothing had tested that an approval reply with a wrong token or an unoffered choice is refused; `thread.parts.test.ts` does (10 tests, 20 mutants killed; app suite 107 suites / 932 tests) | `7e1328d` |
| C24, C26, C28, C29 | No load-time import cycles left, with a test; the dead Docker plugin pipeline and `Dockerfile` archived and `dockerode` dropped; `tdm.ts` moved to `src/mind/`; `src/compliance/` verified live and kept | `db70a49` |

**Owner reports, 2026-09-30 — three defects found in use, not on the list.** Built and installed the same day
(`build-local-mac.sh`: engine bundle answered 7/7, four package gates PASS, `codesign --verify --deep --strict` ok,
the three fixes' strings confirmed inside the shipped `app.asar` and engine bundle; the window opened in 5 s). None of
the three has been exercised by hand in the installed app yet.

| Report | Cause | Fix | Commit |
|---|---|---|---|
| A tool's permission was asked twice, and one card stayed on screen whatever was clicked | A project's question showed as the main window's card and in the approval popup. Each window keeps its own copy of the thread's state and closed only a card it answered itself; the other card's Allow/Deny were refused as expired | The thread manager tells every view when a question closes (`request_closed`), however it closed; the popup leaves out questions the main window or the ⌘2 bar is already asking; a refused reply re-checks and closes a dead card | `04ba29f` |
| The Copy buttons (code block, whole reply) did nothing | `navigator.clipboard` needs a permission the app refuses to every page (`isAllowedPermission` is false by design), and the rejection was never caught | The permission lockdown stays; copying goes through a guarded main-process channel (`clipboard:write-text`) | `9e2990b` |
| In a folder with one lab brief, "check what to do?" got "what would you like me to check?" | The prompt gave the folder's path, never its contents | The folder's top level (brief-like files first) rides in the per-turn context, with the rule that a vague message is about those files | `05c7cd9` |

## Open

- **C13, C17, C18 god files** — `main/index.ts` continues (the Bimax Threads channels, voice/talk, tray, notch remain);
  `ModelDialog.tsx` and `ThreadSurfaces.tsx` not started.
- **B6–B12 — the monolith, decided and built (record 64).** The owner chose it on 2026-09-29; M1–M5 are done and
  M4 (2026-09-30) removed the separate engine process and the stdin/stdout protocol. Closed: B6, B10, B11; mostly
  B8; smaller: B9 (a worker can still crash or hang, so the supervisor stays) and B12 (the process is gone, the
  bundle file stays because Rollup cannot bundle the engine). **Still open: B7** (the window still mirrors the
  engine's state). M6, direct window ↔ engine ports, was declined by the owner as a security compromise.
- E42's other examples (`vector.store.ts`, `outcome.manager.ts`, the paste pipeline), E43's other callbacks (`talk:start`,
  the JSX keyboard chains), E44, G52, H53–H54, H56 — not started. H57 is used by two files and was left. I59–I61
  are storage outside the repo.
- Acceptance gate 08 ("provider secrets … never appear in … logs"): advanced for key shapes the rules know; a full
  proof would need every writer and the app's diagnostics under one test, which does not exist yet.

---

# Bimax — Master Flaw List
Compiled 2026-09-28. Read-only audits of `/Users/vishsiddharth/Bimax` (the real repo).
Sid's direction: **desktop app only, monolith architecture** (no Go TUI, no headless engine).

---

## A. Security — launch blockers

1. **Sandbox is off by default** — `src/sandbox/exec.sandbox.ts`. With it disabled, `bash.tool.ts` runs model-generated commands with ambient user authority. Seatbelt/bwrap exist but are opt-in.
2. **Unauthenticated `POST /events`** — `src/api/webhook.receiver.ts`. Rate-limited and schema-validated, but not authenticated before emitting to the internal event bus. Other endpoints are JWT-gated.
3. **No systematic secret redaction** — commands and tool I/O may be logged/persisted; SSE can broadcast system logs. (Secrets *storage* itself is fine: `env.loader.ts` uses restrictive permissions, refuses symlinks, avoids logging values.)
4. **JWT accepted via URL query parameter** — `webhook.receiver.ts`. Tokens leak through request logs.
5. **No uniform untrusted-content tagging framework** — prompt-injection defences exist in isolated spots, but web/tool output has no consistent tagging.

## B. Architecture — headless engine downsides

6. **IPC latency on every interaction** — everything crosses a process boundary as NDJSON over stdio: serialize, pipe, parse, repeat. Framing overhead + backpressure complexity.
7. **Two things to keep in sync** — engine owns state, UI mirrors it. Stale views and race conditions are a whole bug category a monolith doesn't have.
8. **The protocol is a product** — wire protocol must be designed, versioned, debugged. App v1.2 vs engine v1.1 must fail gracefully. Logs live in two processes.
9. **Crash handling is real work** — dead engine = UI hanging on a dead pipe. Needs supervisors, restarts, health checks, startup handshake. Slower cold start.
10. **Two binaries to ship and version** — they must find each other on the user's machine and agree on versions. Worsens the unsigned-Mac-app + Homebrew distribution problem.
11. **IPC surface is attack surface** — flaw #2 (`POST /events` → event bus) is this tax made concrete.
12. **Installed app confirms headless** — `/Applications/Bimax.app/Contents/Resources/engine/index.js` (22 MB) is a separate bundled process the Electron app spawns. A monolith would not have this folder.

## C. Code structure — god files and duplication

13. `app/src/main/index.ts` — **3,186 lines**. App entry + tray menu + IPC registry + window manager + notch/clipboard/voice/talk wiring. Import block alone pulls ~55 modules. **This is the file the monolith migration must operate on.**
14. `src/core/agent.loop.ts` — **1,563 lines**. Stream dispatch + truncation recovery + context-overflow state machine + completion gates + empty-turn nudges.
15. `src/core/llm.adapter.ts` — **1,394 lines**. Cost math + error taxonomy + status mapping + message rewriting + chat orchestration — *after* a partial extraction.
16. `app/src/main/thread.manager.ts` — **1,154 lines**. Thread CRUD + IPC dispatch + eviction policy.
17. `app/.../components/ModelDialog.tsx` — **1,068 lines**. Model picker + provider API-key CRUD + thinking-budget UI.
18. `app/.../components/ThreadSurfaces.tsx` — **1,007 lines**. God component `ThreadQuickBar` owns prompt state, submit, paste, screenshot, history, dictation, talk, folder chooser, teaching rules.
19. `src/protocol/headless.entry.ts` — **803 lines**, with `startHeadless()` as one ~750-line function. **Monolith note: delete, don't split.**
20. **Model routing in four files** — `src/engine/model.router.ts` vs `src/engine/models.ts` vs `src/engine/provider.ts` vs `src/core/llm.provider.ts`. Four answers to "which model handles this."
21. **Config in three places** — `src/engine/config.ts` (26 KB) vs `src/config/env.validator.ts` vs `src/engine/env.loader.ts`.
22. **Session logic split three ways** — `src/engine/session.ts` vs `session.resume.ts` vs `session.recorder.ts` (two ~5 KB satellites of a 7.7 KB core).
23. **Three routers** — `src/engine/agentRouter.ts` vs `task.router.ts` vs `model.router.ts`. Routing fractured by noun.
24. **Module-level mutable singletons as hidden wiring** — `src/memory/context.manager.ts:36` (`let _graphStore` with global accessors); `src/outcome/outcome.manager.ts:845` (`let manager` + `startOutcomeManager`). These *create* the circular imports that `agent.loop.ts:~1504` works around with an inline `require()`.
25. **Two generations of icon tooling** — `make-icon.legacy-mark.mjs` + `make-icon.py` vs `make-app-icon-assets.mjs`. The filename literally says "legacy."
26. `src/substrate/` — a top-level module containing a single 8.4 KB file (`tdm.ts`). Fold into `src/mind/` or `src/core/`.
27. `src/genome/` — `components.json` references `src/memory/context.engine.ts`, which **does not exist**. Stale manifest next to `contracts.json`/`permissions.json`/`pattern.store.ts` that nothing visibly consumes.
28. `Dockerfile` (Jun 24) with `dockerode` still a production dependency — needs one explicit yes/no for the desktop-only plan.
29. `src/compliance/` untouched since Sep 9, `src/credits/` partially so — compliance/licensing scaffolding with no evidence it's wired into the desktop flow. Verify or remove.

## D. Dead code — ghosts of killed features

30. `src/evolution/` — **empty directory**, committed. A module never built, or deleted leaving the husk.
31. **Go TUI is 100% gone, residue remains** — zero `.go` files in the repo, yet `src/engine/themes/` ships 5 terminal color themes (catppuccin, dracula, gruvbox, nord, bimax) for a terminal UI that no longer exists. `src/core/container.ts` header still says it "wires the dependency graph for the TUI."
32. `app/electron.vite.focus.config.ts` — builds `src/focus-harness/main.ts`, which **doesn't exist**. `npm run build:focus-harness` is broken by construction; the `out-focus/` scaffolding is dead.
33. **Committed binaries** — `app/notch/bimax-notch` (1.59 MB) and `app/voice/bimax-voice` (263 KB). Regenerated every release by `build-notch.sh`/`build-voice.sh`; don't belong in version control.
34. `app/src/main/cdp.stealth.bridge.ts` — CDP stealth bridge orphaned when `src/browser/` was deleted in the 2026-09-02 reset. No browser left to drive.
35. `app/src/phase9/` — dead ML experiment (7 files: `ml.alchemist.ts`, `anomaly.ranker.ts`, `simulator.adapters.ts`, `capability.worker.process.ts`, `process.provenance.ts`, `workspace.capabilities.ts`, `adaptive.policy.ts` + `usePhase9.ts` hook). Untouched since 2026-08-15, named after a phased rollout that ended.
36. `app/design-preview/` — shadow UI (`chat.tsx`, `lab.tsx`, `workbench.tsx`, `models.tsx`, `motion.tsx`, `transcript.tsx`) with its own `vite.config.ts` and `dist/`, duplicating the real renderer's views.
37. **Dead release pipeline** — `app/scripts/create-manual-alpha-release.mjs`, `install-manual-alpha.mjs`, `test-manual-alpha-release.mjs`, `verify-manual-alpha-release.mjs`, `install-on-target-mac.sh` (all Sep 11). Superseded by electron-builder `dist:mac`, never removed.
38. `skills-lock.json` at repo root (Jul 11) — stale, not covered by `.gitignore`.
39. `.gitignore` references `tui/embed/bimax-desktop-helper`, but `tui/` **doesn't exist** at the repo root. Stale ignore entry.

## E. Code quality patterns — the recurring diseases

40. **Silent failure as the default error policy.** Bare `catch {}` in all 24 sampled files. Worst: `src/engine/personas/base.persona.ts:~282–352` — 15 identical try/catch stanzas where a broken mind subsystem degrades the prompt with zero log output, indistinguishable from working. Also `multimodal.ts:52` (`catch { return null; }` discards the fs failure reason), `Composer.tsx:327` (`.catch(() => '')` lies about stashing).
41. **Failures typed as nothing, handled by string-scraping** — `catch (e: any)` everywhere plus message-regex classification (e.g. `/sent no (first token|response headers)/` in `llm.adapter.ts:~1376`). Brittle and invisible.
42. **Copy-pasted stanza shapes inside files** — the 15 stanzas in `base.persona.ts` (a table + one loop deletes ~50 lines); `vector.store.ts:~665/~690` (same nested doc/chunk scan twice in `backfillEmbeddings`); `outcome.manager.ts:808–844` (~35-field hand-written `Math.max(1, Number(x) || default)` coercion instead of a `num()` helper); `JSON.parse(JSON.stringify(…))` deep-clone idiom in three methods; paste pipeline hand-duplicated between `ThreadSurfaces` and `Composer.tsx:325–361`.
43. **Long anonymous multi-layer callbacks** — `main/index.ts:2408` (`secureHandle('talk:start', …)` is a ~45-line anonymous callback); `thread.manager.ts:724–757` (`send()` mixes validation + approval checks + mutation + IPC forwarding); 25–35-line inline keyboard-dispatch chains in JSX (`ThreadSurfaces.tsx:410–418`, `Composer.tsx:367–393`). Anonymous and untestable.
44. **Test bloat** — `app/src/__tests__/desktop.supervisor.test.ts` is **895 lines** (testing too much in one place / inline fixtures); `notch.deck.test.ts` 531. Rest are large but defensible.

## F. File-length distribution (577 non-test source files)

45. **>2,000 lines: 1 file** (`main/index.ts`). **>1,000: 6 files. >500: 34 files (~6%). >300: ~87 files (~15%).** Median ≈ 110 lines, p90 ≈ 386. The typical file is healthy; the heavy tail holds the debt.

## G. Docs — graveyard of abandoned directions

46. CLI-era docs for the abandoned path: `docs/MASTER_CLI.md` (35 KB), `CLI_V1_RELEASE.md`, `MASTER_REBUILD_PLAN.md`, `ENGINEERING_LOG_CLI_RECOVERY.md`.
47. TUI decision docs for the dropped Go TUI: `docs/ENGINE_TUI_COMPARISON.md`, `ADR-001-TUI-RENDERER.md`.
48. Website docs in the engine repo for a site that moved out: five `docs/SITE_*` files + `BIMAX_LIVING_SITE_BRIEF.md` + `CLAUDE_SITE_BUILD_PROMPT.md`.
49. `docs/DEVELOPER_ID_RELEASE.md` — release plan built around Apple signing Sid can't afford.
50. Stale reports: `docs/BIMAX_UPSTREAM_HARVEST_PLAN_2026-08-02.md` (36 KB), `BACKEND_STABILIZATION_REPORT.md`, `INFRA_2026_BACKLOG.md`, `UPGRADE_2026_RESEARCH.md`.
51. `docs/product-reset/gods-land/` — a separate notch app's product docs living inside the engine repo.
52. Public `README.md` is ~3.4 KB despite the deep internal architecture — not a real onboarding page.

## H. Working-tree litter (gitignored but present)

53. `build/`, `dist/`, `coverage/`, `runs/`, `jobs/`, `benchmarks/`, `media-masters/` — hundreds of MB of regenerable output sitting in the working tree.
54. `vendor/` — vendored deps (`codebase-memory`, `headroom`) instead of proper dependencies.
55. `scripts/` phase scaffolding — `phase7/8/9-local-gate.sh`, `p01-harness-selfcheck.ts`, `__pycache__/`.
56. `app/src/renderer/src/styles.css` — 98 KB in a single file, no splitting.
57. `app/src/renderer/src/useEngineDomain.ts` — 245-byte stub hook. Inline it or finish it.
58. `postinstall` writes under `~/.breakglass` — will worry security-conscious users.

## I. Folder zoo (outside the repo — storage, not source of truth)

59. `~/Desktop/DEV/Bimax` — a folder literally named **"untitled folder"**, plus BiMaxIOS, BiMaxIDE, BimaxApk, ink-bimax, BIMAX-GUI, Bimax-Share, BiMaxCloud, `bimax-veo-frames`, `Context OS Bimax`, `Bimax-backup-2026-08-10`, and `Bimax-old-copy-2026-09-14.zip` (1.41 GB).
60. `~/Developer` — `Bimax.stale-2026-08-10`, `bimax-archive`, another full `Bimax` folder, `bimax-research` carrying an entire Python venv (`laya-env`).
61. `front inspo` — a folder **with a space in the name** in the repo root.

---

## Suggested kill order (safe → needs judgment)

1. `src/evolution/` (empty), stale `.gitignore` tui entry, `skills-lock.json`
2. Committed binaries (`app/notch/bimax-notch`, `app/voice/bimax-voice`) → gitignore them
3. Dead configs: focus-harness build config, manual-alpha release scripts
4. Dead features: `app/src/phase9/`, `app/design-preview/`, `cdp.stealth.bridge.ts`, terminal themes, TUI comment in `container.ts`
5. Stale docs (section G) → archive to one `docs/archive/` or delete
6. Duplication merges (section C, items 20–23) — needs care
7. God-file splits: `main/index.ts`, `agent.loop.ts`, `llm.adapter.ts` — biggest work
8. Silent `catch {}` pass — add logging, starting with `base.persona.ts`
9. Security blockers (section A) — before any public launch
10. Monolith migration — deletes `headless.entry.ts`, stdio transport, `Resources/engine/` packaging; rewires `main/index.ts` + `main/engine.ts` to direct imports
