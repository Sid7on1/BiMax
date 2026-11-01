# Native iPhone LAN pairing admission — 24 October 2026

The owner scanned the QR from Mac Settings → Phone connection, but the phone stayed on
“Waiting for desktop approval” and the Mac showed no verification code. Inspection of the
installed Mac showed Ready to pair, an active private-address listener and only the responder's
own relay socket. macOS Firewall was enabled with Bimax allowed; no firewall/permission setting
was changed. These observations do not prove the failed phone's exact wire contents.

Guidance: product-reset README, 03 examples, 04 frontend, 05 architecture, 08 acceptance gates,
Mac Buddy vision/Trust Engine, and records 104–107. Current installed SDK and primary upstream
sources explain a deterministic native compatibility defect absent from the earlier Node fixtures.

## Reproduced defect

React Native iOS delegates WebSocket upgrade construction to SocketRocket. Installed RN 0.88
pins SocketRocket 0.7.1. That version's
[SRHTTPConnectMessage.m](https://github.com/facebookincubator/SocketRocket/blob/0.7.1/SocketRocket/Internal/Utilities/SRHTTPConnectMessage.m)
sets a default `Origin` before applying caller-supplied request headers (lines 51, 57–59).
Installed `RCTWebSocketModule.mm` copies the native constructor's custom headers into that request;
Android's installed `WebSocketModule.kt` likewise defaults Origin unless explicitly supplied.
The old phone client passed only the URL. The app-owned LAN relay deliberately rejects nonempty
browser Origin headers before WebSocket upgrade. Node `ws` clients used by earlier checks do not
synthesize that header, so successful Node pairing did not qualify the iPhone native transport.

A new test uses the **actual app-owned LAN server**, with a native-header constructor shim. The
unadapted native request is rejected. The adapted request upgrades with the exact existing URL,
room and random LAN token; wrong token, wrong room and browser-origin cases still refuse. This
reproduces the implementation mismatch, not an instrumented capture of the owner's failed socket.

## Implemented repair

- A phone-only native WebSocket adapter explicitly clears native LAN `Origin` using RN's custom
  header constructor option. It applies only on native platforms for private `ws:` routes already
  admitted by the shared URL validator. Browser constructors stay unchanged; cloud WSS defaults
  stay unchanged. No server Origin policy, route, token, TLS validation, signed hello, Noise key,
  trust record or human confirmation is weakened or bypassed.
- Pairing now distinguishes connecting/reconnecting from establishing the secure handshake.
  Waiting for a handshake is not presented as proof of a pending desktop approval. The existing
  60-second deadline now explains whether the socket was unreachable or the secure handshake did
  not finish, with fresh-QR/local-network guidance. Transport retries and verification remain.
- The code-comparison screen still requires the actual handshake code and explicit human trust
  confirmation on both devices. No live phone was approved by the agent.

This is an Expo JavaScript delivery. The existing installed Mac relay is compatible and was not
reinstalled/restarted, preserving the owner's open Settings, profile and approval authority.

## Verification and qualification

[Evidence](evidence/2026-10-24-native-phone-pairing/) preserves five new default-runner regressions:
exact native header/URL behavior, browser constructor preservation, WSS preservation, honest
connection/timeout states and real LAN upgrade admission/refusal. Two assertion-caught source
faults remove the native adaptation or restore the false approval label in disposable copies.
Full mobile SDK alignment/typecheck/lint/test/platform checks and iOS Hermes export pass. The
current HTTP-200 SDK-58 Metro bundle contains the native adapter and new progress states, without
the old false waiting label. Earlier crypto, responder, account and security regressions stay in
the complete gate. The actual pairing screen was also driven through its manual-advertisement and pairing controls with inert ports: the pending-handshake state renders Connecting to your Mac and never the false approval claim; existing rendered Retry/Stop and dark-surface checks still pass. No backend or database mutation was required.

The physical iPhone retry and completed two-sided verification remain **Target** until observed.
The owner's successful GPT OSS chat in record 107 is not evidence of WebSocket pairing. Existing
physical background/reconnect, biometrics/development-build OAuth, installed real-engine effects,
hardened cloud rollout, sustained resources and release gates remain open.

An additional inspected source/document conflict remains explicit: record 105 describes Settings
as available without a project, but `App.tsx` still mounts `SettingsDialog` behind `hasProject`.
The pairing component/native fixture does not qualify that outer gate. This attempt uses the
owner's already-open project and accessible Phone connection page; projectless Settings remains
an unresolved onboarding gap, not silently treated as delivered.

All unrelated existing changes and the 77 prior mobile deletions are checked against fresh
source baselines. No account session, device key, trust namespace or macOS permission is reset.
