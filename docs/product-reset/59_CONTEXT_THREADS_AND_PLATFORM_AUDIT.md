# 59 — Context, RAG, Threads and platform: audit and repairs

**Date: 2026-09-20.** Commissioned by the owner in one request: analyse the context and RAG
pipelines, look at CPU/GPU utilisation, make Bimax more macOS-developer-friendly via App Intents,
make Bimax Threads faster and better, and explain two symptoms seen in real use —

> "bimax's context window is breaking in long runs"
> "the responses had a random sequence of alphabets … those are to format text bold/underline but
> it's outputting it as pure text, render isn't working"

Both turned out to be real, both are fixed, and **neither was where it looked**. The formatting one
was not a renderer bug at all.

Guided by records [47](47_RAG_AND_CONTEXT_COMPILER_UPGRADE.md),
[50](50_CONTEXT_COMPILER_BUILD_PLAN.md), [51](51_CONTEXT_UPGRADE_AUDIT.md),
[56](56_APPLE_PLATFORM_AND_PERFORMANCE_PLAN.md), [57](57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md) and
[58](58_RETIREMENT_AND_BACKEND_PLAN.md).

---

## 1. The long-run context defect (D9) — the window was decorative

**Reproduced, then fixed.** One identical 150-round session, four window sizes, measured through
the real `ContextManager.checkAndCompact` ladder:

| configured window | final tokens | window used | snips | summarizer calls |
|---|---|---|---|---|
| 32,000 | 9,660 | 30.2% | 5 | 0 |
| 128,000 | 52,143 | 40.7% | 5 | 0 |
| 200,000 | 52,143 | **26.1%** | 5 | 0 |
| 1,000,000 | 52,143 | **5.2%** | 5 | 0 |

A **31× range of windows produced one identical session.** Three of the four land on the same
52,143 tokens to the byte.

### Why

`snip()` — documented in its own comment as "a blunt guard for runaway sessions" — triggers on a
**message count** (100, keep the last 60) and consults no token pressure at all. It also runs
*before* the token-driven layers in `checkAndCompact`. So on any session past 100 messages it fired
first, every time, and the ladder beneath it never got a turn:

- `capToolResults` never capped,
- `microCompact` (≥50%) never stubbed,
- `compact()` — **the only pass that writes the Goal / Progress / Key Decisions / Next Steps note
  that carries a task across a compaction** — was never called once in any of the four runs.

On a 1M-window model that is ~205 messages discarded to stay inside 5% of what the user is paying
for. From the outside: roughly 41 messages vanish every ~20 rounds and the model loses the thread,
on a window that is three-quarters empty. That is exactly the reported symptom.

### Fixed

The count now only *nominates* a session; pressure decides. Below `SNIP_PRESSURE = 0.85` the ladder
designed to preserve meaning gets first refusal, and snip is the last resort its name claims —
above `COMPACT_THRESHOLD` (0.70) on purpose, so summarizing is always tried first. A separate
`SNIP_HARD_MESSAGES` ceiling still catches the degenerate shape the guard was written for:
thousands of tiny messages that never accumulate tokens but do cost per-request overhead.

Both are fractions of the window, so neither is a pinned token count
(`bimax-perf-constants-pinned-by-tests`).

## 2. The summarizer prompt was unbounded, and goes to the *lite* model (D10)

Found while fixing D9, and **made live by fixing it** — which is why it is here and not filed for
later.

`compact()` serialized the entire backlog with `JSON.stringify(olderForSummary)` and sent it with
`{ lite: true }`. The backlog is, by construction, ~70% of the **main** model's window. Pairing a
200k main model with a 32k lite model is an ordinary, supported configuration, and it would have
failed *every* compaction on a long session — after which the `catch` replaced the whole narrative
with one line:

```
summaryText = '[Older conversation history dropped due to context limits]'
```

Before D9 was fixed this was unreachable, because `compact()` never ran. It is reachable now.

**Fixed.** `boundSummaryInput()` keeps whole messages from **both ends** — the goal and the original
constraints are at one end, what was just done and what is next at the other — and elides the middle
with a parseable marker saying how many messages are missing. Under the limit it is byte-identical
to `JSON.stringify`. An overflow now gets one retry at a quarter budget before anything is given up,
and the continuation state still holds the user's words, the commands run and the assistant's claims
verbatim either way, so a failure is the loss of the *narrative*, not of the facts.

The bound is sized for the smallest model anyone would sensibly route `lite` to, **not** for the
main window — the main window says nothing about the lite model's.

## 3. The "random letters" were ANSI escapes, not a renderer bug (D11)

The desktop renderer was not at fault. Every assistant message in both surfaces already goes through
`<Markdown>` (`Transcript.tsx` ×4, `ThreadSurfaces.tsx` ×2), and that component is sound.

Two real defects, upstream of it:

**a. Nothing asked child processes not to emit colour.** Only `relatedtests.tool.ts` set
`FORCE_COLOR: '0'`; `BashTool` — the tool that runs everything else — set nothing and stripped
nothing. So every coloured `npm test`, `eslint`, `cargo` or `git` wrote raw SGR escapes straight
into the tool result and from there into the model's context, as tokens that carry no meaning. A
weak model (this machine is configured to `openai/gpt-oss-20b`) then echoes them back. **The ESC
byte is invisible in a DOM text node**, so `\u001b[1m` renders on screen as the bare letters `[1m`
— and `[1m` *is* bold, `[4m` *is* underline, exactly as the owner guessed.

Fixed: `BashTool` now sets `NO_COLOR` / `FORCE_COLOR=0` / `CLICOLOR=0` (which also overrides a
`FORCE_COLOR` inherited from the parent) and strips escapes from both its success and failure output
paths. `TERM` is deliberately **not** set to `dumb`: it would add almost nothing here and breaks
build scripts that call `tput`.

**b. The compressor's ANSI pattern matched ordinary text.** In `headroom.compress.ts`:

```js
const ANSI = /\u001b?\[[0-9;]*[A-Za-z]/g;   // the escape byte was OPTIONAL
```

With the ESC optional this matches any `[`, digits, a letter. Measured against real strings:

| input | became |
|---|---|
| `See [Read the docs](https://x) for more.` | `See ead the docs](https://x) for more.` |
| `- [x] ship it` | `- ] ship it` |
| `const a: string[] = []; a[i] = 1;` | `const a: string[] = []; a] = 1;` |

It silently rewrote tool results the model then reasoned against. It runs only above the 70%
compaction threshold, so it corrupted long sessions and left short ones alone — the hardest version
of this bug to notice, and a second, independent way a long run degraded. `skipCode` limited the
blast radius to non-code output (documentation, logs, markdown), not to nothing.

Fixed: the escape byte is required.

## 4. Bimax Threads — make-room eviction (D12)

`ThreadManager.start()`'s eviction runs on **every ⌘2 start once the machine is at its live-engine
cap**. It had drifted from its sibling `reapIdleEngines`, which is careful about the same decision.
Three defects in four lines:

- `.find()` takes the first record in **Map insertion order** — the oldest-*created* Thread, not the
  least recently used. Alternating between two Threads evicted the one just used and kept the one
  abandoned an hour ago, so every switch cost a ~350 ms restart. `ensureRoom()` next door was
  already sorting by `updatedAt` correctly; the two policies simply disagreed, and the one on the
  hot path was wrong.
- `stop(id)` with no options leaves `keepInputs` falsy, and `stop()` then does `r.inputs = []` —
  **silently destroying every queued message on the victim.** A Thread can be `idle` and still hold
  queued work: a turn has settled but the pump has not dispatched the next message yet.
- It applied none of the other guards `reapIdleEngines` uses, so it could stop a Thread visible in
  the ⌘2 bar or one holding an approval waiting on the user.

Fixed: one `reclaimableEngines(now, ttlMs)` predicate serves both callers, ordered least-recently-
used, differing only in whether an age is required. When nothing is safely reclaimable it refuses
with the existing message rather than evicting anyway.

**`MAX_LIVE_ENGINES` is untouched.** Boot was already as fast as record 55 left it: the measured 22%
`NODE_COMPILE_CACHE` win is wired in production (`engine.ts:269`, `:416`), verified this session.

## 5. App Intents — the gate, before the thing it gates (WP-9)

Record 57's order is explicit and was followed.

**Step 1 — Shortcuts, documented.** `bimax://task` was already implemented and already registered;
it had simply never been written down. `docs/SHORTCUTS_AND_AUTOMATION.md` covers Shortcuts, Raycast,
Stream Deck, Folder Actions and cron, as the **interim** story with the App Intents rows marked
Target. Every safety claim was checked against the code rather than the comments: the confirmation's
`defaultId` and `cancelId` both point at Cancel, and the folder is re-refused after `realpath`.

**Step 2 — the packaging gate.** `app/scripts/check-app-actions.mjs` inspects a real `.app` on disk
and asserts the `bimax` URL scheme is registered, that any embedded `.appex` carries its
`Metadata.appintents`, and that the engine is in `Contents/Resources`. It **fails rather than skips**
when it cannot find a bundle — the previous packaging guard degraded to a skip, and a skip is
indistinguishable from a pass (`bimax-packaging-guard-is-dead`, third recurrence;
`bimax-packaged-artifact-untested`).

Verified against `/Applications/Bimax.app` (passes) and three mutants, all killed: no scheme + no
engine; an `.appex` without metadata (the exact WP-9 failure shape); the same bundle with metadata
restored. Wired into all three `dist:mac*` scripts and declared in `.bimax/gates.json`, so `/gates`
now reports packaging as guarded.

**Step 3 — BUILT, and blocked on a Developer ID.** `native/intents/BimaxIntents.swift` →
`Contents/Extensions/BimaxIntents.appex`. Two intents and five Siri phrases, verified present in
the generated metadata, packaged into a real build that passes the gate.

It does not REGISTER. macOS creates no container for it on a self-signed build, and every
registered third-party App Intents extension on this Mac is namespaced `<TeamID>.<bundle-id>` in
`~/Library/Application Scripts/`. Our local identity has `TeamIdentifier` *not set*. Leading
explanation, not proven — confirm with one Developer ID-signed build. **The consequence is a
product fact: Developer ID is a prerequisite for Siri, not only for Gatekeeper.**

Two silent failures were hit building it, both now guarded by
`app/src/__tests__/app.intents.build.test.ts`:

- `-emit-const-values-path` is **ignored without `-wmo`** — swiftc accepts the flag, exits 0 and
  writes no file, after which the metadata processor exports nothing;
- an ExtensionKit extension in `Contents/PlugIns` is **never registered**; it belongs in
  `Contents/Extensions`. The step-2 gate caught this one, which is the order working as intended.

A third mistake was mine and is worth recording: I first concluded the extension was undiscovered
from `lsregister -dump`'s `Intents:` field showing 0. **That field is the old SiriKit one** —
Ghostty ships App Intents and also shows 0. The instrument was wrong, not the build.

## 6. CPU and GPU — WP-6 is NOT closed

`scripts/capture-cpu-baseline.sh` splits the capture by privilege. Tier 1 (per-process CPU%,
CPU-seconds, peak RSS) runs with no root. Tier 2 — the P/E core split, package watts and per-frame
compositor cost — is **printed as exact commands, not run**, because both are unavailable here:
`powermetrics` answers *"powermetrics must be invoked as the superuser"*, and Instruments needs the
Xcode GUI.

So the WP-6 measurement appendix does not exist yet and **WP-7 (sub-agent worker QoS) stays gated on
it**, per record 57's rule that no perf constant is written before it lands. What landed is the
repeatable half, so one `sudo` run closes it.

For the appendix when it is written: **Apple M3, 8 cores = 4 performance + 4 efficiency, 8 GB,
macOS 27.0 (26A428).**

## 7. RAG pipeline — no defect found

Inspected `fusion.ts`, `rerank.ts`, `chunking.ts`, `bm25.ts`, `embeddings.ts`, `vector.store.ts`,
`recall.ts`, `sufficiency.ts` and `composer.tool.ts`. The retrieval half is in good shape and its
design decisions are documented where they are made: RRF over rank rather than score (with the
reason min-max normalization is worse than it looks), agreement-before-id tie-breaking, a
cross-encoder last over a broad cheap candidate set, and a missing retriever contributing nothing
rather than an imputed rank.

Measured this session: `recall@3` 0.80 lexical → 1.00 hybrid → 1.00 reranked; MRR 0.767 → 0.844 →
0.900. Context benchmark v3 **42/42**.

**The one structural risk is not a bug:** dense embeddings and reranking are **remote** and need a
key for the configured retrieval provider. Without one the pipeline degrades to lexical-only BM25 —
the 0.80 / 0.767 column. That degradation *is* surfaced through `reportCapability` rather than
hidden, which is the right behaviour. A key is present on this machine, so both stages are live
here.

---

## Verification that actually ran

| | |
|---|---|
| jest | **2,975 passed**, 323 suites, 17 skipped, 0 failed |
| bun retrieval (`test:bun`) | **125 passed** |
| context (`test:context`) | **62 passed** |
| context benchmark v3 | **42/42** |
| app typecheck | clean |
| engine bundle | 1,565 modules, 21.84 MB, clean |
| packaging gate | passes on the installed app; **3 mutants killed** |
| Threads eviction | 5 new tests; **4 of 5 fail** when `start()` is reverted |

An earlier full run showed one failure, `extract.layout.routing.test.ts`. It passes alone in 7.9 s
against a 5 s per-test timeout — the known worker-contention flake
(`bimax-jest-worker-contention`), not a regression. It passed on the final run.

## Still Target / unmeasured

- **WP-6** CPU/GPU baseline — blocked on root and the Xcode GUI. **WP-7** QoS stays gated on it.
- **WP-9 registration** — the extension is built and packaged, entity schemas included; macOS
  does not register it on a self-signed build. The feature ships ready, not live.
- **The evidence store is not contributed as an entity.** Threads and the undo journal are.
- **WP-5** glass rungs and **WP-10** MLX — untouched, still gated on WP-6 / WP-8.
- **No live-provider run.** Every number here is deterministic and local. The ANSI fix in particular
  is proven at the tool boundary, not by observing a live model stop echoing escapes.
- **The installed app was not rebuilt**, so the Threads and packaging changes are verified in source
  and in tests, not in a running `Bimax.app`.
- `MAX_LIVE_ENGINES` and every other perf constant are unchanged.
