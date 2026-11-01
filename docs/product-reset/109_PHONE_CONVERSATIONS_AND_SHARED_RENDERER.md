# Phone conversations and the shared chat renderer — 24 October 2026

The owner now confirms that pairing succeeds on their iPhone in Expo Go and the phone lists Mac
chats. This supersedes record 108's pending physical pairing/list retry. They could not open a row:
the old Remote screen used a noninteractive View, and protocol 2 had no saved-history read operation.
The native phone renderer was a second, incomplete regex parser, separate from Desktop Streamdown.

Guidance: product-reset README, 03 product examples, 04 frontend, 05 architecture, 08 acceptance
gates, Mac Buddy vision, competitive README/05/06 and records 103–108. Terminal gains no Computer
Use ownership, permission or fallback. Missing competitive/03 remains explicitly unavailable.

## Implemented

- Tap a Mac conversation to open its selected history. Reading never selects, starts, resumes or
  submits a Mac engine. A reply carries that exact conversation ID; a stopped saved Bimax Thread
  can resume through the existing ThreadManager path. Busy conversations reject another turn.
- Native Mac consent grants history access for that selected conversation for the current secure
  session. A visible remote indicator and local Stop remain. Reconnection needs fresh consent.
  Plaintext frames, foreign senders/recipients and inactive accounts cannot dispatch history.
- History uses immutable snapshots split into 16 KiB chunks beneath the Noise frame limit. Each
  cursor binds peer, exact Noise session, selected conversation, snapshot and byte offset. Snapshots
  expire after 60 seconds; only two are retained, with two pending reads and initial-read pacing.
  The adapter caps text at 3 MiB/4,000 messages; serialized transfer caps at 4 MiB. Oversized chats
  refuse rather than silently truncating history. Client timeout, abort, reconnect and account
  teardown retire pending reads. Mac history stays in memory on the phone, outside local chat SQL.
- Both standalone phone chat and Mac conversation screens render one offline WebView per whole
  transcript. Its bundle compiles the actual Desktop `markdown.tsx`, shared `chat-content.css`,
  Streamdown utilities, font and Moonlight tokens. The separate phone parser is retired. Desktop
  also imports the shared styles. GFM, Shiki, KaTeX and Mermaid use the same installed libraries
  and options; plugin code executes on demand. Code copying preserves parser bytes.
- A source/output hash guard fails stale generated artifacts. Desktop prepare/build regenerates
  the linked phone artifact; phone start regenerates it and check verifies it. The link is validated
  against the installed responder/protocol links, with a local ignored Desktop-link file for the
  phone runner. Generated bundles are ignored, not an independently maintained renderer fork.
- The phone renderer has no Desktop preload, files or command bridge. CSP blocks network access,
  frames, objects and arbitrary scripts; HTML stays literal, remote images do not auto-load, links
  require an explicit native confirmation, and Copy uses a narrow acknowledgement bridge. The
  browser preview uses the same artifact inside an opaque iframe sandbox.
- Active/awaiting-approval histories refresh every two seconds; idle histories every fifteen
  seconds, with manual Refresh/Retry. Background views suspend reads; leaving aborts them. Remote
  composition identifies the Mac model and omits unsupported attachments/model switching. The
  emergency Stop explicitly confirms that it stops **all** Mac activity; it is not a per-chat Stop.

## Verification

[Evidence](evidence/2026-10-24-phone-conversations/) preserves end-state reports, fixture screenshots,
source/output identities and hashes of private raw runs. Failed qualification attempts are retained
privately and are not counted as passing end states.

- Desktop full Jest: **478 suites / 4,634 tests pass**, one conditional suite/three tests skipped.
  A CommonJS initialization-order bug found during delivery is fixed; the UI class contract test
  now expects the shared style class. The final run uses two workers. The first simultaneous
  build/full-suite attempt also hit an existing 5-second fsync timeout; the unchanged storage test
  passes in both subsequent full runs. No timeout or production storage guarantee was relaxed.
- Bun: **2 memory-ledger tests plus 131 other tests pass**, and three release-script tests pass.
  A combined Bun run produced a negative JSON heap baseline from prior suites. The normal runner
  now measures that ledger in its own process; its corpus, positive-baseline assertion, 75% bound,
  structural residency check and ranking assertion are unchanged. This repairs measurement
  isolation, not a production memory optimization or a skipped comparison.
- Linked history: **17** end states cover immutable UTF-8 pagination, consent, cancellation,
  reconnect/cursor identity, missing/oversized histories, duplicate/malformed chunks, account and
  authentication boundaries. **Three assertion-caught source faults** remove consent, allow an
  old secure-session cursor, or allow plaintext history dispatch; each grader rejects its fault.
- All **14** existing encrypted responder integration cases pass, now including a multi-chunk
  exact-history roundtrip inside case 2. A real adapter/ThreadManager fixture has **14** checks,
  including stopped-chat resume without selection, no engine start on read, exact reasoning,
  bounded history and refusal of simultaneous turns. Fixture pacing lets the additional history
  transfer leave the relay rate window before the following intentional burst/replay cases.
- **11** shared-renderer end states and **six** actual phone UI end states pass. These include
  GFM/math/code/diagram output, literal scripts, refused tracking loads/navigation, exact native
  Copy bytes, computed Desktop/phone typography/colors, streaming identity and selected-ID replies.
- Full mobile SDK alignment/typecheck/lint/test/platform gates pass, with zero lint errors and the
  three inherited relay array-style warnings. SDK-58 WebView binding is checked against actual
  resolved native versions. iOS Hermes export passes; current Metro delivery is HTTP 200 and
  includes the new route/history/shared renderer while the former token-regex parser is absent.
- Desktop and mobile typechecks/builds pass. The actual bundled engine answers **seven** Electron
  exchanges; native remote-banner/consent-cancellation/Stop checks pass. Packaged controller and
  preload pass **11** pairing/restore/Forget/Stop end states. Package inventory, three App Actions
  and deep/strict signature verification pass. Those engine/host fixtures use inert external effects.

## Installed build and preservation

The verified local arm64 app replaced `/Applications/Bimax.app`, with the previous bundle retained
under `~/.local/state/bimax/chat-parity-20261024/previous/Bimax.app`. Both have the same designated
local signing requirement. New installed `app.asar` SHA-256:
`78e0db2f29ea82311234533f085f54f45ed93efb9a309ee237c128cb1508d343`.
The old asar starts `1f9f6ea641b44ad6` (record 107's installed build). All **907** regular profile-file
hashes match exactly across replacement, after graceful Quit and before relaunch. Normal app writes
on relaunch are separate from that replacement check. No profile, account, device trust or TCC grant
was cleared. The installed app's new process, matching asar, private-address LAN listener and visible
Welcome window were observed after relaunch; no live native history prompt was approved by the agent.

Fresh repository baselines preserve unrelated bytes and all **77** pre-existing mobile deletions;
only the listed implementation/test/docs changes differ. No commit, reset or stash was used.
This is the existing locally signed, unhardened manual alpha. Xcode's unaccepted license prevented
icon-catalog regeneration; packaging retained the existing `.icns`. No agreement was accepted and
no signing/security protection was changed. Developer ID/notarization remains Target.

The rendered-source fixture uses actual React Native Web screens with inert account/router/engine
ports. It grades a real row tap, selected route, saved-history display, selected-ID reply, visible
reply after refresh, dark background and absence of horizontal screen overflow. The independent
renderer fixture compares actual Desktop Markdown and phone rendering, including computed fonts,
sizes, line spacing, colors and exact text, and grades scripts/network refusal and streaming DOM
identity. These are browser/component measurements, not native iPhone execution claims.

## Qualification still open

**Target:** physical iPhone opening/replying after this update, native scrolling/selection/keyboard,
background/reconnect behavior and sustained memory/battery/latency. The owner confirmed pairing
and listing only. Expo Go already answers standalone GPT OSS chats (record 107).

The initial renderer HTML is about 0.95 MB uncompressed. Optional offline assets are approximately
1.76 MB math, 10.21 MB code and 3.46 MB Mermaid. Packaging these strings avoids network fetches;
on-demand execution does not eliminate their download or native-JS string storage cost. Source
parity is not a measured phone performance or battery claim. Further asset partitioning remains
Target, especially for very long conversations near the cap.

Tool activity is summarized by name/status. Desktop interactive Outputs, privileged file previews,
attachment transfer from this composer, app-owned executable previews, complete tool details,
automatic light-theme mirroring and per-conversation Stop are deliberately out of this slice.
Face ID decisions/native OAuth require their separate development-build gates. Projectless Settings
still has the App-level `hasProject` guard noted in record 108. Cloud rollout, clean-device/native
permissions, Developer ID/notarization and public release remain unqualified.

First-party platform evidence: [Expo WebView](https://docs.expo.dev/versions/latest/sdk/webview/)
lists version 14.0.1 and Expo Go inclusion; the installed SDK-58 dependency manifest agrees.
[WebView reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md)
and installed declarations/source guided static HTML, navigation refusal, injection and the narrow
message bridge. Installed Desktop dependency source guided Streamdown plugins and utility CSS.
No competitor source was imported.
