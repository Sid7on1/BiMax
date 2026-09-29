# 64 — The monolith: research, measurements, and the plan

**Date:** 2026-09-29 · **Status:** Research and plan. Phase M1 onward is **Target** until each phase's record says
otherwise. **Owner decision (2026-09-29):** "yes we need to go monolith … research on best monolith architecture
ever possible, then go beautifully into it." This answers flaw-list items B6–B12 and C19 (record 63).

## 1. What "monolith" should mean for Bimax

A monolith is **one codebase, one build, one deployable, one running program**, with strong boundaries *inside* it
instead of across processes. The research below (§3) is unanimous on two further points, and they decide the design:

1. **Nothing heavy runs on the UI thread.** Electron's own guidance: "Blocking the UI thread means that your entire
   app will freeze … For long running CPU-heavy tasks, make use of worker threads … or (as a last resort) spawn a
   dedicated process." Bimax's engine does long synchronous work (the first code-index sync of a large repository
   measured 38 s — `bimax-engine-crash-loop-large-repo`), so the engine on Electron's main thread would freeze every
   window. That option is rejected.
2. **A good monolith is modular.** Shopify's and Grzybek's "modular monolith": each module has a public API and
   private internals, and the boundaries are enforced by tooling, not goodwill.

So the target — the **Bimax modular monolith** — is:

```text
one Electron app · one build · Bimax's code in ONE OS process (the renderer stays Chromium's sandboxed process)
┌────────────────────────── Bimax process ──────────────────────────────────────────────┐
│ main thread: windows, menus, IPC gate, thread manager, supervisor — never engine work  │
│   │ typed messages (MessagePort, structured clone) — no NDJSON, no pipes               │
│   ├── engine worker ─ Bimax Thread A   (own V8 isolate: own module state, own folder)  │
│   ├── engine worker ─ Bimax Thread B                                                   │
│   └── …  each may start its own sub-agent workers (also inside this process)           │
└───────────────────────────────────────────────────────────────────────────────────────┘
      shells, git, MCP servers, the headless browser: still child processes (they are other programs)
```

An engine **worker thread** is not a process: it shares the process, its memory accounting and its crash fate, but it
has its own V8 isolate, so every module-level variable, singleton and the global `engineEvents` bus exist once *per
Bimax Thread* for free. That property is what makes a monolith possible without rewriting the engine (§5).

## 2. What exists today

- Each Bimax Thread (a ⌘2 task or a project window, `origin: 'project'`) runs its own engine in an Electron
  `utilityProcess` — a separate OS process (`app/src/main/engine.ts`). Commands go in over a MessagePort as NDJSON
  lines; events come out as NDJSON on a piped stdout through a bounded `WireQueue` (`src/protocol/stdio.host.ts`).
- The engine is this repository's `src/`, bundled by `bun build` to `app/engine/index.js` (22 MB) and packaged in
  `Resources/engine/` (record 55). It cannot be bundled by Rollup/Vite (`bimax-rollup-cannot-bundle-engine`), so it
  stays a separately built file even in the monolith; the worker loads that file.
- The protocol types are already shared source (`src/protocol/protocol.ts`, imported by the app), and the engine-side
  `ProtocolHost` is already transport-agnostic (it takes a `write` sink).
- Live engines are capped by a memory budget, `MAX_LIVE_ENGINES = 4`, lowered on machines with less free memory
  (`thread.manager.ts`); sub-agent workers have a CPU budget (`MAX_CONCURRENT_SUBAGENTS`).

## 3. Research (primary sources, fetched 2026-09-29)

| Source | What it establishes |
|---|---|
| [Electron — Performance](https://www.electronjs.org/docs/latest/tutorial/performance) | Don't block the main process; worker threads for CPU-heavy work; a dedicated process is the last resort |
| [Node.js — worker_threads](https://nodejs.org/api/worker_threads.html) | In a worker: `process.chdir()` is **not available**; `process.env` is a per-worker copy; `process.exit()` ends only that thread; signals are **not delivered**; an uncaught exception emits `'error'` and terminates only the worker; `resourceLimits` terminate the worker when exceeded, "even if these limits are set, the process may still abort if it encounters a global out-of-memory situation"; `stdin`/`stdout` can be piped by the parent |
| [Electron — V8 memory cage](https://www.electronjs.org/blog/v8-memory-cage) | Electron enables pointer compression (since 14): "the V8 heap is limited to a maximum size of 4GB" |
| [V8 — Pointer compression](https://v8.dev/blog/pointer-compression), [Node #55735](https://github.com/nodejs/node/issues/55735) | Chromium builds use a **shared cage**: every isolate in a process shares one 4 GB cage, so main + all engine workers together have 4 GB of JS heap |
| [VS Code — sandbox migration](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox) | VS Code keeps extensions in a `utilityProcess` for crash isolation because extensions are **third-party** code that spawns processes; renderer ↔ extension host talk over MessagePorts, bypassing main |
| [Zed architecture](https://deepwiki.com/zed-industries/zed/2-core-architecture) | A true single-process editor: one foreground UI thread plus background executors; only *other programs* (language servers) run out of process |
| [Shopify — Packwerk](https://shopify.engineering/enforcing-modularity-rails-apps-packwerk) | Modular monolith: each package exposes a public API; dependency and privacy violations are checked by a tool |

Reading them together: VS Code isolates code it does not own; Zed runs code it owns in-process and isolates only
foreign programs. Bimax's engine is first-party code with **no native add-ons** (§5), which puts it on Zed's side of
that line — as long as it stays off the UI thread.

## 4. Measured on this Mac (M-series, 8 GB, Electron 43), the shipped engine bundle

Probe: the real `app/engine/index.js`, started either as today's `utilityProcess` or as a `worker_thread` in Electron's
main process, answering `ping`, `configGet`, `catalogGet` and an `@`-file query. Working-set memory from
`app.getAppMetrics()`; engines idle after boot (heap under load is not measured here).

| Engines | Today (processes): total MB | Monolith (workers): total MB | Ready (ms) process / worker | All four answered (ms) process / worker |
|---|---|---|---|---|
| 1 | 367 | 326 | 517 / 471 | 877 / 653 |
| 3 (run 1) | 791 | 521 | 476–526 / 465–485 | 721–809 / 644–687 |
| 3 (run 2) | 649 | 494 | 436–509 / 459–482 | 723–756 / 667–699 |

The first engine worker costs ~220 MB; each further one ~70–100 MB, against ~250 MB per engine process (idle
processes shrink under macOS memory compression, which is why run 1 and run 2 differ). Boot time is unchanged; the
round trip is ~15–25% faster.

**The one correctness failure the probe found:** a worker cannot `chdir`, so the engine silently ran in the app's
folder — the `@`-file query returned nothing. With a boot shim that gives each worker its own working folder
(`process.cwd`/`chdir`, relative `fs` paths, the default `cwd` of child processes), the query returned the task's file.

## 5. Code audit (engine `src/`, excluding tests)

- **No native add-ons** in the engine's dependencies (none ships a `.node` file), so a worker cannot bring the process
  down through native code; its SQLite is Electron's built-in `node:sqlite`.
- Process-global state: `process.cwd()` ×105, `process.chdir` ×4, module-level `let` ×98, `getX()` singletons ×45,
  the global `engineEvents` bus in 58 files, `process.env` writes ×21. One engine instance serving several Bimax
  Threads would need all of it rewritten; one isolate per Bimax Thread needs none of it rewritten.
- `process.exit` ×9 (ends only the worker — correct), signal handlers in `shutdown.coordinator.ts` (not delivered in a
  worker: shutdown must be a message), uncaught-exception handlers in `src/index.ts` (work per worker).
- The engine starts its own sub-agent workers (`subagent.manager.ts`); inside the monolith those are nested workers in
  the same process and need the same working-folder shim and a share of the heap budget.

## 6. What the monolith gives up, stated plainly

- **A native crash or a process-wide out-of-memory ends every Bimax Thread and the window**, where today it ends one
  engine. Mitigations: the engine has no native add-ons (kept true by a test), each worker gets `resourceLimits`
  (a worker over its heap is terminated, not the app), and the sum of those limits stays under the shared 4 GB cage.
- **4 GB of JS heap for everything in the process.** Main (~50–100 MB) + up to 4 engines + their sub-agents must fit.
- **Activity Monitor shows one larger Bimax** instead of helpers. Total memory goes down (§4).
- A runaway loop in an engine is still stoppable: `worker.terminate()` interrupts running JavaScript, so the
  supervisor's watchdog keeps working.

## 7. The plan — phases with exit gates

Each phase is its own commit series with tests and mutants, the full suites, and a live check in the installed app.
Nothing is deleted before its replacement has been the default and verified; removed code goes to
`~/Developer/bimax-archive`.

**M1 — The engine runs as a worker thread (behind `BIMAX_ENGINE_TRANSPORT=worker`).**
`src/engine/worker.boot.ts`: the per-worker working folder (cwd/chdir, relative `fs` paths, child-process `cwd`),
installed before the engine loads, applied to sub-agent workers too. `app/src/main/engine.ts`: a `worker` transport —
`new Worker(boot, { workerData, env, resourceLimits, stdin, stdout })`, NDJSON unchanged so every protocol test still
applies; `'error'`/`'exit'` reported to the supervisor like a process exit; shutdown by closing stdin, then
`terminate()` after a grace period. A heap budget (`ENGINE_HEAP_MB`, sum ≤ ~3 GB with the sub-agent share) named as a
**memory** cap per AGENTS.md. Gate: `verify-engine` passes in worker mode; the probe's `@`-query finds the task's
file; shim unit tests (relative read/write, `chdir`, child `cwd`, symlink target left relative); full suites; installed
app opens a project and runs a real turn in worker mode.

**M2 — Workers become the default.** Flip the default after M1's live check; `utilityProcess` stays selectable for
one release as the fallback. Gate: installed-app turn, export, Organize and a ⌘2 task in worker mode; memory measured
again with several Bimax Threads busy, not idle.

**M3 — Typed messages instead of NDJSON.** The worker's `ProtocolHost` writes objects to a MessagePort
(structured clone) and reads objects from it; `app/src/main/engine.ts` exposes a typed `EngineClient`. `WireQueue`'s
bounds survive as credit-based flow control (the main thread acknowledges; bulk output pauses when credits run out;
approvals and lifecycle keep their reserved capacity). Gate: the transcript for a scripted session is identical under
both encodings; an interrupt under congestion is acknowledged as fast as today; malformed-message handling is tested.

**M4 — The process world is removed.** Archive the `utilityProcess` and child-process transports, `stdio.host.ts`,
the NDJSON codec on this path, the stdin-driven shutdown in `headless.entry.ts` and `BIMAX_ENGINE_TRANSPORT`; rename
"engine process" to "engine worker" in code, UI and docs. Flaw-list B6–B12 and C19 close here. Gate: packaging gates,
`verify-engine` (worker), full suites, installed-app journeys.

**M5 — Boundaries that hold.** The engine gets one public entry (`src/engine/api.ts`: start, the typed client
contract, types) and the app may import only that and the protocol types; `src/` never imports `electron`; the
renderer never imports main. Enforced by a dependency test in CI (Packwerk's idea, without a new dependency).
`process.cwd()` is allowed only in one engine-context module; call sites move to it in slices, and when none are left
the `fs`/`child_process` parts of the shim are retired.

**M6 — (Target, decide after M5) renderer ↔ engine direct ports** for streaming, as VS Code does, keeping approvals,
file access and the IPC gate in main.

## 8. Not decided here

- Whether sub-agents should stay nested workers or share their parent engine's isolate — measured in M1.
- The exact per-engine heap limit — M1 measures an engine's peak heap while indexing a large repository before a
  number is chosen, per `bimax-perf-constants-pinned-by-tests`.
