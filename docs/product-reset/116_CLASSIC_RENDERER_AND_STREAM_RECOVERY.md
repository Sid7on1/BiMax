# Classic renderer restoration and remote streaming recovery

Date: 2026-10-26. Implements [plan 115](115_CLASSIC_RENDERER_AND_STREAM_RECOVERY_PLAN.md).
The owner supersedes record 114's message-canvas styling, while retaining its workspace selection,
fresh-chat lifecycle and local embedding recovery. The owner explicitly confirms that **Mac-tab
chats**, rather than all standalone Phone chats, must use only the Mac model path.

## What changed

### Restore the earlier renderer selectively

`app/src/renderer/src/markdown.tsx` again uses the repository's original marked token renderer and
Highlight.js, rather than Streamdown for ordinary messages. The source baseline is
`7d1346dd9f428ce780871a652ce2f3a27b5388f6:app/src/renderer/src/markdown.tsx`, SHA-256
`137032b875c291d27345f64aced2248c5053f6772a66581dcd8eaa1aa4678531`.
This is a selective source restoration, not an old app downgrade or a working-tree reset.

The original heading scale, literal HTML, HTTP(S)-only links, compact code frames, Highlight.js
colors, 34em prose limit and responsive Desktop reading column return. Desktop text inherits its
original 13.5px base, with 10px/16px user-bubble padding; the added fixed 760px/16px canvas rules are
removed. Live and completed messages retain one shared component. The phone compiles this same
source/CSS; its saved 17px/19px accessibility reading scale remains a deliberate host difference.

Adaptations to that historical source are explicit: stable completed tokens/blocks, correct
reference-definition invalidation, memoized highlighting, bounded large/unknown streaming code,
Copy lifetime cleanup and host injection, corrected duplicate task markers, real Desktop Keep
output events and optional bounded offline KaTeX/strict Mermaid addons. Output saving waits for a
completed fence, retains the same request key for retry and disables duplicate Save after success.
Phone Copy goes through the native host; no Desktop preload or Keep output authority is present.
Raw model HTML/images are not executed/fetched; the phone document has `connect-src 'none'`.

The current phone renderer base is **471,168 bytes**, with math **1,727,460** and Mermaid
**3,457,302** bytes. The separate Shiki code plugin is no longer packaged. This is an artifact-size
measurement, not an iPhone memory, speed or battery measurement. Renderer hash:
`aab8c20b7c7008e107a0d08631acd017aec5761f7f94cac08c9b66925ce65b2c`.

### Keep a remote conversation visible and recover its view

The selected Mac chat previously depended on the whole mutable trusted-desktop object and cleared
its conversation at every subscription restart. A same-peer metadata refresh could therefore clear
visible messages and request history again. The screen now depends on the paired device identity,
actual secure-session readiness and subscription lifetime, retains the same chat snapshot through
reconnect, disables sending until the encrypted session is ready and keeps the existing generation/
selected-id fences. A new chat still mounts a fresh owner and retires the old history/draft.

The isolated phone document mounts at most **80 message trees**. Earlier/Next/Latest paging keeps
all canonical messages and incoming patches without re-requesting history. Completed blocks retain
DOM identity during streaming; large or unidentified live code remains readable without repeated
automatic language detection. Final text remains exact.

Native content-process/render-process/load/ready-timeout failures now remount only the WebView,
restore the latest authoritative conversation and reset pending bridge delivery. Duplicate/stale
native events do not consume extra attempts. Two automatic remounts per minute are allowed; repeated
failure exposes an explicit Reload conversation control. Neither path restarts pairing, re-enqueues
a prompt or invokes a model. Only a bounded in-memory ring of 32 technical event codes/timestamps is
retained; no prompts, responses, credentials, peer/account ids, raw errors or URLs are logged there.
The web preview also handles a ready-before-listener load race. A synchronous relay callback throw
is contained and is not acknowledged; a later successful replay can be processed normally.

These are reproduced source-level reset paths and tested recovery mechanisms. **No native crash
log establishes the cause of the owner's 2–3 second interruption. A physical iPhone crash fix is
not claimed.** Total retained conversation/bridge memory remains separate from mounted DOM bounds.

### Mac-tab model authority

The inspected production path is:

`DesktopChat.send → useRemoteActions.sendRemoteChat → account-scoped operation outbox →
provider.sendEncrypted → seal(current established session) → encrypted relay envelope →
Desktop responder/RealEngineAdapter.chat → exact selected engine → Desktop model provider`.

The phone remote hook has no call to standalone `streamChat` or the model gateway. The actual hook
fixture observes one queued idempotency key, one send into the encrypted transport port and **zero
phone HTTP/model calls**. Separate real signature/responder/adapter cases qualify encryption,
selected-engine execution, immutable snapshots and duplicate replay. Those layers are identified
separately; the hook fixture's transport is inert, not a live provider/network trace.

The hook additionally checks the account before admission and rechecks account/paired Mac after an
asynchronous outbox write, so an old account's pending callback cannot send with changed authority.
Recovery preserves the original operation instead of generating another prompt. Standalone Phone
chats intentionally continue using their independent gateway path.

The served iOS bundle contains the new renderer/recovery/account guards and no NVIDIA/OpenAI/Groq
credential-shaped literals in a scoped static scan. Phone public environment names are only the
Supabase URL/public anon key and gateway URL. An absence-of-literals check is not proof of all runtime
secret handling, and no claim of an exhaustively secure application is made.

### Layout and current first-party design research

[The source ledger](02_RESEARCH_LEDGER.md#2026-10-26--classic-chat-recovery-and-desktop-ui-references-records-115116)
records fetched current OpenAI Settings/Commands references and their limits. Keep the dark, quiet
conversation surface, stable left history/search/New area, persistent lower Settings/Your Mac
navigation, bottom composer and grouped settings. Phone Appearance, General, Mac connection and
Account are separate; text-size copy explains that it changes this phone only. Existing saved
motion/thinking/follow controls and exclusive Phone-left/Mac-right histories remain functional.
Your Mac opens connection settings, not another copy of chat history. Mac provider/configuration
controls remain with their Mac owner.

Computer Use refused inspection of the installed ChatGPT app for safety reasons. No copied source,
OpenAI branding or exact live pixel match is claimed. The official references establish functional
placement and categories; Bimax-specific styling remains an implementation choice. The owner's
preferred earlier Desktop renderer takes precedence over record 114's visual changes.

## Verification actually run

[The qualification receipt](evidence/2026-10-26-classic-renderer/qualification.json) retains scoped end states, faults and hashes. Private raw evidence is retained at `~/.local/state/bimax/renderer-recovery-20261026/`:

- **153 Desktop tests / 11 suites**: 110 lifecycle/UI/Outputs/responder/controller tests and 43
  thinking/status/coalescing/render-policy/security-boundary tests. Both Desktop and mobile
  TypeScript checks pass. Tests were not deleted or skipped to obtain these results.
- **36 actual renderer end states**: classic GFM/Highlight.js/math/diagram rendering, historical
  Desktop geometry, phone/Desktop DOM/font/color comparisons, exact native/Desktop Copy and
  Keep output event bytes, unsafe HTML/link/image/CSP refusal, stable completed blocks, appended
  reference definitions, thinking rotation/disclosure/repetition/Reduce Motion, follow preferences,
  17px/19px/narrow-width reading and 2,000-message/80-mounted-tree paging with exact live tail.
- **22 phone UI end states**: actual RN Web screens and isolated transcript, exclusive/searchable
  drawer, selected-chat replies/live Mac updates, metadata stability, visible history through real
  connection-state changes without prompt resend, exact approval navigation, saved preferences,
  explicit folder/new empty chat and retired drafts/history. These are browser-hosted screens,
  not physical iPhone gestures.
- **7 actual remote-hook/native-host end states**, including simulated native process termination,
  latest-text recovery, duplicate-event/budget stopping, manual Reload without another model call,
  account change while awaiting persistence and no browser exceptions. The native WebView and
  secure-storage/transport ports are inert fixture ports; the real React host/hook run unchanged.
- **4 unit regressions**, including relay synchronous throw/no false ACK; **7 assertion-caught
  source faults**: unbounded remounts, removed generation fence, unbounded diagnostic retention,
  synchronous socket throw, injected phone model call, removed post-await account guard and
  metadata resubscription. Mutants run in disposable copies; production files are never mutated.
- Full mobile `npm run check` passes: SDK 58 alignment, type/lint/security/crypto/gateway tests,
  actual Workers/D1/KV/Durable Object checks and linked UI/live/history/workspace suites. Three
  inherited array-type lint warnings remain, zero errors. After the final Desktop Keep output
  adjustment, renderer freshness/36 renderer checks, coordinated build and final iOS export pass.
- Linked Desktop/mobile integration and the **14 actual signature/RealEngineAdapter cases** pass,
  including single execution under replay and two engine replies. Source and **actual final-ASAR
  11-case phone-controller/preload fixtures** pass (`packagedRuntime: true` for the latter).
- Coordinated Desktop build, final iOS export, local stable signing, strict deep code-signature
  verification and full Desktop package gates pass. Xcode asset-catalog regeneration remains
  unavailable under the current toolchain; the existing legacy icon ships. No license/global
  toolchain preference changed. This remains a manual alpha, not Developer ID/notarized release.

Earlier failed attempts remain in the same private evidence folder: missing secure-context
`crypto.randomUUID` for an offline diagram id (replaced with a non-security local serial), inherited
code-font mismatch in the phone builder (matched to the Desktop font token) and a web ready/load
race on a new conversation. The final named end-state receipts pass with no browser exceptions.

## Installed result and remaining qualification

The verified build is installed at `/Applications/Bimax.app`; all **82 packaged JavaScript/CSS/HTML/JSON build files** match the qualified local output bytes. Normal native Quit was available for
this update. **All 921 regular saved-profile files are byte-identical across the closed replacement
interval**, and the stable designated signing requirement is unchanged. The prior app is retained
under the private evidence folder's `previous-installed/Bimax.app`. Final installed ASAR SHA-256:
`8fe8ccd6569503449ab890acbac5b2781bf6297da0ac23e522ac594900a3261d`.
A native screenshot and accessibility tree subsequently show the installed app open with saved
history/sidebar/composer and an active owner turn; no diagnostic prompt was injected. One initial
post-launch AX timeout is retained as a limitation, not mistaken for app failure or a Keychain
prompt. Runtime profile writes after launch are outside the closed-file comparison.

Expo Go's LAN server is restarted with a fresh cache; an actual iOS manifest and **14,357,493-byte**
current development bundle contain the exact renderer hash and recovery/account markers. This
proves delivery availability, not a physical reload. iPhone Mirroring again reports Timed Out.
Physical owner acceptance of the restored renderer, native keyboard/gestures/VoiceOver, continuous
long generation without a reset, native RSS/battery, background/cellular/sleep and public release
remain **Target**. Cloud/schema/model/provider credentials are unchanged. No broad performance,
security, Product-ready or competitive Win claim.

File-hash receipts preserve **10,124 unrelated Desktop files and 274 unrelated mobile files**, with no new missing files and all **77 prior mobile deletions** retained. Existing dirty work is not reset or stashed.

Guiding documents: README, 03 Product Examples, 04 Frontend Plan, 05 Target Architecture, 08
Acceptance Gates, Mac Buddy vision, records 109–115 and competitive end-state/mutation rules.
