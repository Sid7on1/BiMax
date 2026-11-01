# 119 — Bounded history admission and visible recovery

Date: 2026-10-31. **Implemented and locally verified**, addressing audit 117 A03. This closes the
successful-save/silent-reload-omission defect through compatible byte limits and explicit recovery.
It does not implement unlimited or paged in-app histories above the retained 32 MiB snapshot limit.

## Behavior

- Immediate, coalesced and final/archive writers share the reader's **32 MiB encoded UTF-8 byte**
  limit. Oversized state is refused before replacing a valid file. No transcript truncation,
  larger startup parsing limit or snapshot-format migration is introduced.
- An exact-limit snapshot reloads; one byte over refuses. An oversized final attempt does not
  tombstone later valid saves. Deferred failures retain pending work and expose the actual error.
- A persistent sidebar alert reports unsaved conversation changes independently of OS notification
  availability. It clears after failed changes have successfully saved. Input-admission warnings
  include the reason, so a size limit does not offer only generic disk-space advice.
- Existing oversized/unreadable saved files remain on disk and appear under **Conversations needing
  recovery**, with source identities kept separate for saved, archived and Bin backup copies.
  The original title may be unavailable, so entries identify the retained file's conversation id.
  Files beyond the existing 200-active-record limit are reported for recovery rather than silently
  dropped. The recovery UI initially shows five entries and offers additional pages.
- **Export recovery copy…** uses a native Save dialog and copies exact original bytes without parsing
  the oversized/corrupt body. The original remains intact. The action receives ids/location flags,
  not renderer-provided paths, and runs through existing trusted-main-window IPC admission.
- The export stages a private file outside conversation storage, streams using bounded buffers,
  rereads the staged bytes to verify SHA-256, rechecks source identity/change metadata and only then
  replaces the explicitly selected export destination. Cancellation, verification failure, source
  replacement and unsafe sources do not replace an earlier export. Only owned temporary files are
  cleaned up. Directory aliases cannot select an output inside conversation storage.

Startup and Bin reads hold a regular no-follow file descriptor, check size before allocating,
complete short reads and reject detected changes. Invalid UTF-8 is retained for recovery instead of
silently replacing damaged characters. Interactive archived listing/unarchive keep asynchronous
file I/O; JSON parsing remains bounded and runs in main. This is a per-file bound, not a new aggregate
startup RSS, latency or energy qualification.

## Bin recovery correction

The Bin undo envelope adds metadata around a conversation. Previously a snapshot at 32 MiB could
produce a larger backup rejected by its own reader; `records()` then deleted rejected backups.
The correction reserves the exact bounded wrapper overhead above the snapshot budget and checks
the contained snapshot independently. An exact-limit conversation survives move, reopened undo
discovery and restoration with identical content. Oversized/corrupt backup files are retained and
reported through the same recovery UI/export path rather than deleted during inspection/pruning.
The five-copy/expiry policy still applies to readable undo records. Unreadable retained evidence
is not claimed to have an automatic deletion/aggregate-disk-budget policy.

## Tests and falsification

Two new normal-CI suites add **18 tests**:

- `thread.history.storage.test.ts`: immediate/coalesced/final oversize refusal, last-good bytes,
  later valid publication, exact encoded Unicode boundary, metadata-only oversize discovery,
  bounded unarchive, unreadable-file preservation/no placeholder overwrite, invalid UTF-8,
  short reads and growth during reading.
- `thread.history.recovery.test.tsx`: production export action, saved/archive identity, independent
  original/export hashes and modes, unadmitted ids, cancellation, storage/alias destinations,
  symlink and replaced sources, exact-limit Bin wrapper/reopen/undo, preservation/export of corrupt
  and oversized backups, deliberate staged-byte corruption and actual recovery markup.

The original writer/boundary checks failed **four assertions** before repair. Two additional
pre-implementation checks encountered the then-missing recovery API; those are not counted as
assertion-qualified baseline failures. Their raw results remain in `baseline.json`.

The production `ThreadsList` and recovery component run in headless Chromium with the actual storage
catalog and production export action. Six browser end-state groups grade: exact saved/archive/Bin
exports including a 33,554,433-byte original; cancellation; visible refusal; pending/duplicate-control
state; five-row paging; and persistent coalesced-save failure followed by a successful clear.
Colliding ids from three storage locations export their correct distinct bytes. There are zero
browser errors. Native picker/IPC ports are inert: this does not qualify an installed Electron
window, actual native Save dialog, VoiceOver or physical device behavior.

The shared `scripts/prove-thread-persistence.py --history` runner applies nine controlled defects
only to disposable copies. Removing writer bounds, silencing discovery, tombstoning before size
admission, unbounding unarchive, removing Bin envelope room, deleting unreadable backups, ignoring
source replacement, ignoring byte verification and allowing placeholder overwrite all fail tests.
The six earlier persistence/dispatch mutants are rerun separately into this record's evidence,
leaving record 118's raw receipts unchanged. Compiler errors, missing tests and runtime setup
failures do not count as caught faults.

## Verification

Raw scripts, browser results, samples, mutation results and preservation checks are under
[`evidence/2026-10-31-history-recovery/`](evidence/2026-10-31-history-recovery/).
`verification.json` is the final machine-readable receipt.

| Check | Result |
|---|---|
| Final focused storage/export/Bin/persistence set | 37 tests pass, five suites |
| Full final-source Jest, Node 24, two workers | 4,665 pass; three existing skips; 483 suites pass |
| Declared Bun parity | 133 pass, zero failures |
| Declared script tests | Three pass |
| Engine and app TypeScript | Pass |
| Electron main/preload/renderer production bundle | Pass |
| Scoped recovery-module lint | Zero errors; 31 warnings retained |
| Main integration lint versus starting source | Two unchanged pre-existing errors and 12 warnings; no new errors |
| History counterfactual defects | Nine assertion-caught |
| Prior persistence counterfactual defects | Six assertion-caught |
| Actual shared sidebar/storage/export browser fixture | Six end-state groups pass; zero browser errors |

Before editing, **10,200 existing nonignored files** were hashed against the starting dirty checkout.
The previous owner's/source changes and record 118 repairs are part of that protected baseline.
Scoped source backups and final changed/missing-file lists are retained. No reset/stash, dependency
installation, model/config change, private-profile mutation or app reinstallation occurred.
Prior raw audit/repair receipts remain unchanged.

## Scope and remaining targets

New oversized snapshots fail explicitly; legacy oversized histories are discoverable/exportable,
not fully opened or resumed in-app. Exported raw recovery JSON may need an offline migration or
future segmented-history reader; a successful copy does not claim the conversation was repaired.
Full in-app paging, aggregate startup/retention budgets, sustained installed responsiveness,
power-loss/concurrent external-writer guarantees and installed C04/R01/I01 remain Target/unmeasured.
No Product-ready, stable-release or competitive Win claim follows from these local checks.

**A04 queued-message identity is next.** Memory evidence quality, portable dependencies and the
other audit 117 gaps retain their prior ordering. Mac-only capability/permission ownership and the
current worker monolith remain unchanged.

Guiding documents: current product-reset README; audit 117 and repair 118; 04 frontend plan's truthful
failure/navigation requirements; 05 architecture/data ownership; 08 acceptance gates; Mac Buddy
vision's responsiveness and safe mutation principles; competitive status/evaluation rules and the
R01/C04 recovery contract. No new competitor/platform evidence or performance claim was introduced.
