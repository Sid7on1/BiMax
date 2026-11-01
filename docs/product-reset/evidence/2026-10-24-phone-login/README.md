# Mobile sign-in recovery evidence

Scope: [record 106](../../106_MOBILE_SIGN_IN_RECOVERY.md).

- `service-check-before.json`: configured Auth host DNS ENOTFOUND; gateway DNS succeeds.
- `backend-recovery.json`: existing inactive Free-plan bimax project resumed; same project/key,
  final ACTIVE_HEALTHY, read-only database SELECT 1, post-restore advisories. No new project,
  schema, credential, user, provider, redirect, billing plan or other project was changed.
- `service-check-restoring.json`, `service-check-after.json`: retained HTTP 521 while starting.
- `service-check-readiness.json`: Auth health/settings HTTP 200 using the unchanged configured
  public key; Google, GitHub and email enabled.
- `live-app-health.json`: actual application health implementation returns ok against the live
  restored service. This is not a synthetic response. No real email was sent by the agent.
- `auth-tests.log`: 13 focused auth-flow tests pass (unsupported runtime, exact callback, outage
  admission, destination pinning, code validation, cancellation, real-session/error requirement,
  health confidentiality, malformed config and ignored-cancellation timeout).
- `mutations.json`, `A01.log`, `A02.log`: removed Expo Go guard and removed service admission
  each fail their assertion in disposable copied source. No compile error/timeout counted.
- `mobile-check.log`: full workspace typecheck/lint/crypto, the 13 new auth tests, gateway/mobile/
  relay/responder/adversarial and actual Workers/Durable Object regressions pass.
- `ios-export.log`: real current SDK-58 iOS Hermes bundle exported outside the repo to
  `~/.local/state/bimax/phone-20261024/ios-login-repair`.
- `metro-updated-login.json`: actual live development bundle HTTP 200, SDK 58, includes the
  updated login/retry implementation; hash retained rather than public configuration contents.
- `baseline.json`, `preservation.json`: fresh mobile baseline; only the listed existing paths
  changed, unrelated bytes remain identical and all 77 existing deletions remain deleted.
- `changelog-index.md`: first-party current index fetched under the Supabase skill; relevant
  restore/TLS/email-template notes inspected. No security protocol was weakened.

Post-restore advisory: leaked-password protection remains disabled;
[remediation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
No paid plan/password-policy change was performed. Empty paused-project advisory results were
not treated as a security pass.

Account sign-in, email delivery/code-template setup, physical pairing and native development-build
OAuth callbacks remain unmeasured. Successful backend recovery is narrower than those journeys.
The owner must reload Expo Go and retry; Google OAuth is not offered in the unsupported runtime.
No browser password, Supabase private key, JWT session, OAuth URL or email address is recorded.
