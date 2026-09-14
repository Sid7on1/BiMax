# Record 49: the code that was never ported

**Ported 2026-09-14 in `6d602d1`** (backlog F8). The saved patch applied cleanly; `host.ts`, `agent.loop.ts` and
`base.persona.ts` were ported by hand from `codex-exec-calls.txt`, and `tool.factory.ts` already had both
cancellation checks. Record 49's ten suites pass (106 tests), and four mutants fail. The rest of this file is kept as
it was written.

Written 2026-09-14, when record 49 was copied here from the stale `~/Desktop/Bimax` copy (where it was record 45).
Its code change is **not in this repository**. This folder keeps everything needed to port it, so the work
survives even if the Desktop copy is lost. Porting it is item F8 in `../../../48_FEATURE_BACKLOG_2026_09.md`.

## What is here

- **`record49-exact.patch`:** the change to six files as a unified diff against this repository's copies.
  None of the six had changed in `~/Bimax` since 2026-09-09, before the Desktop session began at
  2026-09-13 01:15, so the diff is exactly that session's edits. `git apply --check` passed on commit `355444c`.
  - `src/protocol/headless.session.ts`
  - `src/cli/commands/meta.ts`
  - `src/__tests__/agent.loop.recovery.test.ts`
  - `src/__tests__/headless.session.test.ts`
  - `src/__tests__/protocol.test.ts`
  - `src/__tests__/tools.test.ts`
- **`desktop-copy/`:** the Desktop copy's versions of the ten files the change touched, byte for byte.
- **`codex-exec-calls.txt`:** every shell call from the Codex session that made the change, extracted from
  `~/.codex/sessions/2026/09/13/rollout-2026-09-13T01-15-22-01a09727-19f5-7c40-8df2-b92ef8270f61.jsonl`. The
  edits are mostly Python `read_text().replace(...)` scripts inside JSON-escaped command strings.
- **`hashes.json`:** the SHA-256 of each source file when the record was written.

## Four files need a hand port

| File | Desktop copy against `hashes.json` | This repository since |
|---|---|---|
| `src/protocol/host.ts` | matches: pure record-49 state | changed in `3a135b0` |
| `src/cli/personas/base.persona.ts` | differs: the Threads session edited it afterwards | changed in `b68ebea` |
| `src/core/agent.loop.ts` | differs: the Threads session edited it afterwards | changed in `cca5226`, and again by record 50 step 3 (`prepareContext`) |
| `src/tools/tool.factory.ts` | differs: the Threads session edited it afterwards | changed in `725b28c` |

Take these four files' edits from `codex-exec-calls.txt` (search for `Path('src/...')` naming each file), not from
`desktop-copy/`. Three of the Desktop copies also contain the Threads session's edits, which were already ported
separately and selectively, so copying them would revert work.

## Porting steps

1. `git apply docs/product-reset/competitive/evidence/2026-09-13-chat-tool-isolation/record49-exact.patch`
2. Replay the four files' replacements by hand, confirming each anchor string still exists exactly once.
   Apply the patch and these together, because the patched `protocol.test.ts` and `tools.test.ts` exercise
   `host.ts` and `tool.factory.ts`.
3. Run the ten suites named in `final-tests.log`, then the record's three mutants: remove the clear draining,
   ignore cancellation during provider backoff, and remove the post-approval cancellation check. Each mutant must
   fail.
4. Rebuild the engine. The binary the Desktop copy staged is from the old tree and must not be reused.
