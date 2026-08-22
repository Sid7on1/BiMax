# Computer Use Phase 2 — deterministic completion and safe delivery

Status: **core contract Implemented and locally Measured at the deterministic native-provider
boundary, 2026-08-22.** Physical delivery, menu delivery, and visual-recovery mutation are still
Target behind the logical adapter, so the whole Phase 2 product exit is not yet Product-ready.

This record executes the deterministic-completion core of Phase 2 in
`21_CU_VERIFIED_GRAND_STACK_AND_IMPLEMENTATION_PLAN.md`. It does not treat native API acceptance,
model narration, or a green `outcome:performed` field as proof.

## Result

Every mutation the packaged native logical adapter currently accepts now has a typed condition and
fresh independent evidence:

| Logical mutation | Postcondition source | Required proof |
|---|---|---|
| `open` | derived `app_running` | native launch receipt names the requested app, reports launched + finished or already running, and reports unchanged foreground |
| `click` | caller-declared `semantic_text` | fresh native AX evidence is `satisfied` with `postconditionMatched:true` |
| `type` | caller-declared `semantic_text` | same fresh AX proof; text delivery alone is insufficient |
| `set_value` | derived `semantic_value` | fresh AX evidence matches the exact requested value |
| `arrange` | derived `window_frame` | exact-window native read-back reports `attempted:true`, `honored:true`, and applied bounds |
| `close` | derived `window_absent` | exact-window read-back reports `honored:true` and `windowGone:true` |

`click` and `type` stop before effect with `postcondition_required` when the caller has not supplied
`expect`. `set_value`, `open`, `arrange`, and `close` use only bounded defaults whose end states are
unambiguous. An invalid `expectMode` is rejected before approval or delivery.

After every attempted mutation, retained snapshot authority is discarded. A second mutation must
start from a new observation even if the first delivery was not verified; this avoids replaying a
pre-action element token after an ambiguous effect.

## Receipt grading

A semantic action succeeds only when all of these bind together:

- the response is `semantic.action.receipt`, not a proposal or arbitrary JSON;
- its element names the retained snapshot id, token, pid, window id, and window generation;
- its outer target names the same exact window;
- its delivery policy is background, no focus lease was taken, and measured foreground did not
  change;
- `outcome` is `performed`;
- semantic evidence tier was requested and achieved;
- at least one fresh settle observation reports `outcome:satisfied` and
  `postconditionMatched:true`.

If delivery occurred but proof is absent, the result is visibly
`ok:false`, `verified:false`, `actionAttempted:true`, `code:postcondition_unverified`. That is
deliberately different from a pre-effect stop.

Physical keyboard/pointer, menu activation, and pixel delivery are not silently promoted. Their
logical verbs still return `executor:stop`, `verification.status:not_attempted`, and never call the
native action tool. Read-only exact-window screenshots remain available and are labelled visual,
but they cannot serve as proof of a visual mutation that the adapter does not yet implement.

## Deterministic compiled-provider proof

`npm run cu:phase2:check` runs:

- TypeScript typecheck;
- 12 focused suites / 110 tests;
- Electron Vite production build;
- compiled arm64 Phase 0 native-unavailable refusal;
- compiled Phase 1 one-tool, 10-read, service-restart, and provider-restart proof;
- compiled Phase 2 open, semantic, derived-value, window, close, read-only visual, false-success,
  physical-stop, menu-stop, visual-delivery-stop, and generic-stop journeys.

The native protocol fixture counts semantic deliveries. The verifier confirms missing-condition,
physical, menu, pixel, and unsupported paths leave that count unchanged. It then makes a native
action return `outcome:performed` with timed-out/unmatched evidence and requires the logical result
to fail.

Mutation proofs:

1. disabling the evidence predicate changed that performed-only receipt to
   `ok:true/verified:true`; the focused fixture failed exactly at the false-success assertion;
2. changing the shared stop result to `ok:true` made screenshot-freshness, physical/menu/visual/stop,
   and provider-restart refusals fail.

Both mutants were restored. The focused adapter suite and typecheck passed after restoration, and
the full Phase 2 gate had already passed on the restored production implementation.

Machine-readable evidence: `evidence/cu-phase2-local-2026-08-22.json`.

## Acceptance-gate verdict

Now Implemented and locally Measured:

- P3 no longer renders “not requested” for an accepted packaged-native mutation;
- performed-only false success is killed;
- target/window binding, fresh observation, executor, postcondition, and background truth appear in
  each accepted mutation result;
- unsupported semantic, physical, menu, and visual-delivery paths stop before effect;
- Phase 0 fail-closed routing and Phase 1 restart behavior remain green.

Still Target:

- accepted physical delivery through the logical adapter with a foreground lease and independent
  end-state proof;
- accepted menu mutation and visual-recovery mutation behind the same receipt grader;
- programmatic source dispatch;
- real packaged Bimax.app/TCC journeys and broad app corpus;
- x64, fresh-Mac, stable signing/notarization, update, and permission-persistence rows.

## Governing documents

`README.md`, `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`,
`08_ACCEPTANCE_GATES.md`, the Mac Buddy vision,
`21_CU_VERIFIED_GRAND_STACK_AND_IMPLEMENTATION_PLAN.md`,
`competitive/README.md`, `competitive/05_GAP_REGISTER.md`,
`competitive/06_HEAD_TO_HEAD_EVALS.md`, and `competitive/08_SOURCE_LEDGER.md`.
