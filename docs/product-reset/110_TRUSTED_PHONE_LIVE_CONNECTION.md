# Trusted phone access and live conversations — 25 October 2026

The owner confirms iPhone/Expo Go pairing and Mac conversation listing, but reports that record
109's repeated Mac consent is unusable and that conversation messages do not stay synchronized.
Their explicit policy is to pair once, leave the Mac at home and continue from the phone outside.
This record supersedes records 99/104/105/109 **only for ordinary paired-phone host consent and its
banner**. Human verification of a new phone, account/device ownership, signed tool decisions,
revocation, Stop and all unrelated filesystem/renderer boundaries remain required.

Guidance: product-reset README, 03 product examples, 04 frontend, 05 architecture, 08 gates,
Mac Buddy vision, competitive README/05/06 and records 99/104–109. Competitive/03 is still absent.
Terminal acquires no Computer Use ownership, permissions or fallback.

## Implemented

### Pair once; work from the phone

The verified paired key plus a current authenticated Noise session authorize ordinary history,
chat, command and supported file operations. The main process checks the exact peer, cancellation,
input bound and Stop state. There is no native request-by-request Mac modal or floating access
banner. A small menu-bar Phone indicator retains a main-owned Stop Phone Access command. Stop
revokes the grant immediately, including while engine cancellation is pending or fails; ordinary
work cannot clear its latch. Forget revokes trust and clears the local cloud grant.

Engine tool decisions still require the exact signed, expiring approval capability. The selected
conversation links directly to that action's decision screen on the phone; another conversation's
request is not mislabeled as its action. Expo Go permits the operating system's device-passcode
fallback to strong biometric authentication because Expo Go cannot use the app's Face ID usage
description. An installed build retains its biometric-only policy. Cancel/failure never signs a
positive decision. Nobody needs to approve these decisions at the unattended Mac.

Settings now opens before a project is selected. Engine-dependent agent configuration waits for an
engine; Phone connection does not. This repairs the outer `hasProject` gate that record 108 found.

### Push changes from either device

The adapter receives ThreadManager events for work initiated on either Mac or phone. It publishes
selected-conversation changes after state reduction. Unchanged immutable message arrays are cached
within an eight-conversation bound; streaming does not repeatedly reconstruct saved history.

Opening a conversation starts one peer/Noise/session-bound watch, obtains one immutable paginated
baseline, then acknowledges its revision. Subsequent changes carry ordered revisions and changed
message/text tails, coalesced at 100 ms. A gap or oversized patch replaces the watch and baseline;
there is no periodic full-history polling. Only the selected conversation is followed. Final
messages replace the streaming tail atomically. Disconnect, account change, view exit and Stop
retire the watch and pending reads. Reconnect establishes a fresh baseline under existing verified
trust. iOS foreground return after background suspension refreshes the transport; an authentication
modal's inactive state does not itself force this refresh.

The native-to-WebView bridge also transfers changed tails/text deltas, rather than serializing the
whole conversation for every token. Callbacks stay native; they never enter structured-clone state.
Both phone chat paths retain record 109's actual Desktop Markdown, typography, styles and offline
math/code/diagram plugins, with the same network-denying CSP and narrow Copy/link/Retry bridge.

A new integration check exposed a second transfer bug: immediate history chunks plus acknowledgments
could exceed the relay's 30-frame/second budget. Continuations now share an eight-request/second
budget. The original 16 KiB chunks, 4 MiB serialized cap, 3 MiB adapter text cap, 4,000-message cap
and two-read/two-snapshot bounds remain. Snapshot expiry and client timeout are now two minutes to
permit paced large transfers. Cancellation clears scheduled continuation work.

### Internet relay independent of model billing

Read-only deployment inspection found no deployed `bimax-relay`. Existing model-gateway production
also predates hardened source and lacks its current price/spend configuration; it is **not**
redeployed or represented as hardened by this work. Its deployment and model configuration remain
unchanged. Connection transport must not depend on buying cloud-model credits.

The separate `bimax-relay.sid7vish.workers.dev` Worker now owns transport admission and Durable
Object routing. It uses the existing account JWT verification and same D1/KV account bindings,
with its own new ticket secret. The only production schema addition is nullable
`relay_devices.renewal_id`; existing rows/data are preserved. No Supabase project, account,
provider setting, signing key or RLS policy is changed.

After existing human-verified local pairing, the phone sends the Mac's fresh Ed25519 registration
proof to the fixed owned HTTPS service using its Bimax account session. The room is the SHA-256 of
the Mac's base64 hello public key, preventing an unrelated key from claiming a predictable device-ID
room. Account ownership, fixed limits and pinned device keys still gate admission.

The phone returns an opaque, revocable relay-only credential through Noise. The Mac saves it using
existing encrypted preferences; user access/refresh tokens stay on the phone. Renewal/revocation
requires that credential **and** a fresh action/nonce/device/room-bound Mac signature. Recreating a
removed room does not revive its previous credential. Upgrade tickets expire in 60 seconds, bind
role/key/room and still require signed hello before presence/routing. The relay transports opaque
application ciphertext. It grants no model credits or project execution authority by itself.

The Mac keeps LAN and cloud routes available. Replies follow only a route selected by valid
transport confirmation or authenticated nonduplicate application traffic; unauthenticated metadata
cannot redirect application output. The phone saves the cloud route after the authenticated setup
acknowledgment, prefers it for away access and retains its LAN fallback. Setup errors have a separate
Retry path and do not demand another QR scan or disable working local chat. Stop closes both routes.
A new phone still requires initial human verification at the Mac.

## Measured evidence and verification

Evidence is in [the scoped evidence folder](evidence/2026-10-25-trusted-phone-live/).

- Full Desktop Jest: 478 passing suites / 4,634 passing tests, with the same one conditional suite
  and three skipped tests. Three additional native-cloud regressions pass separately. Bun: 2 ledger
  tests in a fresh process plus 131 other tests; release-script tests: 3 pass.
- Actual Electron host fixture: twenty ordinary operations without any Mac approval dialog or
  BrowserWindow, wrong-peer/disconnect denial and native menu Stop. Three disposable authority
  faults fail assertions; original source is never overwritten by that prover.
- Twelve live end states cover Mac-origin updates, coalescing/no polling, final replacement,
  duplicate/foreign rejection, chunked resync, missing revisions, old Noise identity, view exit and
  a sub-500-byte bridge delta over a megabyte transcript.
- Fourteen encrypted responder cases now include selected live updates through real relay/Noise,
  alongside history, replay, key changes, tool decisions, recovery and PQ pairing.
- Actual RN Web screen checks follow row tap, selected history/reply, a Mac-origin message without
  another history read and exact phone action navigation. Actual shared renderer checks include
  incremental patches/Retry, Desktop parity, Copy bytes and denied script/network access.
- Actual Workers/D1/KV tests grade account ownership, Mac-key rooms, transport with no model
  entitlement, signed renewal, wrong keys/credentials and revocation. Gateway unit/migration tests
  remain green. The new column is exercised by the production health probe.
- A deployed-cloud fixture pairs two disposable synthetic devices locally, transfers a large exact
  history, reconnects the same trusted keys through public TLS, removes LAN entirely and receives
  a Mac-origin live update through Noise. Stop then closes both routes. No real account credential,
  real engine, human phone trust or project data is used by this fixture.

Final verification/install receipts carry the precise completed checks, source/artifact hashes and
preservation counts; do not infer physical-device success from these fixture results.

## Delivered artifact and startup qualification

The rebuilt arm64 app replaces `/Applications/Bimax.app`; its previous bundle remains recoverable
outside the repository. The designated signing requirement is unchanged. The new installed ASAR
SHA-256 is `cbd3f0f62d1e3c876b30cd8f382177ab55519a3f724674b5598c693d43724c38`.
All **921 regular saved-data files** are byte-identical across bundle replacement; no profile,
Keychain item, account or permission is reset. Original source/deletions are audited separately.
The package retains its `.icns` fallback because Xcode's license is unaccepted; no legal agreement
or global developer-tool setting is changed.

The first real installed launch waited on macOS Keychain: a process sample showed
`SecItemCopyMatching` waiting on SecurityServer and SecurityAgent was running. Computer Use is
explicitly prohibited from operating SecurityAgent. The owner completed the local step and
confirmed “Bimax opens”; the actual installed welcome window and Settings → Phone connection were
then independently observed without selecting a project. No password was requested in chat or
entered by the agent. The observed connection screen was off; enabling it and the physical
phone/account/cloud journey still need the owner's end-state check. The final help-copy refresh
is again waiting for the owner's macOS Keychain startup step; it is not claimed as an observed
final-window success. Final visual inspection also
caught and corrected one residual help sentence that directed Expo Go tool decisions back to the
Mac; the packaged Settings fixture now rejects that obsolete policy copy.

The Expo server is running again and serves the current iOS bundle with live/cloud/phone-action
markers (manifest/bundle HTTP 200). Reloading Expo Go is still needed to receive it.

## Target and qualification limits

The owner's latest physical result is still the **negative** record-109 consent/synchronization
observation. Current iPhone retry, same-account automatic cloud registration, native tool-decision
passcode/Face ID, mobile-data/Wi-Fi switching, locked/background recovery, Mac sleep/wake and long
sessions remain **Target until observed**. A sleeping/offline Mac cannot execute work: it must be
awake, connected and running Bimax. No wake-over-internet capability is claimed.

Source parity is not measured native WebView performance/battery qualification. The roughly 0.95 MB
base plus offline math/code/Mermaid assets retain record 109's memory/download cost. Full interactive
Desktop Outputs, attachment transfer from this chat composer, per-conversation Stop, automatic theme
mirroring and broad recovery/clean-machine/release remain Target or deliberately outside this slice.
This is a locally signed manual alpha, not Developer ID/notarized public distribution. No Product-ready
or competitive Win claim is made. Portable hosted two-repository artifact delivery is still Target.

Primary platform evidence: [Expo LocalAuthentication](https://docs.expo.dev/versions/latest/sdk/local-authentication/)
and installed SDK-58 iOS implementation distinguish Expo Go's missing Face ID configuration from
OS-authenticated passcode fallback. The Supabase changelog was checked; current public JWKS returns
an ES256 signing key. Installed auth/client and Wrangler/D1/Worker source/runtime, deployment receipts
and the isolated platform tests guide the connection design. No competitor implementation is reused.
