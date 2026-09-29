# 64 — The monolith: research, measurements, and the plan

**Date:** 2026-09-29 · **Status:** M1, M2 and M3 **Implemented and verified** (see "Progress" at the end — including an
M3 follow-up: the installed M3 build had its hang watchdog off, now fixed); M5 (the engine's public API and an
enforced boundary) **Implemented** — its `process.cwd()` half withdrawn on measurement; M4 and M6 **Target**. **Owner decision (2026-09-29):** "yes we need to go monolith … research on best monolith architecture
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
the `fs`/`child_process` parts of the shim are retired. *(This half was withdrawn on measurement — bundled
dependencies need the shim too; see Progress, M5.)*

**M6 — (Target, decide after M5) renderer ↔ engine direct ports** for streaming, as VS Code does, keeping approvals,
file access and the IPC gate in main.

## 8. Not decided here

- Whether sub-agents should stay nested workers or share their parent engine's isolate — measured in M1.
- The exact per-engine heap limit — M1 measures an engine's peak heap while indexing a large repository before a
  number is chosen, per `bimax-perf-constants-pinned-by-tests`.

## 9. Progress

### M1 — done 2026-09-29 (`4b028f7`, `b7c3a22`)

- `src/engine/worker.folder.ts` (first import of `src/index.ts`): an engine worker's own working folder —
  `process.cwd`/`chdir`, relative `fs`/`fs.promises` paths, `child_process` and `fs.glob` default `cwd`; symlink
  targets and fd calls untouched; `util.promisify` custom forms wrapped (a test caught `promisify(exec)` bypassing
  the folder). Default imports on purpose: `import * as fs` is a frozen namespace in the ESM bundle, which is how the
  first real-worker run failed while every unit test passed.
- **Sub-agents were broken in the packaged app before any of this**: the bundle has no `worker.entry.js` beside it,
  so they fell through to a `.ts` entry that cannot load there (and a dev run used a stale Sep 21 `dist/`). They now
  run the app's own bundle (`BIMAX_ENGINE_MODULE`) as a worker in their folder, under a 384 MB heap share.
- Heap limit chosen from a measurement, not by feel: one engine indexing this whole repository peaked at 128 MB used
  heap; `ENGINE_WORKER_HEAP_MB = 768`, and `MAX_LIVE_ENGINES × 768 ≤ 3 GB` is asserted by a test.
- Live, installed app with `BIMAX_ENGINE_TRANSPORT=worker`: no engine process; a real turn ("MONOLITH OK"); a shell
  tool call went through the approval card and ran `pwd && ls` in the task's folder.

### M2 — done 2026-09-29 (`411661a`)

- The worker thread is the default; `BIMAX_ENGINE_TRANSPORT=process` keeps the separate engine process for one
  release, `child` stays for bisecting. Development picks the newer of `dist/index.js` and the bundle.
- Live, installed default build: the project engine started as a worker thread, resumed its conversation, and ran
  `find src -type f | wc -l` in the right folder. **Not exercised live:** two engines at once inside the app (the ⌘2
  bar is a floating panel that scripted input could not reach), export, Organize. Several engines as workers were
  measured in the probe (§4), and each path is unit-tested.
- A failed build once proceeded to the install step and left `/Applications/Bimax.app` briefly missing; it was
  restored from the archive within the minute. The install step is now gated on the build's result.

### M3 — done 2026-09-29

- `src/protocol/port.host.ts`: one protocol message per port message; the app posts inbound messages as objects,
  the engine posts each outbound message as one JSON string (so the queue counts bytes exactly). Flow control by an
  acknowledged window (1 MB): the app acknowledges handled output per tick or every 64 KB; beyond the window the
  shared `WireQueue` holds output with its usual bounds, reserve and notices.
- `src/protocol/queued.host.ts`: the queue, notices and interrupt rule, shared by the stdio and port hosts — the stdio
  host is now only stream framing.
- The supervisor's engine handle takes message objects (`send(msg)`), and each transport encodes as it needs.
- Verified: the same engine events produce identical messages over the port and over stdio; congested + interrupted
  drops queued display output and acknowledges the stop; acks and junk are never taken for protocol; closing the port
  shuts the engine down. `verify-engine --worker` (real bundle, over the port): 5/5 and a live turn. 8 mutants, all
  killed. Full Jest: every suite passes except `extract.layout.routing`, which times out intermittently under load
  with and without these changes (each test ~0.5 s, an occasional hang past 5 s) — recorded, not fixed here.

### M3 follow-up — the hang watchdog was off in the installed app (found and fixed 2026-09-29)

- **Found in the live check of the M3 install, not by any test.** `engine.log` held the engine's `health` heartbeats
  and `boot` phases as plain log lines. Both were written straight to `process.stdout`, around the protocol host; over
  the M3 port a worker's stdout is only a log. So the supervisor never saw a heartbeat, and its hang detection arms
  only on the first one (`heartbeatSeen`): **a wedged engine would never have been restarted**, crash records carried
  no last heartbeat, and the app could show no start-up phase. Every M3 gate passed, because none asked for either
  message. Present in the installed build from `e3f4358` until this fix; the process transport was unaffected.
- Fix: the heartbeat goes through the host's queue (`send` on both hosts, `queued.host.ts`), so it takes the same
  channel and class as every other message in both transports. Boot phases, which come before the host exists, go on
  the worker's port (`postLifecycle`, `port.host.ts`) and are **counted** into the host's acknowledgement window, so
  the app acknowledging them never opens room the window did not give; once the host is live they take its queue.
- Gate: `verify-engine` now requires a `boot` and a `health` message on the protocol channel. Against the installed
  (pre-fix) engine as a worker it fails (`missing: boot, health`); the fixed bundle passes as a worker and as a
  process. Mutants: four in the hosts killed by unit tests; the heartbeat line alone, reverted and rebuilt, killed by
  `verify-engine --worker` (`missing: health`).
- Stated, not changed: inside a worker Node reports only process-wide `uptimeMs` and `rssMb`; the heartbeat's
  `heapMb` is the engine's own. The protocol type now says so.
- Checked and **not** a defect: two engines for the same folder four seconds apart in the log were two different
  conversations in that folder; the one left idle and off screen was stopped by the idle reaper after its 10 minutes.

### M5 — slice 1: one door into the engine, enforced (2026-09-29)

- `src/engine/api.ts` is the engine's public API: the worker contract (`EngineWorkerData`, `PORT_ACK`, `PortAck`,
  `DEFAULT_PORT_WINDOW_BYTES` — the app had the acknowledgement as a bare `'__ack'` string), the evidence record format
  and secret detection. The app's four imports of engine source now go through it or `src/protocol/protocol.ts`; the
  engine's own port host and worker folder take the contract from it too.
- `app/src/__tests__/module.boundaries.test.ts`, reading imports with the TypeScript parser (`import type`,
  `export … from`, `import()`, `require()`): the app reaches `src/` only through those two files; what they expose
  imports nothing further (Rollup cannot bundle the engine, so a re-export of an internal would break the app build or
  drag the engine in); the engine never imports Electron or the app; the window never imports main-process code.
  7 mutants (each kind of crossing, and two defects in the import reader), all killed.
- **Interpretation stated:** the plan said "the renderer never imports main". The window already takes the
  supervisor's wire shapes from main as **type-only** imports, deliberately, so they cannot drift (`global.d.ts`).
  Those compile to nothing and are allowed; a value import is forbidden.
- Verified: both type-checks, the related suites, the full Jest run (385 of 386 suites; `extract.layout.routing` timed
  out under load again — alone it failed once, 4/15, straight after the full run while the load average was ~5, then
  passed 15/15 four times; it imports only `src/documents/`, which this slice does not touch), the engine bundle rebuilt and `verify-engine`
  passing as a worker and as a process, the app's `electron-vite` build (its main bundle holds no engine module).
- ~~Still Target in M5: `process.cwd()` confined to one engine-context module, after which the `fs`/`child_process`
  parts of the worker-folder shim can be retired.~~ **Withdrawn on measurement (2026-09-29).** The built engine bundle
  holds 113 `process.cwd()` calls: 102 are ours, **11 are in 8 bundled dependencies** (dotenv 3, typescript 2,
  cross-spawn, which, rimraf, graceful-fs, zip-stream, archiver-utils), and dependencies also start child processes
  with no `cwd` (the MCP SDK's stdio transport through cross-spawn). Inside a worker only the shim makes those right,
  so the shim is permanent for as long as the engine runs in a worker, and moving our own 102 calls behind a wrapper
  would retire nothing and change nothing at run time. Not done. What keeps the shim honest instead: it is the first
  import of `src/index.ts`, it is unit-tested with mutants (M1), and `verify-engine`'s `folder` check runs the real
  bundle in a worker.

### M2 gate — several engines busy at once (measured 2026-09-29)

M2's gate asked for memory "measured again with several Bimax Threads busy, not idle"; until now only idle engines had
been measured (§4). Probe: `app/benchmarks/engines/busy-engines.probe.js`, the engine bundle built from `e441f3c`,
three engines started together, each on a **fresh** copy of this repository's `src/` (731 files) so each runs its
first AST index and code-index sync; 60 s per run, sampled every second; this Mac (8 GB, Electron 43). Two runs per
transport, alternating which went first.

| 3 engines, all indexing | Workers (monolith) run 1 / run 2 | Processes (fallback) run 1 / run 2 |
|---|---|---|
| Peak working set, whole app (MB) | **1,061 / 1,127** | 1,389 / 1,446 |
| Main (UI) thread event-loop delay: median of per-second p99 (ms) | 12.4 / 12.3 | 13.2 / 13.0 |
| Main thread: worst per-second p99 / worst single stall (ms) | 21.9 / 28 · 35.4 / 84.5 | 30.3 / 50.5 · 42.8 / 61.5 |
| Engine heap peak, each (MB) | 197–209 | 202–208 |
| Longest gap between an engine's heartbeats (s) | 3.3–3.9 · 5.4–5.5 | 5.4 · 4.8–5.1 |
| Engine `ping` round trip p95 / max (s) | 1.26–1.27 / 3.2 · 1.63–1.68 / 2.7 | 1.5–2.5 / 4.1 · 1.5–2.4 / 3.4 |

Read plainly:
- **Memory:** three busy engines as workers cost 22–24% less than as processes (~300 MB less), consistent with the
  idle measurement (§4). One busy engine alone: 558 MB working set, heap peak 204 MB.
- **The UI thread is not slowed by busy engines** in either transport: its median p99 stays at ~12 ms (the sampler's
  own resolution is 10 ms), the same as with one engine. The worst single stall in any run was 85 ms.
- **Engine responsiveness is the same in both transports.** A ping waits up to a few seconds while its engine does
  synchronous indexing work; that is the engine's own loop, not the channel.
- **The re-armed hang watchdog has margin:** the longest heartbeat gap under this load was 5.5 s against its 20 s idle
  limit. Not measured: a repository near the 12,000-file index cap, where a single engine's first sync is longest.
- Each engine's heap peaked near 200 MB, a quarter of its 768 MB limit.

Still not exercised live in the installed app: export, Organize and a ⌘2 task (the window does not take scripted
typing — only menu shortcuts reach it). These rows are one machine and two runs each: Measured, not a general claim.
