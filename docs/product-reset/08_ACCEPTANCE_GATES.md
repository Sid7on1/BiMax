# Acceptance gates

The target is not a cosmetic `n/n`. A test counts only if it fails when the feature is deliberately
broken and grades the real end state. Provider outages, missing observations, stale fixtures, and
model changes are invalid runs, not product failures or passes.

## Gates for every product change

- work implementing an owner-vision capability names its V-ID and research card from
  `12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md`, including baseline, candidates, hard constraints,
  metrics, mutants and adoption rule;
- unit/contract tests fail against a deliberately neutered implementation;
- typecheck, lint/build, offline tests, and protocol fixtures pass with zero unexpected failures;
- no test is deleted, skipped, loosened, or changed from end-state evidence to “something happened”
  merely to reach green;
- runtime artifacts do not mutate user model/config or leak across fixtures;
- claims name product, backend, model, build, run count, discarded count, and raw artifact.

## Bimax Terminal release gate

- coding smoke matrix passes: inspect, edit, multi-file change, failing-test repair, review-only,
  interrupt, resume, and dirty-worktree preservation;
- TUI build/vet/test and protocol golden fixtures pass on supported macOS architectures;
- warm start and interaction latency meet recorded budgets;
- archive contains engine/TUI/licenses only—no CU driver/service/helper/PiP;
- no Accessibility or Screen Recording prompt appears on a clean Mac;
- non-interactive JSON/NDJSON output is schema-valid.

## Bimax Desktop coding gate

- Electron is on a currently supported major/minor line and the chosen minimum macOS is enforced by
  app packaging and native targets;
- pinned engine digest matches lock file and release manifest;
- current and previous supported protocol versions pass golden fixtures;
- engine crash, hang, malformed frame, upgrade mismatch, resume and diagnostics are visibly handled;
- project file, PTY and git IPC reject traversal/malformed payloads;
- code task works with zero CU permissions.

## Bimax Desktop computer-use gate

- packaged app, not a dev shell, owns the permission and focus experience;
- a Control Mac task cannot reach the engine until the active provider credential, a currently
  served curated Work row for the configured model id, and a currently served screenshot-capable
  route are confirmed; duplicate catalogue rows are resolved by requested slot rather than by row
  order, and `avoidAutoSelect` never vetoes a model the user intentionally selected; a served
  Vision/unknown model with no Work row and provider timeout/error are visible blocked states,
  never implicit fallbacks;
- once admitted, an explicit Control Mac turn is narrowed to the app-owned `mac_control` capability
  as its only acting authority; the engine may expose only its bounded read-only memory/code RAG
  tools beside it, never shell, file mutation or a third-party Computer Use provider, and the turn
  cannot terminate on model narration alone; if the route fails to invoke the tool after the
  bounded activation retries, the task ends with a concrete model-route blocker and an idle UI;
- provider secrets are stored through macOS Keychain-backed main-process storage and never appear
  in renderer persistence, NDJSON, diagnostics or logs;
- app bundle/XPC/bridge/helper signatures and locations pass structural verification, and the exact
  signed packaged app executable proves Electron → bridge → intact app-bundled XPC service through
  a no-window handshake (a direct service self-test does not satisfy this gate);
- the exact native service permissions, not merely the Electron host permissions, gate readiness;
- add-by-drag permission guidance exposes a real native bundle drag source, keeps System Settings in
  front and names the bundle that must land in the list;
- native semantic, native physical, visual recovery, and stop paths each have a test that forces that
  level and proves the postcondition;
- stale frame/element handles and identical failed-call loops are rejected;
- pause/takeover prevents all agent input until explicit resume;
- action receipts bind target app/window, fresh observation, executor, and postcondition;
- background/foreground classification is measured per action and shown truthfully;
- Messages demo uses a safe test contact/account until the user explicitly approves a real send;
- native arbitrary-task evaluation is reported separately from the narrow exact-state benchmark;
- compatibility/legacy backends cannot silently activate in a production build.

## Contextual macOS intelligence gate — owner section 28

- Code remains fully usable with all optional intelligence/CU permissions denied or revoked;
- every finding binds task intent, observed identity, causal evidence, violated expectation, rule or
  model version, freshness/completeness, confidence and disposition;
- an evidence gap, dropped event or unavailable sensor cannot produce an unqualified safe verdict;
- deterministic hard floors, learned anomaly ranking and model explanation are separate in receipts;
- no model/remote call/UI prompt appears in an Endpoint Security authorization deadline;
- correction proves before state, authority, preview, approval, fresh precondition, exact mutation,
  independent postcondition and rollback;
- dirty project/environment state survives correction except for the approved mutation;
- permission grant, denial, revoke, update, extension crash, event loss and queue overload pass on
  the fresh-Mac matrix;
- benign multi-project corpora meet declared false-positive, notification-volume, CPU, memory,
  energy-proxy and latency budgets;
- a deliberately stale/forged observation or false repair causes the evaluator to fail.

No Endpoint Security or Network Extension gate applies until Apple grants the relevant entitlement
and the feature is actually shipped. Lack of that entitlement cannot block the nonprivileged
contextual-receipt product.

## Modular ecosystem and environment gate — owner section 29

- read-only inventory does not execute project scripts, source untrusted shell profiles, expose
  secrets or mutate the environment;
- every executable capability has immutable digest, signed/fresh metadata, publisher/provenance,
  platform/architecture constraints, declared authority, health state and rollback target;
- expired, downgraded, revoked, dependency-confused, traversal, decompression-bomb, identity-drift
  and overprivileged fixtures fail before activation;
- extensions run outside the renderer and cannot bypass nested approvals, path/network/process
  capability handles, resource limits, cancellation or output limits;
- a skill's instructions and MCP tool metadata are untrusted and cannot self-grant capabilities;
- environment changes show exact project/global, download/disk, script, license/provenance and
  rollback impact, then re-inventory and run a project-relevant postcondition;
- iOS runtimes remain Xcode-managed and Android components use official tooling;
- optional Computer Use remains app-owned and Terminal release inventory stays CU-free;
- extension/package crash, compromised metadata, failed activation and failed upgrade restore the
  exact prior graph without harming dirty work;
- ML optimization compares task quality, behavior, latency, memory, artifact size, device/fallback,
  provenance and reproducibility; a smaller but unacceptable model must lose;
- adaptive runtime/rendering policies publish named signals, thresholds, hysteresis, bounds,
  accessibility rules, override and measured device/workload result;
- Reduce Motion and interaction responsiveness are hard constraints regardless of available GPU.

The complete S28/S29 journey tables and claim ladder live in
`11_SECTIONS_28_29_RESEARCH_AND_DELIVERY_PLAN.md` and are part of this gate by reference.

## Fresh-Mac install matrix

At minimum test the oldest supported macOS and current macOS, arm64 and x64 where shipped:

- first download/install/launch from a quarantined browser download;
- manual Open Anyway alpha flow, if applicable;
- Screen Recording request, restart, Accessibility grant, revoke, re-grant;
- app update with grants already present;
- engine/native-service update compatibility and rollback;
- uninstall leaves user projects untouched and documents retained app data.

## Distribution channels

### Manual-install alpha

- prominent unsigned/unnotarized label;
- SHA-256 manifest over the exact DMG/app and visible verification instructions;
- exact in-app build/service hashes;
- explicit warning that macOS may request permissions again after updates;
- no claim of automatic trusted updates or no-warning install.

### Stable public release

- Developer ID signing of app and every nested executable with consistent identity;
- hardened runtime and minimal entitlements;
- Apple notarization accepted and ticket stapled;
- Gatekeeper passes on a clean quarantined download;
- permission persistence across a real update;
- signed update mechanism with rollback.

Electron documents that macOS update delivery expects signed builds, while Apple requires Developer ID
for notarization. If the owner chooses not to sign, the product can remain a serious alpha, but it
cannot honestly pass the stable distribution gate.

Sources:

- [Electron: Updating applications](https://www.electronjs.org/docs/latest/tutorial/updates)
- [Electron: Code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Apple: Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
