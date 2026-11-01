# Mobile sign-in recovery — 24 October 2026

The owner successfully loaded SDK-58 Bimax in Expo Go, then observed Safari reporting that the
server could not be found after Continue with Google. Guided by the product-reset README,
03 product examples, 04 frontend plan, 05 architecture, 08 acceptance gates, Mac vision/Trust Engine,
and record 105. The Supabase skill and current first-party documentation guided service recovery.

## Actual failures

1. The configured `bimax` project's API hostname returned **ENOTFOUND**. The existing public key
   references that same project, so there was no evidence of a simple URL/key mismatch. The gateway
   hostname resolved, but its availability cannot establish Auth availability. Supabase's connected
   project tools independently reported the exact project **INACTIVE**, in the existing Free-plan
   organization. Email uses that same Auth service; it was not a working fallback while paused.
2. Login rendered social OAuth whenever `__DEV__` was true, including Expo Go. This generated
   a browser request even though the project has no configured verified return URL, and current
   Expo guidance requires a development build for this OAuth callback flow. SDK compatibility and
   Expo CLI sign-in do not establish Bimax account authentication.
3. The callback route ignored returned SDK exchange errors and navigated home even without a
   valid session. Root account gating still protected the app, but the callback reported false
   completion and confused recovery.

## Source changes

- Added a bounded HTTPS Auth health probe, with in-app outage/configuration state and manual retry.
  It uses the existing public key in a header, follows no redirects, and bounds an unresponsive
  fetch even if its adapter ignores cancellation. It never creates a session or sends an email.
- Expo Go now offers email-code login; unsupported Google/GitHub buttons are absent. Installed
  builds require the existing exact verified HTTPS callback rather than a development-mode
  scheme fallback. OAuth refuses before PKCE/browser work on unsupported runtimes or an outage.
- Authorization URLs remain on the configured Auth origin/path. Callback origins/paths, duplicate
  or missing codes, fragments and provider errors refuse before exchange. Cancellation causes no
  exchange. The callback route requires both successful SDK exchange and an actual session.
- Email still uses Supabase verification and the existing account-isolated storage/transport.
  No anonymous session, local-login bypass, RLS change or weakened biometric/approval gate.

## Existing project recovery

The CLI binary was terminated before returning project metadata, and no local management token
was available. An opened dashboard required sign-in. The owner then connected the Supabase plugin;
its tools provided the authoritative existing-project status without browser credentials.

Read-only project/organization details, aggregate logs and both advisory types were inspected
before the restore. Logs/lints returned empty while inactive; that is not a comprehensive security
qualification. Resumed **the same existing bimax project**, preserving its project URL and existing
key. The other inactive project was not touched. No new project, branch, paid plan, secret, schema,
user, provider or redirect allowlist was created or changed. Restore first reported COMING_UP,
DNS returned, and the Auth endpoints initially returned HTTP 521 during startup. Final readiness
and end-state receipts are recorded in the evidence folder.

## Verification and limits

[Raw evidence](evidence/2026-10-24-phone-login/) preserves 13 local auth-flow tests, two assertion-caught
source faults (unsupported-runtime guard and outage admission removed), the complete mobile checks,
real SDK-58 iOS export and service observations. Tests use inert authorization/session ports; they
do not send real email or perform a Google login. The faults are caught in disposable copies and
are not counted as additional record-105 mutations. The owner's existing mobile changes and all
77 prior deletions are checked against a fresh persistent baseline.

Actual email delivery/code-template configuration, Google/provider configuration and verified
callbacks in a development build, completed account sign-in/pairing, native permissions, sustained
service availability and release remain Target unless explicitly observed in the final receipt.
Free-plan inactivity can pause this service again; no keepalive automation or billing upgrade is
created. Existing dependency advisories and prior record-105 lint limits remain open.

## Sources

- [Expo authentication](https://docs.expo.dev/guides/authentication/): Expo Go callback limitation.
- [Supabase project pausing](https://supabase.com/docs/guides/platform/free-project-pausing):
  restore of the existing paused project and Free-plan behavior.
- [Supabase passwordless email](https://supabase.com/docs/guides/auth/auth-email-passwordless):
  `signInWithOtp` sends a magic link by default; email codes depend on the actual template/config.
  Do not claim email-code delivery merely from the SDK call or an HTTP health result.
- Supabase changelog index was fetched and inspected. Relevant modern-TLS and restore-credential
  notes do not require weakening TLS or changing credentials here; native Node 24/SDK 58 remain.

## Verified live end state

The same project is now **ACTIVE_HEALTHY**. Both `/auth/v1/health` and `/auth/v1/settings` return
**HTTP 200 using the unchanged configured public key**; settings report Google, GitHub and email
enabled. The actual app health implementation also returns `{ok:true}` against this live service.
A read-only `select 1` succeeds on the restored database. No user rows were read or written.

Post-restore performance advisories return none. Security advisories report the existing
[leaked-password protection disabled](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
warning; it remains open, with no plan or password-policy change. The app uses OTP/PKCE rather
than a new password login. Backend readiness is now Measured; successful physical email delivery,
account sign-in, Google callbacks in a development build and pairing remain separate Targets.
