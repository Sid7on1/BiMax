# Chat startup, switching and rendering — 2026-10-06, round 5

Owner priority: “Starting or switching chats.” These are repairs to existing Bimax Thread
surfaces, not a new feature sequence. Computer Use remains retired under record 66; records
55/64 govern the engine-worker monolith. No model, provider, hardware budget or permission changed.

## Reproduced defects and changes

The initial lifecycle fixture failed eleven assertions: answered config/catalogue calls retained
deadlines; attachments added one engine-message listener each; switching project/conversation,
engine exit and renderer close left requests pending; asynchronous approval replies could dismiss
a newer card. Three positive controls passed. The floating-bar startup fixture passed one control
and failed four assertions after a behavior-preserving extraction of its existing startup reads.
A delayed initial chat/context reply could overwrite a later broadcast, including **New**/null;
closing the surface did not retire pending reads. Original assertion receipts are retained.

- `EngineRequests` owns each resolver and deadline. Reply, original deadline, bridge failure or
  owner retirement settles once and releases both. Config/catalogue retain separate ID domains;
  attachments use their existing query IDs through the single owner message subscription.
  The owner check precedes response handling. Project/Thread changes, terminal engine states and
  unmount settle all three request types. Original deadline lengths remain.
- Approval replies read the current store. Closing a card requires its Bimax Thread, request ID
  and approval token to match, including in the floating bar. A failed approval-inventory read
  preserves the card for retry rather than treating failure as an empty inventory.
- Floating-bar bootstrap subscribes before reading. Context and selection broadcasts independently
  retire their older initial responses and errors. Disposal retires pending reads and unsubscribes.
  Valid initial history still loads when no newer selection arrived.
- Markdown tokens are memoized by text; highlighted HTML is memoized by code and language for
  the component lifetime. Changed text/language still recalculates. Path-link context remains live;
  Copy uses the original bytes. No global content cache or new resource cap was introduced.

Inspection rejected an initial hypothesis that every manager update broadcasts a full quick-chat
snapshot: the current main process already coalesces list/tray/activity updates. That path was
left intact. This sprint does not establish that every startup/switching delay has one cause.

## Rendering measurement and independent end states

The production React browser fixture renders a saved answer containing 200 code lines and a
second automatic-language CodeBlock. Twenty synchronous parent updates keep content unchanged.
The same retained fixture runs with HEAD's original Markdown and the repaired Markdown; other
lifecycle fixes are present in both, so this comparison isolates rendering work only.

| Real calls through the instrumented library, initial render plus 20 updates | Original | Repaired |
|---|---:|---:|
| Markdown lexer | 21 | 1 |
| Automatic syntax highlighting, both blocks | 42 | 2 |

The browser rereads DOM HTML/text, clipboard bridge bytes and selected chat/card. It checks equal
unchanged HTML, exact Copy text, escaped HTML-looking code, fresh path-link context, updated chat
text, updated code and language, one owner listener, prompt attachment retirement, a preserved
fixture input and an old approval acknowledgement leaving the new card visible. This is a real
browser running actual components/hook with a synthetic preload API. It is not a full Composer,
ThreadQuickBar window, native clipboard, installed app or model-backed journey.

Call counts measure removed redundant work; they do not establish cold-start time, switching
latency, CPU time, energy or memory. There is no paired installed performance or competitive claim.

## Qualification

Implemented and locally verified:

- 60 focused tests pass before and after the final mutation campaign. All 28 deliberate faults
  fail behavioral assertions, with exact byte/hash restoration and passing browser baselines.
- Final full Jest: 3,977 passed in 428 suites; 19 existing skips in one skipped suite. Bun:
  132 passed, zero failed. No assertions or deadlines were relaxed.
- Root/app typechecks and builds pass. Production-browser end-state checks pass with the identical
  fixture hash on both rendering measurements. A fresh staged engine answers all seven exchanges
  over its real worker MessagePort, with scrubbed credentials and redirected config/state; no model turn.
- Changed-file lint introduces zero errors. Five unchanged legacy errors remain (four effect
  return paths and the existing ANSI regex), plus fifteen warnings. The raw lint exit is 1;
  matching HEAD line/rule/message evidence is retained. This is not a clean repository lint claim.
- `git diff --check`, restored mutation source hashes and unrelated tracked-file identities pass.
  The initial checkout was clean; the count is in `qualification-summary.json`.

Commands, raw/failure receipts, final source hashes and qualification limits are retained in
[`evidence/2026-10-06-chat-experience-sprint/`](evidence/2026-10-06-chat-experience-sprint/).

Compiler/runtime failures are invalid, not caught behavioral faults. Exploratory receipts retain
an invalid development-JSX build, a lexer instrument attached to a different module instance,
and two mutation fixtures that did not compile. None qualifies the measurement or mutation total.

## Governing research and remaining limits

Read for this work: product-reset README, 01 audit, 03 examples, 04 frontend, 05 architecture,
06 split runbook, 08 gates, Mac Buddy vision (V03), 12 vision research playbook (V03), record 57,
competitive README/02 rival studies/04 model-independent strategy/05 gaps/06 evaluation rules,
and C01/R01 example contracts. Current records 55/64/66 and frontend conversation policy resolve
the older split and Computer Use plans. The status is **Implemented and locally verified**, with bounded rendering operation counts
**Measured** on this fixture.

Referenced `competitive/03_CAPABILITY_MATRIX.md`, `competitive/examples/P01_FAST_CODE_AND_COWORK.md`
and `34_FAST_CODE_AND_COWORK_IMPLEMENTATION_RECORD.md` are absent. Their content cannot qualify a
P01 result. The conflict is reported here and in the gap register; files were not fabricated.

Cold boot, installed-app latency/RSS/energy, live providers, native clipboard, full C01/R01 and
Product-ready/Win remain Target or unmeasured. Same-Thread startup streaming versus initial-history
revision ordering has no new sequence/replay fence in this change; quick-bar stale refusal errors
also remain outside this qualification. Global response admission and memory budgets remain their
own workstreams. Existing assertions and timeouts are not weakened. No installation, commit or
GitHub push is performed by this round.
