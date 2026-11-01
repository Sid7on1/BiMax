# iPhone chat recovery, dark UI and current Mac installation — 24 October 2026

The owner reported that GPT OSS did not answer in iPhone Expo Go and requested a dark,
emoji-free, ChatGPT-inspired interface plus replacement of the installed Mac app. The owner
subsequently reloaded the updated phone app and confirmed **“It answers now.”** This is an
owner-observed phone chat outcome, not a general model reliability or remote-control claim.

Guided by README, 01 current audit, 03 product examples, 04 frontend plan, 05 architecture,
06 repo split, 07 roadmap, 08 acceptance gates, the Mac Buddy vision, competitive README,
02 rival studies, 04 model-independent strategy, 05 gap register, 06 evaluation/end-state rules,
and records 104–106. The referenced competitive 03 capability matrix remains absent; no evidence
or requirements are inferred from that missing file. No competitor source or branding is copied.

## Cause and changes

The native client used global React Native `fetch` and then required `response.body.getReader()`.
Expo's documented streaming transport is **`expo/fetch`**, confirmed in the installed SDK-58 source
and [official Expo documentation](https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api).
Browser/Node stream fixtures had not exercised the native default binding. A generic alert also
hid gateway errors, and waiting for socket EOF after `[DONE]` could leave a finished answer pending.

- `lib/gateway.ts` now selects Expo's native streaming fetch by default. `lib/chat-stream.ts`
  keeps the same account credential and fixed gateway route, document distrust instructions and
  bounded history. Each request carries an explicit 2,048-token output ceiling.
- A 120-second deadline covers session lookup, dispatch and reads. Abort is raced as well as
  forwarded, so Stop/timeouts settle even when an adapter fails to settle its pending promise.
  Pre-aborted session failures are still observed; pending lookup rejection is not unhandled.
- Fragmented UTF-8/SSE, reasoning, trailing completion events and `[DONE]` are handled explicitly.
  Truncated, malformed, provider-error and reasoning-only/empty completions fail visibly.
  SSE transport bytes are capped at 2 MiB and unfinished events at 1 MiB. Request timers/listeners
  are retired, with best-effort reader/native cancellation. No model fallback hides a failure.
- The chat screen displays the actual bounded error, supports Retry without inserting another
  user message, retires failed placeholders from later context, and saves partial stopped output.
  Stop is available during the initial save as well as generation. Empty stopped placeholders are
  removed. Waiting is visible before the first token.
- Shared dark colors, light status bar, dark keyboards/alerts and a dark native app/splash
  configuration apply to home/history, login/callback, chat, pairing, Remote and approvals.
  Native line shapes replace UI emoji, with subdued user bubbles, open assistant text,
  less timestamp clutter, a rounded growing composer and a restrained model control.
  Unsupported image/PDF ingestion is not offered as a composer action; supported text attachments
  retain the existing read limits and encryption/trust rules.
- Remote's unpaired state shows connection steps instead of inactive agent panels. Existing
  pairing, exact-code confirmation, signing, account isolation, Mac consent and Stop remain.
  Actual rendered checks caught empty-string children in native containers; those conditions now
  produce booleans instead of raw text.

## Actual staging configuration, not checked-in assumptions

A read-only Cloudflare settings inspection found that the deployed gateway **does allow**
`openai/gpt-oss-20b`; the checked-in launch allowlist alone was not evidence of the live behavior.
Only the NVIDIA provider key binding is installed there. The phone therefore defaults new chats
and its current staging picker to GPT OSS 20B, rather than advertising unconfigured DeepSeek/Qwen
routes. Existing saved conversation model IDs are not migrated or silently substituted.
General authenticated model discovery and additional provisioned providers remain Target.

One direct, non-mock NVIDIA request returned HTTP 200, content and `[DONE]` in **44,915 ms**.
Only its bounded test prompt and non-secret status/count observations were printed. No provider
key, account token or response body was printed or copied into the repo. This proves one provider
response, not the account gateway journey or an SLA. The later owner's iPhone confirmation is
separately recorded in `owner-observation.json`.

The live Worker is still the 14 October deployment: `/ready` returns 404 and current billing-price,
spend-ceiling and room-ticket bindings are absent. The current hardened gateway source is **not
therefore deployed/qualified**. No Worker deployment, database mutation, new entitlement, guessed
price, credential change or billing bypass was made in this UI/transport repair. Coordinated
backend admission/configuration/rollout remains a release dependency, as in the existing runbook.

## Verification

[Evidence](evidence/2026-10-24-phone-chat-ui/) distinguishes each layer:

- **13 chat transport tests**: actual default Expo fetch selection, chunked UTF-8/reasoning,
  completion before socket EOF, request/auth/output/trust contracts, missing account,
  HTTP/SSE errors, truncation/invalid/empty answers, timeout across all asynchronous phases,
  Stop with/without partial content, size bounds, real HTTP chunk delivery, and pre-aborted
  rejecting session lookup. These join the default mobile test gate.
- **Three deliberate assertion-caught source faults** in disposable copies: restore buffered
  global fetch, ignore pending cancellation, and accept an empty final answer. Earlier failed
  qualification attempts are retained rather than counted as passes.
- Full mobile `check`: SDK-58 runtime alignment, typechecking, ESLint, gateway, cryptography,
  pairing, relays, responder, prior audit regressions and actual local Workers/D1/Durable Object
  checks. Final lint has zero errors and three inherited relay array-style warnings.
- Actual React Native screens rendered through React Native Web in Electron at phone dimensions:
  six surfaces use dark backgrounds, contain no UI emoji and have no horizontal screen overflow;
  real chat controls reject a fixture failure, Retry sends the user prompt only once, and Stop
  saves partial output. Runtime text-node errors fail this check. Screenshots were inspected.
  Account, storage, router and transport ports are inert fixtures; this is not native iPhone UI
  or live authentication qualification. SDK-compatible RN Web/React DOM dependencies support
  this repeatable visual check; React DOM is pinned to React's exact runtime version.
- iOS Hermes export passes. The owner's existing SDK-58 Metro server serves HTTP-200 manifest
  and current development bundle containing the dark UI and Expo streaming transport. No
  fresh login/session reset was required. The owner confirmed GPT OSS answers after reload.
- Desktop typecheck/build, current source engine build/staging and all seven actual Electron
  engine exchanges pass. Linked mobile integration passes all fourteen responder cases plus
  the real phone-signature → adapter → ThreadManager approval checks.
- Newly packaged arm64 Mac inventory/actions/signature checks pass. The packaged runtime phone
  fixture passes eleven independent end states, including QR decoding, trusted pairing,
  restart, Forget and Stop. Its first invocation failed solely because its evidence output
  directory was not created; that failure and the corrected pass are retained.

## Reinstalled Mac and preservation

The current dirty working tree was rebuilt and locally signed, then replaced
`/Applications/Bimax.app` by staging a verified bundle and retaining the previous bundle under
`~/.local/state/bimax/refresh-20261024/previous/Bimax.app`. All **900** regular profile-file hashes
match across replacement. No saved chat, setting, pairing or profile directory was deleted.
The installed `app.asar` matches the rebuilt artifact. Since Desktop production source did not
change in this phone-only repair, its asar hash also matches record 105's current-source build;
this is a fresh rebuild/reinstallation, not a claim of new Mac UI changes.

The local certificate's designated requirement is unchanged. This remains an unhardened local
alpha, not a Developer ID/notarized release. The toolchain's unaccepted Xcode license still
prevents regeneration of the icon catalog; the existing icon fallback is retained. No license or
macOS permission setting was changed. After installation, the actual Bimax welcome window was
observed at the installed `file:///Applications/Bimax.app/.../out/renderer/index.html` URL.

Fresh before/after source receipts preserve unrelated dirty work in both repositories, including
all **77** existing mobile deletions. Raw profile hashes and signing credentials stay outside the
repo. Source/evidence preservation receipts, exact logs, initial failed checks and artifact hashes
are retained with this record.

## Still Target

Physical-phone pairing/reconnect/backgrounding, local-network permission behavior, Face ID in a
development build, installed real-engine/tool interruption and unknown effects, configured native
social OAuth, general model discovery, sustained provider/resource behavior, coordinated hardened
cloud rollout, portable CI/clean-machine recovery and release remain Target. One owner-confirmed
phone answer closes this reported chat failure, not full C04/R01/I01/X01 or Product-ready/Win.
Record 105's full Desktop suite is historical evidence; this change reran the relevant build,
typecheck, engine, package and integration checks rather than claiming a fresh 478-suite run.
