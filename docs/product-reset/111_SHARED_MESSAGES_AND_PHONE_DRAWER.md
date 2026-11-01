# Shared message presentation and phone chat drawer — 25 October 2026

The owner now confirms the paired iPhone sends a message to the Mac and receives its reply. This
supersedes record 110's pending physical selected-chat roundtrip, **only for that scoped journey**.
Their current problem is message rendering and left-side chat management. Connection, cryptography,
account admission and pairing behavior are deliberately unchanged in this follow-through.

Guidance: product-reset README, 03 product examples, 04 frontend plan, 05 architecture, 08 acceptance
gates, Mac Buddy vision and records 109–110. Terminal gains no permissions or Computer Use ownership.

## Implemented

Record 109 shared Markdown, but the phone still supplied its own message wrapper, bubble rules and
reasoning disclosure. `ConversationMessage.tsx` and its stylesheet now own that presentation in
both Desktop's actual Transcript and the phone's offline compiled transcript. Text, GFM/code/math/
diagrams, user bubbles, reasoning disclosure and styling use common source. Phone Copy keeps its
native clipboard bridge and larger touch target; Desktop's speech/ratings and privileged Outputs
remain Desktop capabilities rather than nonfunctional controls on the phone. No remote page,
Desktop preload, file bridge or network authority enters the WebView.

The menu in both phone chat routes now opens one real left drawer, following the owner’s direct feedback on the first grouped-list version. It provides search, New chat,
selected-chat highlighting and a Phone/Mac switch: Phone on the left, Mac on the right. Only the selected source is listed; search stays within it. Route identity includes the
source as well as the ID, so identical IDs cannot open the wrong device's conversation. Selecting
the current chat closes the drawer without replacing the route. Switching chats replaces the route
instead of accumulating hidden chat screens. Phone chats retain explicit, confirmed deletion;
Mac history is read/continued through the existing supported interface. No unsupported Mac rename,
delete or new-project control is invented.


Settings is permanently reachable at the drawer bottom. It shows actual Dark appearance and system
motion behavior, the current Mac connection, app version and the existing confirmed account
sign-out action. Appearance/motion values are informational; unsupported preference switches are
not invented. Drawer opening/navigation dismisses the composer keyboard, and its iOS layout avoids
the keyboard while searching.

The phone now imports the actual Desktop `ThinkingIndicator`, not another imitation. A pending
remote turn has an assistant placeholder even before its first content token, so the display is
visible during waiting. Rotating/decoding words, shimmer, elapsed counter, reasoning tail, show/hide
control, engine-wait text and degenerate-loop suppression use Desktop source. On answer text it
yields to streaming Markdown; reduced-motion CSS and quiet styling derive from Desktop. Timer
and animation cleanup follow that same component's lifecycle. Elapsed time is local to the mounted
indicator; this does not introduce a synchronized server-duration measurement.

Your Mac is a quiet conversation list with search, Refresh and phone action review. The separate
Send Instruction composer, command log and agent-status dashboard are removed. Normal work belongs
in chats. Emergency Stop remains under connection options with a clear all-conversations warning.
Refresh and initial listing require the established secure peer, rather than treating an open socket
as a completed connection. The phone home list no longer waits on an unrelated usage-network request.

## Verification and limits

Evidence: [scoped receipts](evidence/2026-10-25-phone-drawer/). Relevant checks include actual Desktop
message/Markdown versus phone DOM/computed styles, reasoning controls, offline rich content,
Copy/Retry/security boundaries, actual phone row/refresh/drawer/search/source-selection navigation,
Desktop UI/lifecycle regressions, full mobile checks, iOS export and the coordinated signed package.
Receipts contain exact counts, hashes, preservation and installation outcomes. Browser fixtures use
inert conversations, never real phone/account/project data.

The first extended comparison stalled while Puppeteer clicked a background reasoning page; its
60-second runner deadline failed. Reasoning controls were isolated and verified, and the comparison
now invokes each rendered button and checks its resulting expanded content. No timeout assertion or
security gate was disabled. Screenshot checks wait for the drawer's finite fade to settle so an
intermediate transparent frame is not represented as final UI evidence.

Physical reply delivery is owner-confirmed on the preceding build. This new drawer/message UI on
the iPhone still requires the owner's visual/gesture check after Expo Go reload. Native WebView
performance, VoiceOver/large-text/keyboard breadth, sustained/background/roaming/sleep recovery,
complete interactive Outputs parity and public distribution remain **Target**, not Product-ready.
No claim that a browser screenshot qualifies physical iOS behavior is made.

## Installed artifact

The new local arm64 build is installed at `/Applications/Bimax.app` with the same designated
signing requirement. All **922 regular saved-data files**, including pairing preferences, remain
byte-identical across the native-Quit/bundle-replacement interval. The previous bundle is
recoverable. Installed ASAR SHA-256: `58ac8d0729a5a04b5550eb6db6765a497334343da27f55d18f64bc9fc60f356c`.
The new served iOS bundle contains the drawer/shared presentation and no instruction-dashboard
copy. The Mac launch reached its Keychain startup process again; the owner was asked to complete
that local step. Computer Use cannot operate SecurityAgent. No profile/Keychain/permission reset,
new phone trust, provider change or backend deployment is part of this UI revision.

The owner's follow-up confirms the first drawer displayed both histories and specifically requests
mutually exclusive Phone-left/Mac-right selection, a Settings tab and the Desktop changing-word
generation behavior. Those refinements ship in the Expo artifact; the already installed shared
Desktop message build needs no further restart for them. Physical acceptance of this final toggle,
Settings and busy-display refinement remains Target after reload.

Final scoped receipts: 87 Desktop UI/lifecycle tests; 21 actual renderer/generation checks;
15 rendered phone navigation/layout checks; full mobile SDK/type/lint/security/platform/integration
checks; final type/export/layout passes; actual current Metro iOS delivery. The final phone bundle
contains the exclusive toggle, Settings and Desktop thinking display. Three inherited relay-array
lint warnings remain, with zero lint errors. Native final visual/gesture/performance confirmation
still remains Target. No broad release or cross-device duration/battery claim follows.
