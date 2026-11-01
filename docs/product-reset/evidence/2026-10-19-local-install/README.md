# Local Mac installation — 2026-10-19

At the owner's request, rebuilt the current working checkout using
`BIMAX_LOCAL_BUILD_DIR=/private/tmp/bimax-install-20261019-01/release bash app/scripts/build-local-mac.sh arm64`
and replaced `/Applications/Bimax.app`. The previous October 11 bundle is recoverable in
`~/.Trash/Bimax-previous-20261019-01.app`. Version remains 1.1.0; the engine and ASAR hashes identify
this build rather than the unchanged version string.

Guidance: product-reset `README.md`, `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`,
`08_ACCEPTANCE_GATES.md`, `competitive/06_HEAD_TO_HEAD_EVALS.md` and the I01 install contract.
The current local build/package scripts supply the active monolith and built-in CU inventory;
the older split/XPC/retirement descriptions remain historical as superseded in those documents.

Verification actually run:

- Main/preload/renderer and current-source engine builds; seven staged engine protocol exchanges.
- Native CU, voice, notch and App Intents builds. Existing scripts used Command Line Tools when
  Xcode refused its unaccepted license. The Swift non-Sendable warning remains; optional icon
  catalog generation was skipped by the existing hook on the same Xcode restriction.
- Stable local certificate signing and strict deep signature verification before and after copying.
- Staged and installed package gates, native standalone identity/status/module/entry checks,
  100 upstream source-file checks, 34 frozen modules and all three app-action checks.
- Exact installed versus built comparison of 1,001 file/directory/link entries, including file
  SHA-256 and modes. Saved Application Support/Bimax and ~/.bimax bytes matched before and after
  replacement, before normal app startup. No user-data deletion or permission reset was performed.
- Seven protocol exchanges against the engine inside `/Applications/Bimax.app`, hosted by the
  repository's Electron verifier in a disposable project; no paid model turn.
- Launched the exact installed executable. Initial observation showed a blank window; after one
  controlled process restart with startup logging, native AX showed the actual packaged renderer,
  welcome text, Open project control and existing recent projects. No source change or profile reset
  was used. The initial blank observation is retained as a limitation, not a proven startup fix.

`install.json`, `build.log`, `installed-package.log` and `installed-engine.log` retain hashes/results.
The app is installed and its welcome screen was observed on this Mac. This is a local manual-alpha
update only: full I01, live model tasks, B01/R01/R02 recovery/quality, repeated startup reliability,
Developer ID, notarization, fresh-Mac and stable-release qualification remain **Target**. No new
product capability, performance or competitive Win is claimed; no new mutation campaign was run.
