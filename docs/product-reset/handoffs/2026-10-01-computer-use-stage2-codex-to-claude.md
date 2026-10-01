# Claude handoff — Bimax Computer Use, Stage 2

Date: 2026-10-01, IST. Prepared by Codex at the owner's request.

## Resume here

| Item | State |
|---|---|
| Repository | `/Users/vishsiddharth/Bimax` |
| Branch | `feat/sovereign-retrieval-and-layout-extraction` |
| Claude's last commit | `37b3380` — menu opt-in asks macOS for Accessibility only |
| Codex implementation commit / current HEAD | **`a05cf9c`** — `fix(computer): revoke pending looks before stage 2 qualification` |
| Remote state when checked | 10 commits ahead of the tracking branch; Codex did not push |
| Working tree before this handoff was created | Clean; this handoff is the subsequent documentation-only addition |
| Installed app | `/Applications/Bimax.app` — now the rebuilt revocation fix, not the old pre-CU install |
| Preview setting at handoff preparation | **Off** (`computerLook: false`) |
| Stage 2 exit | **Still open**: installed Computer Use observation and Bimax-owned Accessibility attribution not proved |
| Stages 3–6 | **Target; not started by Codex** |

Continue Stage 2 qualification. Do not advance to safe mutation from the outside-app proof alone.
The plan's rule still applies: **each stage ends on evidence or the plan stops there; nothing is waived**.

## Required reading

Read `AGENTS.md` and [product-reset README](../README.md) first, then
[record 65](../65_COMPUTER_USE_RETURN_WITH_CUA_PLAN.md), especially **§6b and §6c**.
Consult [architecture](../05_TARGET_ARCHITECTURE.md), [roadmap](../07_MIGRATION_ROADMAP.md),
[acceptance gates](../08_ACCEPTANCE_GATES.md), the
[Mac Buddy vision](../vision/BIMAX_MAC_BUDDY_PRODUCT_VISION.md),
[competitive grading rules](../competitive/06_HEAD_TO_HEAD_EVALS.md), and
[M02](../competitive/examples/M02_BACKGROUND_MAC_ACTION.md).

The research mapping for this fix is **V20 and V26**, in record 12. The continuation also consulted
records 01/03/04/06 and competitive README/04/05/07. Record 65 §6c lists the guidance and limits.

## What Codex changed

First, Codex verified and installed Claude's staged `37b3380` app. While reviewing Stage 2's
revocation boundary, it found four failures, reproduced them with new regressions, then fixed them:

1. Preview turned off while the grant card was waiting: a late Allow still read the window.
2. Bimax Thread stopped while the grant card was waiting: a late Allow recreated the grant.
3. App discovery completed after the Bimax Thread stopped: it could raise a later grant card.
4. A window read completed after preview off: its contents still reached the engine.

The service now captures a per-Thread generation and a preview generation, checks them after
asynchronous boundaries, and rejects revoked requests before creating grants, reading windows, or
returning contents. Turning preview off calls `revokeAll()`, clearing grants and ending sessions.
An off/on cycle cannot revive an old request.

The driver wrapper separately validates a generation during SDK initialization, trusted-session
creation/renewal, window discovery and tree-read completion. A native read already in flight may
finish; its revoked result is discarded. This is not a claim that native work is forcibly cancelled.

| File | Change |
|---|---|
| `app/src/main/computer/look.service.ts` | Generation checks, revocation after awaits, `revokeAll()` |
| `app/src/main/computer/look.driver.ts` | Generation-bound sessions, renewal and read results |
| `app/src/main/index.ts` | Turning the preview checkbox off invokes revocation |
| `app/src/__tests__/computer.look.test.ts` | Six new service revocation regressions |
| `src/__tests__/computer.admission.boundary.test.ts` | Pins menu-off revocation wiring |
| `app/scripts/computer/prove-look-revocation.cjs` | Actual wrapper tested against a controlled SDK; temporary generation-check mutant |

The look-only manifest, pinned driver version **0.31.0**, engine tool surface and input denials
were not widened. No old XPC service, Mac provider, legacy fallback or Computer Use mutation was restored.

Codex also corrected stale active-status notices in README, records 04/05/07/08 and the competitive
gap register/build sequence, and added the complete continuation record as **65 §6c**. Historical
architecture remains marked as history.

## Build, install and rollback

The corrected app was built with:

```sh
cd /Users/vishsiddharth/Bimax
BIMAX_LOCAL_BUILD_DIR=/private/tmp/bimax-cu-stage2-revoke/release bash app/scripts/build-local-mac.sh arm64
```

Build: `/private/tmp/bimax-cu-stage2-revoke/release/mac-arm64/Bimax.app`.
Installed: `/Applications/Bimax.app`.
Signing: **Bimax Local Code Signing**, self-signed local build, without hardened runtime.
This is not a Developer ID/notarized release.

Rollback copies:

- `/Users/vishsiddharth/Developer/bimax-archive/apps/Bimax.app.before-cu-stage2-20261001`
  — original pre-CU installed app.
- `/Users/vishsiddharth/Developer/bimax-archive/apps/Bimax.app.before-cu-revocation-20261001`
  — intermediate install of Claude's `37b3380` build.

Installed ASAR SHA-256:
`cf82897a7e4eef88bb2596f2afb5e052176e0811bc82c38bcce57e8e404dae79`.

Installed engine SHA-256:
`e21f6f6a6d0933a35a3e5e2454ac939d3197d3914e7eb1cdafb532fd6893e0ff`.

[install.json](../evidence/2026-10-01-cu-stage2-installed/install.json) also contains the SDK dylib,
Node add-on and source hashes. All four installed artifact hashes were rechecked while preparing
this handoff and still match the record. Recheck before relying on the app after further changes.

The build used Command Line Tools after the existing Xcode-license refusal, retained the existing
voice Sendable warning, and shipped the legacy icon when the asset-catalog step was unavailable.
These did not prevent the local build/install; release qualification remains separate.

## Verification actually completed

Evidence directory: [2026-10-01-cu-stage2-installed](../evidence/2026-10-01-cu-stage2-installed/).
`SHA256SUMS.json` covers the retained evidence files.

| Check | Result | Evidence |
|---|---|---|
| Look/admission/host-call/protocol/port/runtime-env suites | **89 passed in 7 suites** | `tests-after.txt` |
| Existing Thread and approval-card suites | **19 passed in 2 suites** | `thread-approval-tests.txt` |
| Four original revocation regressions against old implementation | All four reproduced failures | `revocation-before.txt` |
| Controlled-SDK driver revocation proof | **4 passed** | `driver-revocation.json` |
| Driver generation-validation mutant | Rejected; expected nonzero exit | `driver-generation-mutant.txt` |
| Desktop typecheck and production build | Passed | `typecheck.txt`, `build.txt`, `package.txt` |
| Engine artifact in Electron as a worker | **7/7 protocol exchanges** | `package.txt` |
| Installed package gate | Passed | `installed-package.txt` |
| Deep strict signature | Passed on staged and installed app | Install record and retained build log |
| Installed App Actions structural check | **3/3** | `installed-actions.txt` |
| Installed coding smoke | One independently graded read passed; six grader mutants rejected | `code-smoke.json`, `grade-code-smoke.py` |

The coding smoke used `/Users/vishsiddharth/Library/Caches/bimax-cu-stage2-code-check`, with
`stage2-fixture.txt` containing `BIMAX_STAGE2_CODE_ONLY_20261001`. The installed project task made
one successful `ReadFileTool` call on that exact file and returned its exact marker; the fixture
bytes stayed unchanged. Its displayed model was `gpt-oss-20b · Low`; the exact provider was not
independently captured and model configuration was not changed.

Preview was off. No TCC prompt was observed, no host audit file existed, and a **post-task** `lsof`
sample showed no Cua SDK mapping. This is one local coding smoke, not a whole-session TCC event count.
The saved synthetic Bimax Thread ID is `ddb91d9b-50c0-4def-a7b3-bed11cb88a91`, origin `project`.

The initial native folder-picker attempt was not scored; after restart the folder was confirmed in
recents and the successful smoke above ran. Two initial test invocations named nonexistent files;
the corrected runs passed. `invalid-test-path.txt` retains the later invocation error. Raw compiler
logs retain their original whitespace; the source/docs whitespace check excluded verbatim evidence logs.
The full repository test suite was not rerun; the numbers above are focused checks.

## Reproduction commands

Run from `/Users/vishsiddharth/Bimax`:

```sh
npx jest --runInBand --coverage=false --runTestsByPath app/src/__tests__/computer.look.test.ts src/__tests__/computer.admission.boundary.test.ts src/__tests__/look.host.call.test.ts src/__tests__/protocol.test.ts src/__tests__/protocol.contract.test.ts src/__tests__/port.host.test.ts app/src/__tests__/coding.runtime.paths.test.ts
npx jest --runInBand --coverage=false --runTestsByPath app/src/__tests__/threads.test.ts app/src/__tests__/approval.one.card.test.ts
node app/scripts/computer/prove-look-revocation.cjs
node app/scripts/computer/prove-look-revocation.cjs --mutant
npm --prefix app run typecheck
node scripts/verify-desktop-package.mjs /Applications/Bimax.app arm64
node app/scripts/check-app-actions.mjs --app /Applications/Bimax.app
codesign --verify --deep --strict /Applications/Bimax.app
```

The `--mutant` command **must fail**. The wrapper proof uses a controlled SDK and cannot prove TCC
identity or installed native behavior. `grade-code-smoke.py` depends on the preserved synthetic task,
preview being off and no audit file existing; after a real look session starts, preserve its old result
and use a fresh isolated run rather than expecting that historical probe to pass unchanged.

## Next step for Claude: finish the installed Stage 2 gate

Codex asked the owner to enable the menu item and grant Accessibility, but received no acknowledgement
in this session. The setting is still off when this handoff is prepared. **Actual Bimax TCC grant state
was not independently established**; do not infer it from the setting or an older terminal grant.

1. Have the owner tick **“Let Tasks Look at Other Apps (Preview)”** from Bimax's menu bar icon and grant
   **Bimax Accessibility** in System Settings. For current Stage 2, **Screen Recording is unnecessary**:
   it reads AX text and takes no screenshots. Do not automatically grant permission on the owner's behalf.
2. Use a **new ⌘2 Bimax Thread** for the installed fixture observation. Project windows do not receive
   `LookAtAppTool`; the successful coding smoke was intentionally a project task.
3. Prove Allow, Not now, stop/revocation, and preview off/on behavior in the **installed app**. Preserve
   its own host/driver counts and independent fixture before/after state. Grade zero authorized input
   and no fixture mutation from evidence, not from model narration.
4. Establish that the SDK loads from `app.asar.unpacked` and permission attribution is **Bimax.app's**,
   rather than the terminal's or standalone CuaDriver.app's. App audit location is
   `~/Library/Application Support/Bimax/computer/audit.jsonl`.
5. Inspect whether the existing installed audit surface captures enough evidence for every required
   case; any additional proof work is still Stage 2. `app/scripts/computer/prove-look.js` runs an
   outside-installed-app harness with a played person, so rerunning it alone cannot close this gate.
6. Record all results and invalid attempts in record 65 and the evidence folder. Only after Stage 2's
   exit is actually met, consider Stage 3's one safe fixture mutation and its required mutants.

No installed allow/deny/revoke look session, installed native SDK load, Bimax-owned TCC attribution,
Stage 3 input, local model sidecar, X01 journey, real workflow, clean-Mac matrix, Product-ready status
or competitive Win was established by Codex. Preserve those boundaries when continuing.
