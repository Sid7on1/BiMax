# Computer Use return and Bimax Threads assessment

Date: 2026-09-13. Status: source-grounded strategy and local audit; proposed capabilities are **Target**.
The owner requested strategic analysis, implementation recommendations, novel features and an
assessment of existing Threads. This record does not activate Computer Use or change release gates.

## Recommendation

Bring Computer Use back as an optional capability of a Bimax Desktop task. Make Threads the durable
unit of work across files, code, browser and selected Mac apps. Keep the current Desktop + engine
product shape; restoring CU does not require restoring the Terminal product, website or old UI.
The generic engine must not become a macOS permission owner.

The strongest first promise is: **Bimax changes your code, runs the exact build, uses the app, and
shows whether the requested behavior actually works.** This already has a concrete contract in X01.
For general work, the same machinery connects a generated file to the application where it must be
used: create a report, open it, verify rendering, prepare its destination, then perform only the
authorized delivery. Basic folder organization and file generation should keep using file tools.

Computer Use earns its complexity when the outcome crosses an app boundary that existing tools
cannot cover. A generic screenshot/click assistant is a weak launch identity. The durable task,
fresh verification and respectful resource ownership are the proposed differentiation; no market
uniqueness or competitive Win is established here.

## What exists and what moved

| Surface | Inspected current fact | Consequence |
|---|---|---|
| Active product | Root README and package manifests describe one Electron Desktop app plus the engine | Do not reinstate a second frontend merely to restore CU |
| Archive | `/Users/vishsiddharth/Developer/bimax-archive/` contains `native/BimaxComputerUseKit`, `app/src/capabilities/mac`, native adapter/verification/interlock, historical tests and other removed products | Reuse selected source after dependency/provenance checks; do not bulk-copy the archive |
| Engine admission | `src/mcp/config.ts` rejects `bimax-mac`; `src/mcp/client.ts` filters CU tool names | Returning files alone will not make CU callable |
| Desktop runtime | `coding.runtime.paths.ts` strips CU environment; launcher does not supply native capability | New host-authorized admission is required |
| Packaging | `app/electron-builder.yml` stages the engine, not CU components | Native rebuild, bundle layout, identity and permission qualification are separate work |
| Threads | Per-thread engine, state, queue, folder, session pointer, nonce-bound approvals, linked messaging, quick bar | Preserve these foundations and repair lifecycle gaps |
| Finder context | Fixed read-only AppleScript reads Finder's current folder; packaging declares Apple Events usage | Narrow Automation permission already exists; this is different from Accessibility/Screen Recording control |

The archive README is stale: it describes an in-tree `computer-use/` layout and `git mv` restoration,
whereas the inspected copy is external and uses original paths. Its claim that native payloads were
never packaged also conflicts with dated packaged evidence in records 13–16 and the roadmap. Neither
statement is sufficient to certify an archive build today. Inventory and hash the actual dependency
closure; qualify a newly built package.

The mandatory `competitive/03_CAPABILITY_MATRIX.md` is missing from this checkout. Current source,
the gap register and relevant journey contracts substitute for analysis; its absence is an unresolved
documentation defect. `AGENTS.md` still describes two products, while the active README describes
one and the product-reset README contains successive scope changes. Preserve the binding ownership
rule (only Desktop may own CU) and reconcile the topology documents in the implementation slice.
Git status failed with “not a git repository” despite an inspected `.git` directory. No clean-tree,
branch or commit claim is made; the audit records source hashes instead.

## Is Bimax Threads good?

**The product idea is good and worth keeping. The implementation is an early foundation, not yet a
reliable platform for autonomous multi-app work.** Its most compelling behavior is starting useful
work from a folder and letting independent tasks continue while the user changes focus.

Good existing choices:

- Separate engine processes, transcript state and queues; selecting another task does not stop it.
- Canonical path checks for tool arguments, including escaping symlinks and missing ancestors.
- Same/ancestor folder serialization for ordinary queued turns, instead of unguarded writers.
- Approvals bound to thread, request ID and random nonce; expired replies cannot approve later work.
- Private local broker with process tokens; links are explicit, messages bounded to 8,000 characters,
  and pairs capped at 12 exchanges. Restored snapshots do not restore collaboration grants.
- Restarted histories do not automatically replay stored mutations.
- Folder capture before the quick bar takes focus, with an explicit folder picker fallback.

### Findings, ordered for implementation

The six reproducible probes live in
[`evidence/2026-09-13-threads-audit/probe.cjs`](evidence/2026-09-13-threads-audit/probe.cjs), with
[raw results and source hashes](evidence/2026-09-13-threads-audit/results.json). These deliberately
assert current defects/limitations. They are audit evidence, not acceptance tests for desired behavior.

| Priority / finding | Trigger and actual consequence | Required correction |
|---|---|---|
| P1 / T01: accepted queued prompts are not durable | Submit while working; queue is omitted from `SavedThread` and transcript insertion happens only at dispatch. Reload loses the pending instruction. Lifecycle failure also clears the queue | Persist input IDs and queued/dispatched/settled states before acknowledging acceptance. Recover undispatched work visibly; reconcile possibly executed work before retrying |
| P1 / T02: failed resume can strand a task | Saved session is missing/unreadable. Manager waits for matching `session_restore`; error/idle does not restore readiness or resolve queued Continue | Typed restore success/failure, bounded deadline, retained prompt, visible Resume failed / start fresh / inspect choices |
| P1 / T03: sidebar Resume after terminal engine failure can do nothing | `lifecycle(failed)` marks stopped but retains `r.engine`; `start()` returns because that reference exists | One authoritative restart path; clear/replace terminal engine generations or explicitly ask the supervisor to restart |
| P1 / T04: writer ownership releases before termination proof | `stop()` disposes the old supervisor and immediately pumps the next same-folder task. Supervisor dispose sends SIGTERM without awaiting exit | Async stop/drain, process-tree ownership and lease release only on confirmed termination; keep stopping/blocked explicit. The probe proves early dispatch, not a real lingering-process collision |
| P1 / T05: one storage error poisons all later saves | An actual filesystem write error rejects `this.writes`; future `.then` batches never execute, even after the directory is repaired | Catch/report failure, retain pending writes, retry with bounds, expose unsaved state and test recovery. Await final flush during quit; consider a transactional store |
| P1 before privacy claims / T06: folder scope is not read confidentiality | Real sandboxed shell reads an audit-owned sibling file outside root. Profile allows general reads/network and shared temp writes | State current guarantee accurately. Design declared read roots, task-private temp, credential broker and connector scope if stronger isolation is promised; do not break toolchain reads blindly |

Additional source findings:

- **History capacity has no escape route:** create refuses at 200 records and tells the user to
  remove an old thread, but the inspected manager, IPC and list expose no remove/archive operation.
  Add archive/search/filter/rename and an explicit retention policy before wider use.
- **Waiting is invisible:** an overlapping task can have queued work while its summary says idle.
  Expose queued state, blocker, pending count and cancel/steer controls. Separate idle, completed,
  failed, interrupted, waiting for a resource and waiting for approval.
- **Permission friction:** in thread mode the governor asks afresh for existing-file writes and
  mutating shell commands, even under bypass or persistent rules. This can make ordinary code
  repair tedious. Offer task-scoped permission for an explicitly described change set, and reuse
  that authorization while target, scope and risk remain unchanged.
- **Peer provenance is prose:** linked messages enter the target as ordinary input containing a
  warning string. This is useful labeling, not a structural boundary against injected instructions.
  Add typed peer-origin messages, provenance, causal message IDs, expiry, delivery acknowledgements,
  cancellation and link-generation checks at dispatch. Unlink currently blocks new sends but
  does not retract context already placed in the queue.
- **Discovery shares metadata broadly:** broker `list` exposes other thread titles before linking.
  Decide whether this is acceptable for one user's local workspace; organization/private-task modes
  need explicit discovery scopes.
- **Resource budget is per count, not workload:** four engines plus internal workers can be expensive.
  Use a host-wide CPU/memory/model-budget scheduler; permit independent reads and isolated worktrees,
  while locking actual shared mutations. Benchmark before choosing limits.
- **Threads do not create worktrees themselves.** Existing engine subagent worktrees are a different
  feature. Expose local-folder vs isolated-checkout modes and preserve changes during handoff.

UI assessment is deliberately limited. The installed app's AX tree and screenshot showed the welcome
screen with Open project and recent projects, without visible Threads discovery. Source shows the
quick bar and task list; their full installed interaction was not exercised. Add a discoverable
“Start a task in a folder” entry and a configurable shortcut. `Cmd+2 anywhere` should be reviewed for
conflict with normal application shortcuts. Avoid presenting every internal state as literal text.

## How Computer Use should fit

```text
Thread: outcome + allowed resources + budgets + durable history
    |
    +-- coding/file tools       (existing engine)
    +-- browser tools           (tab/session ownership)
    +-- connectors              (account and operation scope)
    +-- Mac capability          (Desktop-owned broker)
             |
             +-- identity / grant / resource lease / cancellation checks
             +-- native service: observe -> act -> observe -> verify
             +-- durable receipt returned to this same thread
```

Choose the execution surface by outcome: file/API/MCP tools when they provide the needed operation;
browser DOM for web work; native AX for Mac UI; physical input when the proven target needs it;
visual grounding for missing semantics; stop on uncertainty. Within the Mac path preserve the
documented semantic → physical → visual-recovery → stop ladder. A fallback must retain the same
authorization scope and postcondition. An API is not automatically safer if it reaches a broader
account or changes more than the requested operation.

Anthropic's current documentation explicitly distinguishes webpage work from desktop operation and
assigns execution to the host. That supports separating browser and native executors while keeping
one task experience. [Computer use documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool).
OSWorld-MCP studies combined tool/GUI operation; this is evidence to evaluate hybrid routing, not
evidence that Bimax's proposed router improves outcomes. [Research paper](https://arxiv.org/abs/2510.24563).

### Host-owned authority

Use a **single Desktop authority** for native input across all thread engines. Multiple conversations
must never each assume they own the cursor. Grant a bounded resource such as app + window/document
generation, not just a friendly app name. Serialize mutations that share app-global state, selection,
dialogs or clipboard; different windows are not automatically independent. Physical input holds an
exclusive foreground lease. User takeover invalidates all prepared actions by generation, and only
explicit resume issues new authority. Observation permission and mutation permission are distinct.

Use generic negotiated capability descriptors at the engine seam, with short-lived host-issued task
tokens. Preserve the CU deny-by-default posture for Terminal/non-Desktop contexts and untrusted MCP
servers. Do not merely delete the name blocklist or turn inherited environment variables into grants.
MCP defines tools and host controls; it is not the OS sandbox or a substitute for authority checks.
[MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

Every effect has thread/turn/action IDs, resource identity, observation revision, approval scope,
executor, expected result and post-action evidence. Persist admission before the effect. If the
process dies after an action, reread the destination before deciding whether to repeat it. For a
non-idempotent action with an ambiguous outcome, stop for reconciliation; do not claim generic
exactly-once delivery or universal undo.

### Native implementation and reuse

Retain Electron/React and the existing engine. Requalify the archived Swift XPC/AX/capture/input
foundation; selectively port native logical verification, readiness/coordinate contracts, trusted
plan typing and takeover generation guards. Archived `native.logical.adapter.ts` already consumes
verification, readiness and trusted-plan modules; reuse its dependency closure, not one copied file.
Keep legacy compatibility runtime and broad scripting/focus fallbacks out of the release closure.

Compile service, bridge and capability provider against a declared contract. Prove the packaged
Electron → bridge → exact XPC service route, native permission ownership, revocation and updates.
Use Apple's system content picker where the supported OS/API permits it, with a tested fallback for
the declared minimum OS. Do not raise that OS minimum implicitly. [Apple picker documentation](https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker).

Audit this concrete restoration trap: the current thread-mode branch in
`src/governor/governor.ts` returns before the later `COMPUTER_CONTROL` sensitive-target floor. Simply
making CU reachable could change which guard executes. Move non-bypassable capability floors ahead
of generic task approval and enforce them again in the host/native executor; test the ordering.

Treat screen/page/app text and peer messages as untrusted observations. Authorization comes from the
user/task contract. The archived signed plan is worth preserving, but a signature proves provenance,
not that the signed plan is a correct interpretation of the user's request. Bind exact resources and
effects independently. Retain minimal, scoped observations and disclose remote model transmission;
continuous full-screen recording is not the default.

## Delivery sequence and stop/go evidence

| Slice | Concrete implementation | Exit evidence |
|---|---|---|
| 0: reconcile the direction | Record Desktop-only optional CU target across README, architecture, gates and build sequence; archive manifest with hashes/dependency closure; repair missing capability matrix | Active code-only gates still pass; no implicit capability activation; one consistent ownership map |
| 1: dependable Threads | Address T01–T05, task status, archive/retention, typed peer messages, permission scopes and generation ownership; integrate existing session/OutcomeContract/EventLedger foundations | R01/C04 crash windows, failure recovery, queue retention, stale approval and process-drain end states, with mutants |
| 2: bounded observation | Rebuild the native service; expose chosen app/window observation in a thread; permission state and model capability probes | Packaged identity/permission checks, zero input effects, exact window evidence, denial/revoke and zero-CU code journey |
| 3: one safe mutation journey | AX read/set/press against a controlled fixture; host resource leases, typed receipts, takeover, bounded retries | M02 wrong target/no-op/stale frame/duplicate effect mutants; bystander keystrokes and persisted fixture state checked independently |
| 4: build → run → prove | Link edited source/build hash to launched PID/window and GUI result, within the same task | X01 removes exactly completed items; unrelated state intact; wrong-build/no-op mutants fail |
| 5: useful app packs | Two or three workflows selected from actual owner use, browser/file/connector/native handoffs, explicit delivery boundary | Repeated app/version-specific end states, invalid-provider separation, minimum/balanced/frontier route conformance |
| 6: selective expansion | Verified reusable journeys, input invalidation and the experiments below | Demonstrated benefit over fixed baselines before enabling learned routing or greater autonomy |

Start with one fixture application and one healthy configured model. Qualify model tiers before
advertising broad support. The acceptance pack requires at least 20 clean repetitions per risky Mac
task/build/model/executor path for release claims; a local sample is not Product-ready. No elapsed
delivery estimate is assigned until archive rebuild and packaged topology work are measured.

Each implementation should use vision cards V19–V25 and V29B: closed-loop execution, native/coordinate
perception, fresh verification, shared evidence and modular capabilities. Avoid making Endpoint
Security, antivirus functionality, a new editor, model training or a plugin marketplace dependencies
of this first return.

## Ambitious feature proposals

These are product hypotheses, not established inventions or current features. Several have pieces
in the older vision; the opportunity is the integrated, usable workflow and its verified outcome.

| Feature | What the user experiences | Buildable mechanism and first falsification test | Order |
|---|---|---|---|
| **Show me the bug** | Point to a broken behavior, demonstrate it once, and Bimax reproduces, patches and rechecks it | Explicit recording of one chosen app; transform actions into semantic assertions, link to build/process and code investigation. Test on a fixture where a visually successful click leaves the wrong persisted state; Bimax must catch it | First flagship after X01 |
| **Living Threads** | “This report used an old CSV; only these two conclusions need checking again.” | Extend existing workflow dependency evidence into task outputs and native receipts. On source change, invalidate descendants and propose selective rerun. Change one of two independent inputs; only dependent claims expire, and a revoked source must not be reread | Near-term; starts without CU |
| **App Relay** | A folder task produces a report; a browser task checks references; an app task prepares the final document, all visibly connected | Typed artifact handoff carrying hash, source, purpose, scope and freshness; separate grants per receiving task. Tamper with the artifact or unlink before dispatch: delivery must stop | After durable Threads |
| **Teach a result once** | Demonstrate a workflow once, then reuse it with new names/data even when the window moves | Compile observations into a parameterized journey with preconditions/postconditions; reobserve before every mutation. Move controls/change labels and insert a duplicate target; replay must adapt or stop, never reuse stale coordinates | After repeated native success |
| **Borrow my screen politely** | Bimax prepares work in the background, then asks for a bounded turn at the foreground and returns control | Shared foreground lease, wait queue, user activity/takeover generation, progress checkpoint. Inject typing or move focus during preparation; no old action may land in the bystander app | Core trust feature |
| **Parallel possible futures** | Preview two fixes or two document approaches, with evidence for each, then choose which becomes real | Branch code/files/test fixtures in worktrees or disposable app profiles; race alternatives without concurrent live side effects. Only the selected branch may acquire real app authority. Inject a losing-branch commit attempt and require rejection | Later experiment |
| **Honest undo** | “These file edits can be restored; that submitted form cannot. Here is the repair action available.” | An effect timeline with before-state, reversibility class and compensation recipes. Introduce a later human edit; rollback must preserve it and explain the conflict. Never call a remote send reversible without a real supported mechanism | After effect ledger |

My first combination would be **Living Threads + Show me the bug + App Relay**. It extends work the
engine already does, makes CU visibly useful and gives one compelling demonstration: a discovered
problem becomes a fixed, running, independently verified result with a reusable history.

## Verification and limits

- Existing focused test invocation passed 3 suites / 17 tests: Threads manager/storage, thread scope
  (including real OS write-boundary check), and code-only product boundary.
- Existing Desktop supervisor suite additionally passed 47 tests (4 suites / 64 existing tests
  across the two invocations). Desktop `npm --prefix app run typecheck` passed. Supervisor output is
  preserved in `evidence/2026-09-13-threads-audit/supervisor-tests.txt`. These are component checks,
  not evidence that the manager/supervisor composition survives every crash boundary.
- Six added audit probes reproduced current behavior against real manager/storage source. T05 used
  an actual temporary filesystem failure; T06 used the real OS sandbox and synthetic sibling data.
  T01–T04 use injected engine transports. This is not a process-kill or live-provider end-to-end run.
- Installed Bimax welcome screen inspected through native AX and screenshot. No existing user task
  was interrupted, no native mutation workflow was launched, and no installed Threads usability or
  latency claim follows from this observation.
- Archived native source was inspected but not compiled, activated or release-qualified.
- Product source and installed binaries were not modified. This change adds analysis/evidence and
  documents gaps; fixes, new capability admission and all feature proposals remain **Target**.
- Guided by product-reset README; 01, 03–08, 12, 30; Mac Buddy vision; competitive README, 02, 04–06;
  and R01, M02, X01 journey contracts. Missing competitive 03 and topology conflicts are explicit above.
