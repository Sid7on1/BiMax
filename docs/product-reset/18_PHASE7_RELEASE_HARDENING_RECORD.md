# Phase 7 release-hardening record

Status: **manual-alpha implementation and local arm64 candidate gates are complete; external
distribution qualification remains Target**, 2026-08-09. Stable is not complete.

## Scope and sources

This run followed `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`,
`08_ACCEPTANCE_GATES.md`, the Mac Buddy vision, and current Apple/Electron sources recorded in
`competitive/08_SOURCE_LEDGER.md`. It reused the Trust Center, runtime component resolvers,
main-process IPC boundary and crash journal. It did not add a second updater, permission owner,
runtime resolver, crash store, or Computer Use path.

## What now works

- Trust Center measures the app executable and each exact resolver-selected engine, provider, XPC
  service, bridge and helper SHA-256. Non-prompting `codesign` and `spctl` assessments render unknown
  as unknown; stable derives only from Developer ID + hardened runtime + Gatekeeper + notarization.
- Builds without that complete proof show a prominent **unsigned/unnotarized manual alpha** warning
  and an update permission-regrant warning.
- Diagnostic export is a user-selected local, explicit allowlist. It omits project paths,
  source/file contents, transcripts, environment/credentials, raw logs and crash tails. The existing
  bounded atomic crash journal remains the recovery source.
- The manual-alpha manifest binds the DMG and all 294 regular-file/symlink app entries. Mutation of
  either is rejected.
- The installer verifies source and staging, atomically preserves the installed app as `.previous`,
  re-verifies after activation, restores on failure, and refuses to overwrite a rollback copy.
- The stable script fails closed on credentials, enforces one Developer ID team across Bimax-owned
  nested executables, verifies the bundle, staples the app before the DMG, then notarizes/staples the
  DMG. It was not run because credentials do not exist.
- Complete Desktop dependency audit is zero after narrow PostCSS/nanoid transitive overrides. The
  older Terminal/root dependency graph is separate and is not counted as a Desktop pass.

## Exact local artifact

- `app/release/Bimax-1.1.0-arm64.dmg`
- DMG SHA-256: `22f139dd6745499e28677a1f22d9a80f230a0a4c591e39b740422c47aa02bb21`
- App-tree SHA-256: `729a1ad4262a05a4237ebd0a0bb35df8b67e04c702ba5c29eb979ccd9f90633e`
- Actual signature: ad-hoc/linker-signed; no TeamIdentifier
- Actual notarization: not established

The distributable is under ignored `app/release/`; the durable result is
`evidence/phase7-local-2026-08-09.json`. This is a local candidate, not a published release.

### 2026-08-11 isolated Trust Center smoke artifact

- `app/release/latest-isolated/Bimax-Latest-arm64.dmg`
- DMG SHA-256: `43a07297fd8ab3658fad025f6ef74b11874f5212b391cdbf27c3c4bfde0646a4`
- Size: 211,715,388 bytes
- App identity: `ai.bimax.app.latest`; ad-hoc CDHash
  `f0cfb96b20df879b3c693273551d45f057d96c92`; no TeamIdentifier
- CU service identity: `ai.bimax.cu.service`; ad-hoc CDHash
  `5d7bd1416f5f1825653a33be80971bbc488594a3`; no TeamIdentifier

This separate identity prevents Launch Services from substituting the older `ai.bimax.app` while
testing. The clean temporary source bundle passed strict deep code-signature verification and was
used to create the DMG. It opened packaged `app.asar` and rendered Trust Center without the prior
native-icon crash. This is local smoke evidence only: Developer ID, notarization, a performed TCC
drop, fresh-Mac qualification and source-reproducible native artifacts remain Target.

### 2026-08-12 permission-coach follow-up artifact

- `app/release/latest-drag-fix-v2/Bimax-Drag-Verified-arm64.dmg`
- DMG SHA-256: `78c4f00be18b7e350655b3ffa5210a61ea617de7cae407863765dc53ed1c4eb5`
- App identity: `ai.bimax.app.latestfix2`, ad-hoc/no TeamIdentifier

This artifact includes the React coach-lifecycle correction, raw 64×64 BGRA drag icon and bounded
coach lifecycle logging. The focused J4 journey and all five mutants pass; the native Electron icon
smoke reports `empty:false`, 64×64; three trust/model/routing suites pass (9 tests); production build
and strict deep verification pass. The user-controlled System Settings drop, TCC mutation,
Developer ID/notarization and fresh-Mac matrix remain Target.

### 2026-08-12 single local app after live-drag crash

The user subsequently confirmed that the native bundle drag reached System Settings, then reported
an unexpected app exit. The matching `.ips` is a browser-main `SIGTRAP` during an AppKit reopen
event after the coach renderer requested closure. The local fix hides the coach immediately but
defers WebContents destruction until `startDrag` and the reopen event settle; packaged app reopen
also restores one owned window and a single-instance lock prevents a second engine/permission
owner. A macOS 26 one-shot privacy-deep-link retry was added after local end-state inspection found
the first activation at General and the second at Accessibility.

One strict-deep-verified ad-hoc bundle now remains installed at `/Applications/Bimax.app` with
identifier `ai.bimax.app`; generated `Latest`, `Latest Fix`, `Drag Verified`, onboarding, fixture and
old installer bundles were moved to `~/.Trash/Bimax-duplicates-2026-08-12/`. The Electron.app under
`node_modules` remains a build dependency and was not launched as the product. A final-identity TCC
grant on a fresh Mac, Developer ID, notarization and stable publication remain Target.

2026-08-23 local identity amendment: a repeated live report reproduced host 0/2 while the visible
System Settings `Bimax` row belonged to the previous CDHash-only ad-hoc build. `tccd` attribution
confirmed Bimax's helper was asking for responsible identifier `ai.bimax.app`; a separate shell
probe was attributed to ChatGPT and therefore could not be used as Bimax grant evidence. The
existing `Bimax Local Code Signing` identity was then tested on two different binaries with the
same identifier; both emitted the same certificate-root designated requirement. The local signing
path now prefers that certificate for the host, disables hardened runtime, and excludes the XPC CU
service so its manual-alpha ad-hoc hash approval remains intact. This is a stable local-development
identity only, not Developer ID, notarization, Gatekeeper acceptance, or a stable/public release.

The corrected arm64 candidate passed the package ownership/deep-signature gate and the complete Mac
regression (101 suites, 1,154 tests). Its host requirement is `identifier "ai.bimax.app"` plus the
local certificate root, while the XPC service remains ad-hoc at exact hash
`9e08537a69209c591b3089729a31476cf71ed689` and reports both permissions granted. It was installed
at `/Applications/Bimax.app`; the prior app is recoverable at
`/Applications/Bimax.previous-20260823-before-stable-local.app`. The installed Trust Center then
visibly rendered `Control Mac is ready`, host 2/2, and both native-service permissions Allowed.
That closed the reported current-build mismatch. At that point, a second changed
certificate-signed app update was still required to measure persistence across rebuilds; public
release identity remained Target.

2026-08-23 second local-update amendment: the next changed certificate-signed build preserved the
host grants (Trust Center remained 2/2) and the separately owned XPC service remained Allowed for
both permissions at its approved Code Directory hash
`9e08537a69209c591b3089729a31476cf71ed689`. This locally Measures permission persistence across one
changed rebuild under the stable local certificate requirement. It does not replace the clean-Mac,
Developer ID, notarized-update, revoke/regrant or public-release rows.

That rebuild also corrected an independent packaged-runtime fault: Electron's provider descriptor
did not set `BIMAX_CU_NATIVE_ROUTING_ENABLED`, so an otherwise ready service was deterministically
collapsed to the visible `native_tools_unavailable` stop. Packaged Electron now owns and forces the
full-native opt-in only inside the scrubbed provider descriptor; the generic engine receives no
native-routing variable, development preserves only an explicit contributor opt-in, and a hostile
inherited semantic flag cannot downgrade the packaged decision. The installed provider process was
restarted after installation and directly reported packaged mode, Electron-main authority and
`BIMAX_CU_NATIVE_ROUTING_ENABLED=1`. Full unit regression (101 suites / 1,156 tests), typecheck,
production packaging, strict nested signature verification and the Desktop ownership gate passed.
This establishes the corrected launch contract and live permission state; an end-state Messages or
other real-app task was deliberately not claimed from this read-only verification.

## Verification run

- Desktop typecheck and production build: pass.
- Phase 7 unit tests: 1 suite / 3 tests pass.
- Complete Desktop Mac capability regression: 55 suites / 606 tests pass.
- Manual-alpha mutation rejection and rollback injection: pass.
- Packaged arm64 app/component/ownership/fail-closed gate: pass.
- Manual manifest create + verify: pass.
- Desktop full `npm audit`: zero advisories.
- `codesign`: ad-hoc/linker-signed, no TeamIdentifier; `spctl` not accepted and no stapled ticket
  was established.
- Production `dist:mac` correctly stopped because the pinned public v1.1.0 engine manifest URL was
  HTTP 404. The local candidate used the already staged manifest whose digest, engine size and
  engine SHA-256 match `engine/lock.json`, then rebuilt current Desktop/native output.

## Acceptance boundary and next release actions

The Phase 7 manual-alpha **local implementation exit** is complete. These external rows prevent an
unqualified “Phase 7 complete” or stable claim:

1. publish the pinned v1.1.0 engine manifest/artifacts at the immutable URL and make `dist:mac` pass
   without a local staged-artifact exception;
2. publish the DMG, JSON manifest and `SHA256SUMS` together;
3. run browser-quarantine/Open Anyway, deny/grant/revoke/regrant, coding-with-permissions-denied,
   update-with-grants, rollback, crash and uninstall-retains-projects on fresh oldest/current Macs;
4. build/grade x64 if Intel remains shipped;
5. for stable, provide Developer ID/notary credentials, pass signing/notary/stapler checks, and
   implement/grade a signed update feed with rollback.
