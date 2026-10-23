# Master running-code understanding — engineering recommendations, 2026-10-05

**Status: Target.** The owner requested ambitious, useful engineering ideas after the fresh-chat
repair, with depth in one area before expanding. These are proposals, not authorization to build
all of them, measured product capabilities, new algorithms, or competitive superiority claims.
The already selected Outputs Shelf in record 67 retains its scope. Computer Use remains retired.

## Recommendation

Master **debugging an unfamiliar TypeScript/React/Node application from observed behavior to a
working change**. The product promise: “Show Bimax a broken behavior; it finds the execution path,
reproduces the failure, identifies the cause and changes the right code.” Build one coherent engine,
then expand its reach. A generic graph, another chat mode or more parallel agents is not this outcome.

Bimax already has static/Tree-sitter graph indexing, graph impact/context tools, LSP references,
code retrieval, symbol operations, related tests, workflow evidence and agent-tool tracing. The gap
is connecting those pieces to the user's running application. Existing agent spans describe what
Bimax did; they do not establish what the application executed. Reuse these foundations rather than
introducing a second index or treating a stored chat summary as a program model.

## 1. Follow the behavior

**Experience:** select a failed request or an element in the local web preview and choose
“Follow this behavior.” Bimax opens a navigable path: component/event handler → client request →
server handler → relevant query/response → rendered state. Each observed hop opens its exact code.
An inferred static edge remains distinct from an executed edge; uninstrumented hops remain unknown.
This is a development-preview capability, not native Mac app control.

**Engineering:** bind compiler/LSP symbol identities and source maps to a specific working-tree
revision. Join browser actions and backend traces with propagated execution context; use span links
for fan-out and queued work. Add narrowly scoped debugger/instrumentation adapters for values at
chosen code points: OpenTelemetry alone does not record every function call, variable or React
state update. Map database operations and schema identities through an explicit supported adapter.
Index incrementally; source locations must survive a symbol move without pretending an old run
executed today's code. Start with one TS web stack, HTTP and SQLite, not every framework/database.

**Exit:** for planted duplicate requests, wrong cache keys and stale UI state, navigate from the
symptom to the known responsible symbols across browser/server boundaries. Run after a symbol
rename, changed source map and concurrent requests; unrelated requests must not join into one path.
The user can inspect the actual path without asking the model to narrate it.

## 2. Replay this bug

**Experience:** save a real failing interaction as an executable reproduction. Open it tomorrow,
rerun it against the current working copy, and compare the first meaningful divergence. “Why did
this fail?” opens the failure point and its relevant inputs. A fix carries a runnable reproducer,
not a prose account that another developer must reconstruct.

**Engineering:** capture test setup, deterministic seed/clock controls where supported, relevant
network responses, database fixture, dependency versions and source identity. Use an isolated
project test process and a real browser test, then minimize the interaction/input while preserving
the SAME failure signature. Separate deterministic request replay from reproducing a true timing
bug: mocking the response is not proof of a race. Reproduction discovery can use the model;
execution/minimization and the failure oracle must be ordinary code.

**Exit:** failing baseline, fixed run, and a deliberately restored cause behave differently under
the same reproduction. Remove an irrelevant interaction and retain the failure; remove its required
trigger and lose it. A nondeterministic case reports measured reproduction frequency instead of
claiming deterministic replay. This extends record 52's smallest-failing-example idea into a usable
running-app workflow; it is not a new invention or revival of retired worktree racing/self-play.

## 3. Change an intent across the stack

**Experience:** “Allow multiple assignees instead of one.” Bimax can show and implement the linked
change in schema, migration, server types, API response, client state and UI. Open the same behavior
before and after, with realistic fixture data, without discovering missing pieces one chat at a time.

**Engineering:** extend the symbol graph with typed contracts and schema edges learned in the first
two stages. Represent the change as linked edits, with language-server rename/reference operations
and real migration execution, rather than a set of text replacements. Support one migration/type
stack first. Dynamic boundaries and external clients need explicit adapters; a local graph cannot
prove it found every consumer. Reuse existing changes/review and workflow machinery.

**Exit:** execute both the migrated existing-record scenario and creation/editing of new records,
including an old-data fixture. A schema-only, server-only or UI-only implementation must fail the
corresponding scenario. The capability is a coordinated implementation, not another checking panel.

## 4. Compare behavior across revisions

**Experience:** “When did checkout start sending two requests?” Bimax navigates the recorded behavior
across Git revisions, identifies the first reproducing revision, and presents the precise behavior
change beside its code change. A developer can explore a feature's history as behavior rather than
reading months of commits or asking a chat to remember what happened.

**Engineering:** combine the saved reproductions, stable symbol identities and Git history. Use
actual revision runs for attribution, with environment/dependency identity retained. Distinguish a
changed implementation from a changed environment. Support a narrow bisect runner and reusable
local fixtures; do not use agent-loop replay as an application execution recording.

**Exit:** recover the planted first-bad revision despite an intervening rename and an irrelevant
commit, and preserve a replayable before/after interaction. An unavailable revision environment is
an explicit unresolved result, not a model guess presented as attribution.

## Why this could become defensible

The potential moat is the accumulated connection between **symbols, observed executions,
reproductions, changes and their actual behavior**. Each completed job adds a runnable example
of how that repository behaves. Subsequent diagnosis and changes can use those executable assets.
That information is harder to recreate than a prompt, but it is not automatically exclusive or a
market first. Value must be demonstrated on previously unseen bugs; a graph with many nodes and
an attractive trace viewer is insufficient evidence.

## Delivery order and small details

1. Implement one browser-to-Node behavior path and make source navigation excellent.
2. Add saved reproductions and first-divergence comparison for that same stack.
3. Use the accumulated contracts for one coordinated schema/API/UI change.
4. Add revision comparison. Expand languages/frameworks only after the prior journey works.

Freeze a varied held-out set of real bugs and score reproducibility, correct cause location, actual
fix outcome and time to navigate the relevant code. Preserve baseline failures and raw runs under
competitive 06. Never count a confident explanation, an empty test suite or a mocked timing race
as a completed debugging job. Numerical speed/quality targets need a measured baseline first.

Small product details that make this coherent:

- Click a trace hop once to reach the exact range; Back restores the prior cursor, selection and
  scroll position. Keep source and live preview side by side without repeatedly rebuilding the IDE.
- Compare the same interaction before/after with synchronized steps and a visible first divergence.
- A new chat can attach one reproduction by identity rather than importing the entire previous chat.
- Keep last known local preview ready where the app/runtime permits; typing and navigation retain
  priority over indexing. Measure that interaction, not just index throughput.
- Link a generated output to the behavior/change that produced it through the planned Outputs Shelf.
  Sharing a handoff should include the runnable reproduction and relevant source identity.

## Current first-party evidence

Checked 2026-10-05; no competitor installed or benchmarked and no source copied.

- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) documents action/source views,
  before/after DOM snapshots, console and network inspection. These establish browser recording
  primitives, not deterministic backend-state replay or Bimax's proposed cross-stack diagnosis.
- [OpenTelemetry JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
  documents active span context, nested spans and causal links. Those are useful correlation
  primitives; they do not supply function-local values or a complete program dependency graph.
- [Sourcegraph precise navigation](https://sourcegraph.com/docs/code-navigation/precise-code-navigation)
  documents compiler-derived SCIP indexes and language-specific precise navigation. This establishes
  semantic identity/reference tooling, not observed execution or a promise of complete dynamic calls.

The synthesis and delivery order are Bimax design judgments. Guided by README, current architecture
05/55/64, frontend 03/04, Mac Buddy vision, gates 08, competitive README/02/04/05/06 and records
48/52/58/66/67/68/69. Historical Terminal/CU topology does not override the current owner decisions.
