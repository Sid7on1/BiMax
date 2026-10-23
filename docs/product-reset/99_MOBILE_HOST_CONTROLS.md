# Mobile host controls — 16 October 2026

**Implemented; bounded native fixture Measured. Product-ready, installed-phone integration and release remain Target.**

The mobile production follow-up at `/Users/vishsiddharth/Desktop/bimax-mobile` exposed a stale desktop adapter: it constructed a protocol-2 responder without required `HostControls`, retained old declarations after building JavaScript, registered pairing IPC outside the trusted-sender gate and did not connect engine tokens/completion events.

Guidance: product-reset README; 01 current audit, 05 architecture and 06 split; 03 examples, 04 frontend plan and the Mac vision; 07 roadmap, 08 gates; competitive evaluation contract and R01 recovery journey. This is a bounded V26 Security & Trust Engine slice, using the V26 research card in `12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md`. It changes mobile remote consent and host integration, not the app-owned Computer Use architecture.

## Contract and decisions

- Native main-process consent shows the phone identity and exact incoming request. Not Now is default. Oversized text that cannot be fully displayed is refused. Every command/chat/file authorization still comes from the responder's host-control boundary; model text never grants it.
- A sandboxed, script-free, network-free banner and menu indicator remain visible during remote activity. Stop reaches `Responder.emergencyStop()` locally. It cancels pending dialogs, invalidates late Allow replies and latches remote activity off until Bimax restarts. Stop failure is visible and does not create a new grant.
- Native dialogs have a parent: Electron's installed API documentation says an unparented macOS dialog cannot be cancelled with AbortSignal.
- Pairing IPC uses the existing `secureHandle` trusted-frame gate and validates bounded payloads. Local revoke uses the responder cleanup API, including engine stop and pending-resource cancellation.
- Identity loading reuses validated, fsynced encrypted persistence and refuses unavailable/insecure OS encryption. State lives under the app's private user-data directory.
- Engine stream tokens, approvals and completion events now reach the adapter. Only remotely controlled Threads forward tool approvals. Busy/overlapping chat requests refuse; Stop/engine stop/submission failure releases waiters. With no selected Thread or explicitly injected workspace, remote dispatch refuses instead of using process.cwd().
- `BIMAX_RESPONDER=1` remains an explicit development opt-in. Cloud mode requires injected ticket authorization, or `BIMAX_GATEWAY_URL` and `BIMAX_GATEWAY_ACCOUNT_TOKEN`. These credentials are not provider keys. A production desktop account sign-in/settings experience is still Target.
- The responder build now generates declarations so the JavaScript and consumed contract agree. Build the sibling responder before the app.

Baseline: missing host contract and raw pairing IPC. Candidate adopted: native main-owned dialogs plus a small isolated banner, reusing existing security/engine boundaries. Hard constraints: no automatic grant, no late grant after Stop, no raw renderer registration, no script/network in the banner, no model/config mutation, preserve dirty work. Metrics are exact consent/Stop/streaming end states, not latency or general reliability. Adoption requires passing assertions, native fixture and deliberately broken source controls.

## Evidence and limits

- `node node_modules/jest/bin/jest.js --runInBand --coverage=false --runTestsByPath app/src/main/responder/__tests__/host-controls.test.ts app/src/main/responder/__tests__/adapter.test.ts app/src/__tests__/desktop.runtime.security.test.ts`: 60 focused tests passed; includes the responder's 13 integration cases. Initial test-only overload typing failures are corrected; they were not product passes or mutation evidence.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH python3 app/scripts/prove-mobile-host-controls.py`: three faults caught by assertions: allow without consent, Stop without engine call, unescaped peer. Source restored. Logs/hashes in `evidence/2026-10-16-mobile-host/`.
- `node app/scripts/verify-mobile-host-controls.mjs`: actual Electron 43.3.0 / Node 24.18.1 on this Mac rendered the banner, cancelled parented consent, clicked Stop exactly once, destroyed the banner and refused restart. Screenshot visually checked. Synthetic stop callback; no real engine, provider or physical phone.
- Responder-only ESLint passes with zero errors and five test typing warnings. The wider check including `app/src/main/index.ts` retains one `no-useless-assignment` error in the existing `talk:start` handler; the first lint log also retains the two new errors subsequently fixed.
- App typecheck and production bundle checked. This does not prove packaged dependency inventory, install/signing or real device behavior. Full offline suites and installed R01/C04/X01 were not rerun here.

Remaining: verified OAuth associations and signed phone builds, production account UI/credentials, deployed gateway/relay coordination, physical iOS/Android pairing/reconnect/biometric tests, full tool cancellation, instruction-target consistency and unknown-effect reconciliation in the installed app. The native fixture is one bounded local measurement, not a release or competitive Win.
