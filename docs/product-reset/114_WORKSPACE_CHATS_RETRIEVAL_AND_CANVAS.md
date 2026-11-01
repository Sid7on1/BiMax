# Workspace-aware chats, local retrieval recovery and shared canvas

Date: 2026-10-25. Status: **Implemented with scoped measurements**. The design and acceptance
contract were recorded in [plan 113](113_WORKSPACE_CHAT_AND_RETRIEVAL_PLAN.md) before implementation.
Installation and owner-confirmed Mac opening are recorded below; native phone qualification remains separate; this is not Product-ready/release.

## What the owner reported and what actually failed

The owner saw a semantic-search degradation notice, could not tell which repo owns a Mac chat while
the Mac is on Home, got previous conversation content when expecting a new chat, and found both
Desktop and phone canvases too small and inconsistent. These are separate execution paths.

The configured local endpoint `localhost:11434/v1`, model `all-minilm`, dimensions 384 was refusing
connections. The service/model were installed. Opening Ollama initially restored HTTP-200 vectors;
a later check found that GUI-launched service unavailable again. A separate current-session CLI
service now runs bound to **127.0.0.1:11434**, retaining the same model and private destination.
The actual RemoteEmbeddingBackend returns unit vectors and a paraphrase/control margin of **0.1277**
on one inert probe; a direct API probe previously measured 0.2309 with different query handling.
Neither is a general RAG-quality result. No private corpus was moved to another provider, model
settings changed, replacement vectors fabricated, model downloaded or login startup installed.
The service must remain available; automatic login startup remains Target.

Failures now distinguish refused local service (with an Ollama/start-server remedy), timeout,
unreadable JSON and other reachability failures without printing raw exception/body/secret/input.
Lexical fallback and truthful recovery on successful later use remain intact. An old transcript
notice is historical; the active capability clears only after the engine gets valid vectors.

## Chats belong to saved folders, not the current Mac screen

A **Bimax Thread** stores its own folder root. Showing Home on the Mac does not erase or reassign
saved conversations. Standalone Phone chats are phone-owned conversations without a Mac repo.

The Mac now advertises up to 16 known, existing folders from Mac recents/saved conversations, using
canonical path-derived opaque ids, names and abbreviated locations. Roots must be directories;
Home/filesystem root and missing folders are not creation destinations. Same-basename folders have
distinct ids/locations. Metadata lookups for session lists have a bounded short-lived cache; creation
revalidates the current known-folder catalogue rather than trusting that cache or a phone path.

Drawer → Mac → **New Mac chat** opens an explicit folder picker. No folder is preselected. With no
known folder, add/open one in Bimax on the Mac first. The selected folder is shown with existing/new
chat rows and the selected chat header. Phone New chat remains a standalone chat. Searching Mac
history also matches its folder/location. The Mac Home screen can remain open during phone use.

The additive encrypted `session_create_request/result` operation saves a **new empty conversation**
in the chosen folder without selecting it on the Mac, starting an engine or sending a model request.
The first message addresses that exact new id. Missing ids no longer fall back to an old active chat.
Create uses the existing write-ahead idempotency journal with peer/operation/folder binding, snapshots
untrusted request primitives before awaiting, and rechecks the exact current secure-session identity
following authorization and journal admission. Stop/revocation prevents late creation. Interrupted
outcomes remain explicit; an intentional Retry uses the same id instead of creating a duplicate.
The phone bounds pending requests/timeouts and accepts only the matching intent/folder response.

Both phone chat routes now mount a fresh owner on source/id changes. This resets transcript,
composer draft and busy state together; old history loads/subscriptions are retired and mismatched
snapshots cannot paint another chat. A real empty Mac chat shows a fresh-start canvas, not a permanent
“Loading conversation” placeholder or the previous answer.

## One usable message canvas

The actual shared Desktop message/Markdown components remain in both products. Desktop live output
previously bypassed the saved-message component: that made live/completed layouts diverge. Both now
use ConversationMessage; the actual Transcript fixture verifies identical geometry and font before
and after completion. The centered message column is bounded at 760 px with 16 px running text. The comparison
also loads compiled Desktop styles: combined selectors keep the column bound when the app’s later
generic reading-column rule would otherwise override it.
Phone chooses persisted Comfortable **17 px** or Large **19 px** through the same typography rules,
with proportional code/table/headings, better narrow-width bubble/edge spacing and preserved native
motion preferences. This is host-specific reading scale, not a second Markdown implementation.

Code now has one explicit, accessible Copy/Keep toolbar and one frame. Streamdown keeps parsing,
streaming and Shiki; nested code borders and empty built-in action shells are suppressed. Tables keep
one scrolling frame instead of a frame inside a frame. Native phone Copy, Desktop Keep output,
reasoning, KaTeX, Mermaid, safe links/raw HTML/CSP and exact streaming text remain tested. This is a
scoped layout/readability correction, not complete interactive Desktop Outputs/voice parity or a
claim that the owner has accepted the visual result.

## Verification, source faults and retained failures

[Scoped evidence](evidence/2026-10-25-workspace-canvas/) records exact source/artifact hashes.
Guidance: README, 03 Product Examples, 04 Frontend Plan, 05 Target Architecture, 08 Acceptance Gates,
Mac Buddy vision, competitive language/evaluation rules and records 109–113. Mac remains the
folder/tool/OS authority; no Terminal or production gateway/relay change is involved.

- **142 Desktop tests / nine suites** (137 focused plus five connection-controller regressions), including four new embedding diagnostic/recovery cases,
  existing retrieval-factory/capability/adapter/UI/lifecycle tests and retained Outputs behavior.
- **12 workspace end states** using actual ThreadManager, adapter, creation journal/service and
  phone client: Home, duplicate names, empty folder-bound creation, no engine/selection, concurrent
  retry, foreign peer/path/folder, no active-chat fallback, Stop during journal wait, input mutation,
  exact response matching, timeout reconciliation and disconnect.
- **Three isolated assertion-caught creation faults** remove the Stop fence, snapshot or folder
  binding. Existing five preference/delivery mutations also run. Nine phone preference/delivery
  tests now include typed text-size persistence alongside boolean preferences.
- **31 rendered renderer checks and 20 rendered phone UI checks** cover actual shared rich content,
  thinking, scroll/motion, comfortable/large scale, 320-pixel overflow, live/completed Desktop layout,
  new Mac/Phone chat isolation, no inherited draft, exact first-message destination and saved setting
  propagation. These use inert browser fixtures, not a physical iPhone.
- Full mobile SDK/type/lint/security/gateway/crypto/14-case responder/actual Workers/platform/linked
  checks pass. The encrypted responder case now verifies catalogue/create/result/retry over actual
  Noise traffic. Both typechecks, Desktop build/engine/package gates, linked real adapter cases,
  native pairing fixtures and iOS export are recorded separately. Three inherited lint warnings remain.

The first new UI checks exposed fixture request counts reset by full-page reload, missing text-size
row insertion and macOS `/var` versus canonical `/private/var` path expectations. These were corrected
without relaxing the requested outcomes. A browser-only background-frame delay required bringing
the actual Desktop canvas page forward before checking its virtualized completion. One integration
attempt changed Mac state after an arbitrary 120 ms; valid coalescing produced three reads instead
of the expected four. The fixture now waits for the acknowledged initial read, then changes state;
it retains exact message/base-revision and four-read assertions. Earlier failed logs are preserved.
An initial source/native phone fixture ran without the ASAR variable; its `packagedRuntime:false`
receipt is retained separately from the corrected packaged run. The first actual ASAR run then
caught a dependency cycle: importing global settings from the responder caused the packaged chunk
to import the app entry and register phone IPC twice. Known roots now travel through injected
MobileConnection/Responder options from the Mac app; the chunk owns no global settings dependency.
That failed package remains uninstalled and its raw error is retained.

## Delivery and remaining gates

The signed local arm64 Desktop package is **installed at `/Applications/Bimax.app`**, verified with
the same designated signing requirement, and the owner confirms it opens normally. All **918 regular
saved-data files** remain byte-identical across the clean-shutdown/replacement interval. The prior
bundle is recoverable. Installed ASAR SHA-256:
`3576a99f44a4556f380db5c63a1d69bf0d1d75465c1d4b9e922dd8f45d399210`.
The current package passes eleven actual ASAR-backed phone-controller end states after the chunk
cycle correction; full package gates and deep strict signature verification pass. This is manual alpha, not Developer ID/notarization. Unaccepted Xcode license prevents
regenerating the asset catalogue; the existing legacy icon remains. No license or global toolchain
preference is changed. Desktop window automation timed out, so the owner performed the normal
quit and later confirmed the new build opens normally. No native window screenshot is claimed.
Saved profile and verified pairing are not reset. The app's normal runtime writes after launch are
separate from the unchanged replacement interval.

Expo Go’s current LAN development server is restarted and the current iOS bundle/export is checked;
bundle availability does not prove a physical reload. Current native visuals/gestures, background,
cellular roaming, sleep/wake, accessibility/large-text breadth, long-history memory/battery and owner
visual acceptance remain **Target**. Root/phone file-hash receipts verify **10,095 unrelated Desktop files and 263 unrelated mobile
files** remain byte-identical, with all **77 prior mobile deletions** retained. Intentional modified
files and new source/doc files are listed and hashed separately. No commit, stash, reset, new pairing or cloud deployment.
