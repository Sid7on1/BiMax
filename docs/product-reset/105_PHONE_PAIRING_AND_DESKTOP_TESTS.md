# Phone pairing and Desktop test recovery — 24 October 2026

**Implemented and locally Measured, including the packaged runtime. Physical-iPhone confirmation and release remain Target.**

The owner requested the remaining Desktop test failures be fixed and a working phone pairing/settings
flow, preserving unfinished changes in both repositories. The intended phone is **iPhone using Expo Go**. The owner subsequently observed an SDK-58-only
runtime; the phone project is now upgraded to SDK 58 (see the final section).
Guidance: product-reset README; 01/05/06 ownership/architecture; 03 product examples and 04 frontend;
07 roadmap and 08 gates; Mac Buddy vision (networking and Trust Engine); competitive README/06,
C01 dirty-repository repair and R01/C04 recovery; records 99, 103 and 104. No competitor comparison.

## What now works

Settings → **Phone connection** is available without an engine/project. Opening it performs status
reads only. **Enable phone connection** explicitly starts an app-owned relay bound to a selected
current private IPv4 address. No environment flag, external relay command, Desktop cloud account
or deployed gateway is required for this LAN flow. Keep the phone and Mac on the same private
network. The mobile app retains its existing account sign-in and account isolation; nothing bypasses it.

The page displays a real QR plus copyable manual advertisement, updates rotating pairing references,
shows the exact candidate verification code and phone identity, and requires **Codes match — connect
phone** before saving trust. Pending verification replaces the QR so the confirmation is prominent.
Expired, foreign, changed-code and already-paired requests refuse. Connection state distinguishes
paired/offline from an actual online authenticated session. Disable, **Forget this phone**, and
**Stop remote access** have real backing operations. Stop remains available during other UI work,
invalidates an in-flight enable and latches remote access off until app restart.

Enablement/address/port and a reusable random LAN admission token persist through OS-backed
`safeStorage` encryption, mode-0600 atomic file replacement and file fsync. Unavailable/basic-text
storage fails before listening. Interrupted startup closes partial resources. Configuration operations
are bounded to one pending operation; Stop preempts rather than waiting for another user approval.
Saved enablement restores on later launches, but a missing network or bind failure remains visible.
Private token/config data and transport keys are not part of status responses. Pairing data is
intentionally visible only while enabled, online and unpaired; never log real pairing data.

The relay uses the same signed-hello, sender binding, replay, routing and bounded outbox implementation
as the existing hosted relay. That implementation moved into the mobile repo's
`packages/core/src/relay/node.ts`; `apps/relay/src/relay.ts` re-exports it. The app-owned LAN listener
uses memory-only Node SQLite, avoiding a second native SQLite ABI/package. It enforces a random
64-hex admission token, exact desktop room, no browser Origin, 256-KiB frames, eight WebSocket clients,
sixteen TCP connections, hello deadline, rate/outbox/device limits and explicit teardown. This is
an explicit LAN transport with Noise encryption and human code comparison, not a public cloud relay.
Existing native host consent, visible remote indicator and local emergency Stop remain mandatory.

Renderer/preload/main share a typed `MobileApi`; all `mobile:*` handlers use the existing exact
trusted-document/top-frame IPC wrapper. The renderer cannot supply relay URLs, credentials, identity
keys, listeners or storage adapters. Main alone selects the installed responder and cryptographic identity.
The QR encoder is pinned `qrcode-generator` 2.0.4 (MIT), rendered as local image data. Clipboard uses
Bimax's native bridge, preserving the policy that pages cannot obtain clipboard permission.
Phone fixtures and the independent QR decoder are explicitly excluded from packaged artifacts.

## Desktop failures repaired without bypassing checks

- **ESM renderer loading:** Jest global setup bundles the actual installed Streamdown dependency
  to CJS with esbuild. React/ReactDOM remain external and resolve to the app's singleton runtime.
  No fake Markdown component replaces the real implementation. CSS has a test-only loader;
  stylesheet assertions and actual Electron rendering remain checked.
- **Worker heap overhead:** parent engines and sub-agent workers explicitly cap the young V8
  generation at 16 MiB as well as their existing old-generation memory budgets. Node 24 otherwise
  added about 192 MiB beyond those older assumptions. Existing real-worker heap assertions pass;
  their limits were not widened. This is a V8-heap cap, not an RSS/native-memory guarantee.
- **Protocol boundary:** presentation types and the dependency-free presentation validator are
  exposed through the existing public protocol door. App imports use it; the boundary scanner and
  allowed-door list remain intact.
- **FTS5 retirement:** Node 24 now runs retrieval suites in normal Jest. The obsolete FTS5 exclusions
  are removed, the runtime contract requires actual FTS5 support, and existing Bun parity remains.
  Only the previously Bun-owned asynchronous container/schema suite stays excluded from Jest;
  it is still run by the default test command. Root/app engine metadata and CI Node selections
  now require Node 24 (>=24.15, <25 locally), matching the mobile native-ABI requirement.
- **Markup and clipboard contracts:** the prose-width test now verifies the current rich wrapper,
  actual paragraph and code block while keeping the CSS width/selector constraints. A full run
  caught the new page using the forbidden clipboard API; the implementation was fixed to use
  `copyText`, and that assertion remains unchanged. No failures were converted to skips.

## Verification and raw evidence

[Evidence](evidence/2026-10-24-phone-settings/README.md) preserves fresh successful and failed continuation attempts. Earlier screenshots/reports remain; temporary raw logs from before continuation were unavailable and are not represented as retained evidence.

- Complete final Jest: **478 suites / 4,634 tests pass**; one pre-existing conditional suite / three
  tests remain skipped. No failing suite remains in the executed set. Node retrieval cases now run.
- Bun: **133 tests pass**. Three release-artifact script tests pass. Root/app typechecks and builds pass.
  Phone/controller/public-protocol lint has zero errors and five existing protocol typing warnings.
  A broader touched-file lint run also reports two inherited errors and 36 warnings, including
  unrelated existing expressions/assignments in `app/src/main/index.ts`; that gate remains open.
- Full mobile `npm run check` passes: typecheck/lint, crypto/Noise, mobile/gateway, fourteen responder
  cases, LAN/cloud/adversarial and actual platform-runtime cases. Cross-repo `check:mobile` also passes.
- **Eleven source faults** are caught by failed assertions in disposable source copies: the seven
  record-104 faults plus false default-on status, insecure startup before storage admission,
  missing code binding and missing Stop latch. Compile failures/timeouts do not count.
- Actual Electron Settings fixture (final continuation): **eleven end-state checks** cover default-off, QR decoding, native
  Copy, encrypted persistence, admission refusal, code confirmation, real phone Noise/transport
  confirmation, paired/connected status, restart, Forget and Stop, including a delayed Enable IPC with Stop still reachable. The phone endpoint uses the
  actual mobile RelayClient and shared mobile pairing code over real local sockets, not a fake
  pairing grant or fabricated UI state. Engine effects remain inert fixture callbacks.
- The same fixture passes using **the controller/responder loaded from packaged app.asar and its
  production preload**. The package inventory/signature/action gates pass. Native CoreImage decodes
  both the QR's rendered image and the actual captured screenshot back into the advertisement.
  The saved verification screenshot was visually inspected again during continuation; fresh screenshots and reports accompany the final run. Synthetic peer IDs/tokens only.
- **iOS Expo export succeeds**, producing a real Hermes bundle. This is bundle/Metro qualification,
  not execution on the owner's iPhone, native permission confirmation or a Face ID pass.

The initial native fixture attempts exposed module-path, early-render and quoted-selector harness
errors. They are retained, corrected and excluded from pass counts. The first broad run's clipboard
failure is retained. A root-directory packaging invocation failed to resolve its app-relative hook;
final packaging runs from `app/`. Missing-Xcode-license icon compilation falls back to the existing
legacy icon; no license acceptance or system settings were changed. The runnable app is a local
certificate-signed manual build without hardened runtime/notarization, not a distribution release.

## iPhone / Expo Go use

1. Open the updated `/Applications/Bimax.app`; the continuation installed it with the previous bundle backed up.
2. Keep the iPhone and Mac on the same Wi-Fi. Allow local-network and camera access when iOS asks.
   Open Bimax in Expo Go (reload the current project). If necessary, start Metro from the mobile repo:
   `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm --workspace mobile start -- --go --lan`.
3. Sign into the Bimax phone app. Email verification-code sign-in is available when a Google OAuth
   redirect cannot return to Expo Go. Do not change or disable account scope to get through login.
4. On the Mac, Settings → Phone connection → choose the matching network address → Enable.
   In the phone app choose Pair desktop/Pair Device, scan the Mac QR, and compare every verification
   digit on both devices. Confirm on the Mac and in the phone's verification screen.
5. Open a project folder on the Mac before sending tasks from the phone's Remote screen. Native
   Mac consent still applies. Forget removes trust; Stop disconnects and requires restarting Bimax.

Expo Go's QR for **loading the app** and Bimax's QR for **pairing the Mac** are different. Scan the
Bimax QR from inside the running phone app. Expo's LAN guidance requires the same Wi-Fi; tunneling
Metro alone does not expose this private LAN relay. The project now uses Expo SDK 58, matching the owner’s observed Expo Go requirement. A mismatch requires a matching supported runtime/development build, not bypassing
protocol or SDK validation. See the official [start guide](https://docs.expo.dev/get-started/start-developing/)
and [version mismatch guide](https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/).

**Face ID tool decisions cannot work inside Expo Go.** The existing strong-biometric gate is retained;
there is no passcode or development-mode bypass. Approve tools on the Mac while using Expo Go, or
use a development build for phone Face ID approvals. This limit is documented in
[Expo LocalAuthentication](https://docs.expo.dev/versions/latest/sdk/local-authentication/), and surfaced
on both pairing screens. Pairing/session/status are separately qualified from biometric decisions.

## Preserved work and remaining qualification

Earlier work snapshotted both repositories before edits, but that temporary snapshot and raw logs
were no longer present when this continuation resumed. Their full historical byte-preservation claim
cannot be reconstructed. A new persistent resume baseline and final comparison enumerate every
additional change and check existing files and mobile deletions across this continuation. Record 104
retains its separate original preservation receipt. No reset/stash/commit/push or provider/account credential change. No deployed gateway or
relay was changed. Existing native Computer Use owners/resources stay with the Mac app.

Physical iPhone/Expo Go execution, camera/local-network permissions on the owner's device, SDK/store
version compatibility, Face ID in a development build, cross-Wi-Fi/cloud account UI/admission,
clean-machine install, power-loss durability, broad malformed-HTTP/long-lived resource qualification,
model-tier tasks, full C04/R01/I01/X01 and public release remain **Target**. CI's Node requirement is
updated; portable two-repo installation still needs hosted checkout/link configuration and was not
claimed from local tests. Open dependency audit findings are retained in the post-SDK-upgrade report.

## Continuation findings and evidence limits

The first fresh parallel check exposed a shared fixed port in the fourteen-case responder runner:
Desktop Jest also invokes this runner, so a concurrent mobile check could contact the wrong test
relay. The relay now reports its actual OS-assigned socket through parent IPC; the runner waits for
its own child and uses that port. No production admission or protocol assertions were relaxed.

The pending-Enable UI initially hid Stop until status became enabled. Stop is now available while
Enable IPC is pending, with a real Electron regression that holds Enable, clicks Stop and rejects
late enablement. The existing controller test separately checks Stop during runtime startup.
The first extended fixture also exposed an early configuration read; the fixture now waits for
completed persistence rather than treating an online socket as a completed settings operation.

The first fresh Desktop run overlapped builds/mobile checks and hit a spreadsheet-test timeout.
That attempt remains evidence; final checks run with bounded competition and retain unchanged
assertions and timeouts. An accidental Node invocation of the Electron engine probe also remains
as a failed tooling attempt; only the actual Electron invocation counts. See final-checks.

The fixed-port regression is independently checked by two simultaneous fourteen-case suites,
both passing on distinct child-reported sockets. The final Desktop recheck limits Jest to two
workers without changing timeout values or suite exclusion contracts. The RAM-ledger correction
below strengthens its measurement assertions.

The second fresh Desktop run exposed a different RAM-ledger defect: positive heap allocation
deltas were treated as retained memory even without exposed GC. The test now requires a full
collection on Node and Bun, fails on an invalid baseline, and always checks the original 75% bound
and structural/no-resident-vector/search invariants. Focused Node and Bun runs both pass. This
strengthens the measurement and removes the prior silent comparative skip; it is not a production
memory or energy claim. Both failed full runs remain in final-checks.

## Installed local build

The signed local bundle is installed at `/Applications/Bimax.app`. The prior app is retained at
`~/.local/state/bimax/phone-20261024/previous/Bimax.app`, with an additional final build under
`~/.local/state/bimax/phone-20261024/build/mac-arm64/Bimax.app`. Installation verified the same
designated signing requirement, strict nested signature and matching app.asar hash. All **900**
regular app-data files hashed before/after replacement are unchanged. The production app was not
launched and the installer did not enable networking. An installed-artifact controller/preload
fixture uses scratch data, rather than modifying the owner's preferences or pairing identity.
See `final-checks/install.json`. Local certificate signing is still not a notarized release.

A fresh first-party documentation check confirms Expo Go/project SDK versions must match. Expo's
current mismatch guide directs physical iOS SDK 54+ users toward `eas go`/TestFlight and an Apple
Developer membership, while the newer SDK-58 changelog describes forthcoming store availability.
These pages do not prove what is installed on the owner's phone; no automatic SDK migration or
Apple-account action is performed. Follow the observed compatibility error, use the SDK-58-compatible
runtime or a development build, and keep physical execution unqualified until observed.

## SDK 58 upgrade after the owner's actual compatibility error

The owner scanned the initial loading QR and observed Expo Go asking for SDK 58. That concrete
phone result supersedes the earlier unknown-runtime assumption. The linked phone project now uses
Expo **58.0.19**, React **19.3.0**, React Native **0.88.0**, Reanimated **4.7.1** and Worklets
**0.13.0**, with Expo-selected SDK-58 modules and a coordinated npm lock. Root overrides/direct
dev dependencies align the same native runtime: the initial automatic upgrade left stale
SDK-57 root bindings/duplicate React and React Native, which Expo Doctor caught and are repaired.

`npm run check` now starts with `check:expo`, checking resolved runtime versions from the mobile,
workspace and Expo package contexts against Expo's own native version map, then `expo install
--check`. This catches the workspace-override mismatch that app-manifest-only validation missed.
Bounded attachment reads now await SDK 58's asynchronous `FileHandle.readBytes`; byte limits,
zeroing and finally-close remain. Existing attachment regression mocks return promises so the
unawaited implementation fails. Dynamic config uses the supplied static config without mutating
it; regression assertions check retained caller fields. Removed SDK-retired new-architecture and
Android edge-to-edge flags, and migrated the same splash asset/options to `expo-splash-screen`.

Final first-party Expo Doctor passes **20/20**, and a real SDK-58 iOS Hermes export succeeds.
Full mobile checks and cross-repo fourteen-case/eight-approval checks qualify the linked source;
the installed Mac remains the same signed bundle. The SDK-57 export/manifest receipts are retained
as earlier attempts and are superseded for current phone compatibility by `sdk58/`.
Known dependency audit advisories remain explicitly open in `sdk58/dependency-audit.json`; no
unsafe downgrade/audit-force fix is applied. Physical app execution beyond the owner's mismatch,
account sign-in, actual phone pairing/permissions, Face ID and release still need qualification.

Live SDK-58 Metro qualification additionally fetches the real iOS development bundle successfully
(HTTP 200, 8,008,569 bytes) and independently decodes the loading QR. The owner still needs to
reload this updated project; the earlier observed incompatibility is not treated as a successful
Bimax phone run. Final SDK-58 evidence and failures are indexed in `sdk58/README.md`.

The owner's next physical observation was Expo Go signed in as `sid7vish` refusing an unauthenticated
Expo CLI. Local `expo whoami` independently confirmed not logged in. The official CLI's browser
PKCE sign-in was started (`expo login --browser`); user credentials stay in Expo's browser flow.
CLI account identity and a fresh authenticated server restart are checked separately from Bimax's
Supabase account sign-in and phone pairing. Neither account restriction is bypassed.

The owner completed the browser sign-in. `expo whoami` now independently reports **sid7vish**.
The SDK-58 dev server is restarted under that authenticated CLI account. Only username/status is
recorded (`sdk58/expo-auth.json`); no password, OAuth callback, session or token is saved in evidence.
This Expo CLI credential change was requested to match the phone's Expo Go account and remains
outside the repository. Bimax/Supabase sign-in and actual phone pairing are separate next steps.

Record 106 supersedes the next sign-in blocker: the owner confirms SDK-58 Bimax opened, then
Google opened Safari against the inactive Auth project. The existing backend is now restored and
its Auth endpoints return HTTP 200 with the unchanged key; Expo Go has explicit email-code UI
and in-app availability. Actual account login and physical pairing remain unconfirmed.
