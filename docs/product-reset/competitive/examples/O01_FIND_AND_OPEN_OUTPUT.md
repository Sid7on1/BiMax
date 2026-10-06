# O01 — find and reopen the exact output

Version: 1, 2026-10-04. **Target contract; fixture and grader are not implemented.**
Scope: record [67](../../67_OUTPUTS_SHELF_RESEARCH_AND_PLAN.md), with C04/R01 recovery extensions.
References for future comparison: Hermes Desktop and Claude Artifacts. No competitive run has occurred.

## User journey

> Create a report called market-report.pdf from the supplied fixture data and keep it in Outputs.

After generation, stop the engine, switch chats, quit and reopen Bimax with the network unavailable.

> Where is the market report? Open the one we made earlier.

Expected experience: Outputs finds the retained version, shows its source chat and location, and
opens those exact bytes without starting the source engine or replaying its tools.
Use the shelf search field and Open action for the offline baseline; natural-language inference
is a separate optional local-model path, not a prerequisite for this journey.

## Frozen fixture and observation

Use two synthetic projects/chats that each produce `market-report.pdf` with distinct sentinel
content and different expected totals. Freeze the input fixture, document contract, product/model
build, and grader version. Retain final file bytes, hash, catalog owner/version IDs, registration
events, restart sequence, and engine-start count. Check PDF structure and expected extracted
contents independently of the producer's receipt; inspect rendered pages for any layout claim.

Reopen the selected managed file through the real shelf action, then independently read that file
and compare its hash and sentinel with the registered version. A screenshot or click is not enough.
The selection of the other chat's same-named file fails. All unrelated project/config files retain
their before hashes. No cloud upload, native automation permission request, or source-engine start
is permitted for this local read journey.

## Fault matrix

- Replay the same registration/session restore repeatedly: one registration, no new side effect.
- Crash after intent, after producer write, and before/after catalog commit: reconcile only the
  authorized observed bytes; committed versions survive; pending state does not become false success.
- Modify/delete the original: a retained copy remains exact; a linked-only missing/changed source
  is explicitly unavailable or changed, never silently substituted.
- Inject catalog write failure and insufficient snapshot space: disclose registration/retention
  state, preserve produced/original files, and retry without duplicate rows.
- Switch chats during registration; give both files the same name: owner remains the main-side
  Bimax Thread envelope. A wrong engine-session ID cannot become product ownership.
- Swap a symlink/file after validation; request an arbitrary path through output IPC: reject wrong
  bytes/unauthorized locations and preserve scope.
- Remove a source chat while retaining its output: output remains accessible; owner label is
  historical, and a dead chat link does not prevent opening the file.
- Preview hostile HTML/SVG/macro-containing files: no script, network request, or macro executes.

## Grader mutation requirements

Before scoring Bimax or a rival, prove that the grader rejects: unchanged/missing output; wrong
owner with the same filename; stale previous-run bytes; duplicate registration; narration-only
success; draft-only success; mismatched digest; persistence failure hidden as success; and a
reopened path different from the selected file. A valid expected fixture must pass.

Classify fixture/provider/instrumentation failures using competitive/06. Do not convert an invalid
provider attempt into a successful file-quality score. Report valid-run denominators and separate
storage/UI correctness from provider-produced content/layout quality.

Cloud sharing, Office preview parity, and timings require separate frozen fixtures and gates in
later record-67 slices. Until those runs exist, all O01 qualification remains Target/unmeasured.
