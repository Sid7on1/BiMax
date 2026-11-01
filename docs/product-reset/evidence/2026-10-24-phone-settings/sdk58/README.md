# SDK 58 correction after the owner's iPhone mismatch

The owner scanned the SDK-57 loading QR and reported Expo Go requesting SDK 58. The mobile
workspace now matches that observed runtime. Earlier SDK-57 receipts remain historical; they
do not qualify current phone compatibility. This directory supersedes only that compatibility
slice; the installed Mac app and existing Desktop suite results are unchanged.

- `upgrade.log`: official Expo-selected module migration to Expo 58.0.19. Initial workspace
  overrides left Reanimated 4.5.1/Worklets 0.10.1, then duplicate React/native; repaired with
  SDK-selected root overrides/direct dev dependencies and a resolved-runtime guard.
- `align-workspace.log`, `dedupe-runtime.log`: coordinated root/native runtime install.
- `mobile-check-delivery.log`: complete checks pass, including resolved runtime guard and
  `expo install --check`, TypeScript, lint, all crypto/Noise/admission/relay/mobile/gateway
  regressions, fourteen responder cases and actual Workers/Durable Object runtime.
- `doctor-delivery.log`: **20/20** first-party Expo Doctor checks pass. Earlier doctor logs
  preserve duplicate native bindings, legacy config properties and static-base merge failures.
- `config-attachment-regressions.log`: passed after mock reads became async; original bounded
  reads, metadata refusal, cache cleanup, structured attachments and auth redirect checks remain.
  Added assertions preserve caller-supplied config fields without mutating its input.
- `mobile-check.log`: retained SDK-58 type errors exposing unawaited asynchronous readBytes.
  Production now awaits the read and retains byte limits, zeroing and finally-close.
- `splash-migration.log`: plugin installed; CLI cannot rewrite dynamic config, so same image,
  resize mode and background moved explicitly to the splash-screen plugin.
- `ios-export-delivery.log`: current real iOS Hermes bundle, about 4 MB, outside the repo at
  `~/.local/state/bimax/phone-20261024/ios-sdk58-delivery`. Earlier exports are retained.
- `cross-repo.log`: linked fourteen responder cases and eight actual signed-approval/ThreadManager
  checks pass with two engine replies.
- `installed/phone.log`, JSON/PNGs: eleven checks pass against installed controller/preload with
  actual phone-client/Noise traffic. No physical phone or real engine effects in this fixture.
- `expo-server.json`: live SDK-58 LAN manifest and successful **8,008,569-byte** iOS development
  bundle request. `expo-load.gif` is independently decoded by native CoreImage. Metro remains
  running with the cache refreshed. This proves serving/bundling, not native phone execution.
- `dependency-audit.json`: eight open advisories (two moderate/six high) in the dependency graph.
  No unsafe SDK downgrade or force-upgrade was applied. This gate remains open.
- `before.json`: persistent SDK-upgrade baseline; `preservation.json` compares final scoped
  changes and verifies no pre-existing file removal or restoration of the 77 existing deletions.

Original package manifests/lock are also backed up outside the repo under
`~/.local/state/bimax/phone-20261024/before-sdk58`. No Bimax/provider credential, deployed relay,
Apple account, native biometric admission or permission grant was changed. Physical pairing,
account sign-in, Face ID in a development build and public release still require qualification.

The owner then reported Expo Go's missing-CLI-login gate. Expo browser PKCE sign-in completed;
`expo whoami` verifies **sid7vish**, matching the phone. The server restarted using this account.
`expo-auth.json` stores username/status only, with no credentials or OAuth URL. Bimax's account
sign-in and pairing remain separate physical steps.
