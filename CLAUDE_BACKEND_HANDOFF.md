# Claude Code Backend Stabilization Handoff

Date: 2026-07-15

## Your role

Own the Bimax engine, provider/model path, streaming protocol producer, security, installer, and
release engineering. The parallel Codex task owns the visual TUI and website. Do not redesign UI or
change frontend styling.

The working tree is already dirty with user work. Do not stash, reset, discard, reformat, or rewrite
unrelated files. Make small scoped commits and report every touched file.

## File ownership boundary

You may change:

- `src/**`
- engine/backend tests under `src/__tests__/**`
- `scripts/**`, `build-release.sh`, `install.sh`, release workflow/config, and release docs
- `site/public/install` only when keeping the deployed installer byte-for-byte aligned with the
  canonical installer
- packaging/signing configuration under `app/` only for signing, notarization, and release integrity

Do not change:

- `tui/**` (Codex owns the new full-screen renderer and presentation-side stream pacing)
- `site/src/**`, `site/src/index.css`, marketing copy, layout, motion, or visual assets
- desktop renderer design/components

If the engine-to-TUI protocol must change, write the proposed event shape and compatibility behavior
in `docs/PROTOCOL_CHANGE_PROPOSAL.md` first. Do not edit the Go consumer until the frontend owner has
accepted it.

## Confirmed production defects

These are measured on the public v1.0.0 installer, not hypothetical.

### P0 — provider credentials are too permissive in the public build

After a clean install and provider setup:

- `~/.breakglass` was mode `0755`.
- `~/.breakglass/.env` was mode `0644`.
- The file contains the user's provider credential.

The owner-only permission fix is merged in source PR #10, but GitHub's public `latest` release remains
v1.0.0. The live website installer therefore still installs the vulnerable build.

Required:

1. Create/migrate `~/.breakglass` to `0700` and `.env` to `0600` on every startup before reading it.
2. Add tests for new creation, existing permissive files, symlinks, failure handling, and non-secret
   logging.
3. Publish the already-merged hardening as v1.0.1 only after the complete release gate passes.
4. Confirm the live `/install` endpoint installs v1.0.1 and the installed modes are correct.

### P0 — short replies do not stream

Observed UI: the spinner runs, then the complete answer appears at once.

Root evidence:

- Historical default at the time of this observation: `stepfun-ai/step-3.7-flash` (now retired;
  current Work/Vision default is `moonshotai/kimi-k3`).
- `src/core/capabilities.ts` marks the Step family `inlineReasoning: true`.
- `ThinkTagFilter` consequently waits for a closing thinking tag.
- A short, tag-free answer never exceeds the preamble cap, so it is released only by `flush()` at
  stream end.
- Example: `Hey! What are we building today?` is shorter than the cap and arrives as one burst.

Required behavior:

- Preserve genuine inline reasoning privacy: no chain-of-thought text may leak into the user reply.
- A tag-free answer must stream from the first confidently-visible delta.
- A model that sometimes reasons and sometimes answers directly needs a bounded hybrid strategy;
  do not encode the current unconditional "wait forever for a closer" behavior.
- Do not solve this with a canned local response for `hi`; fix the general stream contract.
- Emit engine timing points for first raw provider chunk and first visible token so renderer latency
  is separable from provider latency.

Regression tests must cover:

1. Tag-free short answer split across multiple chunks: visible deltas arrive before stream end.
2. Explicit `<think>...</think>` and `<thinking>...</thinking>` blocks: reasoning stays hidden.
3. Opener-less reasoning ending in `</think>`: reasoning stays hidden.
4. Tool call beginning while reasoning is buffered: buffered reasoning is diverted, not displayed.
5. A Step-family turn that emits no thinking tags.
6. A Step-family turn that does emit thinking tags.

### P0 — trivial turns have unacceptable and highly variable latency

Fresh-install session timestamps for the exact prompt `hi`:

| Run | User timestamp | Assistant timestamp | Total |
|---|---:|---:|---:|
| 1 | 12:30:20.317Z | 12:30:32.248Z | 11.9s |
| 2 | 12:33:11.522Z | 12:34:19.282Z | 67.8s |
| 3 | 12:35:57.998Z | 12:36:09.400Z | 11.4s |

Current instrumentation cannot attribute this cleanly, and the current first-token p95 budget is
120 seconds, which allows visibly broken behavior to pass.

Required:

1. Instrument these monotonic timestamps per turn:
   - input received
   - routing complete
   - context assembly complete
   - provider request started
   - first raw provider chunk
   - first visible text token emitted
   - stream complete
2. Persist a bounded, secret-free latency record so `/perf` still explains the previous turn after a
   restart/crash.
3. Separate provider wait from Bimax overhead in `/perf` and logs.
4. Add a true lightweight conversation lane for greetings, acknowledgements, and simple questions.
   It must avoid graph search, vector-memory retrieval, outcome setup, heavyweight tool schemas,
   compression startup, and verification machinery unless the message needs them.
5. Keep coding requests on the full harness. The existing model-tier heuristic is not sufficient:
   when coding and lite models are the same it skips classification but still enters the full agent
   path.
6. Re-evaluate defaults. A fast plain-content model may be a better LITE default while Step remains
   the coding model. Benchmark before changing defaults and preserve explicit user choices.

Performance gates on the chosen launch provider/model:

- Bimax overhead before provider request: p95 <= 250ms for a greeting after engine ready.
- Raw provider chunk -> visible engine token: p95 <= 100ms.
- Greeting total: target p50 <= 5s and p95 <= 15s, with provider time shown separately.
- No hidden classifier model call for a locally obvious greeting.
- A performance gate must fail, not merely report, when these budgets regress.

### P1 — heavyweight startup work and duplicate sidecar

Fresh-install logs show:

- Headroom/Kompress is started and warmed during a greeting.
- A second process reports `address already in use` on `127.0.0.1:8788`.
- Non-repository launches emit repeated `fatal: not a git repository` noise.

Required:

- Make compression lazy: start/warm it only when context pressure actually requires it.
- Implement singleton ownership, health probing, lock cleanup, dynamic-port or reuse behavior, and
  deterministic shutdown. Never race two sidecars for a fixed port.
- Do not run Git commands until repository detection succeeds. Non-repo use must be a supported,
  quiet state.
- Add cold-start and second-process integration tests.

### P1 — macOS trust and installer integrity are incomplete

The owner observed no macOS warning. That is expected for a CLI fetched with `curl`: the flow often
does not receive the same quarantine/Gatekeeper UI path as a browser-downloaded app. Absence of a
warning is not proof of signing or safety.

Current state:

- CLI release archives are checksum-verified, but the checksum is hosted beside the assets.
- The desktop DMG is explicitly unsigned (`identity: null`, `dmg.sign: false`).
- v1.0.1 is not public.

Required:

1. Sign macOS binaries with the correct Developer ID identity and hardened runtime.
2. Use an Apple-supported notarization flow for the actual distributed container, and verify the
   result on a clean Mac. Do not claim notarization merely because `codesign` passes.
3. Sign or attest release artifacts independently of the adjacent checksum file; document the trust
   verification command.
4. Keep SHA-256 verification in the installer, fail closed, and never execute a partially verified
   download.
5. Make the installer transactional: download to temp, verify, atomically replace, preserve the old
   binary on failure, and provide a tested uninstall path that clearly distinguishes executable,
   config, and project data.
6. Publish a concise security/install page for the frontend owner to surface on the website.

## Verification matrix

Before claiming completion, run and include exact results for:

- TypeScript build and focused stream/filter/config tests.
- Full engine test suite.
- Clean temporary-HOME onboarding without printing secrets.
- Permission migration from `0755/0644` to `0700/0600`.
- At least ten measured trivial turns on the selected fast lane.
- Inline-reasoning and tag-free streaming fixtures.
- Two simultaneous engine starts with no sidecar collision.
- Non-git working directory with no fatal Git noise.
- Release artifact checksum plus signature/attestation verification.
- Clean macOS install showing version, signing identity, and notarization assessment.
- Live website installer resolving to the newly published release.

## Deliverables

1. Scoped implementation commits.
2. `docs/BACKEND_STABILIZATION_REPORT.md` with before/after measurements and exact commands.
3. Public v1.0.1 only after all gates pass.
4. A short protocol proposal if the frontend needs new phase/timing events.
5. A final list of known limitations; do not label provider queue time as a Bimax fix.
