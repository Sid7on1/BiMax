# 55 — One codebase, one engine: the pinned artifact and the generated mirror are gone

**Date:** 2026-09-19 · **Status:** Implemented and locally verified, with the limits stated below.
**Supersedes, in part:** the engine-artifact boundary in `README.md`, `05_TARGET_ARCHITECTURE.md`
(§"resolve a pinned Terminal engine manifest and verify digest") and
`14_PHASE3_ENGINE_BOUNDARY_RECORD.md`.

## What changed in product reality

Three records describe Bimax as two products that exchange a **versioned artifact**: Terminal
publishes a `bun --compile` engine binary plus a protocol schema, and the Mac app pins one verified
version by digest. That boundary no longer exists in the code, and keeping the documents silent
about it was the conflict AGENTS.md forbids working around.

Terminal was archived on 2026-09-06 (`bimax-archive`). With no second product to publish to, the
artifact pipeline was pinning a release (`v1.1.0`) that **was never published**, and the drift gate
was policing a copy of a contract that both halves could now simply import.

| Before | Now |
|---|---|
| App downloads a pinned `bimax-engine` binary, verified against `app/engine.lock.json` | `app/scripts/prepare-engine.sh` runs `bun build src/index.ts` → `app/engine/index.js` |
| Two artifacts, one per architecture | One architecture-independent JS bundle |
| Engine spawned as an OS child process | Electron `utilityProcess` (MessagePort in, piped stdout out); child process kept as an opt-in escape hatch behind `BIMAX_ENGINE_TRANSPORT=child` |
| App holds a **generated** mirror of the wire contract (`protocol.gen.ts`, `evidence.gen.ts`, `protocol.compat.gen.ts`) with a CI drift gate | App imports `src/protocol/protocol.ts` and `src/evidence/schema.ts` directly; a contract change breaks the typecheck |

The two imported files have **zero imports and zero `require()` calls**, which is the whole reason
this is safe: taking them does not drag the engine's module graph into the app build. If either ever
grows an import, this stops being free and the mirror argument comes back.

## Measured

- **Bundle size**, this source, 2026-09-18: `bun --compile` binary **79 MB**; raw production
  `node_modules` **291 MB** (326 packages); this bundle **23 MB in 0.32 s**.
- **Boot**, 2026-09-19, Electron 43 / Node 24, this Mac: engine reaches `ready` in **~424 ms**, of
  which **~394 ms elapses before the first boot phase reports** — V8 parsing the 22 MB bundle, only
  2.1 MB of which is Bimax source. With `NODE_COMPILE_CACHE` the same boot is **~330 ms**, a **22%**
  cut. Threads pays this **per task**, not once. First boot after a new bundle is ~60 ms slower
  while the cache is written; Node keys entries by file, so an engine update misses and repopulates
  rather than running stale code.
- **FTS5 is a runtime property, not a code defect**: plain Node's `node:sqlite` has no FTS5
  (`no such module: fts5`); bun and Electron both do, and Electron is what hosts the shipped engine,
  so production is unaffected. Twelve retrieval/tool-registry suites therefore run under
  `npm run test:bun`, not jest. Left in jest they contributed ~38 permanent failures, and two
  genuinely broken rerank fixtures were hiding inside that noise until the suites were run somewhere
  they could pass. `src/__tests__/fts5.contract.test.ts` fails if the jest ignore list and the bun
  script ever drift apart.

## Removed, and where it went

Every file below is in `~/Developer/bimax-archive` at its repository path (the move-don't-delete
rule), cmp-verified: the ACP protocol (5 files), the MCP server, the engine's `print` and `themes`
modules, their five test suites, `scripts/smoke-acp.mjs`, the two protocol generators and the mirror
gate, `app/jest.capabilities.config.ts`, and the three generated mirror modules. 3,614 deletions
against 569 insertions.

`app/jest.capabilities.config.ts` is gone because there is no longer a second TypeScript project to
configure: the root `jest.config.ts` now has `roots: ['<rootDir>/src', '<rootDir>/app/src']`, and the
Phase 8/9 local gates call it with repo-root-relative paths instead of `cd app && npx jest --config`.

## Verification that actually ran

Recorded in the commit that carries this record. What is **not** claimed: no installed-app run, no
live-provider run, no latency claim for any Bimax path other than the engine boot numbers above, and
no clean-machine packaging qualification. `npm run verify:engine` forks the real bundle with the real
`utilityProcess` and speaks the real protocol to it — that closes the long-standing "the packaged
artifact is untested" gap for the *bundle*, not for the *DMG*.

## Documents this change invalidates

- `README.md` — "Terminal publishes a versioned macOS engine artifact … the Mac app pins and bundles
  one verified version" is now historical. Pointer added.
- `05_TARGET_ARCHITECTURE.md` line 175 — "resolve a pinned Terminal engine manifest and verify
  digest" no longer describes the runtime.
- `14_PHASE3_ENGINE_BOUNDARY_RECORD.md` — the generated schema, per-chip engine manifest/pin and
  drift mutations are evidence of a boundary that has been withdrawn, not current requirements.

These are left in place as historical evidence, as the folder's convention requires; this record is
the correction.
