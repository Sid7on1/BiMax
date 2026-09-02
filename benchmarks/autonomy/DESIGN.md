# Autonomy baseline harness

This is a disk-light walking skeleton for measuring unattended, multi-step work. Runs are serial,
fixtures are copied into a fresh temporary workspace, network access is denied to model-driven shell
commands, and the workspace is removed after its deterministic check finishes.

## Task schema

Each task is a self-contained directory containing:

- `task.json`: stable id, `fixture`, `promptFile`, deterministic `successCheck`, and the offline
  trajectory used only to exercise this network-free walking skeleton.
- A fixture directory copied verbatim into the temporary workspace.
- A prompt describing the work without revealing the answer.
- A success check outside the mutable fixture. It is a shell/Node assertion that runs with the
  temporary workspace as `cwd` and exits `0` for success or non-zero for failure.

The success check is the sole grader. V1 never asks an LLM to judge another LLM. Tasks must be
objectively checkable, such as making a fixture test pass or exporting a function whose output can be
asserted by Node. The offline trajectory is not a grader; it replaces the unavailable network model
for this first reproducible pipeline run and is labelled as such in the report.

## Metrics

Every task records `passed`, total prompt tokens, total completion tokens, total tokens, turn count,
wall-clock milliseconds, and `contextRecoveryFired`. Turn count means LLM rounds (calls to `chat()`),
not user messages. Reports also include tool-call count, check exit/output, and whether every round
reported usage.

No engine instrumentation is added. `AgentLoop` already wraps the provider with the episode recorder.
The harness supplies an explicit `RecordingProvider`/`EpisodeWriter`, then reads:

- `LoadedEpisode.calls[].response.usage.prompt` and `.completion`, populated from existing
  `{ type: 'usage' }` stream events, for token totals.
- `LoadedEpisode.calls.length` for turn count and recorded `toolCalls.length` for tool-call count.
- Existing `cliEvents` `log`/`status` text beginning with `Context recovery tier` or
  `Context overflow` for `contextRecoveryFired`.
- Harness timestamps around provision → agent run → deterministic check for wall time.
- The success-check process exit code for pass/fail.

The bundled offline provider estimates its usage events locally with the repository's existing
`gpt-tokenizer`. It is only a deterministic pipeline smoke test: its pass rate and token estimates
are not autonomy measurements. In `--live` mode, the runner constructs the production `LlmAdapter`
through the same `loadConfig`/`buildKeyPool`/`ApiKeyManager` wiring as the CLI. The adapter's existing
API-reported `{ type: 'usage' }` events flow unchanged through `RecordingProvider` into the episode;
the live runner never recomputes those counts with `gpt-tokenizer`.

## Prompt-caching availability for the live baseline

The official baseline now uses `moonshotai/kimi-k3` through NVIDIA's hosted OpenAI-compatible Chat
Completions endpoint. BiMax's request-side caching optimization emits
Anthropic-style `cache_control: { type: "ephemeral" }` breakpoints only when
`caps.promptCaching` is true. The Kimi K3 capability resolves that flag to false, so the live
baseline never enters that path. The NVIDIA Chat Completions contract does not advertise a
client-controlled `cache_control` parameter, and the benchmark's usage chunks expose no cache
read/write or cached-token counters (they currently omit usable completion-token accounting too).

Self-hosted NVIDIA NIM deployments can enable server-side automatic KV-prefix reuse, but that is a
deployment setting rather than a request feature BiMax can safely activate on the hosted endpoint.
Until this provider exposes a supported, measurable cache-control contract, the harness must not
claim prompt-cache savings or force the Anthropic flag. For this baseline, prompt-token cost can
only be reduced by sending fewer turns or less context per turn.

## Reports

Each invocation writes one `run-<timestamp>.json` under `benchmarks/autonomy/results/`. The JSON
contains task-level evidence, median total tokens, and median turns. Live reports additionally contain
the measured completion rate. Offline reports use `mode: "offline-trajectory-smoke"`, record only a
`pipelineSmokePassed` aggregate, and print `PIPELINE SMOKE: ... (scripted trajectory — NOT an autonomy
measure)` instead of a completion rate. Run the deterministic pipeline smoke with:

```sh
npx tsx benchmarks/autonomy/run.ts benchmarks/autonomy/tasks/01-order-summary
```

Run the same fixture and deterministic grader against the normally configured live model with:

```sh
npx tsx benchmarks/autonomy/run.ts --live benchmarks/autonomy/tasks/01-order-summary
```

`BIMAX_AUTONOMY_LIVE=1` is equivalent to `--live`. Live mode loads the standard BiMax global/project
configuration and provider-key environment, uses a hard ceiling of 40 model rounds, and writes
`mode: "live"`. It performs one run only: a failed deterministic check is reported as failure without
automatic task reruns or result selection.

Run every task directory in sorted, strictly serial order with:

```sh
npx tsx benchmarks/autonomy/run.ts --suite
```

Suite mode gives each task its own provisioned temporary workspace and teardown boundary. A task
crash becomes a recorded failure and does not prevent later tasks from running. One report contains
the per-task results plus median tokens, median turns, summed total tokens, and context-recovery rate.
Live suite reports also include completion rate; offline suite reports retain only the explicitly
scripted pipeline-smoke framing. `--live` or `BIMAX_AUTONOMY_LIVE=1` applies once to the whole suite,
with one production provider instance reused serially across its tasks.
