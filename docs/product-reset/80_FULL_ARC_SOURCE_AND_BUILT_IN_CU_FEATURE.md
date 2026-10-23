# Full Arc source inside the built-in Bimax CU feature

2026-10-07. The owner asked for **all** Arc CU code inside Bimax CU and a feature
integration with no MCP connection. Record 79 already made the connection internal,
but the source still lived under `third_party` and the freeze excluded CLI/MCP modules.
This change closes that source and package completeness gap explicitly.

The first installed saved-model run exposed a real argument mismatch: the tool
advertised a flat `pid` while native discovery accepted only nested `arguments`.
It stopped with zero native input and an unchanged fixture. The Mac binding now
advertises every native argument in the same flat shape as workflow, and the
executor consumes that shape. Existing nested calls remain compatible; mixing
flat and nested targets refuses before driver execution or approval. Irrelevant
optional null fields cannot replace a real target. Five regression tests cover
these paths; the failed attempt remains in the evidence folder.

The v2 saved-model attempt then skipped discovery and requested screenshot without
`pid`; it also produced zero input. Pure argument validation for reads now returns
an actionable, recoverable error with required fields and the discovery order.
It does not instantiate a driver, spend a snapshot, approve or perform an input.
Consent denial, unavailable permission/target, invalid input, Stop and partial
workflow failures retain the terminal barrier. Read correction is bounded by the
engine's existing round budget. The tool instructions explicitly start with
apps → windows → observe → workflow. Three further tests cover same-turn read
correction, denied consent and invalid input. Both failed live attempts remain
visible evidence, not successful qualification.

The v3 model run correctly discovered the app/window and requested its read grant.
Observe then exposed a leftover package-relative import in Bimax's standalone
Python adapter. `_where` now imports `WindowTarget` from `arc_cua.driver` explicitly;
a standalone-entry regression covers exact-window and PID-only routing. This was
an adapter defect, not changed upstream source. The failed run made zero inputs.

The single canonical snapshot is now `app/native/computer/vendor/arc-cua/`, containing
all **100 tracked original files** from Arc 0.1.1 commit
`74ffae1108b1cb4b1f6b161084af12646f544ba5`: driver, native/browser backends, OCR,
keyboard, settling, validation, safety, API, runtime, decision policies, CLI/MCP
adapter, tests, fixtures, examples, benchmarks, documentation, site and lockfile.
The original MIT license, Shiv Shanmugam attribution, source bytes and executable
modes remain. The adjacent import manifest records original/relocated destinations.
The duplicate original third_party location is removed. Archived Bimax snapshots
remain unchanged; record 79's selected active policy reuse continues.

The app build installs that **owned** Python source and freezes all **34 package
modules**, without the old CLI/MCP exclusions. The packaged CU resource also contains
all 100 original files under `upstream-source/` plus provenance and licenses.
`computer-source.mjs` verifies the exact file set, hashes and executable modes before
build and again against the shipped app. The executed helper's `--components`
inventory must match every package module derived from the complete source.

Retaining upstream MCP code does not activate it: Bimax launches only its private
native component and refuses `mcp`, `run`, mixed/unknown CLI arguments and JSON-RPC
initialize. The app's engine receives `BimaxCuTool` through its birth-transferred
MessagePort, with no user MCP config, descriptor, proxy, CU broker socket, MCP
registration or connector lifecycle. Driver/runtime/policies are present; Bimax's
existing model loop and Mac authority remain the active decision/approval owners.
Optional upstream decision providers are not automatically called or configured.
Tests, examples and website files are preserved source/data, not app startup code.

**File → Computer Use…** explains the feature and opens the normal task flow.
It performs no native observation/input and prompts no OS permission merely by
opening. Project and floating chats show **Computer Use**, with readable activity
such as “2 app actions,” instead of the internal tool identifier or raw PID/window
JSON. Main transcript arguments/output remain behind a diagnostic disclosure.
App read grants, each input approval, Stop, executable binding, workflow verification
and protected-target floors are unchanged from record 79.

Guidance: product-reset README, ownership 01/05/06, interaction 03/04, Mac Buddy
vision, migration 07, gates 08, competitive README/02/04/05/06 and M02/X01 contracts.
V20/V24 research cards in `12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md` guide the
boundary and verification; no new algorithm, perception, permission or performance
claim is introduced. `competitive/03_CAPABILITY_MATRIX.md` remains absent.

Evidence is in `evidence/2026-10-07-full-arc-cu-feature/`. The final receipt records
the source/frozen inventory, tests, fault checks, actual renderer end state,
staged/installed package gates and internal engine/native status round trip.
The original upstream suite uses its memory/native mocks and owned headless browser
fixtures; its passes do not qualify real native input or Bimax's saved model.
The browser UI probe uses the actual production-bundled Transcript component with
minimal fixture layout, not the installed desktop or a whole floating-bar journey.

Local qualification: **68 focused Jest tests in seven suites**, **seven source
contracts**, **six standalone/native protocol contracts**, app typecheck, the retained
**382 upstream tests**, **seven assertion-caught implementation faults**, and **five
live end-state grader faults**. Restored code passes. All 100 original source hashes
and modes remain exact; all 34 modules ship. The signed local arm64 v4 staged and
installed app pass package/engine/private-protocol checks. Across replacement, all
protected JSON files match; 126 prior conversation item/input histories also match
after the new live fixture run. Install/build receipts identify the recoverable
previous bundle. Signing is local/unhardened; this is not notarized release evidence.

**Measured on one installed Mac, one owned fixture, one saved gpt-oss-20b run:** the
model first supplied an invalid `action: apps` argument, which was refused before
execution; it corrected the call and completed apps → windows → observe → one
ordered workflow. Its two native inputs (SET_VALUE and CLICK) both report actual
input and independent verification. The separate fixture file contains exactly
`bimax-full-feature-v4-20261007` and `saves: 1`; a fresh native AX read confirms the
field and Saved status. The task ends idle. `live-v4-model-workflow.json` retains
all tool calls, and `grade-live.py` rejects duplicate saves, wrong persisted text,
unfinished task, missing workflow and wrong visible status. Earlier failed attempts
remain in the same evidence folder. The app's File menu and explanation were also
observed in the installed v4 build. The individual v4 native approval dialogs were
not captured by the agent; mandatory app/per-input authority is unchanged and tested,
and the v3 read prompt was directly observed. No additional approval-UX qualification
is claimed from an inferred dialog.

Full native/saved-model M02/X01, repeated/model-tier reliability, bystander
focus/typing, clean-Mac permissions, Intel/notarization and latency/energy remain
**Target/unmeasured**. One fixture success is not Product-ready or a competitive Win.
