# Bimax repository instructions

These instructions apply to every agent and every change in this repository.

## Mandatory product-reset research rule

Before planning, reviewing, or changing Bimax, read `docs/product-reset/README.md`. Treat the
product-reset folder as the repository's product and architecture source of truth.

Then read the documents relevant to the task before taking action:

- Product boundaries or repository ownership: `01_CURRENT_REPO_AUDIT.md`,
  `05_TARGET_ARCHITECTURE.md`, and `06_REPO_SPLIT_RUNBOOK.md`.
- Frontend, interaction, onboarding, or visual work: `03_PRODUCT_EXAMPLES.md` and
  `04_FRONTEND_PLAN.md`, plus `vision/BIMAX_MAC_BUDDY_PRODUCT_VISION.md` for the Mac app.
- Mac app architecture, adaptive runtime policy, hardware-aware performance, developer-environment
  intelligence, networking strategy, or Trust Engine work: read
  `vision/BIMAX_MAC_BUDDY_PRODUCT_VISION.md` in addition to the applicable architecture and gates.
- Computer Use, native macOS, permissions, XPC, fallbacks, or distribution:
  `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`, and `08_ACCEPTANCE_GATES.md`.
- Competitive positioning, model support, infrastructure, or feature prioritization:
  `competitive/README.md`, `competitive/02_RIVAL_STUDIES.md`,
  `competitive/03_CAPABILITY_MATRIX.md`, `competitive/04_MODEL_INDEPENDENT_STRATEGY.md`, and
  `competitive/05_GAP_REGISTER.md`.
- Benchmarks, reliability claims, demos, or release claims: `competitive/06_HEAD_TO_HEAD_EVALS.md`,
  `competitive/examples/`, and `08_ACCEPTANCE_GATES.md`.

This reading is mandatory even when the requested change appears small. Do not rely on memory or an
old handoff when the current documents are available.

## Evidence and freshness

- Prefer current first-party documentation and inspected source. For changing competitor or platform
  facts, verify them again before using them in a decision.
- Record new or materially changed external evidence in the applicable source ledger.
- Keep the status words defined in `competitive/README.md`: Implemented, Measured, Product-ready,
  Target, and Win. Do not silently upgrade one status into another.
- A test invocation, tool call, screenshot, or confident final response is not proof by itself.
  Follow the end-state and mutation-testing rules in `competitive/06_HEAD_TO_HEAD_EVALS.md`.
- Never publish or repeat a broad competitive claim from a single run or an invalid provider run.

## Naming: Thread, worker, core

Three different things in this repository have been called a "thread". Two of them are resource
caps that were never reconciled *because* the word hid the difference (see
`docs/product-reset/57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md`, WP-1). Keep them apart.

| Term | What it is | Cap |
|---|---|---|
| **Bimax Thread** | The product feature: a folder-bound conversation that runs instantly in the ⌘2 floating bar, with its own engine process, history, approval namespace and undo journal. A project window runs as one too (`origin: 'project'`). | `MAX_LIVE_ENGINES` (`app/src/main/thread.manager.ts`) — a **memory** budget |
| **sub-agent worker** | A real Node `worker_threads` `Worker`, i.e. an actual OS thread (`src/core/subagent.manager.ts`). | `MAX_CONCURRENT_SUBAGENTS` (`src/core/subagent.capacity.ts`) — a **CPU** budget |
| **core** | Hardware. `os.cpus().length` → `RuntimeSignals.cpuCount`. Apple Silicon has no SMT, so a logical core is a physical core (an M3 has 8: 4 performance + 4 efficiency). | — |

- **"Thread", unqualified — in prose, UI copy, comments and commit messages — means the product
  feature.** Capitalise it as *Bimax Thread* on first use in a document.
- CPU concurrency is never called a thread. It is a **worker** (ours) or a **core** (the machine's).
- A cap must name its resource in its identifier or its doc comment. Two caps that both happen to
  be `4` are not the same budget.

## Implementation discipline

- Make implementation choices against the documented two-product boundary: Bimax Terminal is the
  coding product; Bimax for Mac is the sole Computer Use and macOS-permission owner.
- Do not add Computer Use binaries, permissions, commands, or fallback ownership to Terminal.
- Do not silently reactivate legacy Computer Use paths.
- Do not copy competitor source merely because a local checkout exists. Confirm license,
  provenance, compatibility, and the exact files being reused.
- When code and the research disagree, inspect the current implementation. Update the affected
  research document in the same change or explicitly report the unresolved conflict; never work
  around it silently.

## Required completion check

Before declaring work complete:

1. Check the result against `docs/product-reset/08_ACCEPTANCE_GATES.md` and the applicable
   competitive journey.
2. Update the gap register, build sequence, source ledger, or example contract when the change
   alters product reality.
3. State which product-reset documents guided the work and what verification actually ran.
4. Clearly separate what now works from what remains Target, unmeasured, blocked, or deliberately
   out of scope.

Work that ignores this rule is incomplete even when its local tests pass.
