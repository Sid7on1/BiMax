# 68 — External fault audit, current-source verification and repair

Audit started: 2026-10-04; final local qualification continued on 2026-10-05 (Asia/Kolkata). Scope: the current desktop monolith, with Computer Use retired by record 66.
The supplied audit read the August public tree. Existing owner changes are preserved.
Guidance: README, 01/03/04/05/06/07/08, vision, competitive README/02/04/05/06/07,
C01, R01 and R02; records 54/63/64/66 supersede historical boundaries.
`competitive/03_CAPABILITY_MATRIX.md` is missing (already recorded in the gap register).

## Verified disposition and delivery order

| Audit item | Current finding | Repair / qualification |
|---|---|---|
| 1 sandbox and shell grants | All app engines already force folder-write containment; reads/network are intentionally open. Background direct/retry entry bypasses sandbox; legacy OS_COMMAND grants are broad | Share execution isolation on background/retry; preserve documented read/network stance; exact-command grants, fail-closed answers and a permission-specific reader check |
| 2 hard loop signals | Real: hard signals add prose and do not halt | Halt after bounded hard rounds; immediate circuit-breaker stop; drain tool replies |
| 3 verification | Real: updateTask bypasses delegated validation; build criteria ignore scope | Route verified status through fresh trusted validation; bind build criteria to exact scope; reject sibling/subfolder global proof and scoped no-tests success without execution attestation |
| 4 redaction | August claim stale for ledger/log/episodes/transcripts and modern shapes; trace exporter still unsanitized | Scrub before trace ring, JSONL and OTLP export; preserve existing shared secret scanner |
| 5 defaults/wallet | BYOK exists; Kimi default exists; no prepaid service. Launch premise is not established | Keep current BYOK and saved choices; prepaid service/default-model changes are a separate owner decision |
| 6 file provenance | Real: file reads/search excerpts are not fenced or tainted | Add file channels using the shared provenance list; enforce taint before Thread/bypass/grant shortcuts |
| 7 retrieval | False in current tree: BM25, FTS5, dense seam, RRF and reranking exist | Keep honest degradation; provider-backed quality remains Target |
| 8 per-run cost | Real flat rate and output-only reservations; daily/machine/per-Thread caps already exist | Separate input/output/cache rates; configurable route rates with explicit estimate fallback; shared per-run token/spend reservation across worker fan-out |
| 9 skills | Both loaders live, but JSON defines personas and SKILL.md defines knowledge | Remove ambiguous naming: custom persona configs are not Agent Skills; keep compatibility with existing JSON personas |
| 10 store query work | Real: every query reparses disk and rebuilds BM25 | Cache by file identity/stat; reload external replacements and deletion, keep recency; persist atomically |
| 11 prompt cost | Stable prefix/session suffix and tail placement already exist; caching is provider-dependent | Bound optional turn context without dropping safety/contract blocks; add RepoMap opt-out; no invented NIM cache guarantee |
| 12 identifiers | Real BM25 camelCase weakness, FTS exact identifier already works | Preserve whole identifier and add split components in shared lexical tokenizer |

## Verification contract

Use synthetic secrets and disposable fixtures only. Reproduce each defect with assertions, then
run relevant regressions, engine/app typecheck and builds, protocol fixtures and offline suites.
Mutation checks must catch missing halt, scope binding, redaction, provenance, background containment,
run ceiling and cache invalidation. C01 dirty-worktree preservation is mandatory.
Live-provider, installed app, clean-Mac qualification and competitive Win remain Target unless separately proven.


## Delivered changes and boundaries

**Implemented and locally verified**, not Product-ready or a competitive Win:

- Foreground/background/retry shell paths use the same OS sandbox profiles and scrubbed child
  environment. An explicitly enabled but unavailable sandbox refuses. All app engines already
  enabled folder-write containment. Record 54 intentionally permits reads/network and temporary
  directories; this repair does not turn that into deny-all isolation. The real fixture attempts
  a disposable home-directory write outside the Bimax Thread folder and checks the resulting file.
- Shell grants name one exact command. Legacy blanket shell allows cannot bypass approval. Unexpected
  or unoffered answers refuse; taint precedes Thread/task/persistent grants and bypass. Permission
  checks no longer mistake scheduling readers such as `env bash`, `sort -o`, `rg --pre` or a fake
  `/tmp/ls` for routine reads. The taint cut is still a conservative named-command policy, not a
  general network sandbox for arbitrary scripts.
- A third hard-signalled tool round ends the run; detector cooldowns cannot reset its allowance.
  A circuit breaker ends it immediately. Tool exchanges are completed before stopping.
- Task verification requires a completed state and fresh trusted parent evidence, including
  integrated worker changes and exact file coverage. Criteria accept repository-wide evidence or
  their complete declared file scope. Scoped successful runners need LCOV execution attestation;
  simple successful `tsc` file checks accept only their canonical inputs. Filename mentions,
  guessed test-dependency links, unrelated checks and no-tests flags cannot certify those files.
  Whole-project checks are deliberately restricted to recognized unfiltered commands launched at
  the project root. A test invocation alone is still not a semantic correctness evaluator: a
  project's weak/no-op test script can be green. General requirement/visual evaluators and a
  model-backed independent critic remain Target; existing deterministic completion gates remain.
- Repository/document/search/graph/LSP/memory/workflow tool text and external shell output shares the untrusted provenance list with
  web/MCP data. This includes the real `ReadDocumentTool` name, Composer retrieval and nested workflow reads.
  Shell output may contain repository instructions too; it is labelled and tainted. Safety marking
  precedes optional observers, so a same-round reader cannot authorize a following downloader. Trace spans
  are scrubbed before memory retention, JSONL and OTLP; short measurement strings use the same
  scanner. Existing ledger, log, transcript, output archive and episode redaction stays in place.
- Each AgentLoop run now owns atomic token and estimated-USD counters shared across nested calls
  and real Node sub-agent workers. Default ceilings: **2,000,000 tokens / $5**; configure positive
  `BIMAX_RUN_MAX_TOKENS` and `BIMAX_RUN_MAX_USD`. Reservations include UTF-8 prompt/tool-schema bytes
  as a conservative text-token estimate plus requested maximum output. Provider usage replaces the
  reservation once; uncertain failures/cancellation retain the estimate. Provider hedging is
  disabled inside a capped run; the archived Bun subprocess route refuses rather than lose the
  shared counters. These are per-run limits, distinct from daily/machine/per-Thread caps. Ancillary
  requests made outside AgentLoop are outside this run namespace and retain the existing daily cap.
- `BIMAX_MODEL_PRICING_JSON` maps exact `provider:model` keys to input/output/cached-input USD per
  million tokens, e.g. `{"provider:model":{"input":0.3,"output":1.2,"cachedInput":0.006}}`.
  DeepSeek native rates use the checked peak schedule as an upper estimate; local routes use zero
  provider-token charges. Unknown routes explicitly report the $2/$2 estimate and ask for configured
  rates. No estimate is an invoice, a guaranteed multimodal token bound, or prepaid-wallet accounting.
  Remote image tokenization and cache-creation pricing need provider-specific qualification.
- VectorStore queries reuse parsed documents/BM25 while nanosecond stat identity is unchanged; local writes,
  external replacement and deletion invalidate correctly. Persistence uses atomic replacement and
  refuses to associate another writer's file identity with its own cached bytes after a save race;
  recency flush reloads external changes first. This is a read/index cache, not cross-process write
  conflict resolution or a new measured speedup claim.
- CamelCase/acronym lexical indexing keeps whole identifiers plus components without duplicating
  surrounding prose frequencies. JSON persona configs were renamed to `PersonaConfigLoader`;
  existing compatibility paths/data remain, while Agent Skills continue to use SKILL.md exclusively.
- Optional per-turn recall/learned blocks have a 12,000-character payload budget, at most 2,000 per
  block, plus clipping markers. Security, user preferences, live task contracts and completion checks
  remain complete. `BIMAX_REPO_MAP=0` removes stale maps and stops refresh. Stable prefixes already
  existed; no NVIDIA cache support or wallet-saving multiplier is claimed.

## Qualification

See [evidence](evidence/2026-10-04-fault-audit/README.md) for commands, exits, assertion-based mutation
receipts and artifact hashes. Original failures are retained. The pricing mutant initially survived
because Jest's default decimal tolerance dwarfed a fractional-cent charge; the assertion was
strengthened to nine decimal places and the mutant was caught. A compile-invalid criterion mutant
was discarded and replaced by an executable behavioral mutant. Neither attempt counts as a kill.
All valid mutants restore the exact dirty source bytes in `finally`, with hash equality checked.
The final campaign catches 23 executable mutations and passes 74 baseline tests before and after.
Final broad qualification: 415 Jest suites / 3,841 tests passed (19 existing skipped tests),
132 Bun tests passed, root/app typechecks and production builds passed. The final staged engine
passed seven real Electron MessagePort exchanges, including its scratch-folder filename lookup.
An earlier native Vision OCR fixture intermittently returned empty text; isolated and full retries
passed, but OCR reliability remains unresolved rather than being upgraded by those retries.

The applicable journeys are C01 (dirty-repository preservation), R01 (honest provider/recovery
boundaries) and R02 (retrieval truth). Their local components are exercised; this is not a new full
installed/live-model journey result. The staged engine responds over the real Electron MessagePort;
installation, provider-backed task quality, paid billing, clean-Mac distribution and matched rival
comparisons remain unmeasured. Computer Use remains retired under record 66. No commit, push, install,
credential/default-model change or cloud service was created.
