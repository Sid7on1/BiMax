# 58 — Retirement, and where the backend goes next

**Status: pass 1 done 2026-09-19.** Companion to [56](56_APPLE_PLATFORM_AND_PERFORMANCE_PLAN.md)
(research) and [57](57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md) (the build plan). Front-end work is
parked by the owner; this record is backend only.

Nothing here was retired on taste. Each removal names the measurement that condemned it, and
everything moved is at its same path under `~/Developer/bimax-archive`, `cmp`-verified before the
original was removed (`bimax-move-dont-delete`).

---

## 1. The measurement that drove pass 1

Taken on this machine, 2026-09-19, before touching anything:

```
sqlite3 .bimax/ledger.db "select type, count(*) from events group by type"
  policy_active|7
```

**Seven rows. One type.** In the lifetime of this repository's state directory the event ledger has
recorded nothing but policy activations — zero `dream_episode`, zero self-play, zero harness
experiments.

And the state directories those features write to:

```
.bimax/dogfood/       0 entries
.bimax/e2e/           0 entries
.bimax/execution/     0 entries
.bimax/harness-lab/   0 entries
.bimax/worktrees/     0 entries
.bimax/dreams.json    does not exist
.bimax/blueprints/    never created
.bimax/launches/      never created
```

Against the live ones, for contrast: `.bimax/learning-proof/` has 32 entries, `.bimax/traces/` has
6, `.bimax/computer/` has 33, and `drives.json` is current. So the substrate is not uniformly dead —
the *self-improvement theatre* on top of it is.

This extends `bimax-learning-substrate-starved` from "the miner is blind to loop-level
pathologies" to something blunter: **the machinery above the miner has never run at all, on the
machine that develops it.**

---

## 2. Retired in pass 1

Two clusters, both organised around the same idea: spin up sub-agents in throwaway git worktrees,
race them, keep a winner on a branch.

**Cluster A — worktree racing.** `/swarm`, `/beast`, `/council`, `/speculate`, `/evolve`, `/heal`,
plus `src/evolution/*` (swarm orchestrator, speculative solver, council orchestrator, genome
evolver, agent context, worktree manager), `src/genome/genome.repository.ts`,
`src/genome/guardian.ts`, `src/sandbox/test.healer.ts`.

**Cluster B — dream and self-play.** `/dream`, `/dogfood`, plus `src/mind/dream.engine.ts`,
`mutation.engine.ts`, `history.replay.ts`, `dogfood.engine.ts`, and `skills/dream.json`.

**Total: 2,931 lines of production code, 722 lines of tests, and ~103 lines out of
`commands/mind.ts`.** Six test suites went with them (322 → 316 suites; 2,899 tests still pass).

### Why these and not others

- **Never ran.** Section 1.
- **Never reachable from the product.** None of the six commands is referenced anywhere in
  `app/src`. The desktop is the product now (`bimax-archive-separation`); these were CLI-era.
- **Cleanly separable.** A dependency scan of every candidate found 18 files with no importer
  outside the set, and 4 more held only by `commands/mind.ts`. Nothing else in the engine reached
  into them.

### Deliberately KEPT, though it looked adjacent

| Kept | Why |
|---|---|
| `src/genome/pattern.store.ts` | Live: imported by `src/index.ts`, `core/agent.loop.ts` and `engine/adversarialVerifier.ts`. |
| `src/mind/harness.tuner.ts`, `harness.lab.ts`, `harness.lab.eval.ts` | Wired into `engine/personas/base.persona.ts`, which injects mined harness patches into the live system prompt. Low-yield (one lifetime patch) but it is in the prompt path — removing it is a behaviour change, not a cleanup. **Flagged, not cut.** |
| `src/mind/replay.harness.ts` | Standalone episode replay behind `/episodes`; imports only `agent.loop` and `self.model`. |
| `src/mind/exemplar.store.ts` | The store survives its writer. `/exemplars` now says plainly that nothing writes to it any more, instead of pointing at a retired command. |
| `src/core/worktree.manager.ts` | The *other* worktree manager — the synchronous spawn-path primitive. Its doc comment was updated: it is now the only one. |

---

## 3. Candidates for pass 2 — with the evidence, and its true size

**These are not yet retired.** Each needs the owner's call, and one of them needs a correction to
a claim I made along the way.

### 3a. Blueprints and training — RETIRED in pass 2, 2026-09-19

`src/blueprints/` (972 lines, "Sketch Mode") and `src/training/` (401 lines — launches
`python3 train.py` as a detached process from a *coding IDE*).

Evidence: `.bimax/blueprints/` and `.bimax/launches/` have never been created. And blueprints'
own header says it is "consumed by the Build stage (beast mode)" — `/beast` was retired in pass 1,
so its consumer is already gone.

They are wired into `src/index.ts` and registered as three tools: `BlueprintTool`,
`TrainLaunchTool`, `TrainMonitorTool`.

**A correction, made before it reached a decision.** I first measured the tool registry as
"46 tools ≈ 11,255 tokens of schema on every turn" and was about to argue these tools were an
expensive per-turn tax. That was wrong, and `src/tools/tool.registry.ts` is why: bimax already has
a deferred-tool mechanism, and all three are deferred. Re-measured with `gpt-tokenizer`, the
repository's own dependency:

```
core working set   19 tools · 2717 tokens of schema — sent EVERY turn
deferred           27 tools · 7439 tokens of schema — NOT sent; ~131 tokens as a name list
→ a deferred tool costs ~5 tokens/turn, not its full schema
```

So the three dead tools cost about **15 tokens per turn**, not 1,422. The case for retiring them is
maintenance surface and `ToolSearch` namespace pollution — a model searching "build" can match
`BlueprintTool` — **not** tokens. Recorded at its true size.

The deferred-tool design is, incidentally, one of the better things in this engine and should be
left alone.

**What pass 2 removed:** `src/blueprints/` (3 files), `src/training/` (2), `BlueprintTool`,
`TrainLaunchTool`, `TrainMonitorTool`, the `/blueprint` command, and two test suites — both
directories are now gone. Unwired from `src/index.ts` (4 imports, 4 constructions) and
`src/core/container.ts` (3 imports, 3 registrations).

**And it surfaced a live defect pass 1 had created.** The `sketch` and `beast` *agent modes* —
protocol values (`protocol.ts`), offered by the desktop as "Plan first" and "Parallel team" — carry
system-prompt sections in `src/engine/agentMode.ts`. Those sections instructed the model to use
`BlueprintTool`, `TrainMonitorTool`, and to "run the mega-pipeline with the /beast command". Pass 1
had retired `/beast` and left the prompt telling the model to call it.

A system prompt naming tools that do not exist is close to the worst thing you can do to a weak
model: it calls them, gets a refusal, and flails (`bimax-nameless-tool-call-json`). Both sections
were rewritten to the surface that actually ships — `PlanTool` for sketch, `SpawnTool` +
checkpoints + real verification for beast — along with the matching copy in `mode.tool.ts` and
`commands/mode.ts`. **The modes themselves are unchanged**: they are protocol values shared with the
desktop, and their read-only gates in `applyMode.ts` never depended on any of this.

Cumulative across both passes: **~4,300 lines of production code and ~900 of tests**, 322 → 316
suites, and the engine bundle from 1,568 modules / 21.89 MB to 1,559 / 21.81 MB.

### 3b. Commands with no evidence either way

`/scout` (37), `/orchestrate` (44), `/timemachine` (81), `/recipe` (132), `/compliance` (122),
`/a11y` (36), `/calibration` (101), `/selfcritic` (32). Small, and unlike pass 1 there is no
measurement condemning them — "0 desktop references" proves nothing for a command, because the
desktop invokes commands by the user typing them, not by name in code.

**The honest gap: we cannot tell which commands people use, because nothing records it.** That is
worth fixing before another retirement pass — see §4.

---

## 4. Where to hunt next, in order

**H1 — Instrument command and tool usage. DONE** — built as W1 (§6). Not in the event ledger as
first sketched here; the reasoning for that is in W1. §3b becomes answerable once the window is
long enough to mean something, which is the one thing no amount of code can shorten.

**H2 — Tests write into the real `.bimax`.** `.bimax/subagent-capacity.json` appeared during this
session's test runs. `jest.setup.ts` redirects `~/.breakglass` — after a measured incident where
the suite blanked the user's configured model (`bimax-tests-wrote-real-config`) — but nothing
redirects the project's own `.bimax`. Same bug class, second directory.

**Severity, measured rather than assumed: low.** The file is gitignored (`.gitignore:37`) and its
content is an empty lease list. So this is a hygiene fix, not an incident.

**And the obvious fix does not work, which is the part worth recording.** `BIMAX_STATE_DIR` already
exists for exactly this redirect — but `stateRoot()` in `src/utils/state.dir.ts` reads

```ts
return redirected ? path.resolve(redirected) : path.resolve(projectRoot || process.cwd());
```

so when the env var is set it **ignores `projectRoot` entirely**. Setting it globally in
`jest.setup.ts` would silently redirect every test that builds a temp root and expects state
underneath it — `mind.test.ts` and the drives/self-model suites all do. That would trade a harmless
stray file for a fleet of false greens.

The real fix is one of: have `stateRoot` prefer an explicit `projectRoot` over the env (safe — the
desktop's ⌘2 threads pass no root, which is the case the variable was built for), or add a
test-only variable that does not shadow an explicit root. Either is small; neither should be done
without running the full suite, because the blast radius is every state path in the engine.

**H3 — The `src/mind` remainder.** 6,837 lines before pass 1, and pass 1 took roughly a third.
What is left divides into genuinely live (`drives`, `traces`, `learning-proof`, `policy.arms`) and
plausibly inert. H1's counters will separate them.

**H4 — Engine boot.** 1,568 modules, 21.89 MB bundled. `bimax-engine-boot-baseline` measured 444 ms
ready with 93% of it V8 parsing, and `bimax-bytecode-blocked-by-puppeteer` found one dependency
blocking a 58% cut. Pass 1 removed ~2,900 lines; re-measure the boot and the bundle, and re-check
whether that puppeteer dependency is still reachable now that the worktree cluster is gone.

**H5 — `src/engine` is 88 files and `src/tools` 68.** The two largest clusters, never audited for
dead paths the way `mind` just was. Do this after H1, with usage data.

**H6 — The live power channel.** Record 57 WP-4, re-scoped: main owns the good sensors
(`NSProcessInfo`), the engine owns the loop that must react, and today the only path between them
is the spawn environment — a snapshot. Still the right fix, still waiting on WP-6's numbers.

---

## 5. Can a weaker model do UI work?

The owner asked directly. The repository has already answered part of it, with measurement.

`src/engine/model.router.ts` compares seven routing architectures. Option 5 was *exactly* this
idea — "optimistic Quick with escalation" — and it was **rejected**:

> serves real work from the weak model first (observed live: the quick model flails on tool loops),
> then pays double latency+cost to escalate. Rejected: quality-unsafe in the failure direction that
> matters.

Option 6 was adopted instead: default to the Work model when ambiguous, because "a misroute in this
direction costs tokens, never quality." And `HEAVY_VERB` already catches `redesign`, `optimi[sz]e`
and `create a component` — so UI-change prompts route to the Work model today, by design.

**But the useful answer is not "no".** It is that a weak model is safe exactly where a deterministic
verifier can catch it, and this repository has unusually good verifiers for UI work:

- `npm run check:glass-contrast` — 119 text nodes over their composited surface, both themes
- `npm run check:motion` — motion tokens
- `npm run check:design-preview` — every theme × window state, real components, no Electron launch

Against that, the UI failures this codebase actually has are ones a weak model would sail past:
`bimax-theme-token-subtree` (a `var()` resolving to the wrong theme inside a subtree),
`bimax-spring-solver-damping` (an Euler step eating 39% of an overshoot),
`bimax-radix-portal-defers-mount` (a layout effect's ref null on first commit). None is visible in
a diff. All three are caught by a verifier or by nothing.

**So: yes, for UI changes that a gate can grade — a colour token, a spacing value, a copy change,
a variant.** No, for motion solvers, portal lifecycles, theme-token plumbing or anything touching
`morph/`. And the way to make "yes" bigger is to widen the gates, not to trust the model.

That is also a feature, not just advice — see §6, W2.

---

## 6. Backend features worth building

Ranked by distinctive × reachable-from-here. All backend.

**W1 — Usage-honest retirement. BUILT 2026-09-19.**

`src/mind/usage.counters.ts` + `/usage`. One counter per command and per tool, recorded at the two
choke points — `CommandRegistry.execute` (under the *canonical* name, so `/mind` and `/self` are one
number) and `agent.loop`'s tool call, *after* the governor and hooks have let it through, so a
refused tool never looks popular.

Deliberately **not** the event ledger: that is an append-only hash-chained audit log taking a SQLite
IMMEDIATE transaction per append, which is right for evidence and wrong for a counter that ticks
tens of times a turn. Counters are a debounced, unref'd, atomically-written JSON file. Names only —
no arguments, prompts or paths. `/usage` prints the observation window and warns under seven days,
because "never run in 40 minutes" is not evidence and someone *will* quote it in an argument.

Verified end-to-end through the real registry path, not just unit-tested: three `/usage` runs
counted 3 and wrote `.bimax/usage.json`. This is what makes §3b answerable.

**W2 — Verifier-gated cheap models. FOUNDATION BUILT 2026-09-19.**

`src/governor/change.gates.ts` + `/gates` + this repo's own `.bimax/gates.json` (six real gates:
glass-contrast, motion-tokens, design-preview, app-typecheck, engine-bundle, engine-lint).

It answers the prerequisite nothing in the engine could answer: **given the files a change touches,
is there a deterministic check that would catch a mistake?** `verdictFor()` returns
`gate-covered` / `partially-covered` / `unguarded`, and `escalationDecision()` supplies the trigger
the router's rejected option 5 lacked — escalate when a *gate* refuses a cheap model's change, not
when the model flails.

Two deliberate strictnesses. **Every** touched file must be graded or the cheap model is refused —
not "most", because the ungraded half is exactly where an invisible defect lands. And a project with
no declaration is inert-but-refusing, never permissive.

It is a **foundation, not the whole feature**: the judgement is pure and reachable from `/gates`, but
nothing yet runs the gates automatically after a turn or performs the escalation. That wiring is the
next step and needs a decision about where in the loop it sits. Said plainly rather than described as
finished.

**W2 — Verifier-gated cheap models.** Route a change class to the weak model *when a deterministic
gate exists for it*, run the gate, and escalate automatically on failure. This inverts §5's
rejected option 5: the reason it failed was that escalation was triggered by the model flailing,
which is late and expensive. Triggered by a *gate*, it is cheap and certain. It also turns "widen
the gates" into a direct cost saving, which is the right incentive, and it is a natural fit for
`bimax-weak-model-is-the-strategy` and the 23.8pp harness spread.

**W3 — A local second opinion, once MLX lands (57 WP-10).** A zero-cost, zero-network model
watching the cloud model's tool calls for the failure shapes already catalogued here — bare-args
JSON (`bimax-nameless-tool-call-json`), a gate proven by the model's own query
(`bimax-circular-gate-proof`), an unneeded action offered as proof. Cheap because local, and it
feeds H1/H3 the loop-level pathologies the miner cannot currently see.

**W4 — Make the Test-Dependency Map earn its keep.** `src/substrate/tdm.ts` already builds the
bipartite "which checks verify which files" graph with tiered confidence (coverage 1.0 downward).
Combined with `bimax-green-needs-attestation` (green scope comes from LCOV `SF:`/`LH:`, never
stdout), that is the foundation for answering "what did this change actually break?" before running
anything. It is built and underused — the opposite of everything in §2.

**W5 — Publish the resource contract.** From 57 WP-6 plus MetricKit/StateReporting: what Bimax
costs per state, on which chip. Nobody publishes this. On an 8 GB laptop it is the deciding factor.

**W6 — Approvals say what an operation DECLARES. BUILT 2026-09-19.**

`src/evidence/operation.map.ts` derives, from any tool call, the hosts it names, whether it installs
dependencies, and whether its effects were read from text rather than observed. `task.guard.ts`
calls it on every call and uses it to **block**. None of it reached the person being asked to
**approve**: `approvalCard` is built from `planFileChange`, which is file-shaped by design.

So an approval for `curl … | sh` showed the command and the affected files — never "this contacts
get.example.dev", and never "these effects were read statically, so the list may be incomplete".
Both now appear (`declaredEffectLines`, wired into `approvalCard`).

**One thing the first version got wrong, caught by rendering real cards rather than trusting the
tests.** `ls -la` carried exactly the same "may be incomplete" warning as `./deploy.sh --prod`. A
caveat that appears on everything is one people learn to click past — which would have cost the
precise case it exists for. It is now suppressed when the mapping is confident the command only
inspects *and* there is nothing else to qualify; a read-only-looking command that names a host keeps
it. Processes and paths are deliberately not listed: the command and the file preview already carry
those, and repeating them is noise, not a fact.

### A tooling defect found on the way, and worth more than the feature

While tracing the above I claimed `operation.map.ts` had "zero production importers". **That was
wrong**, and the reason is a defect: `src/evidence/task.guard.ts` contained a **raw NUL byte** inside
a string literal — `join('<NUL>')`, written as the byte rather than as `\u0000`. `file(1)` therefore
reported it as `data`, and **grep skips a file it believes is binary**. A 425-line production file
was invisible to every plain grep in this repository, which is how a search-based conclusion became
confidently false.

Five files were affected — `task.guard.ts`, `habit.compiler.ts`, `task.metrics.ts`,
`headroom.compress.ts` and its test — all using a raw NUL or ESC where the escape was meant. Runtime
behaviour was always correct; only the tooling was blind.

- All five now use `\u0000` / `\u001b`. Identical values, and `file` reports text.
- `src/__tests__/source.greppable.test.ts` bans the byte class outright (TAB/LF/CR excepted), names
  the file, line and fix, and refuses to pass if the scan itself covers nothing. Mutation-tested
  with a planted NUL.
- The WP-0 naming gate now greps with `-a`. It had been silently covering less than it claimed —
  the exact failure it exists to prevent, and the fourth instance of this repository's signature
  shape (`bimax-packaging-guard-is-dead`, `bimax-jest-cache-false-green`).

---

## 7. What actually ran

Both retirement passes plus W1 and W2, end state after all of it:

- `npx jest --coverage=false` — **316 suites, 2,918 passed, 17 skipped.** (322/2,943 before pass 1;
  six suites were archived with their subjects, and W1/W2 added back 45 tests.)
- `bun build src/index.ts --target=node` — **1,561 modules, 21.82 MB, clean.** This is the check
  that matters: `tsconfig` excludes `__tests__`, so `tsc` cannot see a dangling test import
  (`bimax-jest-cache-false-green`). Run after every unwiring step, not just at the end.
- `npm --prefix app run typecheck` — clean.
- Every archived file `cmp`-verified against `~/Developer/bimax-archive` before the original was
  removed. Nothing was `rm`'d without a verified copy (`bimax-move-dont-delete`).

**Driven end-to-end, not just unit-tested** — because a registered-but-never-invoked surface is this
repository's signature failure (`bimax-custom-slash-commands`, `bimax-packaging-guard-is-dead`):

- `/usage` executed three times through the real `CommandRegistry.execute` path: counted `3`, and
  wrote `.bimax/usage.json`.
- `/gates` executed against this repo's real `.bimax/gates.json` for three file sets, returning
  `gate-covered`, `partially-covered` and `unguarded` respectively.
- The naming gate (WP-0, record 57) mutation-tested again: red on a planted violation, green when
  removed.

**Mutation-tested** (`08_ACCEPTANCE_GATES.md`: tests must fail against a deliberately neutered
implementation), each mutant chosen as the DANGEROUS direction, then reverted:

- `coverageFor` made to treat an ungraded file as covered — **5 tests failed**.
- `UsageCounters.record` made to stop incrementing on repeat — **1 test failed**.

### One gate was declared and then withdrawn, which is the point

`.bimax/gates.json` was first written with six gates. `engine-lint` was removed before it shipped:
measured on a clean tree, `npm run lint` exits with **12 errors and 1,464 warnings**, in
`src/compliance/rules.ts`, `src/documents/{ocr,pdf.writer}.ts`, `src/engine/task.router.ts`,
`src/memory/facts.ts` and `src/tools/args.validate.ts` — none of them touched by this work.

**A gate that is already red cannot grade a change.** You cannot separate a new failure from the
standing one, so declaring it would have marked every engine file "covered" while catching nothing,
and the escalation would have fired on every turn. Withdrawn until the 12 errors are fixed — the
reason is recorded in the file's `$notDeclared` block so the next person does not re-add it.

This is the failure direction working as designed: an undeclared area reads as *unguarded*, which
refuses the cheap model rather than trusting it. Five gates ship (glass-contrast, motion-tokens,
design-preview, app-typecheck, engine-bundle) and all five were run green.

**H7, new** — fix those 12 lint errors, then declare `engine-lint`. Small, and it widens the
cheap-model-eligible surface to the whole engine.

### Status words (per `competitive/README.md`)

| | |
|---|---|
| **Implemented** | Both retirement passes. W1 usage counters + `/usage`. W2's gate registry, `verdictFor`, `escalationDecision`, `/gates`, and this repo's six-gate declaration. |
| **Measured** | The ledger query (7 rows, one type), the empty state directories, the tool-schema token split (19 core / 2,717 tokens vs 27 deferred / ~131 as names), and the line counts. |
| **Target — NOT built** | Automatic gate execution after a turn, and the escalation itself. W2 decides; nothing yet acts. W3, W4, W5. |
| **Deliberately out of scope** | Every front-end item, parked by the owner. Record 57's WP-5 (glass rungs) and WP-6 (the Instruments capture, which needs Xcode's GUI). |

### Documents that guided this

`docs/product-reset/README.md`, records [56](56_APPLE_PLATFORM_AND_PERFORMANCE_PLAN.md) and
[57](57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md), and `AGENTS.md`'s naming rule (added by WP-0 in the
same sequence of work).
