# Bimax Thread undo reliability sprint — 2026-10-06, round 3

**Status: Implemented and locally verified for the file fixtures below.** The owner requested
another bug-hunting, advancement and optimization sprint. This extends the existing app-owned
Bimax Thread undo controller and engine journal under records 55/64/66. Computer Use remains
retired; Outputs Shelf and record 70's new feature sequence remain Target.

## Reproduced defects and resulting behavior

Eleven initial regressions fail behavioral assertions against the original source. Fixtures use
actual disposable files and a scratch Bin, never the person's Bin, with controlled gates and
injected callbacks that report success without producing the expected disk state.

- Missing backups were skipped while the whole change was marked undone. Every remaining saved
  copy is now checked before any step runs. It must be a regular file, within the backup folder,
  at most 512 MiB, and not a symlink. Missing or detected changing copies refuse preflight.
- Lexical containment allowed a symlinked project parent to escape the folder, or a journal/backup
  directory to redirect writes and reads outside its state. Canonical parents and missing-path
  ancestors are checked; replacement/Bin leaf links, journal leaf links, escaped Bin roots and
  self-mutation of the undo journal/backups refuse. A rename of a leaf symlink remains safe because
  it moves the link itself. Legitimate names beginning with two dots are accepted.
- Concurrent undo calls could consume the same entry twice. One in-process lock is keyed by the
  canonical state folder, so state aliases share it. Selective undo and an entire undo-back-to
  batch use that lock; failures release it. The app retains its existing idle-engine checks.
- Bin/rename/copy callbacks could return success without performing their change. Creation undo
  observes absence; rename observes the original item's device/inode at its restored path and
  absence at the moved path. A missing move at both ends refuses. Observable Bin files get byte,
  mode, type and source-absence checks; observable directories get type/source-absence checks.
- A replacement used to send the current version to the Bin before discovering a failed copy.
  It now stages a unique, exclusively created file beside its destination, applies the saved
  mode and verifies bytes/size/mode before the current version goes to the Bin. It repeats
  containment before the step and rereads the final restored file before recording success.
  Verification streams through a fixed 64 KiB buffer and fills short reads; it checks descriptor
  size/timestamps/mode and the path's device/inode. This bounds the verification buffer, not RSS.
- Interrupted multi-step undo had no progress receipts: retry could replay already completed
  steps and replace a person's intervening edit. Each independently verified step now appends an
  `undo-step` receipt with its original operation index. Retries skip those steps; history exposes
  completed/total steps. The final `undo` marker is written only after all remaining steps finish.
  Failures report progress and leave the change pending. Malformed operation kinds, duplicate
  change IDs and invalid step indices refuse rather than falling into another operation branch.
- Failed, oversized, nonregular or symlink overwrite backups were silently omitted from the
  engine's entry. An explicit `unprotected` operation now retains that coverage gap in the same
  change. App history reports partial coverage and undo refuses before any step mutates files.
  Existing move/create/restore/trash entries remain supported; actual engine-to-app round trips
  include empty files and executable permissions.

File-result recency and touched-path deduplication use Sets instead of repeated array scans.
History accumulates later touched paths once in reverse order instead of constructing a fresh
suffix Set for each row. Dependency computation still has its existing scanning cost; there is
no claim that all history work is linear or that latency, energy or RSS improved measurably.

## Qualification and limits

Applicable contracts: C01's dirty-repository preservation and executable mutation proof; the
local filesystem recovery/receipt portion of R01; V17–V19 safe mutation, trash and independent
end-state checks. This does not qualify the full provider/crash/restart journey. Detailed results
and receipts are in [the evidence directory](evidence/2026-10-06-thread-undo-sprint/README.md).

- Sixty-seven focused tests pass across eight undo/history/organize/recovery/journal suites,
  including 28 new regressions/positive controls. Existing Bin fixtures now seed and actually
  move scratch files instead of returning pretend success. Their assertions and timeouts stay.
- Nineteen executable source mutations fail assertions, with exact source SHA-256 restoration
  after each and passing complete focused baselines before and after. An initial mutation broke
  TypeScript narrowing; it is recorded as invalid, not a kill. Final mutations include the lint
  fixes that preserve error causes.
- Final full Jest (`--maxWorkers=1`): 423 suites / 3,920 tests pass; the existing one skipped suite /
  19 skipped tests remain. Bun passes 132 tests across 14 runtime-specific files. Final root/app
  typechecks and production builds pass; changed-file lint has zero errors and four warnings.
- A fresh scratch engine bundle answers seven actual Electron worker/MessagePort exchanges with
  redirected state/config and scrubbed credential environment; no model turn or install occurs.
  This verifies engine transport, not native app Bin permissions. All 226 unrelated starting
  dirty identities remain intact; five existing research documents are intentionally extended.
  Final mutation hashes match production source; `git diff --check` passes.
- The first broad run has twelve timeouts in the unchanged PDF-layout routing suite; an isolated
  unchanged run has three passes and twelve timeouts. This known round-2 issue remains unresolved.
  Failures are retained; no timeout or assertion is weakened and the passing final run does not
  establish PDF reliability.

**Remaining Target/unmeasured:** installed native Finder/iCloud Bin and permission qualification,
full R01/crash recovery, process-wide memory/energy/latency improvements, external-writer atomicity
and arbitrary metadata/ownership restoration. When Finder can access a Bin item but Node returns
EACCES/EPERM, lexical Bin ownership and destination presence are checked; source-byte/type/absence
checks cannot be performed and are not claimed. Directory content is not recursively verified.
Checks do not prevent a different process changing symlinks or paths between observation and
mutation. Step/final receipts are append-only but not fsynced; a crash between a side effect and
its receipt, power loss, forged records, partial final lines and general journal corruption remain
outside qualification. Retrying a step whose effect occurred but whose receipt was not written can
still require manual recovery. Saved copies have no historical signed digest: copy-time source
stability, original provenance, extended attributes and whole-journal write failures remain separate
Targets. The governor's existing best-effort append failure logging is unchanged. There is no
atomic all-or-nothing multi-file undo guarantee.

Guided by current product-reset README; audit/architecture/split 01/05/06 with 55/64/66 precedence;
applicable migration 07 and gates 08; examples/frontend 03/04 for existing interaction boundaries;
competitive README/02/04/05/06/07 and C01/R01; Mac Buddy vision's filesystem awareness, safe mutation
and independent end-state principles; V17–V19 in research playbook 12; inspected app IPC/Bin/undo,
engine governor/journal and existing tests. `competitive/03_CAPABILITY_MATRIX.md` and README's
referenced records 32/33/34 are absent, as previously recorded; no contents were inferred.
Current first-party Node 22 filesystem documentation is recorded in the source ledger. No competitor
source, dependency, model/default/credential change, Computer Use route, commit, push or install is added.
