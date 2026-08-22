# Computer Use Phase 7 — optional local AI, rehearsal and training gates

Status: **capability/evaluation/safety policy Implemented and deterministically Measured,
2026-08-23.** No Foundation Models or FastVLM/MLX worker is active in production, no device corpus
has been measured, and fine-tuning has not begun. This is a Research Target, not Product-ready AI.

## Result

`app/src/capabilities/mac/optional.local.ai.ts` makes the deterministic controller an always-
available, complete base capability. Optional candidates are admitted only from host facts supplied
by an app-owned probe:

- Foundation Models requires macOS 26 or newer, a linked optional bridge, system-model availability
  and locale support;
- FastVLM/MLX requires macOS on Apple silicon, an isolated MLX worker and a digest-bound artifact.

One frozen evaluation contract compares deterministic baseline, Foundation Models and FastVLM/MLX
on quality, safety, failure rate, cold/warm p95 latency, peak memory, energy proxy, model size and
repetitions. An unavailable or over-budget candidate cannot be selected, and a failing baseline
cannot be hidden by an optional model.

High-risk rehearsal is only an additional check. Deterministic refusal always stops; when rehearsal
is enabled, unavailable, abstaining or disagreeing optional output also stops. Disabling the
optional feature restores the complete deterministic base, so older/ineligible Macs retain CU.

Fine-tuning admission is separately blocked unless explicit dataset consent, redaction, training-
compatible licensing, a valid dataset digest and a predeclared sufficient receipt count all pass.
Raw screens or typed content make the dataset ineligible.

## Local gate

`npm run cu:phase7:check` inherits Phase 0–6, runs the optional-AI policy suite, typechecks and builds
the Desktop app. Deterministic fixtures cover macOS 13 and 26/27 host states, unavailable and
over-budget candidates, unsafe evaluations, every rehearsal disagreement/refusal branch, complete
base behavior with optional models removed, and fine-tuning denial/eligibility.

## Acceptance-gate verdict

Now Implemented/locally Measured: capability-policy logic, common evaluation schema, non-authorizing
rehearsal and dataset-readiness gate.

Still Target: a native Swift Foundation Models availability bridge, supported-language/session
handling, isolated FastVLM/MLX worker artifacts, frozen receipted device corpus, actual quality and
resource measurements, model-version regression handling, explicit opt-in UX, production
rehearsal integration, dataset review and all training. No model quality or speed claim is made.

Apple's current documentation says `SystemLanguageModel` spans macOS 26.0–26.4 and macOS 27 model
versions and requires runtime availability checking because device, region and readiness vary. That
is why an OS version check alone is deliberately insufficient here.

## Independent verification and hardening (2026-08-23, second reviewer)

The non-authorizing rehearsal property was proven load-bearing by mutation: removing the
deterministic-refusal short-circuit let rehearsal authorize an action the deterministic policy had
refused; the focused suite killed it immediately, and restoring returned green with byte-identical
source. The fine-tuning readiness gate (consent, redaction, license, digest, corpus size) was read
line-by-line against the documented denials and matches.

Governing documents: `README.md`, `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`,
`08_ACCEPTANCE_GATES.md`, the Mac Buddy vision, the grand-stack plan, Phase 0–6 records, competitive
model strategy/gap/eval/source records, and Apple's Foundation Models documentation.
