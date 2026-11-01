# Competitive source ledger

## Native mobile host controls — 2026-10-16

[Record 99](../99_MOBILE_HOST_CONTROLS.md) uses current first-party adapter/security source and installed Electron 43.3.0 `app/node_modules/electron/electron.d.ts` (MessageBoxOptions.signal: macOS cancellation requires a parent). The native fixture directly checks that behavior. Evidence is in `../evidence/2026-10-16-mobile-host/`; no competitor implementation, new runtime dependency or general reliability claim.

## Memory RAG completeness and warm work — 2026-10-14, record 95

[Record 95](../95_RAG_EVIDENCE_AND_RETRIEVAL_WORK.md) uses inspected first-party source and frozen starting bytes. Newly checked primary references: [Elastic RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion) (retain ranks/window semantics); [Anthropic contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval) (contextual BM25/embeddings/reranking; vendor results are not Bimax gains); [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) and [programmatic context management](https://arxiv.org/abs/2608.21690) (evidence placement/management research); official [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) and [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) (external evaluation candidates, not executed here). User attachments are hypotheses, not benchmark receipts. No upstream code/dependency/dataset/model import. Preserved local samples, grader controls, source faults and defer decisions are under `../evidence/2026-10-14-rag/`; public/independent heldout/live answer-quality results remain Target.

## Exact context serialization and bounded continuation work — 2026-10-13, record 94

[Record 94](../94_LESS_CONTEXT_WORK.md) uses newly inspected first-party Bimax source and frozen starting bytes. Newly read primary references: [ECMAScript JSON serialization](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.stringify) (living draft: hooks, own enumerable fields, quoting and errors), and [Node 22 proxy detection](https://nodejs.org/download/release/v22.15.0/docs/api/util.html#utiltypesisproxyvalue). The shortcut applies only to plain data with a primitive-string lower bound; proxies, getters, hooks, nested values and possible serialization errors retain native JSON behavior. No upstream code/dependency is imported. Exact-result tests and local paired measurements establish this Bimax slice; references do not prove model quality or product acceleration. Research and all samples are under `../evidence/2026-10-13-context-work/`.

## Context compaction, bounded work and cancellation — 2026-10-13, record 93

[Record 93](../93_CONTEXT_ORCHESTRATION.md) records inspected Bimax context/request/recall/continuation/evidence source and frozen working-tree baselines. Newly read primary references: [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (2025-09-29: compaction, structured notes and just-in-time references; tradeoffs, not a Bimax-quality result), and [Node 22 AbortSignal](https://nodejs.org/download/release/v22.15.0/docs/api/globals.html) (cancellation propagation and throwing the abort reason). Bimax's existing request-deadline helper is reused; no competitor source, new package, remote provider call or claim of superior model performance. The research index and retained samples are in `../evidence/2026-10-13-context-orchestration/`.

## Indexing membership, bounded signatures and OCR diagnosis — 2026-10-13, record 92

[Record 92](../92_LESS_INDEXING_WORK.md) freezes current first-party source, records every paired phase/heap sample and checks exact outputs plus assertion-caught faults. Primary mechanisms: [ECMAScript Set](https://tc39.es/ecma262/multipage/keyed-collections.html#sec-set-objects), [split limit](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.split), [Microsoft Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), and [Node Buffer encodings](https://nodejs.org/api/buffer.html#buffers-and-character-encodings). Apple confidence HTML/Markdown was inaccessible for substantive browsing; the installed Vision header hash and actual owned native outputs are recorded in `../evidence/2026-10-13-indexing-work/research.json`. Accurate/fast confidence is preserved, not inflated. No upstream code, dependency/runtime upgrade, installed performance or competitive claim. Final local checks pass: 4,291 Jest, 133 Bun, three script tests, builds/typechecks, zero lint errors and seven staged-engine exchanges. Earlier native OCR failures remain evidence; this later pass does not qualify general reliability.

## Compiler state and heap measurement — 2026-10-13, record 91

[Record 91](../91_COMPILER_STATE_LIFETIME.md) freezes current first-party sources and records all paired compiler-memory samples, collection/end-state contracts and eight source faults. Fresh primary references: [Microsoft Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), [Node 22 memoryUsage](https://nodejs.org/docs/latest-v22.x/api/process.html#processmemoryusage) and [V8 Orinoco GC](https://v8.dev/blog/trash-talk). Applicability and the initial sampler correction are in `../evidence/2026-10-13-index-memory/research.json`. No upstream implementation/dependency import, forced production GC, installed RSS/energy or competitive claim.

The first full-suite MCP timeout failure is retained; four deterministic settlement tests and three further source faults qualify a deadline-clock correction against the [Node timer scheduling contract](https://nodejs.org/api/timers.html#scheduling-timers). Final Jest passes 4,270 tests; Bun remains 132/133 due to a repeated native OCR confidence failure, so the complete offline/release gate stays open.

## Graph performance mechanisms — 2026-10-13, record 90

[Record 90](../90_GRAPH_PERFORMANCE.md) records current first-party baselines, exact output checks, eight source faults and all paired graph/heap timings. Fresh primary references: [NetworkX BFS layers](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.traversal.breadth_first_search.bfs_layers.html), [Boost circular-buffer semantics](https://www.boost.org/doc/libs/develop/doc/html/circular_buffer.html), and [Lucene 10.3.1 priority queue](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/util/PriorityQueue.html). Applicability is in `../evidence/2026-10-13-performance/research.json`. Bimax freshly implements its FIFO/batch filtering; the heap portfolio is rejected by measured tradeoffs. No upstream code/library import, product-wide acceleration, peak-RSS/energy result or competitive claim follows from these references.

## Graph freshness and rejected heap candidate — 2026-10-13, record 89

[Record 89](../89_GRAPH_FRESHNESS_AND_LINT.md) records inspected first-party source, local source faults, a graph-checkpoint process kill and the rejected bounded-heap experiment. Freshly read primary references: [Node 22 filesystem stat fields](https://nodejs.org/docs/latest-v22.x/api/fs.html), [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html), and [Lucene priority queue](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/util/PriorityQueue.html). Applicability and constraints are in `../evidence/2026-10-13-graph-freshness/research.json`. These references support mechanisms, not Bimax performance or recovery claims. No upstream implementation/dependency import, model qualification or competitive Win.

## Algorithm research and scoped local evidence — 2026-10-12, record 88

[Record 88](../88_ALGORITHM_AUDIT_AND_UPGRADE.md) and its [27-source research index](../evidence/2026-10-12-algorithm-upgrade/research.json) record newly checked primary references, applicability and adoption/defer decisions. Sources describe mechanics; none proves Bimax outcomes merely through citation.

- [Stanford inverted indexes](https://nlp.stanford.edu/IR-book/html/htmledition/an-example-information-retrieval-problem-1.html), [Lucene bounded collectors](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/TopScoreDocCollector.html), [priority queues](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/util/PriorityQueue.html): term-to-document traversal and bounded best-result selection, freshly implemented without importing upstream code.
- [Resilience4j](https://resilience4j.readme.io/docs/circuitbreaker): circular storage and subtract-on-evict aggregates. Bimax retains exact sample timestamps and its existing finite-state/probe policy; time buckets would change cutoff behavior.
- [Oracle access order](https://docs.oracle.com/en/java/javase/24/docs/api/java.base/java/util/LinkedHashMap.html), [ECMAScript Map](https://tc39.es/ecma262/multipage/keyed-collections.html#sec-map-objects): ordered-key storage informs the unchanged LRU policy. [V8 sort](https://v8.dev/blog/array-sort) documents adaptive stable runs and informs the explicit ordered-input tradeoff.
- [Caffeine](https://github.com/ben-manes/caffeine/wiki/Efficiency), [HNSW](https://arxiv.org/abs/1603.09320), [Microsoft DiskANN](https://github.com/microsoft/DiskANN), [Netflix concurrency limits](https://github.com/Netflix/concurrency-limits), [Datadog DDSketch](https://www.datadoghq.com/blog/engineering/computing-accurate-percentiles-with-ddsketch/): investigated candidates, not adopted without workload/recall/memory/fairness/error evidence. Historical legal commentary on Caffeine's page is not a current legal conclusion.
- [AWS retries/jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/), [Google overload](https://sre.google/sre-book/handling-overload/), Elastic RRF/ranking, SQLite FTS5/atomic commit/WAL, original PageRank and long-context research, Node buffering, TypeScript/Tree-sitter, SciPy/scikit-learn and HMAC references inform retain/investigate decisions; direct URLs and boundaries are in the index.
- Frozen first-party baselines, structural manifests, exact fixtures, twelve assertion-caught source faults and every final paired timing are under `../evidence/2026-10-12-algorithm-upgrade/`. Initial accumulator regressions and the initial unqualified mutation-grader result remain recorded. No competitor code, new dependency, installed-app/model-tier qualification or competitive Win.

## Messaging reliability evidence — 2026-10-11, record 84

- Inspected first-party workflow, native authority, schemas and interruption code;
  evidence and source/grader faults: `../evidence/2026-10-11-messaging-reliability/`.
- Owned AppKit Messaging Proof fixture, preserved v1/v2 source and independent
  stored-message/AX end states. The first installed model attempt stopped before
  input and remains a product failure, not a discarded provider run.
- WhatsApp 2.26.38.74 was observed locally through its current native home UI using
  cua_repl. No personal conversation was selected, drafted into or sent to; private
  chat text is excluded from saved evidence. This establishes availability only.
- Installed v2 saved gpt-oss-20b Low / Do: one selected-conversation fixture Send
  passed independent stored-message/AX grading with injected Pause/Resume. Record
  84 preserves the exact prompt, build hash, five approvals and two human control
  interventions. 189 tests, nine source faults and fifteen grader faults pass;
  deterministic repetitions remain separate from native/provider qualification.
- No new competitor code, dependency or external compatibility claim. Existing
  pinned Arc MIT inventory and Mac-only/private-channel ownership remain unchanged.


## Direct @CU experience — 2026-10-11, record 83

[Record 83](../83_DIRECT_AT_CU_EXPERIENCE.md) supersedes records 81–82’s required app/window picker at the
owner’s request. Send `@CU <task>` in either composer: Do is the default, and the
CU model discovers actual running apps/windows after dispatch. Guide/Teach and
saved workflows are optional. Read grants, per-input approval, exact observations,
Pause/Stop and no-replay barriers remain. Main-owned ephemeral single-use admission
refuses restored/expired requests; discovery metadata grants no input authority.
Mac owns CU through its private host channel. Broader model reliability, full M02/X01
and release qualification remain Target. The signed local arm64 app is installed;
one direct saved-model Do task is Measured on the owned fixture (two verified
inputs, exact text, exactly one Save). Local typecheck, 392 regression tests, ten
renderer checks and seven source faults pass; record 83 scopes the receipts.


## CU modes and verification recovery — 2026-10-11, record 82

[Record 82](../82_CU_MODES_AND_VERIFICATION_RECOVERY.md) adds Do/Guide/Teach,
revision-bound in-panel approvals, Pause/Take over/Resume/Stop, and explicit
read-only correction of a changed unexpected status. Guide has no native input;
Teach saves only verified literal instructions and reuse requires a fresh target
and consent. Exact postconditions and no-replay barriers remain. Local host and
renderer contracts are scoped in record 82; assisted correction is not autonomous
model inference. The signed local arm64 v2 app is installed. Individual Teach
(assisted), Guide (zero native inputs) and Do outcomes are Measured on one owned
fixture; 33 grader faults are rejected. Interrupted/rejected attempts remain
recorded. Broader model planning/prose reliability, repeated model tiers, full
M02/X01 and distribution remain Target.

## Explicit @CU messages — 2026-10-10, record 81

[Record 81](../81_AT_CU_MESSAGE_ROUTING.md) implements per-message Computer Use in the project composer
and ⌘2 floating bar: autocomplete, a visible chip and explicit running-app/window
selection. Main-owned single-use receipts and native enforcement bind the exact
window; the engine advertises and executes only CU plus clarification for that
turn. Ordinary coding messages cannot activate CU by guessing its tool name.
Picker consent is separate from task read/input approvals. Queued/restarted routes
never silently become coding turns. Native ownership remains Bimax for Mac through
its private host channel, without an MCP connector. Local contracts, renderer end
states and assertion-caught faults are scoped in record 81. Full M02/X01, repeated
model reliability and release/performance qualification remain Target.
The signed local arm64 v2 app is installed with matching staged bytes and preserved
profile/history. One saved gpt-oss-20b request with an explicit full postcondition
is Measured: two verified inputs and exactly one additional persisted Save. An
earlier inferred-postcondition attempt remains partial; repeated reliability is
Target. Record 81 scopes the native/dialog and distribution evidence.

## Full Arc source owned by Bimax CU — 2026-10-07, record 80

[Record 80](../80_FULL_ARC_SOURCE_AND_BUILT_IN_CU_FEATURE.md) places all 100 original
Arc files inside `app/native/computer/vendor/arc-cua/` and ships that full source
snapshot plus all 34 Python package modules inside Bimax CU. Original MIT identity,
authorship and byte hashes remain. The upstream MCP/CLI code is retained; Bimax's
entry refuses its `mcp`/`run` commands and exposes only the private app component.
Computer Use is a File menu action and readable chat activity. Its engine connection
remains the birth-transferred internal MessagePort, never a managed MCP connector.
Record 79's module exclusions and the earlier third_party location are superseded.
The installed v4 app is **Measured** on one owned fixture with the saved gpt-oss-20b:
one verified field edit, one verified Save click, exact persisted text and save count
one, plus independent native AX read-back. Flat arguments, safe read correction and
standalone window-target import defects are fixed. Failed attempts remain recorded.
Full native/saved-model M02/X01, clean-Mac distribution and performance remain Target.


## Internal Bimax CU and saved-model sequencing — 2026-10-07

[Record 79](../79_INTERNAL_BIMAX_CU_AND_WORKFLOW_RELIABILITY.md): internal app-owned
capability and bounded ordered workflow are **Implemented**. This supersedes
record 78's active MCP route and Arc product identity. The pinned Arc backend and
license are preserved; two selected first-party archived Bimax policies now serve
the active implementation. Native ownership stays in Mac; the engine receives only
a generic transferred host channel. Remove native MCP approval exceptions and
prevent environment descriptors from installing Mac CU. Clarification duplicates
are suppressed within a user run; cancelled questions release the run.

Qualification order: internal channel and workflow contracts → assertion-caught
fault mutations → native freeze and app/engine/package gates → independent native
fixture end-state → installed app/saved-model test. Consult record 79's current
receipts for exactly how far this sequence ran. Native/provider full M02/X01,
clean-Mac/Intel, private API distribution and performance remain **Target**. No
Product-ready or Win upgrade follows from a component test.

The record 78 section below describes the superseded MCP build and its receipts.


## Arc runtime activation — 2026-10-07

[Record 78](../78_ARC_APP_INTEGRATION.md): **Implemented**, with a locally graded
native fixture through MCP → authenticated broker → Mac authority → frozen arc
Driver. Pinned source `74ffae1108b1cb4b1f6b161084af12646f544ba5`, version 0.1.1,
MIT; all 100 imported files remain unchanged. The full driver supplies AX, hybrid
OCR, window-bound background inputs and menu operations. Bimax's existing model
chooses tools; arc's standalone JEV decision loop is not connected or required.
Package Python 3.13.1, PyObjC 12.2.2 and PyInstaller 6.20.0 from the checked-in lock;
retain dependency licenses. Source inspected locally; no new competitor win claimed. Final signed arm64 app installed; bundle hashes and user-data preservation checked. Actual main performed approved native CLICK and SET_VALUE; deterministic final packaged fixture saved the exact text once. The saved model's multistep run was invalid; general model reliability remains unqualified.
No legacy path is restored. Full M02/X01, provider reliability, clean-Mac/Intel,
private-API release compatibility and performance remain **Target/unmeasured**.


## CU source import — checked 2026-10-07

[Record 77](../77_CU_SOURCE_IMPORT_RECORD.md) now imports source rather than merely
inspecting it: all 100 tracked files from arc-cua
`74ffae1108b1cb4b1f6b161084af12646f544ba5`, including its original
[MIT license](../../../third_party/arc-cua/LICENSE), are copied unchanged.
[Local import manifest](../../../third_party/arc-cua.BIMAX_IMPORT.json) records Git
blob/mode/size/SHA-256 identities; the first-party clone matches record 76's revision.

All 55 Bimax archive source files, original manifest/README, and seven dependency
package/license notices are copied separately; the original external archive stays
intact. [Archive import manifest](../../../archive/computer-use/2026-10-04-retired-cua-driver.BIMAX_IMPORT.json)
records their hashes. The retained native-runtime notice identifies MPL-2.0; no
native binary or compiled dependency is redistributed by this source copy.
Private chats/settings and runtime state are excluded. No runtime source is
adapted, no package is installed, and no provider/platform capability is inferred.

## arc-cua versus archived Bimax CU — checked 2026-10-06

[Record 76](../76_ARC_CUA_AND_ARCHIVED_BIMAX_COMPARISON.md) compares arc-cua 0.1.1 at
`74ffae1108b1cb4b1f6b161084af12646f544ba5` with Bimax's latest retired 0.31.0-driver
integration. All 55 archived manifest source hashes matched. Current record 66 still retires CU.

- [Driver contract](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/docs/driver.md):
  model-free Python/MCP, exact window/snapshot scope, structural-change/semantic guards and opt-in settling.
- [Choice policy](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/src/arc_cua/policies/choice.py)
  and [validation](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/src/arc_cua/validation.py):
  finite observed IDs, supplied input keys, validated choices; not proof of correct target selection.
- [Runtime](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/src/arc_cua/runtime.py)
  and [safety](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/src/arc_cua/safety.py):
  optional verifier; cooperative cancellation/deadline checks; named CLICK/DOUBLE_CLICK risk filter.
  Six controlled fake-policy/backend assertions qualify only these runtime behaviors.
- [Hybrid observation](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/src/arc_cua/backends/macos_hybrid.py),
  [background input](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/src/arc_cua/backends/macos_background.py),
  [parking](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/src/arc_cua/backends/macos_parking.py)
  and [Chrome](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/src/arc_cua/backends/chrome.py):
  conditional Vision OCR, private SkyLight/virtual-display mechanisms and a separate DOM/CDP backend.
  No native behavior, permissions, distribution or performance was exercised here.
- [Benchmark contract](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/benchmarks/README.md):
  upstream primitive/workflow checks and independent effects; no run or comparative timing accepted.
- [MIT LICENSE](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/LICENSE)
  and [package metadata](https://github.com/shhivv/arc-cua/blob/74ffae1108b1cb4b1f6b161084af12646f544ba5/pyproject.toml):
  actual license and Python 3.12+ packaging inspected. No runtime code/dependency was imported.

Bimax source inspection covers archived service/driver/grants/commit/manifest/observation/identity
and retained failed installed Music attempts in record 65. Executable-file hashing is not full ASAR
identity; exact typed-value read-back is not whole-task verification. No Product-ready/Win status
or restoration was inferred. The absent capability matrix remains unavailable.

## Chat experience and renderer work — checked 2026-10-06

[Record 75](../75_CHAT_EXPERIENCE_AND_RENDERING_SPRINT.md) uses inspected preload, useEngine,
EngineStore/reducer, ThreadQuickBar, ThreadManager, StreamCoalescer, Markdown and clipboard code.
The existing manager already coalesces list/tray/activity broadcasts; no full-snapshot-per-token
claim was accepted. No dependency or competitor source was imported.

- [React useMemo](https://react.dev/reference/react/useMemo): caches calculation results between
  updates while dependencies are unchanged. It does not speed up the initial render. Applied to
  pure lexing/highlighting with content/language dependencies; context consumers remain live.
- [React memo](https://react.dev/reference/react/memo): consulted for comparison, not introduced.
- [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance): renderer work
  and profiling inform the investigation. No first-paint/CPU/energy result is inferred from advice.

The inspected runtime (React 18.3.1, marked 18.0.6, highlight.js 11.11.1; Electron 43.3.0) and actual libraries are exercised in the production-browser probe.
Retained library-call counts compare original and repaired Markdown using the same fixture. DOM
checks qualify selected chat/card and rendering; a synthetic preload API cannot qualify installed
IPC, native clipboard or provider behavior. Missing P01/matrix/record 34 and invalid exploratory
fixtures are explicit in record 75. Current Mac vision V03, record 57 and C01/R01 guide scope;
Product-ready/Win, installed latency and broader journeys remain unmeasured/Target.

## Fault audit and provider pricing — checked 2026-10-04

[Record 68](../68_FAULT_AUDIT_AND_REPAIR.md) distinguishes the supplied August public-tree audit from
inspected current source (sandbox/app engine boot, outcome/evidence, taint, telemetry, hybrid memory,
persona and Agent Skills loaders). No competitor source or dependency was imported.

- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/): first-party peak/off-peak
  native input/output/cache-hit schedules. Peak Flash ($0.30/$1.20 per million, cached $0.006) and Pro
  ($1.32/$3.96, cached $0.044) inform conservative native-route estimates. These rates cannot be applied
  to NVIDIA/OpenRouter or treated as a Bimax wallet invoice. Recheck before commercial activation.
- [Alibaba Cloud Model Studio models](https://www.alibabacloud.com/help/en/model-studio/models):
  model/region/deployment-specific Qwen support/prices were inspected. No global Qwen rate or launch
  lineup was inferred, and no default was changed. NVIDIA's attempted pricing page was inaccessible;
  it does not establish a current NIM per-token charge. Unknown routes stay explicitly estimated.

Local assertions and mutation receipts, not the pasted audit's confidence, establish the repairs.
Provider-backed end-state quality, prepaid balances and general semantic evaluators remain Target.


## Outputs Shelf and agent skills — checked 2026-10-04

[Record 67](../67_OUTPUTS_SHELF_RESEARCH_AND_PLAN.md) is the current feature plan. These sources
were opened as first-party documentation, not installed-agent measurements. All Bimax additions
remain Target; the owner selected only Outputs Shelf. No third-party source, skill package,
dependency, cloud resource, or account credential was imported.

| Primary source | Established fact and planning limit |
|---|---|
| [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop) | Searchable generated-output gallery, session provenance, origin-aware file resolution. Bimax durability/ownership still needs its own end-state proof. |
| [Claude Artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) | Cross-conversation collection, editing, templates, and format-dependent export. Artifact availability does not establish a Bimax renderer or editable Office runtime. |
| [Manus attachments](https://open.manus.im/docs/v2/attachments) | Execution path, temporary download URL, file and version IDs are different fields. Plan durable identity separately from transport. |
| [Codex/ChatGPT skills](https://learn.chatgpt.com/docs/build-skills) | Portable instructions/resources with progressive loading and scope. Retrieved through the official OpenAI documentation search/fetch tools. |
| [Claude Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) | Document skills and differing surface/runtime requirements; no automatic cross-surface synchronization. Avoid assuming a skill has its original environment in Bimax. |
| [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) | Staged loading, bundles, and source-based recipe learning. Bimax already has completed-task skill capture; extend it. |
| [OpenClaw skills](https://docs.openclaw.ai/tools/skills) | Inventory, readiness, visibility, and dependency gates are distinct. Installation alone cannot confer authority or prove readiness. |
| [OpenCode skills](https://opencode.ai/docs/skills/) | On-demand SKILL.md discovery, compatible roots and skill permission patterns. Import compatibility requires concrete mapping/tests. |
| [Agent Skills specification](https://agentskills.io/specification) | Metadata/resources and optional compatibility/license fields; experimental tool allowance. Bimax-specific output descriptors are a separate contract. |
| [Anthropic skills README](https://github.com/anthropics/skills), [xlsx metadata](https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md), [xlsx license](https://github.com/anthropics/skills/blob/main/skills/xlsx/LICENSE.txt) | Repository license scope varies by skill; document skills are source-available, with proprietary terms. Reference inspection only; no import/adaptation selected. |
| [R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/) | Object streaming and bound SQL access support an optional storage service; account identity/authorization remain application work. |
| [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) | Signed URLs are bearer grants through expiry. Proposed revocable shares check authorization in a Worker on each request. |
| [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) | Separate storage/operation, request/CPU, and row/storage meters. No fixed monthly Bimax quote or free-operation promise. Recheck before activation. |

Cursor's `docs.cursor.com/en/context/skills` page was inaccessible in this check and is not evidence
for a current skill capability. The missing competitive capability matrix and record 31 remain
unavailable; their content was not inferred. Local producer/outcome/skill/files/security/SQLite
seams informed the plan. O01 specifies future independent end-state/mutation qualification;
this research produced no new runtime or competitive result.

## Feature suggestions after Computer Use retirement — checked 2026-10-04

- [Git: git-worktree](https://git-scm.com/docs/git-worktree) documents multiple working trees sharing one
  repository. This is a foundation for proposed isolated solution comparisons (backlog L6/L17), not proof that
  Bimax already supports product Thread isolation, safe handoff or comparative grading.
- [Playwright: tracing](https://playwright.dev/docs/api/class-tracing) distinguishes browser-context traces
  from Playwright Test tracing that includes assertions. A possible local-web QA feature must retain actual
  assertion outcomes; a trace alone is not completion evidence. No native Computer Use is proposed.
- [GitHub: re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
  documents failed-job reruns via `gh run rerun --failed`. This is adjacent infrastructure for proposed Project
  Guardian/CI diagnosis (L5), not an implemented Bimax repair loop or authorization to launch paid CI runs.

Recommendations use current retirement record 66, existing backlog 48 and proposal record 52. Output discovery,
bounded fault checks, failure reduction and isolated alternatives are proposed product extensions; no competitor
absence, novelty, performance or Product-ready claim is made. The referenced `03_CAPABILITY_MATRIX.md` and
record 31 are absent from the current repository; their stale pointers are not treated as inspected evidence.
No feature code or dependencies changed, and no runtime tests were needed for this research-only addition.

## Context audit and feature research — checked 2026-09-14

[Record 51](../51_CONTEXT_UPGRADE_AUDIT.md) records inspected source at `333329f`, 25 passing Bun
tests, a reproduced 26/33 local benchmark and controlled adversarial probes. A budget mutant
survives both supplied suites and preserves the benchmark score. This qualifies earlier local
C0/C1 completion claims; no live-provider, installed-app or competitive result was measured.

[Record 52](../52_NOVEL_FEATURE_RECOMMENDATIONS.md#sources) records the checked primary-source
bibliography: Cursor rules/search/security; Claude Code memory/context/hooks/checkpoints; Codex CLI;
Aider maps/modes/testing; Cline checkpoints/compaction; the current Devin Desktop destination of
Windsurf's memories documentation; OpenCode configuration; Stryker mutant classification; and
Zeller/Hildebrandt's original reduction research. These establish adjacent capabilities and known
algorithms, not market-wide absence. All ten proposed product contracts remain Target. No external
source code or dependency was imported.


## Failure visibility — inspected 2026-09-12

Owner-supplied `../../RETRIEVAL_TOOL_AUDIT.md` is the investigation input; its live-provider results
were not rerun or promoted into new measurements. Record 45 uses inspected local embeddings,
reranking, CodeIndex/SQLite/VectorStore, tool factory/Governor, MCP client/manager, AgentLoop,
protocol host/wire queue, CLI print and Desktop main/reducer/rendering code. Controlled HTTP,
filesystem, MCP and scripted-model faults provide the new evidence. No competitor source,
external dependency or contemporary provider claim was introduced.


## Workflow evidence implementation — inspected 2026-09-10

Record 42 uses local `file.tool.ts`, `search.tool.ts`, `fsWalk.ts`, `tool.factory.ts`,
`tool.workflow.ts`, `file-state-cache.ts` and `epistemic.ledger.ts`. The former workflow file-read
path could return mtime-cached content; directory traversal silently skipped unreadable directories
and stopped at its file cap. Actual-byte capture and explicit workflow completeness now address
those evidence gaps. Existing ephemeral correctness statistics are not promoted into immutable
proof; cross-system code/test claim integration remains Target. No new external dependency or
competitor code reuse. The earlier Bazel and replay references remain design background only.

## Tool-workflow feature exploration — checked 2026-09-10

- [Anthropic: advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
  describes tool discovery and programmatic orchestration. Those mechanisms alone are not evidence
  of novelty; Bimax's proposals should be assessed on verified behavior and integration.
- [Bazel: remote caching](https://bazel.build/remote/caching) binds actions to inputs, commands,
  outputs and environment. This informs a proposed incrementally invalidated workflow/evidence
  graph; safe reuse still requires Bimax-specific input completeness and invalidation tests.
- [rr](https://rr-project.org/) documents deterministic record/replay for Linux processes. It
  inspires a proposed tool-boundary replay debugger, not an rr dependency or a claim of equivalent
  instruction-level replay on macOS. Model and external results would be recorded fixtures.

These are design references, not implemented Bimax features or evidence of market uniqueness.

## Tool result contracts — checked 2026-09-10

[MCP tools specification, 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx)
documents structuredContent and outputSchema validation, with serialized text for compatibility.
This supports record 41's proposed typed search-result extension; it does not establish that Bimax
currently implements that output contract. The shipped slice uses inspected local tool.factory,
args.validate, tool.schedule, file/search tools and the existing deferred registry. No dependency
upgrade, external code reuse or competitor performance claim.

## Renderer subscriptions — checked 2026-09-08

[React: useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore) requires
cached immutable snapshots and stable subscribe functions with cleanup. Applied to stage 3c
in record 34 using the installed React 18.3.1 API; no dependency upgrade. Local reducer and
Virtuoso source informed integration. Eight regressions, five caught mutants and a simulated-IPC
browser fixture support the bounded claim; latency and installed-product qualification remain Target.

## Major-lab research recheck — accessed 2026-09-08, Asia/Kolkata

Full methods/limits, local findings and E1–E5 transfer experiments are in
`../33_REFACTOR_RECHECK_AND_RESEARCH.md`; amendments are applied to plan 32 and P01.

| Primary source | Version/type | Decision informed; limit |
|---|---|---|
| [Google Research / DeepMind / MIT: Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v3) | Paper v3, 2026-04-08 | Task-aware coordination with a single-agent control; empirical thresholds are not Bimax constants |
| [DeepMind / Berkeley: Scaling LLM Test-Time Compute Optimally](https://arxiv.org/html/2408.03314v1) | Paper v1, 2024-08-06 | Compare bounded repair/search budgets; math and fine-tuned-model findings are not coding guarantees |
| [Microsoft Research and collaborators: LLMLingua-2](https://arxiv.org/html/2403.12968v2) | Paper v2, 2024-08-12 | Optional compression ablation with overhead and fidelity checks; protect exact operational data |
| [Google Research: Sufficient Context](https://arxiv.org/html/2411.06037v3) | Paper v3, 2025-04-23 | Separate evidence availability from model use; evaluate answer coverage as well as accuracy |
| [OpenAI: SWE-Lancer](https://arxiv.org/html/2502.12115v4) | Paper v4, 2025-05-29 | Independent hidden user-flow graders; benchmark task payouts do not predict Bimax savings |
| [Anthropic: multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Engineering report, 2025-06-13; not a paper | Include coordination/copied-context costs; parallel research is not equivalent to concurrent edits |

Selected literature, not an exhaustive survey. No competitor code/model was copied, no paper
performance multiplier is adopted, and no new Product-ready/Win claim follows. The retained local
checks establish existing module behavior and two rollback defects; optimization remains Target.

## Coding and cowork performance architecture — checked 2026-09-07

Recorded with the 2026-09-08 refactor plan in `../32_FAST_CODE_AND_COWORK_REFACTOR_PLAN.md`.
These sources constrain proposed implementations; they do not establish a Bimax speedup or Win.

| First-party source | Verified constraint | Plan consequence |
|---|---|---|
| [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance) | Profile running code, defer unnecessary initialization, and avoid blocking main/renderer work | Measure critical paths; preserve security initialization while making optional work lazy |
| [Node writable streams](https://nodejs.org/api/stream.html#event-drain) | A false return from write requires waiting for drain before producing more buffered writes | Bound the NDJSON output path and test slow consumers; preserve event order and controls |
| [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore) | External-store snapshots must be immutable and retain identity when unchanged; subscriptions should be stable | Evaluate domain subscriptions without replacing the entire renderer stack |
| [SQLite WAL](https://sqlite.org/wal.html) | Readers can coexist with a writer, but there is one writer at a time; WAL requires same-host shared memory and does not work on network filesystems | Use one storage writer and crash-tested settings; do not treat a synced database as team collaboration |

Local source inspection on working tree `65725a3` found existing bounded tool scheduling,
subagent capacity leases, manifest-based code indexing with cooperative yields, Virtuoso,
content-hash corpus deduplication and dynamically imported office writers. Proposed work extends
those foundations. Repeated discovery, broad stream state, observer-ledger write failure semantics
and the transaction empty-file sentinel are code observations; their latency/incident frequency
was not measured. The worktree includes pre-existing uncommitted composer changes.

The missing capability matrix and absent `tui/` directory are explicit historical-audit conflicts
in plan 32. No competitor feature claim was refreshed or inferred for this optimization program.
Validation performed for the plan is source/document inspection and reference/diff checks only.

Accessed 2026-08-08 unless noted. First-party sources are preferred. Product documentation changes
quickly; re-open every source before publishing an external comparison.

## Hermes Agent

| Source | What it supports |
|---|---|
| [Feature overview](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview/) | skills, memory, checkpoints, cron, subagents, programmatic calls, browser, MCP, routing/fallback, plugins, ACP |
| [Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop/) | shared core/state, chat/files/artifacts/terminal/review/worktrees/profiles, backend process boundary |
| [Tools and toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/) | capability categories and gated toolsets |
| [Nous product page](https://nousresearch.net/hermes-agent/) | supported surfaces, positioning, distribution |
| Local `/Users/vishsiddharth/Desktop/hermes-agent` at `ce6dd1a65f4b6b20b1f3b31f75184a3e26583488` | core/edge policy, cache invariants, execute_code, gateway, current Desktop architecture/design |

Local files read: root `AGENTS.md`, `apps/desktop/AGENTS.md`, `apps/desktop/DESIGN.md`, and targeted
source searches. No Hermes source was copied in this research change.

## OpenAI ChatGPT and Codex

| Source | What it supports |
|---|---|
| [ChatGPT desktop app](https://learn.chatgpt.com/docs/app) | one desktop command center, projects/files/browser/apps/plugins, ChatGPT Work and Codex entry |
| [Computer Use](https://learn.chatgpt.com/docs/computer-use) | app-only plugin, macOS permissions, allowed apps, background Mac tasks, cross-app workflows |
| [Long-running work](https://learn.chatgpt.com/docs/long-running-work) | goal contract, pause/resume/edit, verification criteria |
| [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) | local coding loop, permissions, review, structured automation |
| [Code review](https://learn.chatgpt.com/docs/code-review) | review scopes and app/CLI/IDE surfaces |
| [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) | parallel isolated chats and local/worktree handoff |
| [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | subagent visibility, steering, inherited permissions |
| Local `/Users/vishsiddharth/Desktop/codex` at `53d06e24ea318a963812030fa8fed1bd0fc42d42` | Rust core, sandbox/approval architecture, app-server threads/events/skills/MCP |

OpenAI product docs were restricted to official OpenAI/ChatGPT sources. The proprietary native
Computer Use implementation is not present in the open Codex checkout and is not a copy source.

## OpenCode

| Source | What it supports |
|---|---|
| [Introduction](https://opencode.ai/docs/) | TUI, desktop, IDE, open-source coding agent |
| [Providers](https://opencode.ai/docs/providers/) | 75+ providers and local models |
| [Agents](https://opencode.ai/docs/agents/) | primary/subagents and permission overrides |
| [Permissions](https://opencode.ai/docs/permissions/) | resource/tool/command permission patterns and loop guard |
| [Agent Skills](https://opencode.ai/docs/skills/) | SKILL.md discovery and permissions |
| [Server](https://opencode.ai/docs/server/) | headless OpenAPI server and TUI client/server architecture |
| [MCP](https://opencode.ai/docs/mcp-servers/) | external tool integration |
| [LSP](https://opencode.ai/docs/lsp/) | editor/language intelligence |

No local OpenCode checkout was found in the supplied Desktop paths; only current official docs and
the first-party GitHub repository were treated as source.

## Claude Code

| Source | What it supports |
|---|---|
| [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) | interactive/print/resume, JSON streams, permissions and MCP |
| [Subagents](https://code.claude.com/docs/en/sub-agents) | custom/built-in agents, background behavior, models/tools/skills/hooks/MCP/memory/worktrees |
| [Hooks](https://code.claude.com/docs/en/hooks-guide) | lifecycle automation |
| [Checkpointing](https://code.claude.com/docs/en/checkpointing) | reversible agent changes |
| [Agent teams](https://code.claude.com/docs/en/agent-teams) | coordinated parallel sessions |

## Cursor

| Source | What it supports |
|---|---|
| [CLI usage](https://docs.cursor.com/en/cli/using) | resume, review, approvals, MCP/rules, structured non-interactive mode |
| [Headless mode](https://docs.cursor.com/en/cli/headless) | scripting and JSON/stream-JSON events |
| [Background agents](https://docs.cursor.com/background-agent) | isolated remote agents, follow-up, takeover, branch handoff |
| [Web and mobile](https://docs.cursor.com/en/background-agent/web-and-mobile) | remote launch, collaboration, desktop handoff |
| [Checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints) | local snapshots of agent edits |

## Zed and supporting patterns

| Source | What it supports |
|---|---|
| [Zed agents](https://zed.dev/docs/ai/agents) | native, external ACP, and terminal harness separation |
| [External agents](https://zed.dev/docs/ai/external-agents) | process/auth/config boundary and thread import |
| [Parallel agents](https://zed.dev/docs/ai/parallel-agents) | multi-project threads and worktree lifecycle |
| [ACP](https://zed.dev/acp) | open agent/client interoperability |
| [Raycast AI Extensions](https://manual.raycast.com/ai/ai-extensions) | narrow named tools and visible approval model |
| [Raycast AI Commands](https://manual.raycast.com/ai/ai-commands) | contextual Accessibility request pattern |
| [Warp Blocks](https://docs.warp.dev/terminal/blocks) | command/output as a reusable evidence object |

## Bimax evidence read

- `docs/product-reset/01_CURRENT_REPO_AUDIT.md`
- `docs/product-reset/08_ACCEPTANCE_GATES.md`
- `docs/BIMAX_UPSTREAM_HARVEST_PLAN_2026-08-02.md`
- `docs/BIMAX_CU_PORTING_LEDGER.md`
- `docs/COMPUTER_USE_ARCHITECTURE_AUDIT_2026-07-31.md`
- `docs/INFRA_2026_BACKLOG.md`
- `docs/FEATURES.md`
- current source paths named in `05_GAP_REGISTER.md`

The current Bimax worktree was not modified outside `docs/product-reset/` by this research pass.

## Owner sections 28 and 29 platform research

The deep primary-source ledger, architecture decisions and journey contracts are centralized in
`../11_SECTIONS_28_29_RESEARCH_AND_DELIVERY_PLAN.md`. It covers Apple Endpoint Security, System and
Network Extensions, FSEvents, code signing/notarization, SIP/SSV/XProtect, provenance-based anomaly
research, ExtensionFoundation/XPC, TUF/Sigstore/SLSA/OSV, Agent Skills/MCP, Xcode and Android
simulators, Virtualization, MLX/Core ML/PyTorch MPS, ProcessInfo/memory/network signals, Metal frame
policy and Reduce Motion.

These sources support Targets and constraints, not competitive Wins. No rival comparison or broad
security/performance claim was added from this research.

## Model Context Protocol provider boundary

Accessed 2026-08-09. These current first-party sources guided Phase 4's engine/Desktop seam:

| Source | What it supports |
|---|---|
| [MCP 2026-07-28 tools specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx) | `tools/list`, `tools/call`, JSON Schema inputs, structured content and list-change capability |
| [MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture) | host/client/server roles and local stdio process lifecycle |
| [TypeScript SDK client documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md) | dynamic discovery/calls through the official client rather than provider-specific engine imports |

The retained local contract is
`app/benchmarks/computer-use/contracts/mac-provider-tools.sample.json`. This supports a bounded
local provider claim only; it is not evidence of a general extension marketplace or remote MCP
security model.

## Complete owner-vision research map

`../12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md` maps all 37 distinct owner-vision chapters to
primary leads, algorithms, examples, falsification experiments and search prompts. New source areas
include Apple Metal device/working-set capabilities, ProcessInfo power/thermal state, responsiveness
and MetricKit, Network path, Homebrew/Python/Xcode/Docker structured environment sources,
Tree-sitter/LSP/Git editing contracts, OSWorld 2.0 and visual-grounding research, OpenSSF/OSV and
package-confusion research, and algorithm-selection/autotuning literature.

The map is an implementation-research index. It does not establish a competitor comparison,
Product-ready capability, or Win.

## Phase 5 frontend reset — interaction and accessibility sources

Accessed 2026-08-09, before any Phase 5 code was written. The existing research already carried the
product-level references (`../03_PRODUCT_EXAMPLES.md`, `examples/REFERENCE_MATRIX.md`); what it did
not carry was current first-party guidance for the two shapes Phase 5 actually builds — a
projects/tasks sidebar and a contextual evidence inspector — nor for the motion constraint.

| Source | Retrieved | What it supports | What it changed in the implementation |
|---|---|---|---|
| [Apple HIG: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) (page dated 2026-06-08) | 2026-08-09 | a sidebar navigates "areas of your app or top-level collections of content"; no more than two levels of hierarchy; group with disclosure; let people hide it but not by default; **"avoid putting critical information or actions at the bottom of a sidebar. People often relocate a window in a way that hides its bottom edge."** | The six implementation tools left the sidebar (they were panels, not collections). It is now exactly two levels: project → task threads, grouped Current/Earlier. Trust Center is reachable from the title bar and ⌘⇧T as well as the sidebar row, because the old build had Support and Settings only at the bottom edge. |
| [Apple HIG: Split views](https://developer.apple.com/design/human-interface-guidelines/split-views) | 2026-08-09 | first-party precedent for an inspector pane beside a main canvas (Keynote); set sensible min/max pane sizes so the divider stays visible; **"provide multiple ways to reveal hidden panes"** — toolbar button or menu command including a keyboard shortcut; prefer the 1pt thin divider | The evidence inspector is a resizable pane with declared min/max (300–56%) rather than an icon rail plus a dock. It has a title-bar toggle, a close control and ⌘J; every lane also has a palette entry. Dividers stayed 1pt. |
| [ChatGPT: Computer Use](https://learn.chatgpt.com/docs/computer-use) | 2026-08-09 | the current shipped competitor states which app is being controlled, keeps an always-allowed list, documents scoped background macOS work, and promises **"you can stop the task or take over your computer at any time"** | Confirms the Live Target contract is table stakes, not a differentiator: app + exact window, background/foreground per action, and a takeover control that is always reachable (⌘⇧P, task header, inspector). Bimax's addition over this is the per-action end-state receipt and the evidence age. |
| [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) | 2026-08-09 | `reduce` means minimise non-essential motion — the vestibular triggers are "scaling or panning large objects"; the documented approach is to **replace** motion with a muted alternative, not to delete all feedback | `styles.css` previously set `animation: none` plus `transition-duration: 0.01ms !important` on everything, which removed state feedback entirely. Transform-based entrances now collapse to a short opacity fade and only continuous decoration stops. |

Stored material: `../examples/PHASE5_FRONTEND_REFERENCES.md` records the observations and the
decision each one drove. Deterministic renderer artifacts live at
`app/benchmarks/ui/results/phase5/` (journey reports) and `app/benchmarks/ui/screenshots/`
(supported-window-size regression images). The same results folder also stores distinct
`electron-*` records for the built Electron main/preload/supervisor/compiled-provider boundary;
their native target is an explicitly named safe fixture, not a live-app performance sample.

These sources support interaction and accessibility decisions only. No competitive Win, and no
performance or hardware claim, is derived from them.

## Phase 7 macOS release hardening

Accessed 2026-08-09 before changing the release path. These are platform constraints, not evidence
that the current artifact passed them.

| Source | What it supports | Implementation consequence |
|---|---|---|
| [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution?changes=_5) | Developer ID signing precedes notary submission; a successful result produces a ticket that can be stapled | Stable script signs/submits/staples the app before constructing and submitting/stapling the DMG. A local signature is not called notarization. |
| [Apple: Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues) | valid Developer ID Application identity, secure timestamp, hardened runtime, and no debug-only entitlements are baseline requirements | Stable path refuses missing/mismatched nested Developer ID teams and verifies the hardened bundle before upload. |
| [Electron: Security checklist](https://www.electronjs.org/docs/latest/tutorial/security) | context isolation, sandboxing, restricted navigation/new windows, sender validation, and narrow permission handling remain release requirements | Phase 7 preserves the existing security boundary and adds only a no-argument, user-save-dialog export. |
| [Electron: Context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) | expose narrow methods rather than raw `ipcRenderer` | Export is one typed method; filesystem/process authority stays in main. |
| [Electron: Updating applications](https://www.electronjs.org/docs/latest/tutorial/updates) and [autoUpdater API](https://www.electronjs.org/docs/latest/api/auto-updater/) | macOS auto-update requires a signed application | Manual alpha gets a verified transactional manual installer; signed update remains a stable Target. |
| [Electron: Process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox) | sandboxed renderers move privileged work behind IPC | Diagnostic assembly/writing stay in main and renderer receives only `saved/cancelled/failed`. |

Stored local evidence: `../evidence/phase7-local-2026-08-09.json` and
`../18_PHASE7_RELEASE_HARDENING_RECORD.md`. It supports a local arm64 manual-alpha candidate only,
not a public release, Intel build, clean-Mac result, stable channel, or competitive Win.

## Trust Center, native drag and motion hardening

Accessed 2026-08-11 before changing the Trust Center, permission coach, model catalogue and shared
dialog/button motion. These are current first-party platform and interaction constraints; they do
not establish fresh-Mac TCC success or a competitive Win.

| Source | What it supports | Implementation consequence |
|---|---|---|
| [Apple HIG: Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos) and [Settings](https://developer.apple.com/design/human-interface-guidelines/settings) | Mac utilities should expose clear hierarchy and native platform behavior; settings describe user-adjustable app choices, while macOS privacy grants remain system-owned | Trust Center reports live, responsible-host permission readings and opens the exact System Settings pane; it never draws fake grant switches. Required Control Mac grants are separated from optional access. |
| [Apple HIG: Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | Modal work should be focused and avoid unnecessary depth or prolonged nested interaction | Trust Center and Model catalogue each have one fixed header, one scrolling body and one fixed footer. The nested two-scrollbar Trust Center was removed. |
| [Apple HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion) and [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | Motion should clarify state and feedback, remain brief and coherent, and provide a reduced-motion alternative | Dialogs use short opacity/scale entrances, buttons use bounded press feedback, and Reduce Motion removes sheen/scale in favor of opacity feedback. No permanent decorative loop was added. |
| [Apple HIG: Drag and drop](https://developer.apple.com/design/human-interface-guidelines/drag-and-drop) | A drag source should be visibly draggable, the destination should remain clear, and a non-drag alternative should exist | The compact coach names the exact tile, keeps System Settings as the visible destination, supplies Back to Bimax, and never substitutes a fake toggle for a macOS grant. |
| [Electron: Native File Drag & Drop](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop/) and [`webContents.startDrag`](https://www.electronjs.org/docs/latest/api/web-contents#contentsstartdragitem) | A native drag begins in the main process and the drag item requires a file path plus a non-empty icon on macOS | The permission coach resolves the exact responsible host/service bundle and guarantees a non-empty generated raw-bitmap icon before starting the native drag. The main sheet hides so it cannot cover System Settings. A local 2026-08-11 crash report showed `app.getFileIcon()` trapping in AppKit `NSImage` on Electron 43.3.0/macOS 26.5.2, and a 2026-08-12 packaged run showed SVG/PNG data URLs decoding empty, so native/file/codec icon lookup was removed from this path. These are local observations, not broad Electron compatibility claims. |
| [Electron: `BrowserWindow`](https://www.electronjs.org/docs/latest/api/browser-window) | Window show/hide/focus and always-on-top behavior are main-process responsibilities | Electron main owns the permission-coach window choreography and restores Bimax only when the coach closes or the user chooses Back. |
| [Apple: Keychain Services](https://developer.apple.com/documentation/security/keychain-services) and [Electron: `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) | Passwords and keys belong in protected credential storage; on macOS Electron's encrypted storage key is kept in Keychain | Provider API keys are encrypted in main, persisted with private filesystem modes, decrypted only for engine spawn, redacted from IPC recordings, and never sent on NDJSON. |

Local evidence: `app/src/main/__tests__/manual-alpha.trust.test.ts` and the fully green/mutation-aware
renderer record `app/benchmarks/ui/results/phase5/run-2026-08-11T16-02-32-205Z/report.json` (including
J4, J9, J10, J11 and the model-gating J12). Exact-hash local approval is an alpha bridge only: it neither proves builder
identity nor bypasses Accessibility, Screen Recording or any other macOS permission.

Local follow-up evidence, 2026-08-12: the user-controlled `Bimax Drag Verified` native drop reached
System Settings, followed by
`~/Library/Logs/DiagnosticReports/Bimax Drag Verified-2026-08-12-002835.ips` (`SIGTRAP` during
AppKit application reopen) and bounded coach lifecycle logs. The corrected local build passed J4
with M1–M5 rejection, the 64×64 raw-bitmap Electron smoke, 3 focused suites / 9 tests, production
build and strict deep ad-hoc verification. This is a local regression record, not a new external
source and not evidence for clean-Mac TCC, Developer ID, notarization or Product-ready status.

## Computer Use grand-stack verification

Accessed 2026-08-22 before correcting the external grand-stack drafts or changing provider
registration. These sources support research cards and platform constraints; they do not establish
Bimax Measured/Product-ready status or a competitive Win.

| Source | What it supports | Constraint carried into Bimax |
|---|---|---|
| [Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility) and [PR #38102](https://github.com/electron/electron/pull/38102) | `AXManualAccessibility` is Electron's programmatic third-party accessibility switch; PR #38102 fixed its old apparent-failure behavior | Retain the existing one-attempt-per-pid helper path; do not add a duplicate Swift owner or treat historical false failure as the current API contract |
| [Apple ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos) and [SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager) | Desktop-independent single-window filtering and one-shot screenshot APIs exist | Availability is a platform fact; occlusion support and latency remain Bimax measurements |
| [Apple Shortcuts CLI guide](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac) | `shortcuts run` accepts input/output; a shortcut that asks for input pauses | A provider wrapper needs a timeout and visible user-input blocker; the guide does not prove silent consent behavior |
| [Apple Foundation Models updates](https://developer.apple.com/documentation/Updates/FoundationModels) and [macOS 27 overview](https://developer.apple.com/macos/whats-new/) | macOS 27 beta-era dynamic profiles, model protocol, multimodal prompting, OCR/barcode tools, `fm`, Python and updated model behavior | Optional, capability-detected experiment only; base CU continues on macOS 13 without it |
| [Apple `SystemLanguageModel`](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel) and [availability](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.property) (rechecked 2026-08-23) | Apple's on-device model spans macOS 26 and 27 model versions, while readiness varies by eligible device/region/model state and must be checked at runtime | Phase 7 accepts an app-owned availability probe, not an OS-version guess; disabling the optional layer leaves deterministic CU complete |
| [Apple App Intents](https://developer.apple.com/documentation/AppIntents/app-intents) (rechecked 2026-08-23) | Apps expose structured, parameterized actions to Shortcuts/system experiences and receive completion results | Phase 6 evaluates only fixed manifest operations with bounded parameters; model-authored JXA/script/command payloads are rejected |
| [Apple FastVLM research](https://machinelearning.apple.com/research/fastvlm-efficient-vision-encoding) and [official repository](https://github.com/apple/ml-fastvlm) | Research baseline and Apple-Silicon-compatible 0.5B/1.5B/7B artifacts | Candidate grounder; licensing, quality, resource and device gates precede adoption |
| [VPI-Bench](https://arxiv.org/abs/2506.02456) and [WASP](https://arxiv.org/abs/2504.18575) | Visual/web prompt injection remains high-rate in author evaluations | Screen/AX/OCR text is untrusted evidence; add adversarial end-state fixtures |
| [CaMeLs Can Use Computers Too](https://arxiv.org/abs/2601.09923) | Upfront branching-plan isolation gives control-flow integrity but branch steering remains | Typed trusted plan plus auditable branches; regex screening alone is insufficient |
| [CoAct-1](https://arxiv.org/abs/2508.03923) | Hybrid GUI/programmatic delegation improves the authors' OSWorld success and step count | Direct engine shell would violate Bimax's current CU gate; any programmatic path stays provider/broker-owned |
| [Agent Workflow Memory](https://arxiv.org/abs/2409.07429) and [OpenCUA](https://arxiv.org/abs/2508.09123) | Workflow induction and computer-use trajectory pipelines are credible research directions | Replay remains a hint with fresh validation; trajectory retention/export requires privacy controls |
| [WebDreamer](https://arxiv.org/abs/2411.06559), [Agent JIT Compilation](https://arxiv.org/abs/2605.21470), and [Scaling Agents for Computer Use](https://arxiv.org/abs/2510.02250) | Model-based planning, typed invariant protocols, scheduling and trajectory judges improve author baselines | Later experiments only; deterministic postconditions and serial mutation remain hard floors |
| [MacArena](https://arxiv.org/abs/2606.06560) | 421 verified tasks across 50 macOS apps; AIWILD workshop at ICML 2026 | Candidate external comparator; do not label it ICML main-track or replace Bimax's frozen release denominator |
| [Cua Driver contracts](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/contracts.mdx) and [repository](https://github.com/trycua/cua) | The project documents best-effort background macOS delivery and MCP contracts | Competitive evidence only; its private-SPI implementation requires independent license/provenance/distribution review and is not a Bimax copy source |
| [trycua/cua](https://github.com/trycua/cua) at `9545a3d` (2026-09-30), read 2026-10-01: `libs/cua-driver/README.md`, `libs/cua-driver/rust/Cargo.toml` | Driver 0.31.0, MIT, rewritten in Rust with a versioned C ABI and UniFFI SDKs; MCP via the executable; `standard` / `bounded` / `unrestricted` permission modes fixed at launch; "Embedded" mode keeps TCC grants on the host app; no authorization UI of its own (`DriverAuthorizationHost`); optional `cua-perception` is AGPL-3.0-only. Measured on the installed 0.31.0 the same day: telemetry **on by default**; macOS background delivery and exact-window activation call SkyLight private SPI (`SLPSSetFrontProcessWithOptions`, `SLPSPostEventRecordTo`, `SLSEventAuthenticationMessage`, …) and `_AXUIElementGetWindow`, ~60 sites; `@trycua/cua-driver` 0.31.0 (MIT) is on npm | Record 65: candidate pinned dependency for Computer Use primitives, `bounded` only, embedded in Bimax.app; perception extension excluded; private-SPI distribution review still owed (row above); behaviour re-measured in record 65 stage 1, nothing assumed from 0.12.3 |
| [trycua/cua `libs/cua-s1/MODEL_CARD.md`](https://github.com/trycua/cua/tree/main/libs/cua-s1) at `9545a3d`, read 2026-10-01 | CUA-S1: `nano-0.1` ≈ 855K params (Apache-2.0), `forms` 706K (MIT), `4b-0.1/0.2` LoRA adapters on Qwen3.5-4B (Apache-2.0); early research; nano/forms not run in Cua's fixture runs; forms 12/41 on out-of-catalogue labels; 4B base weights 9.32 GB, "8 GB hosts … cannot load" | Record 65 stage 4: nano/forms only, as advisory candidate ranking, measured on Bimax fixtures before use; 4B not on this Mac. Author claims, not Bimax measurements |

Local implementation evidence, 2026-08-22: `../24_CU_PHASE2_DETERMINISTIC_COMPLETION_RECORD.md`
and `../evidence/cu-phase2-local-2026-08-22.json` record the deterministic compiled-provider
postcondition gate and its two false-success mutants. This is not a new external source, live-app
evidence, Product-ready status, or a competitive Win.

Phase 3/4 local follow-up, 2026-08-22:
`../25_CU_PHASE3_PERCEPTION_AND_LATENCY_RECORD.md` and
`../26_CU_PHASE4_UNTRUSTED_OBSERVATION_RECORD.md` record the deterministic full-snapshot/readiness
gate, separate protocol-fixture latency buckets, authenticated pre-observation branch graph, six
killed scope-widening mutants, and one usable bidi benign control. These are local implementation
records derived from the external research constraints above; they add no new external fact and do
not establish live-app performance, broad injection robustness, Product-ready status, or a Win.

## Step 3.7 Flash provider continuity

Accessed 2026-08-28 after the installed Bimax app returned HTTP 410 for a greeting. The live,
authenticated API response is the serving-authority evidence; provider marketing/catalog pages are
discovery evidence only and must not override a failed request.

| Source | Current evidence | Bimax consequence |
|---|---|---|
| [NVIDIA Step 3.7 Flash build page](https://build.nvidia.com/stepfun-ai/step-3.7-flash/build) plus a secret-safe authenticated request to `integrate.api.nvidia.com/v1` | The public page still described `stepfun-ai/step-3.7-flash`, while the live chat endpoint returned RFC 7807 HTTP 410 stating that the model reached end of life on 2026-08-28T08:00:00Z; NVIDIA's authenticated model list contained no StepFun id | Treat the NVIDIA route as retired. Preserve the RFC 7807 `detail` field instead of allowing the OpenAI-compatible client to reduce it to `410 status code (no body)` |
| [OpenRouter: StepFun Step 3.7 Flash](https://openrouter.ai/stepfun/step-3.7-flash) | Current provider page and API slug are `stepfun/step-3.7-flash` | Map the Mac app's exact model family to the OpenRouter wire id only when OpenRouter is selected and keyed |
| [StepFun quickstart](https://platform.stepfun.ai/docs/en/quickstart/overview) and [chat API](https://platform.stepfun.ai/docs/en/api-reference/chat/chat-completion-create) | The direct OpenAI-compatible base URL is `https://api.stepfun.ai/v1`; the direct model id is `step-3.7-flash` | Add a first-class StepFun credential/provider route and keep the key in the existing Electron-main Keychain boundary |

Local evidence: three bounded live NVIDIA request shapes returned the same 410 end-of-life problem,
and an authenticated `/models` query returned no StepFun model. No key or response payload outside
the model/status/detail fields was preserved. OpenRouter and direct StepFun availability remain
unverified from this machine until the user supplies one of those provider keys; this is not a live
successful-answer claim, a Computer Use completion, Product-ready status, or a competitive Win.

## Kimi K3 NVIDIA migration

Accessed 2026-08-29 after the owner directed Bimax to retire StepFun from product routing and make
Kimi K3 the default. The authenticated serving inventory establishes availability only; it does not
establish response latency, tool fidelity, Computer Use quality, Product-ready status, or a Win.

| Source | Current evidence | Bimax consequence |
|---|---|---|
| Secret-safe authenticated `GET https://integrate.api.nvidia.com/v1/models` | The active NVIDIA account returned 83 unique ids, including `moonshotai/kimi-k3`, and no StepFun id. Response rows exposed only `id`, `object`, `created`, and `owned_by`; they did not expose trustworthy capability tags, parameter counts, or release dates, and the sampled `created` value was identical across unrelated models | Remove StepFun from active provider/default routing; use the exact NVIDIA Kimi K3 id; keep live membership as availability truth and source recommendation metadata separately from publisher model cards |
| [NVIDIA Kimi K3 model page](https://build.nvidia.com/moonshotai/kimi-k3/playground) and [NVIDIA API reference](https://docs.api.nvidia.com/nim/re/reference/moonshotai-kimi-k3) | NVIDIA documents native text/image input, tool/function calls, structured output, always-on reasoning, configurable `low`/`high`/`max` effort, a 1,048,576-token context window, and the requirement to replay the complete assistant message including `reasoning_content` and `tool_calls` across tool rounds | Add an exact Kimi K3 capability profile, omit unsupported generic sampling fields, default unspecified effort to `low`, preserve replay-required reasoning only, and count it in context pressure |
| [NVIDIA Nemotron 3.5 Lightning model card](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard), [Muse Glimmer model card](https://build.nvidia.com/meta/muse-glimmer-30b/modelcard), and [Laguna XS 2.1 model card](https://build.nvidia.com/poolside/laguna-xs-2.1/modelcard) | Publisher cards provide model-specific parameter scale, release date, input modality and tool/reasoning claims that the live inventory endpoint omits | Curate recommendation membership and display metadata independently from live availability; mark unmeasured routes `avoidAutoSelect` instead of converting publisher claims into Bimax qualification |
| Installed local manual-alpha package, 2026-08-29 | Recompiled the arm64 engine, rebuilt and locally signed the complete Desktop bundle, installed it at `/Applications/Bimax.app`, and passed the package/signature gate against that exact installed path. The installed `app.asar` SHA-256 is `68015fc7b013857671228c65568d3b67582cd74bf7328793edbf922b03e46ea7`; the bundled engine SHA-256 is `2fa184b0e07db7f0d0a66cbade5a40b9dde65a0cb21fc840595ed229e88e3825`. Fresh app UI inspection showed 83 NVIDIA models served; Kimi K3 recommended in Work and Vision; fast, plain models first in Quick; parameters/release dates/tags in recommendation rows; Browse all expanding uncurated live ids; and a Quick search returning `openai/gpt-oss-120b`. Existing Work selection remained DeepSeek while migrated Quick/Vision resolved to Mistral/Kimi, proving model slots are no longer app-locked | Treat the installed local build as current for owner testing. This proves packaging, catalogue projection and visible selection only; it is not Developer-ID/notarized distribution, a successful Kimi task, a Computer Use completion, Product-ready status, or a Win |

Local qualification boundary: one authenticated catalogue request succeeded. Bounded completion and
streaming probes produced no model payload within 60 seconds on this key; a separate default-effort
attempt was interrupted after more than 120 seconds without a response. Those are provider-route
availability/latency observations, not a model-quality failure and not a valid task evaluation.
Kimi K3 is now the owner-selected default, while coding reliability, tool fidelity, screenshot
grounding, real-app Computer Use and latency remain Target pending healthy repeated runs.

## Coding and knowledge-work ideation refresh — 2026-09-07

Owner request: suggest ambitious features combining the experience of Codex, Claude Code,
ChatGPT Work, and Claude Cowork. This is exploratory product advice, not an implementation or
approval to reactivate Computer Use. The 2026-09-02 code-only boundary remains current.

| First-party source, accessed 2026-09-07 | Documented baseline | Ideation consequence |
|---|---|---|
| [ChatGPT Work getting started](https://learn.chatgpt.com/docs/get-started-with-work) | Files, plugins and approved tools support reviewable briefs, decks, analyses and workflows; local and cloud execution have distinct capabilities | Artifact creation and long-running work are established comparison points; explore consistency across a mission's deliverables |
| [Codex app introduction](https://openai.com/index/introducing-the-codex-app/) | Isolated worktrees, parallel task threads, in-thread review, skills and scheduled automations | Parallel agents alone are insufficient differentiation; explore measurable alternative implementations and durable task state |
| [Claude Code overview](https://code.claude.com/docs/en/overview) | Repository edits, commands, verification, MCP, skills, hooks, memory, parallel agents and scheduled work | Preserve coding depth while exploring broader workflows; do not treat a model selector or subagents as a unique advantage |
| [Claude Cowork product guide](https://claude.com/blog/the-claude-cowork-product-guide) | Local files, connected apps, citations, subagents, long-running work and scheduled tasks | Explore linked code/research/document outputs with inspectable sources and completion checks |

Candidate Targets discussed: durable missions, dependency-aware artifact updates, alternative
implementation comparison, independent falsification, source-linked decision memory, workflow
recipes, budgeted background work, reviewable rollback and resumable provider handoff. These are
proposals, with no claim of novelty, implementation, measured quality, Product-ready status or Win.
Broad knowledge-work scope would require a subsequent product-boundary decision.

Repository context: current README, reset record 30, frontend plan 04, architecture 05, acceptance
gates 08 and gap register were read directly. Dataless research files were consulted through Git
HEAD, including competitive README/02/04, repo audit 01, examples 03, split runbook 06, owner vision
and C01/R01 journeys. Referenced competitive/03_CAPABILITY_MATRIX.md is absent from both the
working tree and HEAD; no matrix findings were inferred. Verification for this refresh is source
inspection only, with no product execution or competitive evaluation.

## Learning-loop evidence — 2026-09-09

- Local first-party source: `src/telemetry/trace.ts`, trace producer in
  `src/core/agent.loop.ts`, and `src/mind/{episode.recorder,epistemic.ledger,policy.arms,stats,harness.tuner,harness.lab.eval,event.ledger}.ts`.
  Current traces record confidence and execution status, but lack mutation paths, verifier scopes,
  request/response recordings and policy assignments. Read-only SQLite inspection found no ledger
  events; WAL/main-file size alone was not used as proof of emptiness.
- Local corpus: 15 `.bimax/traces/*.jsonl` files, 59,454 unique spans, input SHA-256s in
  [`evidence/2026-09-09-learning-loop/report.json`](evidence/2026-09-09-learning-loop/report.json).
  Record 35 distinguishes observational import from replay and from causal experimental evidence.
- Statistical primary source, checked 2026-09-09:
  [Newcombe (1998), interval estimation for the difference between independent proportions](https://pubmed.ncbi.nlm.nih.gov/9595617/),
  DOI `10.1002/(SICI)1097-0258(19980430)17:8<873::AID-SIM779>3.0.CO;2-I`.
  Combines Wilson intervals for independent binomial proportions. The new PolicyArms API uses the
  uncorrected square-and-add form for fixed-propensity binary samples. It does not certify sample
  independence or convert missing/nonrandomized history into a treatment effect. The corpus effect
  and CI are unavailable. Existing Wilson 95% default is a statistical convention, not a tuned
  empirical threshold.

## Live outcome sensor — 2026-09-09

Local source and actual execution, no new external claims: `src/mind/outcome.sensor.ts`, production
calls in `src/core/agent.loop.ts`, string-array export in `src/telemetry/trace.ts`, and
`src/mind/learning.proof.ts`. Evidence and source hashes:
[`2026-09-09-live-learning/manifest.json`](evidence/2026-09-09-live-learning/manifest.json).
Two fresh controlled real-tool runs independently reopen with one resolved claim and nine
hash-valid SQLite events each. These are scripted actions with real file/shell execution, not
model-quality or policy-effect experiments. The raw diagnostic output, before/after state,
span links, source mutants and limitations are preserved. No archive was mined this run.

## Background learning execution — 2026-09-09

Source: `src/core/shell.tasks.ts`, `src/mind/background.evidence.ts`, the AgentLoop/BashTool origin
handoff, and `src/mind/epistemic.ledger.ts`. Preserved local evidence:
[background-learning manifest](evidence/2026-09-09-background-learning/manifest.json).
Five controlled real-tool runs were independently reopened: named failure (source/bundled) resolves
one captured claim; no-file failure, cancellation and an intervening write resolve none. A first
probe observed unchanged bytes/inode/mtime with changed ctime; its cause is unverified. The guard
therefore uses content hash, inode and modification time, not ctime. See record 37 for the exact
limitations, failed attempts, mutants and remaining Targets. No new external/platform claim.

## Computer Use return strategy — checked 2026-09-13

These sources support [record 46](../46_COMPUTER_USE_RETURN_AND_THREADS_STRATEGY.md), a Target strategy.
No benchmark score, current rival superiority or universal novelty claim is imported.

| Source | Inspected evidence | Bounded use |
|---|---|---|
| [Anthropic computer use documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | Host executes desktop tool calls; webpage-only tasks have a separate browser surface; observations can carry prompt injection | Separate browser/native execution and keep host authority; no Bimax performance inference |
| [Apple SCContentSharingPicker](https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker) | System-provided capture picker and stream selection configuration | Prefer supported system capture selection; minimum-OS and fallback qualification still required |
| [MCP tools, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Tool discovery/call contract and host control/security considerations | Generic capability seam; MCP is not an OS sandbox |
| [OSWorld-MCP](https://arxiv.org/abs/2510.24563) | Research benchmark studies tool invocation and GUI operations together | Evaluate hybrid routing; does not demonstrate a Bimax benefit |

Local evidence: current manager/storage/broker/supervisor/sandbox source hashes and six probes in
`../evidence/2026-09-13-threads-audit/results.json`; external archive at
`/Users/vishsiddharth/Developer/bimax-archive/`; native logical adapter and input interlock inspected.
Archive instructions disagree with actual external layout and historical package records. Current
source wins for this audit; native rebuild and provenance qualification remain Target.

## Feature ideation references — checked 2026-09-14

Owner-requested research for additional feature ideas. Inspected paper abstracts, official project
documentation and repository READMEs; no full-paper replication, code execution, license clearance,
or competitive evaluation. These are mechanisms to explore, not evidence of Bimax implementation,
market uniqueness or performance. All proposed combinations remain **Target**. Existing code-only
gates remain active; native observation/control proposals require a separate Desktop-owned slice.

| Primary source | Bounded evidence and proposed use |
|---|---|
| [DynaSaur paper](https://arxiv.org/abs/2411.01747), [official repository](https://github.com/adobe-research/dynasaur) | Dynamic programmatic action creation and reuse; inspiration for promoting tested task helpers into reusable personal capabilities. No automatic self-improvement or latency claim. |
| [Proactive Agent paper](https://arxiv.org/abs/2410.12361), [official repository](https://github.com/thunlp/ProactiveAgent) | Proactive task prediction and accepted/rejected assistance; inspiration for an opt-in repeated-friction detector. User acceptance and interruption cost need local evaluation. |
| [Pare](https://arxiv.org/abs/2604.00842) | Evaluates proactive assistants with simulated active users; supports testing intervention timing, not assuming that observation implies permission. |
| [Sketch-n-Sketch tutorial](https://ravichugh.github.io/sketch-n-sketch/tutorial/02.html), [repository](https://github.com/ravichugh/sketch-n-sketch) | Direct manipulation of computed output can imply multiple program updates; inspiration for constrained result-to-source editing with visible alternatives. General cross-app inversion is not established. |
| [AppWorld](https://arxiv.org/abs/2407.18901) | Controllable app environment for interactive coding-agent evaluation; inspiration for bounded rehearsal against fixture state, not a complete clone of a user's Mac. |
| [WebArena repository](https://github.com/web-arena-x/webarena), [Generative Agents](https://arxiv.org/abs/2304.03442) | Functional web-task evaluation and simulated behavior respectively; inspiration for synthetic exploratory testers. Such agents cannot certify real-user usability or conversion. |
| [Microsoft UFO](https://github.com/microsoft/UFO) | Desktop/device orchestration research reference; possible inspiration for cross-surface semantic handoff. Windows implementation is not a qualified Mac executor. |
| [Screenpipe](https://github.com/screenpipe/screenpipe) | Local computer-history infrastructure reference; inspiration for explicit, scoped task provenance. Continuous capture is not required or enabled by this proposal. |
| [Apple FastVLM](https://github.com/apple-aiml-research/ml-fastvlm) | Official vision-language implementation; candidate for bounded visual interpretation experiments. No Bimax device latency, energy, privacy or grounding claim follows. |

Guidance: product-reset README, product examples/frontend plan, Mac Buddy vision, record 46,
competitive README/rival studies/model-independent strategy/gap register, and acceptance gates.
The previously recorded missing capability matrix remains unresolved. Only this source ledger was
updated; no product capability or gap status changed. Verification: primary-source URL inspection
and review of the appended record; no runtime tests warranted for this documentation-only entry.

### Long-running agent follow-up — checked 2026-09-14

Inspected [Anthropic's Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
(published 2025-11-26). The article reports incremental work, explicit feature requirements,
persisted handoff artifacts and end-to-end browser checks as responses to context loss and premature
completion. It explicitly says compaction alone is insufficient. Use as support for evaluating
durable Bimax missions with independently checked milestones; it does not prove Bimax reliability,
general Mac automation, or that multiple agents outperform one. Proposed mission features remain
**Target**. Record 46's queue/restart/storage findings remain audit evidence, not newly reproduced
results. No runtime or product-status changes; verification was source inspection only. Existing
acceptance gates and the missing capability matrix/topology conflicts remain unresolved.


## RAG and context compiler research — checked 2026-09-14

See [record 47, research ledger](../47_RAG_AND_CONTEXT_COMPILER_UPGRADE.md#7-research-and-inspected-open-source-ledger)
for exact primary-source URLs, inspected paper versions, pinned code links, applicability and limits.
The research covers LongMemEval, HippoRAG 2, Recursive Language Models, Sufficient Context,
Lin–Bilmes submodular summarization, and Build Systems à la Carte verifying traces. Five upstream
repositories were inspected: HippoRAG, RLM, Aider, Graphiti and QMD. Their exact commits, file hashes
and license metadata are preserved in
[evidence manifest](evidence/2026-09-14-context-audit/upstream-index.json). No upstream code was
executed or incorporated. Paper benchmark results are not transferred to Bimax.

Local evidence: eight synthetic audit limitations reproduced under Bun, source hashes preserved;
56 existing focused tests passed. Initial Node FTS5 failures are retained as invalid SQLite probe
results. All compiler mechanisms remain **Target**, with no measured quality or competitive claim.
Guidance and unresolved missing capability-matrix/topology documentation are recorded in record 47.

## God's Land (notch deck) research — checked 2026-09-25

See [gods-land/02_RESEARCH.md](../gods-land/02_RESEARCH.md) for every URL. Three repositories were shallow-cloned
outside the repository and their window, event and drop code read: boring.notch@bf0724d NotchDrop@e70b3d7 DynamicNotchKit@cd0b3e5 . Licenses: boring.notch
**GPL-3.0** (study only, no code reused), NotchDrop and DynamicNotchKit **MIT**. Data sources: gitleaks rules **MIT**;
ClearURLs rules **LGPL-3.0+** (not bundled). Platform facts recorded there and marked for re-checking on this Mac:
pasteboard privacy (`NSPasteboard.accessBehavior`, macOS 15.4+), ScreenCaptureKit ignoring `sharingType = .none`
(macOS 15+), three haptic patterns only, Electron's declined notch API, Liquid Glass merging
(`NSGlassEffectContainerView`, `glassEffectID`). Papers: Citrine (UIST 2004), Quick Access (KDD 2017) and its
KDD 2020 follow-up, Stuff I've Seen (SIGIR 2003). No code was executed or incorporated; no claim about Bimax follows.


## Providers, rate limits and MCP sign-in — checked 2026-09-28

Used by [record 62](../62_PROVIDERS_KEYS_MCP_AND_BUGFIX_RECORD.md). Re-check before relying on them; these change.

- OpenAI models page (`https://developers.openai.com/api/docs/models`, redirected from platform.openai.com): current ids
  `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`. `.../models/gpt-6-sol`: Chat Completions and Responses supported; "Chat
  Completions supports function calling only with `reasoning_effort` set to `none`"; 1,050,000 context, 128,000 output.
- Google Gemini models (`https://ai.google.dev/gemini-api/docs/models`): `gemini-3.8-flash`, `gemini-3.1-pro-preview`,
  `gemini-3.5-flash-lite` among current ids; Gemini 2.0 and 3-series previews deprecated. OpenAI compatibility page
  (`https://ai.google.dev/gemini-api/docs/openai`) says Gemini 3 supports thought signatures through Chat Completions but
  did not state the field; `extra_content` pass-through is a defensive choice, not a verified contract.
- DeepSeek pricing/models (`https://api-docs.deepseek.com/quick_start/pricing`): `deepseek-flash` (V4.1 Flash, 1M, tools,
  vision) and `deepseek-v4-pro`.
- Anthropic OpenAI SDK compatibility (`https://platform.claude.com/docs/en/api/openai-sdk`): base `https://api.anthropic.com/v1/`;
  tools, `tool_choice`, `parallel_tool_calls`, streaming supported; `reasoning_effort`, `response_format` ignored; prompt
  caching not supported; "not considered a long-term or production-ready solution for most use cases". Model ids
  `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`.
- OpenRouter public model list (`https://openrouter.ai/api/v1/models`, 458 models, 390 with `tools`): `anthropic/claude-sonnet-5`,
  `openai/gpt-6-sol`, `google/gemini-3.8-flash`, `moonshotai/kimi-k3`, `openai/gpt-oss-20b`.
- NVIDIA API catalog free tier: 40 requests/minute per model at the account level (third-party guides and NVIDIA
  developer-forum threads found by search; no first-party page was fetched). Measured here: `/models` lists
  `mistralai/mistral-7b-instruct-v0.3` and `google/gemma-3-4b-it`, and chat requests to both return 404 for this account.
- MCP TypeScript SDK 1.29.0 (local `node_modules`): `OAuthClientProvider`, `StreamableHTTPClientTransport.finishAuth`,
  `UnauthorizedError`, `ListRootsRequestSchema`, `ToolListChangedNotificationSchema` — read from the installed type
  definitions, exercised by `mcp.allservers.test.ts`.

## 2026-10-02 — pinned Cua Driver authorization-session lifecycle

Inspected first-party source in the existing research checkout at
`~/Developer/bimax-research/cu/cua/libs/cua-driver/rust/crates/` (the pinned 0.31.0/9545a3d baseline already recorded
in record 65). `cua-driver-core/src/session_authorization.rs` explicitly expires contexts on absolute/idle leases,
returns “authorization context expired”, and refuses duplicate public/transport binding to a live context.
`cua-driver-core/src/authorization.rs` checks that context before dispatch; its “Permission denied” text can therefore
mean native context expiry rather than macOS TCC. `cua-driver-sdk/src/abi.rs` closes native session handles through
`session_destroy`. No source was copied or dependency upgraded. Installed run 4 corroborates expiry after an approval
wait and label-reuse failure; the correction and limits are in record 65 §6h and `evidence/2026-10-02-cu-session-renewal/`.

## 2026-10-02 — Accessibility diagnosis and macOS 27 permission label

Independent System Settings UI inspection on the owner's macOS **27.0** (`sw_vers -productVersion`) shows
Privacy & Security → **Device Control and Data Access**, with Bimax on. This is observed on one Mac, not a universal
version-matrix claim. No grant was changed. The pinned Cua 0.31.0 source (`platform-macos/src/tools/get_window_state.rs`)
contains accessibility-word errors for an AX walk backstop, `ax_app_launching`, `ax_window_unresolved` and `ax_tree_empty`;
these are observation degradation, not evidence of TCC denial. Inspected Electron's shipped `electron.d.ts` confirms
`systemPreferences.isTrustedAccessibilityClient(prompt)` and `process.getSystemVersion()`; Bimax uses `false`, only after
an admitted failed look, and chooses the settings label from the actual OS version. No SDK code copied or dependency
changed. Record 65 and `evidence/2026-10-02-cu-permission-diagnosis/` preserve the failure trace and limitations.

## 2026-10-02 — installed closed-Music recovery failure

Local evidence only: saved Bimax Thread `6055c9bd-83e2-4de2-94cf-f32695321999`, 10:52 UTC,
and the installed archive/engine hashes matching the previous diagnosis install. Music's bundle id was absent from
discovery, the shell rejected `open -a Music`, and the model did not try the already-permitted background launch.
No Music window was read or input dispatched. This is a model recovery failure, not new evidence of TCC denial or
background search failure. The source correction and bounded tests/mutants are in record 65 and
`evidence/2026-10-02-cu-launch-recovery/`; no external platform claim or competitor source is introduced.

## 2026-10-05 — fresh chat evidence and code-behavior proposal

Current source inspected: `startEngine`/ThreadManager project selection, BasePersona harness lab,
RecordedReplayBackend/AgentLoop, engineEvents/ProtocolHost/SessionRecorder, renderer/preload owner
subscriptions and episode fencing. A real recorded call is delivered to live listeners before the
fix; record 69 preserves final-state regressions, eight mutants and local installation evidence.
No user transcript or credential contents are published.

Primary documentation rechecked for record 70 on 2026-10-05:
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer): action before/after DOM,
  source, console and network exploration are existing building blocks, not a novel Bimax feature.
- [OpenTelemetry JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/):
  active asynchronous context and nested spans support causal correlation; this alone does not
  recover arbitrary function locals or explain all behavior.
- [Sourcegraph precise code navigation](https://sourcegraph.com/docs/code-navigation/precise-code-navigation):
  compiler-generated SCIP indexes support precise symbol navigation.

The joined symbol/execution/reproducer/revision product and its proposed usefulness are our design
inference, not a claim about rival absence, market novelty or measured superiority. All slices Target.

## 2026-10-06 — background task lifecycle and pipe decoding

Primary sources rechecked for record 71:

- [Node child processes](https://nodejs.org/api/child_process.html): detached POSIX children form
  process groups; close follows child exit and stdio closure; sending a signal does not establish
  termination and SIGTERM can be handled without exiting. Bimax's real fixtures independently
  verify cooperative cancellation, resistant parent/descendant removal and drained output.
- [Node StringDecoder](https://nodejs.org/api/string_decoder.html): decoding keeps incomplete
  multibyte characters until subsequent bytes arrive and end flushes the remaining input. Bimax's
  controlled split-byte fixture verifies its actual shell output rather than a copied algorithm.

Inspected local BashTool, shell tasks, TaskRegistry, sub-agent blackboard/manager, tool factory,
shared taint channel and background evidence observer. No competitor source copied; no new
external model, service, platform-performance or competitive-superiority claim introduced.

## 2026-10-06 — transaction lifecycle and bounded filesystem snapshots

Primary documentation rechecked for record 72:

- [Node 22 filesystem API](https://nodejs.org/docs/latest-v22.x/api/fs.html): FileHandle open/stat/read/
  close APIs support reading through one descriptor; reads may be short and callers must fill the
  requested range themselves. Filesystem checks do not make a later operation race-free. The bounded
  allocation, shared reservation and post-read rejection policy are Bimax implementation choices,
  verified with real file growth/replacement fixtures and controlled short reads, not Node guarantees
  of atomic multi-file rollback or an externally measured performance claim.

Inspected TransactionManager, `/tx`, actual write/edit/delete/multi-edit call sites and existing
rollback tests. Record 72 preserves initial failures, mutation/restoration hashes and final-state
filesystem checks. Missing competitive matrix and referenced reset records are explicitly reported.
No competitor source reused, provider/default/credential changes, install or public Win claim.

## 2026-10-06 — Bimax Thread undo containment and verification

[Record 73](../73_THREAD_UNDO_RELIABILITY_SPRINT.md) uses inspected app undo/Bin/IPC and engine
journal/governor source, real scratch-file assertions and executable source mutations.

- [Node 22 filesystem API](https://nodejs.org/docs/latest-v22.x/api/fs.html), opened as current
  first-party documentation: realpath resolves filesystem links; lstat identifies the link itself;
  copyFile supports exclusive destination creation and is not promised atomic; FileHandle
  open/stat/read/close supports descriptor checks and bounded streaming. These inform canonical
  parents, exclusive staging, nonblocking regular-file checks and byte/mode read-back. They do not
  establish protection against cross-process path swaps, durability/fsync, Bin permissions,
  recursive directory integrity or historical source-copy provenance.

No competitor/platform superiority claim or imported source is involved. Installed native Bin,
crash recovery and performance measurements remain Target/unmeasured; missing reset records are
reported in record 73. First-party API text is evidence of semantics, not a successful Bimax journey.

## 2026-10-06 — PDF footer pagination and owned reader jobs, round 4

[Record 74](../74_PDF_RELIABILITY_SPRINT.md) repairs inspected document paths in the current
55/64/66 monolith; no dependency or competitor source is imported.

- [PDFKit text documentation](https://pdfkit.org/docs/text.html), opened 2026-10-06: text flows
  into new pages; width selects a wrapping region and lineBreak is documented as disabling
  wrapping. Inspected installed PDFKit **0.20.2** selects its LineWrapper when an explicit width
  exists even with lineBreak:false. Real Poppler page-count/text assertions reproduce the footer
  adding a page, so the repair omits width and measures placement instead of relying on that
  general documentation sentence. bufferPages retains pages for explicit numbering.
- [Node v22.17.0 child-process documentation](https://nodejs.org/download/release/v22.17.0/docs/api/child_process.html):
  spawn owns pipes; close follows exit and stream closure; detached establishes a new process
  group/session on non-Windows platforms. execFile's convenience behavior is not a whole-tree
  termination guarantee. [Process signals](https://nodejs.org/download/release/v22.17.0/docs/api/process.html#processkillpid-signal)
  distinguish a signal sender from observed process death; signal 0 checks existence.
  [Versioned util documentation](https://nodejs.org/download/release/v22.17.0/docs/api/util.html)
  was also inspected during diagnosis; the actual callback/promisified Poppler probe completed.
  No promisify defect is claimed. These are explicit versioned first-party pages, not a claim to
  have read latest-v22 pages (those requests were inaccessible). Actual test runtime: **22.13.1**.
- Inspected local `/opt/homebrew/bin/pdftotext -v`: **Poppler 26.08.0**. Actual generated-file
  metadata/text and three rendered pages qualify the local artifact. The attempted upstream
  GitLab man-page URL was inaccessible and is not relied on as retrieved evidence.
- The unchanged layout-suite process trace records a footer-only OCR invocation taking 21,369 ms,
  while Poppler extraction/metadata complete in tens of milliseconds. That trace supports the
  specific unnecessary-OCR diagnosis, not general native OCR reliability or a speedup benchmark.

General OCR, clean-Mac tooling/distribution, installed/provider journeys and resource/performance
qualification remain Target. Details and exploratory fixture exclusions are retained with record 74.

## 2026-10-14 — RAG resources and public qualification, record 96

[Record 96](../96_RAG_RESOURCE_AND_PUBLIC_QUALIFICATION.md) uses inspected current memory retrieval, frozen record-95 and pre-95 source, exact-output contracts and retained measurements. Current first-party benchmark sources were checked before inference; their status does not imply a completed or reference-comparable Bimax benchmark.

- [Classic LongMemEval repository](https://github.com/xiaowu0162/LongMemEval), pinned code revision `9e0b455f4ef0e2ab8f2e582289761153549043fc`; [official task-specific judge](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py) and [MIT license](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/LICENSE). Only `get_anscheck_prompt` is executed through AST extraction in the evaluator; its exact source and Di Wu copyright/license are preserved in record-96 `research/`. No upstream evaluator imports/driver run. Configured NVIDIA gpt-oss-20b differs from the listed reference judges. An initial model control rejected the published temporal off-by-one tolerance; the system instruction now spells out that same rule, with negative controls, before public answers are generated.
- [LongMemEval cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f): pinned revision, 500-question `longmemeval_s_cleaned.json`, MIT metadata, 277,383,467 bytes, downloaded SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`. Exact content-range resumptions and schema/size checks preserve failed downloads; full data is outside the repository. The selected 100 histories exclude answer annotations from retrieval input.
- [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench), pinned code revision `538026089d1a8a8eff05121d0db89b388f360eba`; [evaluation utilities](https://github.com/HUST-AI-HYZ/MemoryAgentBench/blob/538026089d1a8a8eff05121d0db89b388f360eba/utils/eval_other_utils.py) and [MIT license](https://github.com/HUST-AI-HYZ/MemoryAgentBench/blob/538026089d1a8a8eff05121d0db89b388f360eba/LICENSE) inspected and retained as references, with their source attribution. EventQA's published recall requires every answer element; RULER QA reference answers are alternatives. The qualification judge follows these distinctions; normalized EM/F1 are supplementary, and its model-judge score is not an official MemoryAgentBench leaderboard metric. No upstream utility module or network/chunking helpers are imported into production.
- [MemoryAgentBench dataset](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/tree/7ea066982b140a19337e17e60d45d4076e042faf): pinned revision, `Accurate_Retrieval` has 22 contexts/2,000 questions, MIT metadata, 20,024,386-byte parquet, SHA-256 `56c3cd80fb6731a3e53cd1a6be3148f54df60ff2d290ee50e28f8acebf9655c1`. Fixed balanced selection takes 100 questions across six families and 21 contexts. The whole context is ingested; oracle evidence-session metadata stays outside the index. Other competencies are unmeasured.
- [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) is a distinct newer benchmark inspected during scope research. Classic LongMemEval_S results must never be labelled V2 results. V2 remains Target.

`research/source-provenance.json` records exact source URLs, revisions and SHA-256 hashes; the previously downloaded judge bytes match the pinned revision. The owner's selected 200-question balanced qualification uses real preinstalled all-minilm embeddings and configured NVIDIA gpt-oss-20b for answering/judging, with provider/model differences disclosed. Baseline/current prompt equality shares one reader observation per question, so it cannot establish independent accuracy improvement. Source licenses allow this benchmark-reference reuse; no competitor product implementation is copied. Installed/full-suite/reference-model/independent-judge/rival/release gates remain Target.

The retained MemoryAgentBench reference utilities attribute DensePhrases. Its pinned Apache-2.0 license is preserved alongside the MIT benchmark license (`research/DensePhrases-LICENSE` and license-provenance JSON); no DensePhrases module is imported or executed. Adapter provenance allows only production chunker whitespace changes, retaining exact source hashes and shown spans. all-minilm context overflow is explicitly measured per batch and permits declared provider prefix truncation, rather than silent corpus loss or fabricated vectors.

The pinned Hugging Face tree APIs independently confirm both downloaded file SHA-256 values against their LFS OIDs (`dataset-lfs-verification.json`). A selected-history shape audit confirms aligned session/date arrays and string messages, but finds three repeated session IDs with differing dated text. The qualification adapter assigns occurrence IDs while retaining original benchmark aliases outside the embedding text; all histories stay intact. None of those duplicated IDs is a gold answer-session label. This is a declared input-identity repair, not evidence of a production quality gain. Failed uniqueness assumptions and the first raw retrieval run are retained.

## 2026-10-14 — Power-loss recovery and configured alternate model

The Mac shut down after local retrieval qualification completed. All 200 corrected contexts and their source/prompt/provenance observations survived; the temporary raw dataset cache did not. `power-recovery.json` verifies the current production, worker, compiled and recall/chunking dependency hashes against the saved retrieval run. Answering from those saved contexts requires neither redownloading the public datasets nor re-embedding 90,648 chunks. The original Python 3.13 runtime remains installed; the post-reboot shell defaults to Python 3.14/Node 24, so historical resource timings retain their original Node 22 runtime attribution. No cross-runtime speed comparison is made.

The owner explicitly authorized another configured model after checking availability. Readonly global configuration names `nvidia/nemotron-3.5-lightning-30b-a3b`; a real availability probe returned HTTP 200, complete `READY`, in 959 ms (`alternate-model-availability-1.json`). Presence/one response qualifies availability only. Its non-thinking judge pilot failed abbreviation and temporal-tolerance controls and produces no public score. A fresh bounded-reasoning profile keeps the question set, retrieval, rules and expected labels unchanged.

- [NVIDIA model API example](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/build), checked 2026-10-14: exact served model ID, compatible endpoint and `chat_template_kwargs.enable_thinking` example.
- [NVIDIA inference reference](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b-infer), checked 2026-10-14: maximum generation tokens, reasoning budget applying when thinking is enabled, JSON/SSE responses and distinction between completed 200 and pending 202. The completed judge qualification uses explicit 1,024-token reasoning with a 2,048-token completion cap; pending/error/truncated observations cannot become valid answers.

These first-party API facts do not prove Bimax answer quality. Current model choices are per-invocation benchmark flags; user config and credentials remain unchanged. All gpt-oss timeout/control failures and alternate pilots are retained separately, never merged into an accuracy denominator.

Before selected-question inference, bounded-reasoning pilots exposed wrapper ambiguities: a reused concrete example distracted the correct-target case, and “exact entity” was read as exact wording. The wrapper now explicitly accepts equivalent meanings/abbreviations while requiring the requested subject/relation, consistent with the published rubric. No expected labels or selected questions changed. The final Lightning profile passes all 17 controls; all failed pilots are preserved.

The final `public-answer-nemotron-4` run completes 200/200 valid selected questions: classic LongMemEval judged accuracy 40/100 (26/85 answerable), MemoryAgentBench custom judged accuracy 39/100. `public-answer-qualified.json` verifies raw reader prompts/predictions, raw judge verdicts, counts and all frozen source/dependency hashes. Licensed upstream MemoryAgentBench helpers produce 22.00% EM, 35.25% token F1 and 37.00% substring EM under the published family postprocessing; ROUGE/full official evaluation is absent. These are balanced-subset observations with a different model/backend, not official scores, quality improvements, population estimates or competitive claims. The 94.06% answerable source-session recall does not establish sufficient shown evidence or correct answers.

Five separately recorded preference/all-elements controls also pass under the frozen profile after main inference; their inputs were declared before completion, contain no benchmark cases, and cause no grading or production changes. All raw requests, wrong answers, invalid attempts and failed pilots remain intact. Final-run usage is 571,839 total tokens including its initial controls/failed attempts with usage; the five extra controls add 4,193 tokens. Endpoint currency cost is unavailable and not inferred. Reader/judge accepted-attempt latency, retries/pacing, embedding truncation, resource samples, test failures and nominal-interval limitations are separately attributed in record 96. Independent judging, heldout evidence-sufficiency experiments, full suites and installed/release gates remain Target.

## 2026-10-14 — RAG answering evidence, record 97

[Record 97](../97_RAG_ANSWERING_EVIDENCE.md) develops source-window/date preservation and bounded evidence allocation on independent constructed fixtures. The old 200 scored questions are excluded by ID and normalized question text from the new paired qualification; production and reader/judge profiles freeze before scoring. No competitor implementation or new dependency is copied.

- [LongMemEval first-party repository](https://github.com/xiaowu0162/LongMemEval), opened again 2026-10-14: timestamped sessions, explicit source/evaluation annotation separation, turn/session retrieval granularities, and reader experiments that extract relevant information before reasoning. This supports preserving actual source dates and separately checking shown evidence; it does not prove a Bimax accuracy gain. Classic and V2 remain distinct. Record 96's pinned MIT rubric/dataset bytes remain the evaluation references.
- [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval), opened 2026-10-14: discusses context loss in isolated chunks and adding context before embedding/lexical indexing. Bimax's change quotes existing source headers at reading time; it does **not** implement Anthropic's generated contextual-embedding method or inherit its reported gains.
- [Sentence Transformers Retrieve & Re-Rank](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html), opened 2026-10-14: separates efficient candidate retrieval from joint query/passage scoring. This is a reference for retaining separate stage-quality measurements. This round keeps existing ranking/reranker behavior and measures evidence assembly; it does not introduce or qualify a new cross-encoder.

Independent fixtures reproduce long-line head truncation, source/chunk starvation and lost date headers. Ten evidence cases, focused/context suites and nine assertion-caught real source faults scope local implementation; the unchanged context benchmark remains 43/43. The new default excerpt allowance is 6,000 versus 1,800 characters, with caller overrides retained; token/latency/resource costs must accompany any answer gain. Real all-minilm vectors, explicit truncation and a benchmark-only digest/role/text-addressed cache remain declared. Same configured Nemotron reader/judge and exact frozen rubric/functions are used in both arms. The complete paired audit now measures a rejected prototype; final results and rejection are recorded below. Installed/full-suite/independent-judge/release/Win remain Target.

NVIDIA serving repeatedly returns HTTP 429 during qualification, including below the configured 40-request/minute ceiling. [NVIDIA RAG troubleshooting](https://docs.nvidia.com/rag/latest/troubleshooting.html), rechecked 2026-10-14, identifies 429 as an API service limit; it supplies no exact limit or credit balance for this endpoint. [NVIDIA Data Designer's model-stack notes](https://docs.nvidia.com/nemo/datadesigner/dev-notes/owning-the-model-stack), rechecked 2026-10-14, describe shared capacity feedback, reduced concurrency and Retry-After-aware cooldown, keeping capacity signals distinct from transient transport faults. These support a benchmark-only transport recovery wrapper; no NVIDIA implementation is copied and no production provider policy changes. The first wrapper admits at most ten requests/minute and two simultaneous HTTP calls; its conservative successor admits three requests/minute and one HTTP call. Both record actual HTTP and admission wait separately and preserve every valid answer across resume regardless of correctness. It does not prove the cause of this account's throttling or a product performance gain.

Following reported Mac crashes, a readonly diagnostic check finds watchdog reports without establishing cause. The new benchmark-only durable wrapper preserves frozen request/judge/source/selection semantics and uses file/directory fsync plus create-only atomic publication. Five tiny offline end-state/process-termination checks, an assertion-caught direct-overwrite fault and a fake-transport exact-body preflight support this receipt writer only. `public-answer-8` reuses 321 valid arms at nice 10, three requests/minute and one HTTP call; one client snapshot is about 59 MiB RSS and 0% CPU. No local embedding or broad build/test rerun, macOS settings change, hardware durability or installed C04 claim. A 43 MiB same-volume recovery archive has every file hash verified; it is not a disk-failure backup. Current diagnostic/recovery receipts are in record-97 evidence.

The final record-97 paired audit completes 400 valid arms: classic LongMemEval 43→64/100, answerable 29→49/85, MemoryAgentBench custom judge 51→45/100. All three EventQA family totals decline, so the predeclared adoption rule rejects the candidate; production recall and generated runtime return to starting behavior. Reader input rises 2.45×. All 1195 attempts,334 throttling responses,1,413,836 reported tokens, source/raw request/usage audits and five failing observation faults remain preserved. The rejected source/tests are archived without weakening assertions;32 restored recall/RAG tests pass. An explicit hash-checked source snapshot permits reproducible re-audit after production restoration. The owner authorizes only 50 fresh questions (25 per dataset) for the next qualification; no result from that revision is yet measured.

## 2026-10-14 — Complete passages and fresh 50 pilot, record 98

[Record 98](../98_RAG_COMPLETE_PASSAGES.md) keeps its revision isolated after rejecting record 97. Newly checked first-party [LlamaIndex parser documentation](https://developers.llamaindex.ai/python/framework/module_guides/loading/node_parsers/modules/) distinguishes complete sentences, reader context windows and hierarchical expansion. Bimax preserves complete existing matched passages; it imports no parser/auto-merging implementation and claims no inherited gains. [Ollama embed API](https://docs.ollama.com/api/embed), [FAQ](https://docs.ollama.com/faq) and [official typed options](https://github.com/ollama/ollama/blob/main/api/types.go) document runtime options/truncation/keep-alive and num_gpu/num_thread fields. Installed 0.40.4 independently returns real 384-dimensional all-minilm embeddings with zero loaded VRAM for the CPU control. Cached original vectors retain exact model-digest/role/text identity and conservative flags; a read-only seed and separate batched overlay avoid copying the large cache. Streamed preparation,14 fixtures,11 source faults, cache rollback controls and hashes scope local evidence. The 50-question paired pilot excludes all earlier 400 IDs/normalized questions and remains unmeasured until all 100 arms pass audit. No production, OS settings, configuration, CU/UI, installed or release change.

The completed record-98 pilot audits all 100 valid arms and rejects the isolated candidate under its unchanged rule: classic LongMemEval judged answers 6→13/25, MemoryAgentBench custom judged answers 15→15/25 with three gains/three losses and two declining EventQA families. These new paired denominators cannot be compared directly to earlier subsets. Reader input rises 31,179→78,279 tokens (2.51×); all 259 attempts and 360,145 reported total tokens remain recorded. Same-model semantic agreement remains unqualified: one lost response ends with the reference choice after long analysis, but the frozen judge marks it false. No score/profile/parser change follows this observation. Preserved upstream MAB helpers yield EM 36→40%, F1 45.77→49.48% and substring EM 52→56%; these do not override the adoption rule. All 19 frozen dependencies, 41 raw corpora and 722 shown spans match; five altered observations are caught. Production source/vector store/staging engine remain at baseline. One 256-MiB heap-limited regression invocation aborts; one identical-assertion 512-MiB-cap retry passes all 32 tests, observing 626,491,392 bytes maximum RSS and zero process swaps. No installed, crash-fix, population/reference leaderboard, release or Win claim follows. The authorized fresh 50-question scope is complete.
