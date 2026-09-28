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
