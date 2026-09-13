# Capability failures must reach the person using Bimax

Date: 2026-09-12. Products: Terminal engine and Electron coding Desktop. Status:
**Implemented; local controlled measurements recorded below. Not a release or model-quality claim.**

## Problem and inspected evidence

The input is `docs/RETRIEVAL_TOOL_AUDIT.md`, supplied by the owner. Its provider catalogue,
quality and timing numbers are prior audit evidence, not measurements repeated here. Source
inspection confirmed the withdrawn embedding endpoint could become a keyword fallback without a
user-facing event; reranker errors only changed internal mode; incomplete index coverage could be
reported as zero pending by overlapping callers; and visible document schemas did not enforce
actual document delivery. The audit also exposed directory creation outside the workspace.

The solution operates at failure boundaries and frontend delivery, rather than relying on the model
to mention a problem or on a diagnostic command the user has to discover. No new local model,
service, dependency, periodic provider probe or outbound telemetry was added.

## Resulting contract

- Embeddings and reranking report failed credentials, HTTP errors, invalid responses and bounded
  deadlines. Invalid/zero vectors and duplicate/missing indices cannot count as healthy output.
  Terminal provider errors back off for 30 seconds; a later use retries. Only a valid subsequent
  response clears the notice. Partial reranker coverage remains explicitly degraded.
- Index synchronization reports incomplete coverage, pending files/vectors, manifest errors and
  unavailable storage. Concurrent callers share the actual in-flight result. Lexical-only indexes
  do not pretend they are waiting for embeddings. No speed improvement is claimed.
- Shared tool execution reports policy blocks, thrown errors, typed non-success outcomes and
  legacy `Error:` results without waiting for model narration. Typed errors produce error tool
  cards. MCP `isError` is preserved, with live startup/reconnect/watchdog failure notices.
- Explicit English document-creation requests matching the narrow activation rule require
  DocumentTool. A model that repeatedly claims success without calling it ends with a visible
  “operation was not performed” after the bounded retries. Generic text writes cannot masquerade
  as DOCX/XLSX/PPTX/PDF. DocumentTool checks written bytes. This is not an arbitrary natural-language
  intent classifier, nor proof of factual or visual quality of generated documents.
- Directory creation passes the same Governor file-write boundary as other writes. Allow rules and
  bypass mode do not waive workspace containment. Nested missing ancestors and dangling symlinks
  are checked; tests inspect actual filesystem end states. This does not claim race-free protection
  against another process changing symlinks between the check and the filesystem operation.
- Memory read/write failures are explicit. A corrupt store cannot be overwritten by treating its
  failed initial read as an empty database. A valid later read clears the read warning.
- A bounded registry emits system messages with capability, state, reason, impact and next action.
  Repeated identical failures are deduplicated; excess identities coalesce visibly. These messages
  have reserved wire-queue priority and replay at host attachment. They contain no raw provider
  errors, credentials, arguments or document content; endpoint identity strips URL credentials,
  query and fragment. Existing unrelated logging is not certified secret-free by this change.
- Desktop shows unresolved warnings above the transcript, persists them through transcript clear,
  and retains them across renderer reload. A new engine replays its own observed failures; a new
  project resets the old project's notices. Recovery is a distinct event. CLI print mode writes
  notices to stderr without requiring verbose mode, preserving answer stdout.

A notice means an observed operation failed or ran with reduced capability. Absence of a notice
is **not** a health certificate for unused capabilities. Detection occurs at the failed use/deadline
(or an existing MCP watchdog observation), not at an unknowable provider withdrawal instant.

## Verification and reproducibility

The checked-in runners use isolated temporary projects/configuration and controlled loopback HTTP
responses. They make a normal CodeSearchTool turn, not `/retrieval`, and grade the emitted failure
before the answer. They record binary/script hashes and raw frames. They do not measure a real
model's tool-selection accuracy, provider availability or retrieval quality.

From the repository root:

```sh
bun build src/index.ts --compile --minify-whitespace --minify-syntax --outfile .engine-local/bimax-engine-no-silence
BIMAX_ENGINE_LOCAL_OVERRIDE="$PWD/.engine-local/bimax-engine-no-silence" npm --prefix app run prepare:engine
npm --prefix app run build
node scripts/prove-capability-failures.mjs app/engine/bimax-engine
node app/scripts/ui/capability-electron.mjs
python3 scripts/prove-capability-mutations.py
```

The mutation runner restores exact bytes after each serial mutation, including exceptions. Do not
edit its named source files concurrently. Build before testing Electron: Desktop consumes the
staged binary, not TypeScript source. The local staging manifest explicitly says contributor
override; it is not a signed/pinned release artifact. No installed `/Applications/Bimax.app` is
replaced by these steps.

The renderer-only runner (`app/scripts/ui/capability-failures.mjs <engine-run-directory>`) replays
captured binary frames into the production renderer with the existing fixture preload. It checks
the minimum/default viewports, visible warning text, horizontal containment, and recovery removal.
Use `BIMAX_UI_CHROME` to select an already installed Chromium executable when managed Chromium is
absent; no browser download is necessary. This boundary is distinct from actual Electron IPC.

## Scope and acceptance gates

Guidance: product-reset README, current-repo audit, target architecture/split/migration documents,
frontend plan/examples and Mac vision, acceptance gates, competitive README/strategy/gap register,
head-to-head evaluation rules and the R01/R02 retrieval journeys. C05's visible-outage and config
preservation expectations are applied to controlled faults. This is not a rival comparison or
Track C model-tier qualification. `competitive/03_CAPABILITY_MATRIX.md`, referenced by AGENTS,
is missing in this checkout; its absent contents were not assumed.

Full signed packaging, installed-app upgrade, supported model-tier qualification, semantic quality
regression probes, independent export-layout validation, exhaustive legacy-tool outcome migration,
and detection of arbitrary uncalled capabilities remain **Target/unmeasured**. Existing code-only
boundaries remain authoritative; no Computer Use path is reintroduced.

## Measurement ledger

See the appended final verification ledger and content hashes in `evidence/capability-failures/`.

Final candidate binary SHA-256:
`6b9fe90ac616fc7638c1fe4a34d266d76b33d4b22c3561477df458a72bc1e86b`.
The staged `app/engine/bimax-engine` is byte-identical to the compiled candidate. Darwin arm64,
8,589,934,592 bytes physical memory. No live provider quality/availability conclusion is drawn.

| Boundary | Final observation | Raw record |
|---|---|---|
| Staged compiled engine, normal search, isolated embedding 410 | Warning before final answer; 32 valid frames, zero invalid; observed response→notice 3.48ms in this one fixture run | [engine proof](evidence/capability-failures/2026-09-12T06-47-40-035Z/result.json) |
| Same binary, isolated reranking 404 | Warning before final answer; 32 valid frames, zero invalid; observed response→notice 0.34ms in this one fixture run | Same engine proof |
| Real Electron main→preload→renderer, staged engine, HTTP 410 | Automatically visible compact failure summary; ordinary search completes; unresolved warning survives reload; isolated config hash unchanged; existing minimal runtime profile selected | [Electron proof](evidence/capability-failures/electron-2026-09-12T06-49-00-444Z/result.json) |
| Production renderer, fixture preload, actual captured engine frames | 720×480 and 1180×800; visible summaries, horizontally contained text, expandable cause and recovery removal; zero captured page errors | [renderer proof](evidence/capability-failures/2026-09-12T06-47-40-035Z/desktop-result.json) |
| Behavioral mutations | 12/12 caught by assertion failures, zero invalid in final campaign; exact source restored after each | [mutations](evidence/capability-failures/mutations-20260912T064400Z/result.json) |
| Focused regression | 20 suites, 196 tests pass; includes filesystem end-state, protocol/reducer, document activation, MCP, memory, print and code-only boundary checks | [test log](evidence/capability-failures/delivery-20260912/regression.log) |
| Static/build checks | Engine/app typechecks, protocol mirror, compiled engine and production Electron build pass. Focused lint: zero errors, 102 warnings (not a warning-free claim) | [verification](evidence/capability-failures/delivery-20260912/verification.json) |

The Electron timing field is a test observer's sampled DOM/geometry observation, **not** compositor
first-paint latency or a percentile/SLA. Its screenshot verifies that the embedding summary is not
hidden below the index warning. Full reasons/actions expand on request and remain in system messages.
The two HTTP fault cases use a scripted provider and known fixture vectors, not a model benchmark.

All 1,665 files hashed before this work are still present: 1,635 byte-identical, 30 intentionally
modified paths listed in verification.json. Existing edits were retained; no reset, checkout,
commit, package install or replacement of the installed app was performed. The original dirty
checkout is the base for these changes, not a clean-HEAD release artifact.

### Discarded/intermediate attempts — retained, not hidden

- `2026-09-12T06-15-05-580Z`: rerank fault was never reached with one candidate. Invalid fixture
  for that case; the raw older runner called it fail. The embedding case also broke reranking.
- `2026-09-12T06-15-51-542Z`: two candidates reached reranking, but the embedding scenario still
  broke both endpoints. Do not use it as evidence of isolated faults. Corrected later runs are kept.
- `mutations-20260912T062218Z`: seven caught, one invalid TypeScript mutation. The corrected eight-
  mutant campaign and final twelve-mutant campaign both caught all their mutants behaviorally.
- The first renderer attempt lacked managed Chromium. It was rerun using the installed Chrome;
  no download. Earlier screenshots exposed long text overflow/stacking; the final compact-summary
  layout and geometry assertions address those defects.
- `electron-2026-09-12T06-43-36-461Z`: invalid renderer observation. The runner used the Electron CLI
  wrapper; cleanup initially left its child. The identified fixture child was terminated, and the
  corrected runner launches/cleans up the actual Electron executable directly.
- `electron-2026-09-12T06-45-27-396Z`: the harness waited for only `ready`, while Desktop correctly
  reported its usable `degraded` minimal profile. Captured frames contain the failure notice; the
  UI claim was not graded. The final runner accepts both interactive states.
- `electron-2026-09-12T06-47-10-030Z`: IPC/reload proof passed, but screenshot review showed the
  second failure below a long first warning. The final run additionally grades summary geometry.
- Expanded regression exposed a real corrupt-memory overwrite after a failed read. The write path
  now validates storage before mutation; the strengthened end-state assertion passes and its
  omission is caught by the memory-corruption mutant. The earlier failing log is retained.
- An existing CodeIndex partial-store test also failed with HEAD's implementation because its
  fixture no longer produced two chunks. The fixture now forces the byte cap; its original pending,
  indexed and old-row-preservation assertions remain. The baseline failure log is retained.
