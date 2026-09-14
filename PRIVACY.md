# Privacy & Data Use

**Short answer: BiMax does not phone home. Nothing about your code, prompts, or usage is sent
to us — there is no "us" endpoint. Everything BiMax records stays on your machine.**

This is verifiable in the source, not just a promise. See "How to verify" below.

## What stays local

- **Telemetry / metrics.** BiMax's only telemetry is a metrics file written to
  `<project>/.breakglass/telemetry/metrics.json` on your own disk
  (`src/telemetry/metrics.ts`). It is never transmitted anywhere.
- **The Mind layer** (epistemic ledger, self-model, drives, exemplars, episodes) is
  machine-local state under `.bimax/` and `.breakglass/` — SQLite and JSON files on your disk.
  These are `.gitignore`d by default.
- **Config and secrets.** Your model API key and settings live in `~/.breakglass/` with the
  token file written `0600` (owner-only).

There is **no analytics SDK** in BiMax — no PostHog, Segment, Amplitude, Mixpanel, or
Sentry-style crash reporting calling out with your data.

## When BiMax uses the network

BiMax makes network requests **only when a tool you invoke needs the network**, and only to the
destination that tool implies:

- **Your model provider** — the OpenAI-compatible endpoint you configured (e.g. NVIDIA, or a
  local/self-hosted model). Your prompts and the code the model needs go here, because that is
  the model doing the work. Point it at a local model and nothing leaves your machine at all.
- **Web search / fetch** — only when you ask (`websearch`, `webfetch`, `@url <…>`).
- **Package lookups** — the npm / PyPI registries, only when you use the `scout` tool.
- **MCP servers** — only the servers you explicitly add.
- **Training monitor** — your configured Weights & Biases endpoint, only if you use it.

If you never invoke a network tool and you point the model at a local endpoint, BiMax makes no
outbound connections.

## What a ⌘2 task can reach

A task started with ⌘2 works in one folder. That folder limits what the task **changes**, not everything it can
**read**:

- **Changes stay in the folder.** File tools refuse paths outside it. Shell commands run in a macOS sandbox that
  refuses writes anywhere except the folder and the shared temporary folders. Deletions go to the Bin, and every
  change asks first.
- **Reads and the network are not limited by the folder.** A command the task runs can read any file your user
  account can read, and it can use the network (sovereign mode denies the network).

So do not rely on a task's folder to keep other files private. A design for limiting reads is in
`docs/product-reset/54_TASK_FOLDER_SCOPE.md`; it is not built.

## Local / self-hosted models

BiMax is provider-agnostic: it talks to any OpenAI-compatible API. Set the base URL to a local
runtime (e.g. an on-machine server) and inference stays entirely on your hardware. There is no
requirement to use any hosted provider.

## How to verify

```sh
# The only telemetry sink is a local file — no fetch/http in the telemetry module:
grep -rnE "fetch|http|axios|posthog|segment|sentry|analytics" src/telemetry/   # → no egress

# Every network call in the engine is a user-invoked tool or your model endpoint:
grep -rnE "fetch\(|https?://" src --include="*.ts" | grep -v __tests__
```
