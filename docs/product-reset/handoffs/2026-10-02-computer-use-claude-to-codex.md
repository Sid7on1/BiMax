# Codex handoff — Bimax Computer Use, after stages 2–5

Date: 2026-10-02 (IST). Prepared by Claude at the owner's request: "give the hand off prompt to codex so that from here
codex will work on this". It continues `2026-10-01-computer-use-stage2-codex-to-claude.md` in this folder.

## Resume here

| Item | State |
|---|---|
| Repository | `/Users/vishsiddharth/Bimax` |
| Branch | `feat/sovereign-retrieval-and-layout-extraction` |
| HEAD | **`0405789`** (record 65 stage 5 set aside) — this handoff is the next commit |
| Remote | 21 commits ahead of the tracking branch; **nothing pushed** (push only when the owner asks) |
| Working tree | Clean apart from this handoff |
| Installed app | `/Applications/Bimax.app`, built from **`dc6e711`** (stage 3). Install record: `docs/product-reset/evidence/2026-10-01-cu-stage3/install.json`. `d972d56` (stage 5 build identity) is **not** installed |
| Menu switches | "Let Tasks Look at Other Apps (Preview)" **on**; "Let Tasks Press Buttons in the Test App (Preview)" **on** — both set by the owner |
| Rollback copies | `~/Developer/bimax-archive/apps/Bimax.app.before-cu-stage3-20261001` (stage 2 + Stop fix), `…before-cu-stop-20261001`, `…before-cu-revocation-20261001`, `…before-cu-stage2-20261001` |
| Next step | **The owner decides.** Nothing is in flight |

## Required reading, in order

1. `AGENTS.md`, then `docs/product-reset/README.md` (mandatory for every change).
2. `docs/product-reset/65_COMPUTER_USE_RETURN_WITH_CUA_PLAN.md` — the plan and every result: §3 stages, §6b–§6g.
3. `08_ACCEPTANCE_GATES.md` — the Computer Use admission gate (look, press, which build is running).
4. `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`, `vision/BIMAX_MAC_BUDDY_PRODUCT_VISION.md`.
5. `competitive/06_HEAD_TO_HEAD_EVALS.md` (grading rules), `competitive/examples/M02_*` and `X01_*`.
6. Record 46 §"Native implementation" (the governor trap, now fixed) and record 61 §4 / record 60 (laya).

## Where each stage stands

| Stage | Status | Record | Evidence |
|---|---|---|---|
| 1 Bench | Measured outside the product | 65 §6 | `evidence/2026-10-01-cu-stage1/` |
| 2 Look only | **Exit met**, installed: allow ×5, Not now, Stop, preview-off + late Allow, Stop-after-Allow re-asks | 65 §6b–§6d | `evidence/2026-10-01-cu-stage2*/`, `…-installed-look/` |
| 3 One press | **Exit met**, installed: one press in the test app on two cards; 7 live failure modes press nothing | 65 §6e | `evidence/2026-10-01-cu-stage3/` |
| 4 Small models | **Declined** (laya-mlx measured on its pre-written set; CUA-S1 nano/forms take no user request as input) | 65 §6f | `evidence/2026-10-02-cu-stage4/` |
| 5 Build → run → prove | **Set aside by the owner** after its parts were built; X01 not Measured | 65 §6g | `evidence/2026-10-02-cu-stage5/` |
| 6 Real workflows, release | Target | 65 §3 | — |

## What exists in code

Engine (`src/`):
- `tools/implementations/look.tool.ts` — `LookAtAppTool` (`BIMAX_COMPUTER_LOOK=1`).
- `tools/implementations/press.tool.ts` — `PressInAppTool` (`BIMAX_COMPUTER_LOOK=1` **and** `BIMAX_COMPUTER_PRESS=1`),
  task type `COMPUTER_CONTROL`, destructive, blank names rejected by argument validation before any card.
- `governor/governor.ts` — computer-control floors (sensitive targets; "not while unattended") now run **before** the
  Bimax Thread branch (record 46's trap). The engine's card for a press is one-time, never "allow for this task".
- `protocol/protocol.ts` — protocol **3.4.0**, `HostCapability = 'look' | 'press'`; fixtures/schema regenerated.

App (`app/src/main/computer/`):
- `look.service.ts` — the authority. Look: preview on → grant card per app per Thread → look-only driver session →
  menu bar cut, password fields blanked. Press: press switch on → app on `PRESS_APPS` → a look under 2 min, one press
  per look → exactly one named enabled button/checkbox/radio → the app's own card **every time** → no Stop/switch-off →
  same running build as the look → driver press → re-read; "nothing changed" is a failure; unknown outcome is said.
  Generations revoke in-flight requests (Codex's `a05cf9c`); any Stop of a turn ends the Thread's grants (`6e5e6c2`).
- `look.driver.ts` — Cua Driver 0.31 in-process (`app.asar.unpacked`); separate press-only session (manifest: look
  tools + `click`); press re-reads, matches once, clicks by element token in the background, never retries.
- `look.manifest.ts` — `LOOK_TOOLS`, `INPUT_TOOLS` (denied by name), `PRESS_TOOLS = ['click']`,
  `PRESS_APPS = ['ai.bimax.cu.fixture', 'ai.bimax.cu.x01-todo']` (Bimax's own test apps only), `PRESS_ROLES`.
- `look.identity.ts` — running executable + SHA-256 (stage 5, built, not installed).
- `index.ts` — the two tray switches, env flags for ⌘2 Threads only, audit at `userData/computer/audit.jsonl`
  (content-free; press receipts hash the control name).

Tests and proofs: `app/src/__tests__/computer.look.test.ts`, `computer.press.test.ts` (32),
`src/__tests__/computer.admission.boundary.test.ts` (the gate — widening anything must fail it),
`governor.computer.floor.test.ts`, `press.host.call.test.ts`, `look.host.call.test.ts`;
`app/scripts/computer/press-mutants.cjs` (11/11), `prove-press-driver.cjs` (controlled SDK, 4 mutants),
`prove-look-revocation.cjs` (+ `--mutant`), live harnesses `prove-look.js`, `prove-press.js`, `prove-x01.js`.

## Rules that hold (do not relax without the owner and a failing test first)

- Bimax for Mac alone owns Computer Use and macOS permissions; never in Terminal; no legacy XPC/provider paths.
- Every press asks **twice** (engine card + app card) — the owner chose this. No "allow for this task" for presses.
- `PRESS_APPS` is Bimax's test apps only. Real apps (Spotify, WhatsApp…) are stage 6 and a deliberate gate change.
- Only `click` by element token may be authorized; every other input tool stays denied by name. No typing yet.
- Never grant TCC or tick the switches on the owner's behalf; the owner does it by hand.
- Grade end states from evidence the model cannot write (independent fixture reader, driver observer, audit), and
  run mutants against every grader (`competitive/06`). Record invalid runs; never upgrade a status word.
- Move, don't delete; never chain `git commit` after tests in one command (read the result first).

## Practical traps (measured this session)

- **Engine bundle**: live proofs run `app/engine/index.js`; after any `src/` change run `npm run build:engine`.
- **Build/install**: `BIMAX_LOCAL_BUILD_DIR=/private/tmp/<new>/release bash app/scripts/build-local-mac.sh arm64`;
  quit Bimax, `mv` the old app to `~/Developer/bimax-archive/apps/`, `mv` the new one in; same signing identity keeps the
  Accessibility grant. Ask the owner before building/installing.
- **Installed runs**: start a ⌘2 Thread with `open 'bimax://task?folder=…&prompt=…'`; the Start dialog may open on
  another Space behind a full-screen terminal; a finished ⌘2 Thread on screen blocks the next one (8 GB → 2 live engines)
  — the owner presses Esc to hide the bar. Scripts: `evidence/2026-10-01-cu-stage2-installed-look/scripts/look_run.py`,
  `evidence/2026-10-01-cu-stage3/scripts/press_run.py`.
- **Fixture**: `~/Developer/bimax-research/cu/BimaxCuFixture.app`; relaunch if its window closes. Independent reader:
  `…stage2-installed-look/scripts/read_fixture.py` (standalone `cua-driver`; run `cua-driver stop` after reads).
- **The owner**: wants short, plain answers that start with "your work is safe"; calls the tray "⌘2 at the top right";
  presses Allow on cards by habit — when a test needs "Not now", say so in one line and nothing else.
- **Model/provider**: the configured model is `openai/gpt-oss-20b` (NVIDIA). In stage 5 its replies slowed to 3–6 min
  each; a long agentic task did not reach its first edit in 23 min.

## Owner's direction for what comes next

The owner asked whether, after all stages, Bimax can "click and play songs on Spotify… operate any app… send text via
WhatsApp", and then set stage 5 aside as not needed for Computer Use. Read that as: the next useful work is **stage 6,
the owner's real apps**. Before any code, agree with the owner on two or three concrete workflows with explicit limits.
Measured facts that bear on it (record 65 and memory): Spotify publishes a usable web AX tree once its window exists;
WhatsApp controls are named and its chat rows accept background presses; Notes rows cannot take a background press.
Sending a message to a person is a new input class (typing + send) that needs its own design: the recipient and the
exact text on the card, no auto-send, recipient proven by fresh evidence (see the old "circular gate proof" lesson).
The release bar stays: beat v1.1.0's 3/15 on the same fixtures across three repeats; 20 clean repetitions per risky
path before any release claim.

## Verification to re-run before trusting this state

```sh
npx jest --runInBand --coverage=false --runTestsByPath app/src/__tests__/computer.press.test.ts app/src/__tests__/computer.look.test.ts src/__tests__/computer.admission.boundary.test.ts src/__tests__/press.host.call.test.ts src/__tests__/look.host.call.test.ts src/__tests__/governor.computer.floor.test.ts src/__tests__/protocol.contract.test.ts app/src/__tests__/coding.runtime.paths.test.ts
node app/scripts/computer/press-mutants.cjs
node app/scripts/computer/prove-press-driver.cjs
node app/scripts/computer/prove-look-revocation.cjs && ! node app/scripts/computer/prove-look-revocation.cjs --mutant
npm --prefix app run typecheck
node scripts/verify-desktop-package.mjs /Applications/Bimax.app arm64
```

Last results this session: 115 tests in 7 focused suites, 11/11 press mutants, driver proof 10/10 with 4 mutants
caught, app typecheck clean, installed package gate 4/4.

## Housekeeping left

- Branch `wip/cu-stage3-press` (`cd03d48`) is superseded by `7d8e305`; delete only with the owner's OK.
- Stage 5 run folders `~/Library/Caches/bimax-x01-run-*` and `bimax-x01-state-*` can be cleaned up (scratch).
- `d972d56` is not installed; install it with the next build if the owner wants the build identity in the app.
