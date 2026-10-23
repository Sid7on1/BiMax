# Rich conversation and retained outputs

Checked: 2026-10-19. Owner-authorized implementation of the supplied chat/harness/canvas plan.
**Implemented** describes the source mechanisms below. **Measured** applies only to the scoped local
fixtures in the evidence directory. Installed performance, provider-tier qualification, complete O01,
Product-ready, release and Win remain **Target** until their independent gates pass.

## Product and architecture

Guided by product-reset README, frontend examples 03 and plan 04, architecture 05, migration 07,
acceptance gates 08, Mac Buddy vision, competitive README/02/04/05/06, and records 67/75. The
referenced competitive/03_CAPABILITY_MATRIX.md is still absent and was not treated as evidence.
Current monolith records 55/64 and Mac-owned built-in Computer Use records 79–84 retain precedence.
No Computer Use ownership or fallback was added to Terminal.

The existing chat store, virtualized transcript, worker transport, animation-frame coalescer and
approval paths remain authoritative. Wire release 3.8.0 adds an optional `rich-presentation` feature,
configuration notices and bounded presentation parts. No competing conversation runtime is installed.
AG-UI lifecycle separation and A2UI's client-owned component catalog inform this contract; full
AG-UI/A2UI protocol adapters are unnecessary for the current integrations.

- Streamdown renders streaming Markdown, GFM tables/footnotes, math and completed Mermaid diagrams.
  Expensive code/math/diagram plugins load on demand. File links and host clipboard copying remain.
  Raw HTML is literal text; untrusted remote images require an explicit link click. Raster MCP image
  bytes and resource/structured metadata survive separately from model-facing text.
- Pricing configuration messages use `engine_notice` and Settings → Providers & models → Usage
  estimates. They no longer replace task progress. Provider billing/rate arithmetic is unchanged.
- A Desktop-born `OutputTool` publishes managed snapshots for its host-owned Bimax Thread and run.
  It has no arbitrary project/export path. Text fallbacks remain useful without rich UI support.
- Outputs opens in the existing right workbench, beside chat/composer, including without an active
  project. Preview/source, local drafts, editing, exact saved-version selection, comparison and
  explicit native-dialog export share one catalog. Saved bytes remain available after engine exit.
- Markdown, rich HTML documents (Tiptap core/tables), code, Mermaid, inline-data Vega-Lite charts,
  sortable tables, bounded forms, HTML and React are supported. Chart controls run locally; the
  linked table can filter the plotted data. Selection/row/form/console follow-ups fill a draft for
  user review. There is no automatic model request.

## Storage and authority

The desktop stores snapshots under its userData `outputs/` directory. Stable output IDs bind owner,
producer run and caller key. Exact version IDs include ancestry and content; versions are never
replaced on an edit or revert. Commit means fsynced bytes plus an atomically published manifest,
followed by hash/byte-count read-back. A replay with the same key/bytes is idempotent; a conflicting
replay is refused. Revisions require the current exact base version and original owner/format.

Content is limited to 192 KiB, 1,000 versions per output and a 100 MiB managed disk budget, counting
interrupted orphans. Symlink/nonregular/oversized retained files are refused. Missing and altered
bytes stay visibly Missing/Changed; they are not replaced by similarly named files. Available means
readable retained bytes, not semantic correctness or a passed check. UI drafts are separate local
storage entries; explicitly saving creates another immutable version.

This first registry retains text-backed outputs. Binary PDF/Office/media import, automatic
DocumentTool file registration, deletion/retention management, cloud sync and the complete record-67
O01 contract remain Target. Existing DocumentTool outputs continue through their existing file path.

## Executable previews and tool interfaces

One runnable preview per main window uses a distinct memory-only Electron session and sandboxed
WebContentsView. Generated content has no Node, Bimax preload, trusted IPC or filesystem access.
Navigation, new windows, downloads, permissions and network requests are denied. A loopback deny
proxy and disabled non-proxied UDP cover the separately tested WebRTC/TURN path. The CSP also
blocks external scripts, connections, frames, forms and workers. React compiles in a bounded,
cancellable worker against a bundled React/ReactDOM catalog; arbitrary dependency imports are
refused. Restart/Stop, pane/dialog/conversation transitions and window teardown retire the guest.
A per-window session is cleared and reused to avoid retaining a new Electron partition per restart.
Console events carry an owner/token, are bounded, and can be attached to a draft request.

MCP Apps uses the pinned upstream MIT AppBridge SDK in an isolated first-party host and an opaque
sandbox iframe. The dedicated host preload can invoke only the selected, granted tool bridge; the
iframe has neither that preload nor Bimax's API. Engine-local grants expire and become invalid when
the connection/catalog retires. Only the original UI-declared producing tool is callable; it goes
through the existing tool factory/Governor and cancellation paths. No direct SDK client or provider
credentials enter the UI. UI-originated automatic chat/context changes, external domains, downloads,
sibling app-only tools and native execution are unsupported and fail closed. The text result remains.

Full native applications, arbitrary packages/development servers, paid document collaboration,
React Flow graph editing and Excalidraw whiteboards remain outside this first runtime. Dedicated
security review and broader hostile-server qualification remain release gates.

## Evidence and limits

Evidence: [2026-10-19-rich-outputs](evidence/2026-10-19-rich-outputs/).
The source ledger records fresh first-party references and package provenance. Tests exercise real
filesystem snapshots, actual browser components under the renderer CSP, a real stdio MCP server,
and actual Electron guests/React/MCP bridge. The checks assert resulting bytes, DOM, tool-call count,
blocked requests and destroyed guests rather than treating an invocation as proof.

The initial browser campaign caught the default library clipboard mismatch and a Compare-effect
race; both are repaired. Initial harness selectors and the distinction between a window's own view
and an added guest were corrected before final qualification. A two-setting Node mutation remained blocked by context isolation; removing that third boundary
produces the expected assertion failure. The draft CSP WebRTC directive was rejected after the
installed Electron reported it unrecognized; the separate UDP/TCP network checks grade the adopted
proxy/policy mechanism. Source-fault results are preserved,
including assertion failures, exact starting hashes and restoration.

No local fixture establishes installed scrolling/startup/RSS/energy, accessibility certification,
minimum/balanced/frontier generation quality, full crash/recovery O01, clean-Mac distribution or a
competitive advantage. Those stay Target. Final commands, counts and artifact provenance are added
below after qualification; no broad release claim is implied.

## Completed local verification and installation

- Root `tsc --noEmit`, app typecheck, protocol fixture/package generation and production builds pass.
  Wire 3.8.0 remains compatible with the existing major-3 transport.
- 114 focused Jest checks in 12 suites pass. They include filesystem restart/version/ownership and
  tamper end states, the real pricing estimator event, state/store isolation, real stdio MCP UI
  resource/tool calls through the Governor, existing MCP deadline/connection ownership, embedded
  tools, clipboard and protocol contracts. No paid model turn ran.
- 23 actual browser-component checks and nine complete renderer checks pass. These cover GFM/math,
  syntax highlighting under the unchanged trusted CSP, exact clipboard/kept code bytes, stable
  completed DOM and selection while streaming, unfinished/malformed Mermaid, charts/sliders/linked
  tables, row follow-ups, safe document editing, version comparison/reload, malformed JSON fallback,
  workbench navigation, late-owner saves, visible settled panels and pricing notices in settings.
- Ten dangerous source faults are assertion-caught: foreign owner, stale revision, altered bytes,
  cancelled publication, active image format, unauthorized UI tool, notice-as-progress, revoked UI
  grant, all guest authority boundaries removed, and a nonopaque MCP iframe. One additional
  two-setting Node mutation remains defeated by context isolation and is retained as defense
  survival, not counted as a caught defect. All mutated source bytes were restored.
- Eighteen actual Electron runtime checks pass against the installed artifact's compiler,
  dependency files, preload and MCP host assets. They cover React hooks, blocked imports,
  superseded compilation, no privileged APIs, fetch/file/permission/navigation refusal, real local
  STUN-UDP/TURN-TCP denial, foreign-owner controls, replacement/Stop/runaway teardown and MCP App
  initialization/action/opaque-origin separation. This is a scoped fixture, not full adversarial
  certification or a whole-app resource benchmark.
- Scoped root lint: zero errors, 110 warnings. Dependency updates leave the app's production npm
  audit at zero high/critical, three moderate and seven low findings; the raw audit is retained.
- Built and signed the local arm64 app with the existing local certificate. Installed it at
  `/Applications/Bimax.app`; all 1,089 file/directory/link entries and modes match the signed build.
  The previous bundle is recoverable at `~/.Trash/Bimax-before-rich-outputs-20261019.app`.
  Version remains 1.1.0; `install.json` identifies the exact engine/ASAR/tree hashes.
- Strict deep signatures, installed package/native inventory and three app actions pass. The
  installed engine answers all seven verifier exchanges. CU/voice/notch/App Intents staging uses
  the existing build scripts; their Command Line Tools fallback and Swift warning remain in logs.
  No macOS permission was reset.
- All 1,419 saved profile files had the same aggregate hash during replacement, before normal app
  startup. Native AX observed the exact installed renderer and opened Workbench → Outputs with
  its search, New control and retained-output explanation. The first cached automation binding
  did not activate the button; rebinding to the installed path worked without a restart or reset.

Raw results and source hashes are linked from `evidence/2026-10-19-rich-outputs/qualification.json`.
Installed startup/scrolling/input/RSS/energy comparisons, accessibility certification, minimum/
balanced/frontier generation, complete binary/automatic-file O01, broad MCP compatibility and
Developer ID/notarization/release remain Target. There is no reliability or competitive Win claim.
