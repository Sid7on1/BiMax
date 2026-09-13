# Historical design notes: evidence-driven autonomy (superseded)

> **Status: SUPERSEDED — historical reference only. Do not build from this document.**
>
> **Bimax ships one thing: the macOS desktop app.** There is no CLI product, no TUI, and no
> command-line distribution. This file previously described itself as "canonical product and
> engineering direction for the Bimax CLI", which has not been true since the terminal TUI was
> removed from the build (commit `d97018f`, 2026-09-06). The claim is removed rather than the file
> because parts of the design below are still live.
>
> **What is stale here:** §1 (Compact TUI refactor) describes a surface that no longer exists, and
> §9 (Browser and computer interaction) describes Computer Use, which was also separated out of the
> product. The v1.0.0 public-beta framing and the launch-gate language refer to a CLI release that
> is not a thing Bimax ships.
>
> **What is still live:** the shared task runtime, sub-agent coordination, honesty and quality
> gates, and the Outcome Convergence Engine correspond to `src/core/subagent.manager.ts`,
> `src/evidence/` and `src/outcome/`, which are all real and in use. Read those sections as design
> rationale for the engine that the desktop app drives — never as a product plan.
>
> Last substantive edit: 2026-07-14.

The design below was written around a persistent, evidence-driven autonomy system.

Browser automation, sub-agents, research, memory, verification, honesty, performance, and
long-running recovery cannot behave like disconnected features. They need one shared task runtime
responsible for driving every request toward the outcome the user actually specified.

The goal is not maximum activity, maximum tool calls, or maximum agent count. The goal is the
fastest safe path to a genuinely verified user outcome.

## Implementation status

**Current audited north-star implementation: 91/100 (2026-07-14).** This score covers the broader
product direction in this document. Separately, the concrete **v1 launch gate is 10/10 (100%)**:
TypeScript build, protocol mirror, 1,065 engine assertions (including real Chromium), Go TUI tests,
self-contained binary, artifact identity, clean install, packaged-user dogfood, three-task offline
evaluation-pipeline smoke, and checksum all passed from one command (`npm run release:check`).

| Area | Weight | Complete |
|---|---:|---:|
| Compact TUI and progressive disclosure | 10 | 9 |
| Shared outcome runtime | 12 | 12 |
| Sub-agent coordination and integration | 10 | 10 |
| Adaptive parallel execution | 8 | 8 |
| Equal-capability recursive agents | 7 | 6 |
| Honesty, evidence, and quality gates | 10 | 10 |
| Universal outcome convergence adapters | 10 | 8 |
| Disciplined research | 6 | 4 |
| Real browser/computer interaction | 8 | 8 |
| Long-running durability and recovery | 8 | 7 |
| Performance budgets and measurement | 5 | 4 |
| Dogfooding and evaluation | 3 | 3 |
| End-user launch readiness | 3 | 2 |
| **Total** | **100** | **91** |

Implemented foundations:

- Persistent per-session outcome contracts and acceptance criteria.
- Trusted-evidence completion gate; model and sub-agent reports cannot verify themselves.
- Mutation-driven evidence invalidation and automatic continuation while a contract is incomplete.
- Dependency-aware adaptive scheduler with duration-weighted critical paths, safe dispatch sets,
  scope-conflict checks, worktree isolation, bounded retries, and task-to-agent ownership.
- Parent validation required before delegated work becomes verified.
- Fail-closed four-slot capacity leases shared across nested worker threads, subprocesses,
  worktrees, and independent agent managers, with heartbeat and crash expiry.
- Session-bound delegated-task settlement and crash reassignment: a late worker result is persisted
  to the outcome that spawned it even if the user has switched threads.
- Safe recent crash snapshots now resume bounded assignments automatically at startup when every
  worker belongs to one active outcome session. Recovery reopens the exact durable worktree,
  preserves partial edits and attempt counts, refuses bypassed/stale/ambiguous snapshots, validates
  every task owner before consuming the checkpoint, and exposes recovering-task count in the TUI.
- Delegated results now queue a durable parent-coordinator wake. When the interactive turn is idle,
  the parent inspects and integrates receipts, performs fresh verification, validates the task,
  recomputes the critical path, and continues newly-ready graph work. Wake generations survive
  restart and cannot lose results arriving mid-turn; user interruption, three no-progress wakes,
  and a bounded wake cap stop the loop safely. The TUI exposes real `AUTO N`/paused state.
- Atomic outcome-contract writes and direct shutdown flushing on terminal or supervisor loss.
- Structured sub-agent result receipts with authoritative changed-file manifests. Isolated edits
  remain pending until the engine confirms the parent checkout exactly matches the reviewed files;
  only verification produced after that integration may validate the task.
- Conflict-aware automatic worktree integration: the engine rechecks the manifest and ownership
  scope, refuses overlapping parent changes, commits and merges safely, verifies the parent files,
  and only then cleans up the isolated branch.
- File-scoped verification receipts flow from the epistemic ledger into Review and the outcome
  runtime. Narrow green checks cannot validate unrelated changed files; repository-wide checks are
  recorded explicitly.
- Equal-capability worker foundation: outcome loop, nested-agent inspection, research, editing,
  precision editing, targeted tests, graph tools, and web research.
- Compact TUI outcome strip with real running, ready, waiting, blocked, parallel, and critical-task
  facts plus linked agent phases.
- Self-contained CLI startup now falls back to a writable temporary engine cache when the platform
  user-cache directory is unavailable, preventing a cache-permission failure from blocking boot.
- Persistent native Chromium control with navigation, input, uploads, responsive viewports,
  DOM inspection, console/network diagnostics, screenshots, exact visual-baseline comparison,
  deterministic assertions, bounded retry/backoff, workspace confinement, and saved profile/state.
- Automatic masked first-run provider/key onboarding, immediate in-session key application,
  provider-aware model discovery, and direct `/keys <provider>` recovery.
- Explicit cold-start, memory, first-token, tool, and guard budgets plus time-to-verified-outcome,
  critical-path, and parallel-time-saved measurements in `/perf`.
- Training launches expose fresh-process readiness instead of fixed sleeps; stale metrics/results
  cannot produce a false ready state, and process startup/teardown is bounded and observable.
- One-command release gate, clean offline/local-artifact installation, verified download checksums,
  update/uninstall paths, packaged TUI/CLI/site dogfood, and four self-contained platform archives.

Required before a general-availability claim (not blockers for today's public beta):

- Multi-hour fault-injection dogfooding of browser/research/recovery state on real projects.
- External private-beta feedback without verbal setup assistance.
- Platform signing/notarization credentials and the actual hosted GitHub release/tag. Archives are
  checksummed and ready to upload; signing requires the release owner's platform identities.

Completed external validation:

- The authored seven-task autonomy suite passed 7/7 in a single live production-provider run on
  2026-07-14, with one run per task, no retries or result selection, 649,374 measured tokens, median
  81,507 tokens, and median 15 turns. The same seven-task deterministic pipeline smoke also passed
  7/7 and remains labelled separately from the live autonomy result.

## North star

When the user gives Bimax an outcome, Bimax should:

1. Determine exactly what the user wants.
2. Translate the request into measurable acceptance criteria.
3. Inspect the environment and current state.
4. Reproduce the problem when applicable.
5. Research unfamiliar techniques, tools, and repositories.
6. Build a dependency-aware plan and coordinate agents.
7. Parallelize independent work when doing so reduces time to completion.
8. Work persistently with durable checkpoints.
9. Inspect the real result using appropriate tools.
10. Compare the result against every acceptance criterion.
11. Identify gaps and change strategy when necessary.
12. Continue until the requested outcome is verified.
13. Report evidence, limitations, and remaining gaps honestly.

“Done” must be a verified runtime state—not a sentence generated by the model.

## Non-negotiable principles

1. **Outcome over activity.** A successful tool call is not a successful task.
2. **Evidence over confidence.** Model confidence never substitutes for verification.
3. **Fastest safe path.** Parallelism is used when it materially reduces the critical path.
4. **Quality is not traded for speed.** Faster execution must preserve the acceptance contract.
5. **Equal-capability agents.** Sub-agents can plan, research, act, verify, and iterate like the
   parent, within their assignments and permissions.
6. **Persistent convergence.** Difficulty, duration, or an unsuccessful first approach are not stop
   conditions.
7. **Strategy must change when progress stalls.** Repeating the same failed action is not
   persistence.
8. **Runtime-owned completion.** The engine—not the model alone—controls completion status.
9. **Progressive disclosure.** The TUI stays compact while retaining inspectable detail.
10. **Real states only.** No animation or status may imply work that is not occurring.
11. **Durable work.** Long-running outcomes must survive process, terminal, and context restarts.
12. **Authorized scope.** Research, browser interaction, installation, and mutations remain within
    user-granted permissions.

## 1. Compact TUI refactor

The TUI should be compact, calm, and immediately understandable. It should have three primary
layers.

### 1.1 Top status line

Show only essential session information:

- Project and branch.
- Current mode and autonomy level.
- Active model.
- Context usage.
- Session cost.
- Engine health.

### 1.2 Main transcript

The transcript should prioritize the conversation and meaningful results:

- User and assistant messages remain visually dominant.
- Tool calls collapse into concise one-line summaries.
- Related tool calls group into a single activity block.
- Diffs remain compact, correctly numbered, aligned, and readable.
- Long diffs show a small preview with a dedicated review view.
- Repeated searches and browser actions collapse into iteration summaries.
- Sub-agent activity summarizes real progress instead of streaming noise.
- Completed output commits cleanly to native terminal scrollback.

### 1.3 Bottom task strip

Show the real state of the active task:

```text
LOOP 7 · VERIFYING · 4/6 PASSED · 2 GAPS · 38m · 3 AGENTS
```

The strip should include:

- Current task phase.
- Iteration number.
- Elapsed time.
- Acceptance progress.
- Remaining gaps.
- Active sub-agents.
- Verification state.
- Current blocker, when one exists.
- Current critical-path assignment.

For parallel work, it may expand into a compact tree:

```text
LOOP 8 · BUILDING · 4 AGENTS · 3 PARALLEL · CRITICAL: API INTEGRATION
├─ A1 Frontend       editing       68%
├─ A2 Backend        testing       81%
├─ A3 Research       verified      done
└─ A4 Browser QA     waiting on A1
```

### 1.4 Progressive disclosure

Secondary systems should not permanently clutter the transcript:

- Sub-agents appear as a compact expandable tree.
- Browser work shows the current target, action, and iteration.
- Mind, memory, context, logs, and diagnostics open as overlays.
- Detailed tool input and output remain available on demand.
- Research sources open in a dedicated evidence view.
- Verification evidence opens in a review panel.
- Task dependencies and critical-path detail open in a task-graph view.

There should be no decorative animation pretending that work is happening. Every visible state must
correspond to a real engine event.

## 2. Shared task runtime

Every meaningful request should become an outcome contract managed by the engine.

The contract contains:

- The user's requested outcome.
- Measurable acceptance criteria.
- Constraints and explicit non-goals.
- Required evidence.
- Allowed permissions.
- Time and cost limits, when specified.
- Current plan and dependency graph.
- Parallelization decisions and their rationale.
- Completed and remaining work.
- Verification results.
- Research and implementation history.
- Checkpoint and recovery state.
- Current critical path.
- Active blockers and attempted resolutions.

The runtime—not the language model alone—decides whether the task can enter a completed state.

A successful file edit, tool call, browser action, or sub-agent response does not mean the task is
complete. Completion requires the outcome contract to pass.

### 2.1 Core runtime entities

The shared runtime should model at least:

- **Outcome:** the real-world state requested by the user.
- **Criterion:** a measurable condition required for success.
- **Task:** a unit of work with dependencies, ownership, and expected evidence.
- **Agent:** a parent or sub-agent executing one or more bounded tasks.
- **Attempt:** one strategy applied to a task.
- **Observation:** the real result of an action.
- **Evidence:** an artifact supporting or disproving a criterion.
- **Gap:** a measured difference between the current and requested state.
- **Blocker:** an external condition preventing meaningful progress.
- **Checkpoint:** durable state sufficient to resume the outcome.
- **Decision:** a recorded choice among approaches, including its evidence and trade-offs.

### 2.2 Engine-owned completion gate

Before allowing a verified completion, the runtime must confirm:

1. Every required criterion has a terminal verification result.
2. Every passing result has appropriate evidence.
3. No required task remains queued, running, or silently abandoned.
4. Sub-agent results have been validated by the coordinator.
5. Known gaps are either resolved or explicitly classified.
6. The final real-world state was inspected after the last relevant mutation.

## 3. Real sub-agent coordination

The parent agent should coordinate sub-agents through a shared task graph.

```text
Goal
├── Inspect current state
├── Research
│   ├── Primary documentation
│   ├── Relevant repositories
│   └── Alternative techniques
├── Implementation
│   ├── Component A
│   ├── Component B
│   └── Integration
├── Verification
│   ├── Automated checks
│   ├── Real-world inspection
│   └── Gap analysis
└── Final acceptance
```

Every sub-agent receives:

- A bounded assignment.
- Relevant context.
- File or worktree ownership.
- Acceptance criteria.
- Expected evidence.
- Dependency information.
- Time and retry limits.
- Allowed tools and permissions.
- A clear reporting format.

Sub-agent states must reflect real activity:

- Queued.
- Booting.
- Ready.
- Planning.
- Researching.
- Editing.
- Running tools.
- Testing.
- Verifying.
- Waiting on dependency.
- Blocked.
- Failed.
- Completed.
- Validated by parent.

The coordinator should:

- Prevent overlapping file ownership.
- Schedule independent work concurrently.
- Track dependencies between tasks.
- Detect stalled or silent agents.
- Retry failed assignments with a changed strategy.
- Reassign work when necessary.
- Preserve useful results from failed attempts.
- Validate every sub-agent result independently.
- Reject summaries without evidence.
- Merge only work that satisfies its assignment contract.
- Cancel obsolete work when the plan changes.
- Propagate useful discoveries into shared state immediately.

Sub-agent animations must never substitute for actual work. The TUI should expose real lifecycle
timings and tool activity.

## 4. Adaptive parallel execution

Bimax should finish tasks through the fastest safe execution path.

Before beginning substantial work, the coordinator should:

1. Break the outcome into a dependency graph.
2. Identify tasks that can run independently.
3. Estimate their cost, duration, risk, and coordination overhead.
4. Determine the critical path.
5. Assign parallel work when it will materially reduce completion time.
6. Keep dependent or conflict-prone work sequential.
7. Continuously reschedule agents as new information appears.

For example:

```text
Goal
├── Research framework options       ┐
├── Inspect existing architecture    ├── Run in parallel
├── Reproduce reported failure       ┘
│
├── Choose implementation approach   ← Waits for findings
│
├── Backend implementation           ┐
├── Frontend implementation          ├── Run in parallel
├── Tests and fixtures               ┘
│
└── Integration and verification     ← Final convergence
```

### 4.1 Use sub-agents when

- Workstreams are genuinely independent.
- Several repositories or techniques need investigation.
- Multiple components can be implemented without file conflicts.
- Tests, browser inspection, and implementation can overlap safely.
- Competing solutions can be explored simultaneously.
- A specialist investigation would unblock the critical path.
- Verification can begin while remaining implementation continues.
- Separate environments or platforms can be tested concurrently.
- The expected time saved exceeds spawn, context, and merge overhead.

### 4.2 Do not use sub-agents when

- The task is faster for one agent to complete directly.
- Assignments would modify the same files or shared mutable state.
- One step depends entirely on the previous result.
- Coordination overhead exceeds the expected time saved.
- The assignment is too vague to verify independently.
- Splitting the task would remove context essential to correctness.
- Additional concurrency would exceed user-set cost or resource limits.

### 4.3 Critical-path coordination

The coordinator should constantly ask:

> What action or assignment will reduce the remaining time to a verified outcome the most?

It should:

- Start independent work immediately.
- Avoid leaving capable agents idle while useful parallel work exists.
- Reassign agents that become blocked.
- Cancel obsolete investigations.
- Give newly idle agents verification, integration, or research work.
- Prioritize tasks blocking the most downstream work.
- Merge discoveries into shared task state immediately.
- Detect and stop duplicated effort.
- Prevent conflicting edits.
- Validate every result before integration.
- Recalculate the critical path after material discoveries or failures.
- Prefer useful speculative work only when its expected value exceeds its cost.

### 4.4 Dynamic concurrency policy

Agent count should be chosen dynamically rather than maximized blindly. The scheduler should account
for:

- Available independent tasks.
- Expected duration of each task.
- Spawn and initialization overhead.
- Shared-resource contention.
- File and worktree conflicts.
- Model, token, and financial budgets.
- Provider rate limits.
- Verification capacity.
- The cost of integrating competing solutions.

Fast does not mean careless. Persistent does not mean sequential. More agents do not automatically
mean faster. Bimax should dynamically choose the execution structure that minimizes time to a
genuinely verified outcome.

## 5. Equal-capability and recursive sub-agents

Sub-agents are not weak background workers. Every sub-agent should have the same fundamental
capabilities as the parent, within the scope and permissions of its assignment:

- Planning and reasoning.
- Tool usage.
- Browser and computer interaction.
- Web and repository research.
- Code editing.
- Testing and verification.
- Checkpointing.
- Gap analysis.
- Strategy changes.
- Its own Outcome Convergence Loop.

When a sub-agent does not know something, it should not immediately return failure. It should:

1. Identify the missing knowledge.
2. Search documentation and relevant repositories.
3. Inspect examples and competing techniques.
4. Test possible approaches.
5. Compare real results.
6. Change strategy when progress stalls.
7. Continue until its assignment criteria pass or it reaches a genuine blocker.
8. Return evidence—not only a summary.

Nested agents may be used when they save meaningful time, but every level remains accountable to the
same outcome, permission, cost, and evidence contract. Child agents must not silently broaden scope,
and their parent remains responsible for validating their output.

Each sub-agent runs a local convergence loop for its assignment while the root coordinator runs the
global convergence loop for the user's outcome.

## 6. Honesty and quality gates

Bimax should never rely on its own confidence as proof.

Every completion claim must connect to evidence such as:

- Test results.
- Runtime behavior.
- Screenshots.
- Browser recordings.
- Visual comparisons.
- Console and network checks.
- File diffs.
- Health checks.
- Data validation.
- Primary research sources.
- User-provided acceptance criteria.

Completion states should be explicit.

### 6.1 Verified

Every required acceptance criterion passed with appropriate evidence.

### 6.2 Partially verified

The implementation succeeded, but one or more checks could not be completed. Bimax must state
exactly what remains uncertain.

### 6.3 Blocked

A genuine external dependency or missing user decision prevents further progress. Bimax must report
the blocker, attempted solutions, and required next action.

### 6.4 Failed

The produced result does not satisfy the outcome contract.

Bimax must not say “done” merely because:

- A file was edited.
- A command returned successfully.
- One test passed.
- A sub-agent claimed success.
- The output looks reasonable.
- The maximum tool iteration count was reached.
- A time estimate expired without an explicit user limit.
- The model feels confident.

### 6.5 Claim-to-evidence ledger

The final response should map material claims to evidence. The runtime should retain:

- The claim being made.
- The criterion it satisfies.
- The verifier used.
- The evidence artifact or result.
- The time of verification.
- Whether a later mutation invalidated that evidence.

Evidence invalidated by later changes must be rerun before completion.

## 7. Outcome Convergence Engine

This is the universal execution loop for every Bimax task.

1. Parse the user's requested outcome.
2. Create or update measurable acceptance criteria.
3. Inspect the current environment and relevant existing work.
4. Reproduce the problem when applicable.
5. Identify missing knowledge, tools, and capabilities.
6. Research unfamiliar techniques, documentation, and repositories.
7. Build or revise the dependency-aware execution plan.
8. Select the fastest safe next actions, including parallel assignments.
9. Execute the highest-value work.
10. Observe the real result.
11. Run the appropriate verification method.
12. Compare the result against every acceptance criterion.
13. Identify and rank remaining gaps.
14. Fix the highest-impact gap or unblock the critical path.
15. If progress stalls, change strategy.
16. Save a durable checkpoint.
17. Recompute dependencies, critical path, and useful concurrency.
18. Repeat until the outcome is verified.

The loop applies to every task type.

### 7.1 Code and debugging

- Reproduce the original failure.
- Inspect relevant code and history.
- Implement the smallest complete fix.
- Run targeted tests.
- Run broader regression checks.
- Reproduce the original scenario again.
- Verify that the root cause—not only the symptom—was fixed.

### 7.2 User interfaces

- Inspect the target behavior and visual requirements.
- Test relevant viewports and states.
- Implement the interface.
- Render it in a real browser or application.
- Capture screenshots.
- Compare structure, spacing, typography, colors, and interactions.
- Check responsive behavior, accessibility, console errors, and network failures.
- Iterate until the required fidelity passes.

### 7.3 Writing and documents

- Verify required length.
- Check requested structure and tone.
- Confirm required facts and sections.
- Detect contradictions and missing material.
- Validate formatting and file type.
- Revise until every constraint passes.

### 7.4 Research

- Search using multiple query variations.
- Prefer primary and authoritative sources.
- Compare competing explanations.
- Corroborate important claims.
- Record sources and uncertainty.
- Confirm that every research question was answered.

### 7.5 Data work

- Validate schemas and types.
- Check counts and invariants.
- Detect missing or duplicated records.
- Inspect representative samples.
- Reconcile output with the requested transformation.

### 7.6 Deployment and operations

- Verify the build artifact.
- Exercise the real startup path.
- Check health endpoints and logs.
- Test failure and recovery behavior.
- Confirm the deployed version.
- Validate the experience from an end-user environment.

### 7.7 Strategy escalation

Bimax must not repeat the same unsuccessful action endlessly. When an iteration fails, it should
escalate intelligently:

1. Correct the current implementation.
2. Try an alternative technique.
3. Inspect deeper diagnostics.
4. Search documentation and issue trackers.
5. Study relevant repositories.
6. Use an equal-capability sub-agent.
7. Explore competing solutions in parallel when useful.
8. Build a minimal reproduction.
9. Replace the failing dependency or approach.
10. Ask the user only when a decision, credential, permission, or unavailable external state is
    genuinely required.

### 7.8 Stop conditions

Bimax should stop only when:

- Every required acceptance criterion passes.
- The user cancels the task.
- An explicit time or cost limit is reached.
- A genuine external blocker requires the user.
- Continuing would require permissions outside the authorized scope.

It should not stop because the task is difficult, lengthy, requires many iterations, or exceeded an
internal model/tool loop count. Internal limits should checkpoint and resume or escalate safely,
not fabricate completion.

## 8. Research hunger—with discipline

Bimax should actively seek better approaches when its current knowledge is insufficient.

Research should include:

- Multiple search-query variations.
- Primary documentation.
- Relevant GitHub repositories.
- Source-code inspection.
- Issue trackers and known limitations.
- Implementation examples.
- Competing libraries and techniques.
- Compatibility and maintenance status.
- Security and licensing considerations.
- Recorded reasons for the selected approach.

Research needs a defined purpose. Each search should address a knowledge gap in the active outcome
contract.

New repositories, dependencies, and external tools must be:

- Inspected before execution.
- Evaluated for relevance and quality.
- Sandboxed when possible.
- Checked for dangerous installation behavior.
- Added only when they materially improve the outcome.
- Recorded in the task evidence.

“Hunger” means persistent, curious discovery—not random searching or blindly installing packages.

Independent research questions and competing techniques should run in parallel when this reduces the
critical path. Findings should be merged into shared state as soon as they become actionable rather
than waiting for every research branch to finish.

## 9. Browser and computer interaction

The browser is an execution and verification instrument inside the convergence loop, not a
website-specific feature.

Bimax should be able to:

- Search the web.
- Open and navigate real pages.
- Inspect the DOM and accessibility tree.
- Click, type, scroll, and interact with controls.
- Upload and download authorized files.
- Capture screenshots.
- Inspect console errors.
- Inspect failed network requests.
- Test responsive viewports.
- Compare visual output.
- Preserve browser state across iterations.
- Recover from navigation and selector failures.

Browser actions should be grouped into meaningful iterations rather than flooding the transcript.

```text
BROWSER · Iteration 6
Target: checkout flow
Actions: 14
Result: payment form fixed
Verification: 3/4 passed
Remaining gap: mobile error state
```

Bimax should interact like a careful human tester while retaining machine-level repeatability and
evidence. Independent browser inspections, viewport checks, route crawls, and research may run in
parallel when they do not mutate conflicting state.

## 10. Long-running work

For tasks lasting minutes or hours, Bimax needs durable execution rather than one fragile
conversation loop.

Required capabilities include:

- Persistent task state.
- Durable checkpoints.
- Crash and restart recovery.
- Saved browser state.
- Saved research and evidence.
- Resumable sub-agent assignments.
- Periodic verification.
- Time and cost accounting.
- Strategy-change history.
- Automatic retry with bounded backoff.
- User interruption and cancellation.
- Clear progress updates based on evidence.

After restarting, Bimax should recover:

- The requested outcome.
- Acceptance criteria.
- Current task graph.
- Completed work.
- Active and failed agents.
- Research findings.
- Browser state.
- Verification results.
- Remaining gaps.
- The current critical path.
- The next highest-value actions and safe concurrency plan.

Long-running work must not depend on the original model context remaining intact.

### 10.1 Long-running scheduling

The scheduler should:

- Checkpoint before and after high-risk mutations.
- Persist agent assignments and dependencies.
- Resume valid independent work after restart.
- Revalidate stale evidence when underlying files or external state changed.
- Respect explicit user time, cost, and concurrency limits.
- Surface evidence-based progress without interrupting useful work.

## 11. Performance requirements

Engine performance supports the larger autonomy system and is part of the outcome contract.

Bimax should maintain budgets for:

- Startup time.
- Input-to-first-action latency.
- Input-to-first-token latency.
- Tool dispatch overhead.
- Sub-agent boot time.
- Context assembly time.
- Task scheduling overhead.
- Inter-agent communication overhead.
- Merge and validation overhead.
- Memory usage.
- TUI rendering latency.

Optimization should be measurement-driven. New autonomy features must not silently make ordinary
tasks slow.

The TUI should remain responsive while:

- Multiple sub-agents are active.
- Browser automation is running.
- Large diffs are produced.
- Long tasks are checkpointing.
- Verification is occurring in the background.
- The coordinator is recalculating the task graph.

### 11.1 Time-to-verified-outcome metric

The primary performance metric should be **time to verified outcome**, not raw token speed or maximum
parallelism. Supporting measurements should include:

- Time spent on the critical path.
- Parallel time saved.
- Spawn and coordination overhead.
- Idle agent time.
- Duplicated or discarded work.
- Rework caused by insufficient verification.
- Time from final mutation to final verification.

## 12. Dogfooding and evaluation

Bimax should be tested against difficult, outcome-based tasks—not only unit tests.

Evaluation categories should include:

- Multi-file debugging.
- Complex feature implementation.
- UI reconstruction.
- Unfamiliar repository onboarding.
- Dependency migration.
- Performance optimization.
- Research-heavy engineering.
- Data transformation.
- Deployment repair.
- Long-running tasks with interruption and recovery.
- Tasks requiring multiple sub-agents.
- Tasks with intentionally ambiguous completion claims.
- Tasks with parallel and sequential phases.
- Tasks where excessive parallelism creates conflicts.
- Tasks where research agents must discover unfamiliar techniques.

Each evaluation should measure:

- Outcome success.
- Acceptance criteria passed.
- Unsupported claims.
- Number of strategy changes.
- Research quality.
- Verification coverage.
- Time and cost.
- Time to verified outcome.
- Parallel time saved versus coordination overhead.
- Human corrections required.
- Recovery after interruption.
- Sub-agent usefulness.
- Final user satisfaction.

The goal is not to maximize tool calls or agent count. The goal is to maximize verified outcomes
while minimizing elapsed time, wasted effort, unnecessary cost, and dishonest completion claims.

## 13. End-user launch readiness

Only after the verified-outcome experience is reliable should Bimax be prepared for launch.

Launch readiness includes:

- A working public installation path on supported platforms.
- Signed and checksummed release artifacts where applicable.
- Automatic first-run provider and API-key onboarding.
- Masked key entry and immediate validation.
- Provider-aware model discovery and selection.
- Clear permissions and sandbox explanations.
- Actionable offline, invalid-key, rate-limit, and startup errors.
- Update and uninstall paths.
- Clean-machine end-to-end testing.
- Documentation, privacy guidance, and support/reporting paths.
- A private beta completed without verbal setup assistance.

## Implementation order

1. Define the shared outcome, criterion, task, evidence, gap, blocker, and checkpoint model.
2. Implement the engine-owned completion gate.
3. Add the dependency graph, critical-path calculation, and adaptive concurrency policy.
4. Refactor the compact TUI around real runtime state.
5. Build reliable equal-capability sub-agent coordination on the shared task graph.
6. Add ownership, conflict prevention, lifecycle telemetry, and parent validation.
7. Implement adaptive verification for different task types.
8. Build the universal Outcome Convergence Engine.
9. Integrate disciplined parallel research and repository discovery.
10. Integrate real browser and computer interaction.
11. Add durable checkpoints and long-running recovery.
12. Add performance budgets and time-to-verified-outcome measurements.
13. Build difficult outcome-based evaluation suites, including concurrency failure cases.
14. Dogfood Bimax on diverse multi-hour tasks.
15. Fix every observed honesty, coordination, scheduling, verification, and recovery failure.
16. Prepare installation, onboarding, API-key guidance, updates, and release automation.
17. Run a private end-user beta.
18. Launch Bimax only after the verified-outcome experience is reliable.

## Final governing principle

> Bimax must reach the verified user outcome as quickly as safely possible by combining persistent
> iteration, evidence-based verification, disciplined research, and efficient parallel execution.

Bimax should not behave like a model that tries once and explains what it attempted.

It should behave like a persistent engineering system that keeps inspecting, researching, planning,
acting, coordinating, measuring, verifying, and changing strategy until reality matches the user's
requested outcome—or until it can prove exactly why that outcome is currently impossible.

Fast does not mean careless. Persistent does not mean sequential. More agents do not automatically
mean faster. Every agent is capable of researching and converging on its assignment, while the root
coordinator dynamically chooses the execution structure that minimizes time to a genuinely verified
outcome.
