# Phone chat/UI and current Mac delivery evidence

Record 107 distinguishes native transport tests, local fixtures, one direct provider probe, the owner-confirmed iPhone answer, current Metro delivery, packaged pairing and actual installed-window observations.

- `mobile-delivered.log`: final full mobile gate, 13 auth tests + 13 stream tests, 47 gateway tests and all prior integration/security suites. Lint has zero errors/three inherited warnings.
- `mutations-delivered.json`, `S01-delivered.log`–`S03-delivered.log`: three assertion-caught source faults. The initial S01 refusal was an ordinary thrown error and was not counted until its adapter assertion was explicit.
- `ui-delivered.log`, `rendered-delivered/ui-result.json`, `rendered-delivered/*.png`: actual RN Web source controls and screenshots with inert account/router/storage/transport fixtures. Earlier harness failures and an assertion-caught native text-node warning are retained.
- `ios-final-delivered.log`, `ios-artifact-delivered.json`, `metro-delivered.json`: successful SDK-58 export/current development bundle; no fixture bypass in the Hermes artifact. Exports/bundles stay outside the repo.
- `provider-probe.json`: exact non-secret console observation, not a retained raw HTTP response. `owner-observation.json` is direct owner feedback, not agent-captured phone instrumentation.
- `mobile-integration.log`, `verify-engine.log`, `phone-check-final.log`: actual linked responder/approval, engine and packaged-runtime boundary fixtures. `phone-check.log` retains the initial missing output-directory failure.
- `install.json`, `installed-window.json`, package/signature/actions logs: current bundle replacement and observed installed welcome screen. The app profile and previous bundle remain outside the repo.
- Fresh baselines and `preservation.json` establish unrelated dirty source/deletion preservation. No credentials, raw profile hashes, live account token or provider payload is included.

These receipts do not qualify physical phone pairing/Face ID, sustained provider behavior, current hardened cloud rollout or public release.
