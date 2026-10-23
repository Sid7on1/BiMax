# Novel feature recommendations — 2026-09-14

## Recommendation

Build **Test the test**, **Check quotes before sharing**, and **Smallest failing example**, in that order, after repairing the evidence and grading defects in [audit 51](51_CONTEXT_UPGRADE_AUDIT.md). These help a modest local model by adding executable checks, exact source validation and smaller diagnostic inputs. They do not require a stronger model to decide whether their narrow contracts passed.

All ten proposals below are **Target**. Sizes are relative engineering scope, not delivery promises: S is one bounded subsystem, M crosses a few engine/UI boundaries, L requires lifecycle or security work across subsystems. There are no measured latency, accuracy, energy or competitive Win claims. User quotes describe proposed experiences; they are not interview evidence.

## Research basis and novelty limits

The repository basis is README, records 01/03/04/05/06/08/46/47/48/50, the Mac Buddy vision, competitive README/02/04/05/06, R02 and inspected engine source at `333329ffbbc550c8ff7e5a9fbafb3173b6e106e7`. Record 51 supplies new local findings. `competitive/03_CAPABILITY_MATRIX.md` was unavailable. Records 46–48 already propose completion evidence, workflow rehearsal, contradiction handling, context compilation, adaptive retrieval, skills, persistent preferences and broader evaluation machinery. Those are dependencies or adjacent work, not new recommendations here.

First-party pages were checked on 2026-09-14. Documentation establishes a published adjacent capability, not that a competitor lacks an undocumented feature or a plugin. These are proposed **Bimax product contracts**, not invented algorithms or proven market firsts. Custom hooks, scripts and plugins can implement parts of them today. No competitor source was copied.

### Current comparison baseline

| Product | Documented adjacent surface | What this establishes |
|---|---|---|
| Cursor | Rules, search/Explore, security controls [^1][^2][^3] | Instruction selection, retrieval and execution guardrails are established product surfaces. |
| Claude Code | Memory/context management, compaction hooks, checkpoints [^4][^5][^6][^7] | Summaries, persistent instructions, extensibility and rewind are established; a hook can host a custom check. |
| Codex | CLI inspection/editing/commands, scripting and review [^8] | Repository automation and review are established; a script can implement a proposed oracle. |
| Aider | Repo maps, architect/editor modes, lint/test automation [^9][^10][^11] | Context selection, split model roles and ordinary test feedback are established. |
| Cline | Checkpoints and automatic compaction [^12][^13] | File/task restoration and context reduction are established. |
| Windsurf/Cascade | Memories/rules documentation now redirects to Devin Desktop [^14] | The current page distinguishes legacy Cascade memory from Devin Local behavior. Do not assume old Windsurf memory behavior applies unchanged. |
| OpenCode | Configuration for instructions, plugins and compaction [^15] | Extensible context policy is established. |

The matrix below compares **each** proposal with all seven products. Codes refer to the baseline: **R** rules/instructions, **S** search/map, **H** hooks/plugins/scripts, **T** test/command execution, **C** compaction/memory, **W** checkpoint/rewind, **G** guardrails. A cell identifies a nearby building block, not an equivalent implementation. The differentiating contract is specified separately for every proposal.

| Rank / proposal | Cursor | Claude Code | Codex | Aider | Cline | Windsurf/Cascade | OpenCode |
|---|---|---|---|---|---|---|---|
| 1 Test the test | S/G | H | T/H | T | W | R | H |
| 2 Check quotes | S | C/H | T/H | S | C | C/R | H/C |
| 3 Smallest failure | S/G | H/W | T/H | T | W | R | H |
| 4 Source egress inheritance | G/R | R/H | H | S | C | R | H/R |
| 5 Forget derived material | R/S | C/W | H | S | C/W | C/R | C/H |
| 6 Count originals | S | C/H | H | S | C | C/R | H |
| 7 Mistake to regression | R | H | T/H | T | W | R | H |
| 8 Context stress test | S/R | C/H | T/H | S | C | C/R | C/H |
| 9 Conflicting rules | R | R/H | H | H | H | R | R/H |
| 10 Discriminating question | S | H | H | S | H | R | H |

## 1. Test the test

**User:** “Show me that this test would catch the bug you say you fixed.”

**Experience:** beside a passing fix, Bimax offers a bounded check on a disposable copy: preserve the successful baseline, reintroduce the specific fault, run the same test, and show whether it fails for the expected reason. “Not demonstrated” remains a valid result. Compilation failure is not a successful detection of a behavioral bug.

**New contract:** F3 completion evidence checks success; this tests the sensitivity of its evidence to one named fault. Ordinary test automation in Aider [^11] and general command execution in Codex [^8] are adjacent. Mutation testing itself is established; Stryker's distinction between killed, surviving and invalid mutants is essential precedent [^16]. Bimax's addition is an outcome-linked, version-bound user receipt, not a new mutation engine.

**Implementation:** extend `OutcomeManager.addEvidence()` and `validateTask()` in `src/outcome/outcome.manager.ts` with baseline/mutant source, test, command and environment identities; capture inputs with `WorkflowEvidence` in `src/core/workflow.evidence.ts`; use `observeCommandOutcome()` in `src/mind/outcome.sensor.ts` for the observed result. Add a narrow mutation runner rather than making the model the grader. Existing `benchmarks/context/cases.ts` graders demonstrate why the oracle must be independent of returned success fields.

**MVP / falsifier:** one JavaScript boundary-condition fixture, one reviewed mutation and a serial two-run limit. Baseline passes; behavior-changing mutant fails the named assertion; irrelevant mutation survives; syntax-error mutant is invalid; changing the test invalidates the receipt. Any false “caught” result fails the MVP. Preserve stderr and exit reason, not just exit code.

**Size / dependencies:** M; F3/F5 and repaired C1/U09 first; L17 isolation if its execution environment is used. This is not permission to modify the user's working tree. **Privacy/cost:** local only by default, no extra model call; explicit time/output caps and disposable-state cleanup. Uncontrolled external side effects exclude a test from the MVP.

## 2. Check quotes before sharing

**User:** “Before I send this, check that every quote and number really appears in the source.”

**Experience:** draft output receives exact quote/value checks. Each selected passage says current source, historical source, or unsupported; a changed file offers a fresh check. Initially this validates literal quotations and structured number/unit pairs only. It does not certify the surrounding argument as true.

**New contract:** C4 can explain included evidence; this checks emitted content against versioned source spans at the output boundary. Cursor search [^2], Aider maps [^9] and Claude context inspection [^5] help supply context but are not proof of this exact output contract. See the full comparison matrix for the other products.

**Implementation:** extend `evidenceSpan()` and `ContextEvidence` in `src/context/evidence.ts` with byte-safe locator validation; use `readEvidenceFile()`/`evidenceIsCurrent()` in `src/core/workflow.evidence.ts`; add a final-draft validation stage at `AgentLoop.execute()` in `src/core/agent.loop.ts`, before claims are presented as checked. Bind the validated rendered text, not the larger recall chunk (audit U07). A proposed validator module must return precise match coordinates.

**MVP / falsifier:** validate twenty literal fixtures with moved lines, changed numbers, negative signs, units, Unicode and deleted sources. An unsupported quote must never be labeled checked; a historical quote must never be labeled current. No model judges exact matching.

**Size / dependencies:** S for literal checks, M with the final-output UI; C1 repairs U02/U04/U07, then C2 output/residency integration. **Privacy/cost:** bounded local reads, no provider round trip; quotes inherit source access restrictions. A draft may need buffering, so measure added final-answer latency.

## 3. Smallest failing example

**User:** “Turn this huge failure into the smallest example that still breaks.”

**Experience:** from an already reproducible failure, Bimax shrinks a JSON input or test fixture in a scratch copy while retaining the same failure signature. It returns the original, reduced input, command and observed reduction trail. If the run budget expires, call it reduced, not minimal.

**New contract:** L7 rehearses a workflow with faults; this reduces an existing failure under a fixed oracle. It is not another debugger chat or speculative root cause. Checkpoints [^7][^12] supply restoration, not reduction. Delta debugging already established automated failure-input reduction [^17]; the product contribution is safe, inspectable integration with Bimax evidence.

**Implementation:** add a bounded reducer invoking the existing command path observed by `observeCommandOutcome()`; retain raw original/output via `archiveOutput()` in `src/context/output.archive.ts` after U05/U06/U11 repairs; link each candidate through `derivedEvidence()` and attach the final reproduction using `OutcomeManager.addEvidence()`.

**MVP / falsifier:** reduce a seeded 100-entry JSON fixture to its failure-inducing entries within at most 20 serial runs. Run the final candidate again and require the original assertion signature. A timeout, different crash or parse error cannot count as preserved failure. Demonstrate that the working tree stays unchanged.

**Size / dependencies:** M; F3/F5, fixed C1 and isolated command execution. **Privacy/cost:** originals remain local and access-controlled; time/CPU/output quotas, no automatic dependency installs or remote tests. Especially useful when a small model cannot inspect the original log/input in one context.

## 4. Keep this source local, including its summaries

**User:** “Use this file, but never send it—or a summary of it—to a cloud model.”

**Experience:** a source receives a local-only label. Derived snippets, summaries and recall inherit it. Before every model or embedding request, Bimax either routes eligible material locally or explains that the requested remote operation cannot include it. Omitting a source is explicit.

**New contract:** F13 controls authority/scope; this adds dependency-based information-flow enforcement through transformations. Cursor guardrails [^3] and instruction systems [^1][^4][^14] are adjacent, but prose instructions are not the enforcement mechanism. This is not a promise to prevent all inference about a secret.

**Implementation:** attach an egress policy to `EvidenceSpan`/`derivedEvidence()`; preserve it in `ContextEvidence.admit()` and archive metadata. Enforce it at the LLM request boundary used by `AgentLoop.execute()`, and the embedding/reranking wiring in `src/core/container.ts`. Audit every auxiliary summarization/critique path in `src/cli/personas/base.persona.ts`; enforcing only the final chat request is insufficient.

**MVP / falsifier:** a synthetic canary appears in a file, a derived summary and archived recall. Instrument all configured outbound transports: zero restricted content or restricted-derived spans may reach the remote fixture endpoint. Removing the literal canary from a summary must not remove its label. Test mixed-source derivation and unavailable local models.

**Size / dependencies:** L; F13, repaired C1 dependency identity/lifetime, C2 manifest, archive ownership. **Privacy/cost:** metadata must not leak sensitive path names in diagnostics; route changes can add local latency. No claim of complete confinement until all request paths are enumerated and tested.

## 5. Forget this source and everything derived from it

**User:** “Forget that document everywhere Bimax reused it.”

**Experience:** select a source and preview affected current-task snippets, summaries, memory and archives. Revoke those retained derivatives, then show removed, retained-by-policy and unreachable locations. Original user files remain intact. Previously sent provider requests cannot be recalled.

**New contract:** N11 task archiving and ordinary memory edits do not specify transitive source revocation. Checkpoint/compaction features [^7][^12][^13] address restoration or context size. This is an auditable deletion lifecycle over Bimax's own retained material, not a general secure-erasure guarantee.

**Implementation:** extend `ContextEvidence.sourceChanged()` into a distinct revocation operation with durable tombstones; add lineage metadata to `archiveOutput()` and source tags in `ProjectMemory.remember()` (`src/memory/project.memory.ts`). Clear affected entries in `src/memory/file-state-cache.ts` and rebuild affected messages via `ContextManager`. Use `threadStateRoot()` in `app/src/main/thread.undo.ts` to enumerate actual storage ownership rather than assuming task IDs imply separation.

**MVP / falsifier:** within one task, create a source → summary → recalled derivative → archive chain; revoke source; restart. None can be retrieved or reinserted. An unrelated source remains usable. Eviction of a parent must not defeat revocation. Report any backend that cannot delete.

**Size / dependencies:** L; F2/C1/C2 plus U03/U05 repairs. Cross-task revocation waits for explicit L13/L14 identity contracts. **Privacy/cost:** bounded local scans, durable tombstones and retention policy; no promise about backups, SSD physical erasure or third-party retention.

## 6. Count originals, not copies

**User:** “Are these three sources independent, or are they all repeating the same original?”

**Experience:** an answer groups duplicate excerpts and inherited summaries under their known origin. “Three excerpts, one known origin” replaces misleading corroboration. Unknown lineage remains unknown; matching wording alone does not prove dependence.

**New contract:** L2 detects conflicting facts. This handles false agreement caused by duplicate retrieval and summary reuse. Search/maps [^2][^9] and memory systems [^4][^14] are adjacent; the proposed result is a lineage-qualified count, not a generic confidence score.

**Implementation:** use source version plus locator identity in `evidenceSpan()`; repair `derivedEvidence()` identity to include dependency semantics (U03); group provenance in the future C2 context manifest and attach the groups through `OutcomeManager.addEvidence()`. Retrieval scores must not become independent-source counts.

**MVP / falsifier:** one source, two copied chunks and a derived summary count as one known origin; a genuinely separate source with an identical numeric value stays separate when lineage is independent; unknown external copy provenance is labeled unknown. Test cycles and evicted dependencies.

**Size / dependencies:** M; repaired C1, C3 source admission and C4 presentation. **Privacy/cost:** local metadata traversal with bounded graph size, no extra model; avoid exposing restricted origin names in a shared answer.

## 7. Turn this mistake into my regression check

**User:** “Remember this failure as a check so we can tell if it happens again.”

**Experience:** after the user corrects a concrete context mistake, Bimax drafts a small local regression fixture containing authorized input, the expected source span and a falsifiable assertion. The user reviews the expectation. Future engine/model changes can run it on demand.

**New contract:** FL6 records reusable actions; N10 records preferences; the evaluation lab is broader infrastructure. This supplies a specific incident-to-reviewed-oracle authoring flow, not another memory or skill. Aider test automation [^11] and scriptable agents [^8][^15] are nearby execution foundations.

**Implementation:** extend `buildCases()` in `benchmarks/context/cases.ts` with a separate user-owned fixture loader; capture source versions through `WorkflowEvidence`; record the corrected assertion via `OutcomeManager.setCriterion()`/`addEvidence()`. Keep fixtures outside product source by default. Never derive both expected answer and grade from the same candidate output.

**MVP / falsifier:** a lost-answer-span incident creates a replayable fixture; the known broken implementation fails and repaired one passes; an empty result or fabricated token count cannot pass. A changed fixture expectation requires explicit review. Include one hostile source trying to redefine the expected result.

**Size / dependencies:** M; F3, C1 and independent grading repaired first. **Privacy/cost:** opt-in local storage, redaction preview, capped fixture size; no automatic uploading or training. Narrow authoring is the new increment; avoid duplicating a general evaluation dashboard.

## 8. Stress-test this task's context

**User:** “Does the answer depend on which order Bimax happened to read the files?”

**Experience:** a diagnostic makes equivalent versions of a frozen context: reordered snippets, duplicate copies and relocated files with updated locators. It checks required evidence retention and validity, then optionally runs a bounded local-model comparison. It reports instability, not a universal model ranking.

**New contract:** C2 selects under a budget; this tests invariance under representations that should preserve the task's facts. L6 compares alternative implementations; here the implementation and facts stay fixed. Configurable compaction [^5][^13][^15] supplies the adjacent mechanism, not an invariance guarantee.

**Implementation:** extend `benchmarks/context/cases.ts` with metamorphic fixture builders; instrument `planContext()` in `src/graph/context.planner.ts` and `ContextManager` to emit actual admitted IDs/bytes; use independent measurements rather than `tokenEstimate`. A proposed harness compares manifests before asking any model.

**MVP / falsifier:** ten deterministic transformations of one seeded task preserve required span IDs or explicitly report a budget exclusion; a stale locator or lost decisive span fails. A deliberate order-sensitive truncation mutant must be detected. Optional model trials are graded separately against fixed expected facts.

**Size / dependencies:** M; C1/C2 and F5; no live model required for the first slice. **Privacy/cost:** serial runs, bounded fixture bytes, at most a user-selected number of local generations; no paid-provider sweep by default. Distinguish compiler instability from model nondeterminism.

## 9. Show me the conflicting rules

**User:** “Which instruction is making Bimax use the wrong command?”

**Experience:** for a few structured operational choices, Bimax shows the active rules, origins, scope and precedence. Overlapping rules requiring different package managers or incompatible network policies produce a concrete conflict before execution; the user resolves that choice once for the relevant scope.

**New contract:** basic project rules are already mainstream [^1][^4][^14][^15]. N10 stores corrections and L2 concerns source contradictions. This proposal adds a runnable conflict witness for typed operational constraints; unrestricted natural-language contradiction detection is outside the MVP.

**Implementation:** extend `folderRulesText()`/`folderRulesSection()` and existing protected-path handling in `src/tools/thread.rules.ts` with a separate typed rule representation; attach origins through C1; resolve in `AgentPersona.buildSections()` and enforce applicable policies at the existing tool boundary. A prompt-only warning cannot satisfy a hard constraint.

**MVP / falsifier:** two applicable typed package-manager requirements produce a conflict listing both source versions; a non-overlapping folder rule does not. An unresolved hard-policy conflict blocks the dependent command; editing a rule invalidates the prior resolution. Keep free prose visibly outside typed enforcement.

**Size / dependencies:** M; C1/C2, F13 and the rule-related quick fixes in record 48. **Privacy/cost:** local deterministic checks, no extra model; rules remain untrusted content and cannot grant authority by claiming higher priority.

## 10. Ask the question that changes the decision

**User:** “Ask me the one thing you need to choose correctly.”

**Experience:** when two or three explicit interpretations remain, Bimax shows one discriminating question tied to those alternatives. The answer resolves only that task decision; it does not become a universal preference without a separate instruction.

**New contract:** C3 retrieves missing evidence and ordinary agents ask questions. This is a narrow decision procedure: record candidate interpretations and the missing fact that separates them, then select a question that best partitions those candidates. It is not confidence theater or a promise to know all alternatives. General scripts/hooks [^6][^8][^15] could implement it; differentiation is less certain than ranks 1–6.

**Implementation:** add a typed ambiguity record beside `OutcomeManager.setGaps()`/`setBlocker()`; bind candidate support with C1 spans; route the selected question through the existing `AskUserTool` registered in `src/core/container.ts`; bind the answer to that decision before `requestFinish()` can use it. Do not turn untrusted retrieved instructions into user choices.

**MVP / falsifier:** a fixed suite with three known interpretations and explicit discriminating facts; require one question that separates the remaining candidates, no question when evidence already resolves them, and no reuse after supporting source changes. Wrong or incomplete candidate sets must be reported as a limitation, not hidden by a numerical confidence value.

**Size / dependencies:** M; C3/F7 and C1. If C3 already implements this explicit decision contract, merge it there and remove it as a standalone feature. **Privacy/cost:** deterministic partition scoring once candidates exist, at most one bounded model call to propose candidates; collect only the missing fact and do not retain it globally by default.

## Shipping order and proof

The top three form a useful sequence: verify that a test detects a fault, verify that an emitted quote matches its source, then reduce a large failure while preserving its oracle. Start with explicit commands/actions rather than background work. All three need source identity and independent grading from audit 51; a new UI cannot compensate for those defects.

Before calling any proposal Implemented, add its negative fixtures and hostile mutants. Before calling it Measured, record representative task distributions, source sizes, model/provider identity where relevant, runtime/RSS and failure rates. Product-ready still requires the applicable gate 08 and competitive journey, including installed Desktop behavior if UI is shipped. No Computer Use, native permission request, model retraining, third-party source reuse or remote execution is authorized by these proposals.

This research ran source inspection, the 25-test Bun suite, the local context benchmark and controlled probes/mutants documented in audit 51. It did not implement or user-test these ideas, run competitor products, measure weak-model improvements, or perform a full release qualification.

## Sources

All external sources accessed 2026-09-14; titles identify first-party documentation, not independently verified performance claims.

[^1]: [Cursor — Rules](https://cursor.com/docs/rules).
[^2]: [Cursor — Search](https://cursor.com/docs/agent/tools/search).
[^3]: [Cursor — Agent security](https://cursor.com/docs/agent/security).
[^4]: [Anthropic — Claude Code memory](https://code.claude.com/docs/en/memory).
[^5]: [Anthropic — Claude Code context window](https://code.claude.com/docs/en/context-window).
[^6]: [Anthropic — Claude Code hooks](https://code.claude.com/docs/en/hooks).
[^7]: [Anthropic — Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing).
[^8]: [OpenAI — Codex CLI](https://learn.chatgpt.com/docs/codex/cli).
[^9]: [Aider — Repository map](https://aider.chat/docs/repomap.html).
[^10]: [Aider — Chat modes](https://aider.chat/docs/usage/modes.html).
[^11]: [Aider — Linting and testing](https://aider.chat/docs/usage/lint-test.html).
[^12]: [Cline — Checkpoints](https://docs.cline.bot/core-workflows/checkpoints).
[^13]: [Cline — Auto Compact](https://docs.cline.bot/features/auto-compact).
[^14]: [Devin Desktop — Cascade memories and rules](https://docs.devin.ai/desktop/cascade/memories), current destination of Windsurf's memories documentation.
[^15]: [OpenCode — Configuration](https://opencode.ai/docs/config/).
[^16]: [Stryker — Mutant states and metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).
[^17]: [Zeller and Hildebrandt — Simplifying and Isolating Failure-Inducing Input](https://www.st.cs.uni-saarland.de/papers/tse2002/), author-hosted record of IEEE TSE 28(2), 2002.
