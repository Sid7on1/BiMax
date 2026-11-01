# Phone preferences, connection settings and rendering work

Date: 2026-10-25. Status: **Implemented with scoped measurements**. Physical iPhone interaction,
cellular roaming and sustained native resource qualification remain **Target**.

## Owner outcome and boundary

The owner confirms physical phone → Mac → reply delivery and asks for useful phone Settings,
exclusive Phone-left/Mac-right history, shared Desktop rendering/thinking, connection controls under
Your Mac, restrained motion, less rendering work and a truthful Wi-Fi/cellular explanation.
This record supersedes record 111’s Your Mac conversation-list navigation. Both histories stay in
the drawer; Your Mac now opens connection settings. Existing verified trust, account, model gateway,
Mac installation and saved profile are preserved. No backend deployment or expanded remote authority.

Guidance: product-reset README, 03 Product Examples, 04 Frontend Plan, 05 Target Architecture,
08 Acceptance Gates, Mac Buddy vision, records 110–111, competitive language/evaluation rules and
actual inspected source. This is a phone interaction follow-through, not a new competitor or V-ID claim.

## Implemented

- Real account-scoped, persisted **Reduce motion**, **Show thinking details** and **Follow new replies**
  controls. Phone/system Reduce Motion wins over decorative motion. Slow initial storage cannot
  overwrite a new choice; serial writes preserve the final choice; sign-out cancels queued writes
  and late notifications. Read/save errors are visible. Dark remains the default.
- Show thinking controls available live/saved reasoning while preserving answer content and the
  generation indicator. The actual shared Desktop ThinkingIndicator supplies changing words,
  elapsed time, reasoning controls and repetition guard. Its optional controlled motion prop lets
  the phone stop word rotation/decoding immediately without resetting elapsed time. System/native
  motion preference also reaches isolated WebView CSS.
- Follow new replies can stop automatic scrolling. When enabled, scrolling up still suspends
  following until the reader returns near the bottom.
- Your Mac opens **Mac connection** from either drawer or Settings. It shows authenticated state,
  actual current transport (Cloudflare/local/offline), separately labelled internet configuration,
  existing secure reconnect, internet-setup retry, pairing and explicitly confirmed emergency Stop.
  Mac conversations remain exclusively under drawer → Mac. Mac model/workspace/tool/system settings
  remain on their owning Mac; this does not pretend to offer remote provider/OS configuration.
- Drawer source changes have a short 160-ms opacity transition; app/system Reduce Motion disables
  it and the modal fade. Touch controls retain native semantics. The two histories remain exclusive.
- Streaming bridge delivery coalesces updates once per display frame, keeps the latest complete
  snapshot, skips unchanged states, retains preference/error-only changes, and cancels pending frames
  on reset/unmount. Stable earlier message rows are memoized. Auto-scroll frames are canceled before
  replacement. No tokens are truncated and existing narrow Copy/Retry/link/plugin boundaries remain.

## Where chats and networking actually live

Mac conversation storage and execution stay on the **Mac**. The separate Cloudflare relay carries
end-to-end encrypted device traffic; it is not a new cloud conversation database. The active route
comes from the current connected relay URL **and an authenticated paired session**, not a saved
last-working guess. “Configured” is not proof that the phone is currently using cloud transport.

With cellular data enabled, Mac chats can continue away from home when **Current connection is
Cloudflare**, the Mac is awake/online and Bimax is running. A local-network route needs the same
reachable network. Neither the phone nor relay wakes a sleeping Mac. With all internet connectivity
off there is no remote sync/provider response; local saved phone chats remain on the phone.

**Expo Go is a separate development dependency.** The current Metro server uses LAN. Opening or
reloading that project away from home cannot be promised just because chat relay setup is complete.
An installed build (or separately arranged development-server tunnel) is needed to remove that LAN
loading dependency. This task does not publish a development server, install an unsigned phone app,
or assert reliable iOS background operation. Primary Expo/Apple evidence is in the source ledger.

## Verification and adversarial checks

Scoped receipts: [evidence folder](evidence/2026-10-25-phone-settings/). Node 24.15 is used.
Final green end states: **8 new unit tests, 5 assertion-caught source faults, 27 rendered renderer
checks, 17 rendered phone UI checks, 87 Desktop UI/lifecycle tests and 14 real adapter cases**, plus
full mobile checks, both typechecks and final iOS export. Three inherited lint warnings, zero errors.
The current served iOS bundle is HTTP 200 with all new feature markers; physical reload is unverified.

- Eight new storage/delivery regressions cover malformed preference data, slow load, concurrent
  toggles, save errors, logout, exact Unicode burst delivery, reset/dispose and preference-only patches.
- Five isolated deliberately broken source variants must fail an assertion. The first no-op mutant
  survived because the original test also changed failedId; a true preference-only assertion was added
  and now catches it. No production bytes are mutated by this harness.
- Actual rendered phone controls verify separate histories, selected chat routing, persisted switches
  after app remount, connection page routing/reconnect request, live replies and propagation of saved
  preferences into the isolated transcript. Actual Desktop/phone renderer comparisons cover rich text,
  reasoning, rotating words, controlled/system reduced motion, hidden thinking and long-chat scrolling.
- Full mobile SDK/type/lint/security/gateway/crypto/responder/Workers/platform/linked UI checks,
  Desktop typecheck and 87 UI/lifecycle regressions, linked Desktop adapter integration and an iOS
  Hermes export are recorded separately. Three inherited relay array-style warnings are retained.
- Browser UI testing exposed an unbound requestAnimationFrame invocation in the initial delivery
  implementation; explicit global wrappers fix it. Fixture-only missing RN global/account-scope
  adapters and checkbox-property assertions were corrected without dropping behavioral gates.

Physical verification was attempted through iPhone Mirroring twice; both attempts timed out before
an iPhone screen was available. The owner was asked to keep the locked phone nearby with Wi-Fi and
Bluetooth enabled. No native interaction, on-device frame/battery measurement, cellular journey,
VoiceOver, large-text/keyboard breadth, background/lock or Mac sleep/wake acceptance is claimed.
The source/browser tests are **Measured only within their fixture scope**. Product-ready, release,
complete Desktop Outputs/voice/settings parity and whole-app performance improvements remain Target.

## Preservation and delivery

Baseline snapshots precede this task. Scoped hash receipts identify every intentional source/doc
change and verify **10,093 unrelated Desktop files and 264 unrelated mobile files** remain byte-identical;
all **77 mobile deletions** remain intact. The 13 Desktop/10 mobile pre-existing files intentionally
edited are listed separately; newly added preference/regression/doc files are source-hashed. There is no reset,
stash, commit, new pairing, Keychain access or Mac replacement. Record 111’s installed Desktop is
retained: this phone UI update does not require a Mac restart. Generated renderer freshness, native
iOS export and the currently served Metro bundle are separately checked; none prove physical reload.
