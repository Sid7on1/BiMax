# Fresh chats and replay isolation — 2026-10-05

Owner outcome: opening a repository should begin a fresh conversation; the sidebar action should read
**New**; old tool calls must not appear after saying “hi” in that conversation. Install the fix.

## Verified causes

1. `startEngine()` deliberately looked up the newest project Bimax Thread for a root and resumed it.
   That policy contradicts the owner's requested fresh-open experience. Reopening a repo now creates
   a new Bimax Thread. History stays selectable explicitly; renderer reload retains its current chat.
2. `BasePersona.executeTurn()` starts the harness lab alongside a live full-harness turn. Its recorded
   replay drives a real `AgentLoop` with fake tool results, but emitted those old calls through the
   live `engineEvents`. ProtocolHost, appStore, SessionRecorder and the desktop reducer accepted
   them as new events in the correctly owned worker. The existing IPC owner guards cannot distinguish
   this same-worker pollution. Local metadata showed reused call IDs with fresh timestamps and a
   rapid burst of recorded calls. No personal transcript content is included in the evidence.
3. The replay flag was process-global. Overlapping replay and live work could suppress genuine
   recording or resume observing a replay when another evaluation ended.
4. File results are already fenced in recorded request messages. Re-fencing those replay results
   changed the request hash even for an unchanged harness.

## Repair plan and implementation

- Use `AsyncLocalStorage` for an execution-scoped replay marker; asynchronous replay work retains
  that marker without changing concurrently running foreground work.
- Suppress the complete live event seam before EventEmitter listeners and the appStore bridge.
  Stand down live tool observers, usage, task metrics, capability state, steering consumption,
  todo/outcome continuation and completion checks. Preserve replay's own loop/report.
- Reuse recorded tool messages exactly instead of applying their provenance fence twice.
- Move repo-open policy into ThreadManager so the production caller and behavioral tests use the
  same decision. Credential renewal restarts the selected matching-root conversation, with its
  queued input, rather than selecting whichever chat was updated most recently.
- Rename the sidebar button to New and fix the composer callback's current-Thread dependency.
  Keep old history inspectable. Do not rewrite already polluted saved conversations.

## Evidence and limits

[Evidence](evidence/2026-10-05-fresh-chat/README.md) preserves regression, mutation, build, package,
signature, packaged-window and installation receipts. The real replay is exercised against
ProtocolHost, SessionRecorder, appStore and ThreadManager, with assertions on the final saved file.
Eight fault mutations fail behavioral assertions; syntax failures do not count.

The first packaging/full-test attempt hit ENOSPC. A later standard electron-builder run produced
its current ASAR, but signing every unchanged Electron framework repeatedly stalled and was stopped.
The final local staging uses that **standard current ASAR**, current engine/helpers/extension and an
APFS clone of the unchanged, already signed Electron 43.3.0 runtime. ASAR header integrity is refreshed;
changed components are signed with the existing local identity and the whole signature verified deeply.
The earlier raw archive rewriter is an interim experiment, not the final installed archive. This is a
local installation path, not a newly qualified release pipeline.

The packaged-window fixture runs actual packaged main, preload, renderer and engine worker in the
same-version Electron host with disposable userData and a synthetic recorded episode. It qualifies
this local fresh-open/New/replay path. It does not establish a billed-provider greeting, the full
R01 outage/crash journey, broad installed race/reaper performance, clean-Mac distribution or a Win.
The recommendations in record 70 remain Target and are not implemented by this repair.

Guided by product-reset README, 01/03/04/05/06/07/08, Mac Buddy vision, competitive README/02/04/05/06,
R01, and records 55/58/64/66/67/68. Competitive 03 remains missing. Record 66's CU retirement stands.
