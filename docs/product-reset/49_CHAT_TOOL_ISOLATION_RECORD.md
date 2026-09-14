# Chat isolation and tool cancellation — 2026-09-13

Status in this repository: **Implemented 2026-09-14** in `6d602d1` (backlog F8): record 49's ten suites pass (106
tests) and four mutants fail. This record was written in the stale `~/Desktop/Bimax` copy
as record 45, and its code was first ported here on that date. It was copied on 2026-09-14 and renumbered, because this
repository's record 45 is a different change; the text below is otherwise unchanged. Porting it is item F8 in
`48_FEATURE_BACKLOG_2026_09.md`; `competitive/evidence/2026-09-13-chat-tool-isolation/UNPORTED.md` says where
the exact edits are.

Original status in the Desktop copy: **Implemented, locally verified** for the deterministic cases below. Healthy-provider
PDF tool-count/latency, detached background work and installed-app qualification remain **Target**.

Guidance: README, 03_PRODUCT_EXAMPLES, 04_FRONTEND_PLAN, 05_TARGET_ARCHITECTURE,
08_ACCEPTANCE_GATES, vision/BIMAX_MAC_BUDDY_PRODUCT_VISION, competitive/06_HEAD_TO_HEAD_EVALS,
and competitive/examples/P01_FAST_CODE_AND_COWORK. Applicable journeys: C04 cancellation/resume
and P01 correct work without unnecessary delay. This change adds no Computer Use capability.

## Corrected behavior

- `/clear force` previously ignored a refused history replacement and still announced success.
  A blank transcript could retain the old model conversation. The headless session now aborts and
  drains the old turn before clearing, holds arriving inputs behind that boundary, and resets all
  personas rather than only the default persona. A refused replacement no longer emits `clear`.
- Stop and forced clear resolve outstanding protocol prompts without approval. Late replies are
  ignored. Tools check cancellation before admission and after the governor wait, before effects.
- Provider retry backoff (up to 30 seconds) now observes cancellation. An aborted conversational
  request no longer falls back into a fresh full-harness request.
- The generic task prompt previously instructed PDF tasks to orient in the repository, investigate
  code and run builds/tests. Those instructions now apply to code work. Simple document output is
  directed to the existing DocumentTool using supplied content, with source reading/research only
  when necessary. Text/source output is distinguished from PDF/Word/deck/spreadsheet output.

The document change is prompt steering, not a hard tool allowlist or a measured reduction in model
calls. It preserves access to research and source tools when a document actually needs them.

## Verification and evidence

`competitive/evidence/2026-09-13-chat-tool-isolation/` retains final suite output, hashes and three
rejected mutants: remove clear draining; ignore cancellation during provider backoff; remove the
post-approval cancellation check. The last mutant writes the protected fixture file and is rejected.

TypeScript no-emit check passed. Scoped ESLint passed with existing-style warnings and no errors.
The Bun compiled engine build passed and `--version` returned 1.1.0. The binary is staged in
`app/engine` through the explicit contributor override with a regenerated digest manifest. This is
not a release pin update. `/Applications/Bimax.app` has not been replaced.

Regression coverage includes old late output before clear/new output after clear; empty history
for the next input across personas; refusal without false clear; cancelled pending approval and
ignored late reply; no file mutation when cancellation arrives during approval; cancellation of a
30-second backoff within the test deadline; existing document creation and visibility, renderer
isolation, protocol, recovery and fallback suites. See final-tests.log for exact counts.

No live provider was invoked; no broad tool-latency speedup is claimed. Slow model inference,
external MCP tools, non-cooperative tools and independent background tasks are not qualified by
these tests. Clear intentionally waits for active work to settle instead of falsely declaring a
safe boundary while effects may continue. Full packaged C04/P01 runs remain Target.
