# 61 — Context fix, an on-device reranker, laya as a reranker, and a parked Computer Use plan

**Date: 2026-09-25. Commits `699af81`, `0f30ed6`, `e1c0be5` on `feat/sovereign-retrieval-and-layout-extraction`.**
The owner asked for more advanced context and RAG, a look at how useful laya-mlx is, and a plan to bring Computer Use
back. The owner then stopped the laya benchmark (it stalled twice on this 8 GB Mac) and parked Computer Use for later.

## 1. Baseline before any change

jest 3,215 passed / 0 failed (356 suites), `test:context` 62, `test:bun` 125, context benchmark v3 42/42. Nothing was red.

## 2. Context fix — acknowledgements no longer evict instructions (`699af81`)

Record 48 F2's open limit, reproduced: the continuation state keeps the task plus the ten newest user messages, so
twelve different replies like "ok", "go on", "thanks!" archived "Never modify package.json." while keeping "oky".
Past the cap, the oldest reply made only of acknowledgement words (a closed list, ≤ 40 characters) now gives up its
place first; the newest message never does while another can. Test written first and failing; three mutants fail it.
`test:context` 63/63, benchmark 42/42.

## 3. RAG — an on-device reranker, built and switched off (`0f30ed6`)

**Found:** no search was being reranked. The live account's rerank function answers 404 for every model
(`settings.ts`, measured 2026-09-12), keyless installs have no reranker, and code search reranks only with remote
consent. Record 59's "1.00 reranked" is a stand-in cross-encoder in the unit test, not a live figure.

**Built:** `LocalReranker` (ms-marco-MiniLM-L6-v2, int8 ONNX, 23 MB, Apache-2.0, pinned `233902d`) on
onnxruntime-web's WebAssembly build; a WordPiece tokenizer matching Hugging Face on 301/301 pairs; a `Reranker`
interface and `ChainedReranker` (remote first, local when remote cannot answer). Verified bundled and under Node with
`node_modules` hidden — the installed app's shape.

**Measured, and why it is off:**

| Bimax labelled set, 15 queries, BM25 candidates | recall@3 | MRR@10 | cost per passage | resident memory |
|---|---|---|---|---|
| BM25 alone (today, keyless) | 0.80 | 0.811 | — | — |
| MiniLM-L6 int8, raw order | 0.93 | 0.844 | 2.5 ms (Python ORT) | **~240 MB loaded (WASM, in Node)** |
| MiniLM-L6 int8, through the store's guard fusion (as shipped) | 0.87 | 0.822 | | |
| mxbai-rerank-xsmall, guarded | 1.00 | 0.900 | 7.8 ms | not measured; needs a DeBERTa tokenizer in JS |
| laya-mlx yes/no, raw | 0.93 | 0.911 | **~108 ms** | **~1.1 GB** |
| all-minilm dense (Ollama, 45 MB) + BM25, RRF | 1.00 | 0.878 | 6 ms per query embed | Ollama process |

Fifteen queries cannot separate these; the 300-query BEIR SciFact run was stopped by the owner after two stalls
(swap reached 8 GB with laya resident; MLX blocked in `CommandEncoder`). So `BIMAX_LOCAL_RERANK=1` turns the reranker
on (and stages the model at build), and nothing else does. The same rule declined laya in record 60: a small,
unconfirmed gain does not buy a large share of 8 GB. MiniLM also rated a passage that merely repeated the query's
words above the answering one in a spot check — a known MS MARCO weakness the guard fusion limits but does not remove.

**Next, if retrieval is picked up again:** run the SciFact comparison one model per process (the scripts in
`~/Developer/bimax-research/rerank` checkpoint every 20 queries now); a local embedding lane is the stronger candidate
on the small set (hybrid recall@3 1.00 with a 45 MB model) and needs its own memory measurement.

## 4. laya-mlx — verdict so far

- Reranking: best MRR on the 15-query set, but ~40× slower than MiniLM, ~1.1 GB, Python + MLX only (no path into the
  JavaScript engine), and it stalled the machine. **Not for the always-on engine.**
- Standing-instruction detection: record 60, not shipped; §2 above fixes the concrete failure without a model.
- Computer Use decisions (action risk, screen-text injection): sets, rules and prompts are written
  (`~/Developer/bimax-research/cu_decisions.py`, including the archived `action.impact.ts` rule verbatim) but **not
  run**. That run belongs to Computer Use stage 4 below.

## 5. FL11 (`e1c0be5`)

Talking continues with the ⌘2 bar hidden, shown and stopped from the menu bar. See backlog 48.

## 6. The Computer Use return plan — parked by the owner on 2026-09-25

> **Superseded 2026-10-01 by [record 65](65_COMPUTER_USE_RETURN_WITH_CUA_PLAN.md)**, which keeps these stages' rules and
> rebuilds them on Cua Driver 0.31 and CUA-S1. The facts below are kept as measured on 2026-09-25.

**Status: Target. Nothing in this section is built.** The code-only boundary (record 30, gate "Code-only product
gate") stays enforced, and its tests stay green, until stage 2 below replaces it in one reviewed change that edits the
boundary test in the same commit. Record 46 is the strategy this plan executes; it is not repeated here.

### What is being brought back, measured before the plan

| | Fact | Consequence |
|---|---|---|
| Archive | `~/Developer/bimax-archive`: `src/computer` 46 files / 19,051 lines, `app/src/capabilities/mac` 138 / 37,579, `native/` Swift 38 / 19,350 (a self-contained `BimaxComputerUseKit` package with service, bridge, fixture and its own tests) | ~76k lines. Restore by dependency closure from one entry point, never by folder |
| Last whole-system number | v1.1.0 baseline: **3 of 15** fixture tasks completed (form 2/6, menu 0/3, selection 1/3, transaction 0/3), compatibility backend, one VL model | This is the denominator every stage below must beat, on the same harness |
| Last native number | Packaged conformance 11/11, 15 semantic actions verified live, 0 overclaimed; M02 9/0 (2026-08-17) | The native layer worked; the loop around it did not |
| Identity | TCC grants follow the signing requirement. Ad-hoc signing voided them on every rebuild; Developer ID is also what registers App Intents (record 59) | Stage 1 cannot be qualified on an ad-hoc build. Self-signed stable identity is enough for local; Developer ID for anyone else |
| Machine | 8 GB M3. One engine ≈ 227 MB; the live-engine cap is computed from free memory | Every always-on addition is paid out of the Threads budget |
| Safety rule shipped before | `action.impact.ts`: one regex over the action and its arguments (`submit|send|…|delete|…`) | It never reads the dialog: "OK" on "permanently erase the Trash" contains no listed word (by inspection; the §4 study was not run) |

### Stages

Each stage names its exit evidence. A stage that cannot show its evidence stops the plan there; it does not get
waived to reach the next one.

| # | Stage | Work | Exit evidence |
|---|---|---|---|
| 0 | Decide and reconcile | Owner approves this plan. README, 05, 07, 08 and the gap register state "CU returns as an optional capability of a Bimax Thread, Desktop-owned"; the code-only gate is marked as the thing stage 2 replaces | Docs consistent; code-only tests still green; no capability reachable |
| 1 | Native kit builds again | Build `BimaxComputerUseKit` from the archive against the current SDK **outside the product** (no `git mv` yet); run `bimax-cu-tests` and the fixture conformance | Conformance ≥ the 11/11 of 2026-08-17 on this macOS (27); a list of every archived file the service's dependency closure actually needs |
| 2 | Read-only, one Thread | Move only that closure into the repo. Host-issued, Thread-scoped grant; one Desktop authority for input across all engines (record 46 "Host-owned authority"); observe AX tree + one window capture. Replace the code-only gate with an admission gate in the same commit | Zero input events in a whole observed session (counted by the service, not claimed by the model); denial and revocation paths; the Thread's other tools unchanged |
| 3 | One safe mutation | AX press/set on the fixture app; receipts bound to window + fresh observation; takeover invalidates prepared actions; governor floor ordered before thread approval (record 46's trap) | M02 mutants fail (wrong target, no-op, stale frame, duplicate effect); fixture end state graded, not events |
| 4 | Decisions beside the model | The fast checks in §4 of this record, wired as **advice to the approval gate, never as authority**: action risk and screen-text injection | Measured on a fresh labelled set per decision; a false "safe" never skips an approval the rule would have asked for |
| 5 | Build → run → prove (X01) | Link the edited build to the launched PID/window and grade the GUI result | X01 contract passes; wrong-build and no-op mutants fail |
| 6 | Owner's app packs | Two or three workflows picked from real use, with explicit delivery boundaries | The v1.1.0 harness, same fixtures: beat 3/15 by a margin that survives 3 repeats; 20 clean repetitions before any release claim (gate 08) |

### Where laya (or a small decision model) fits — and where it must not

Only as a second opinion that can **add** friction, never remove it:

- **Action risk.** If the rule or the model says "needs approval", ask. Neither can waive the other's "ask". This is
  the shape that keeps a false "safe" from the model harmless.
- **Screen text that addresses the agent.** Flag and quarantine the text in the observation (it is already typed
  untrusted, record 26); never let a "clean" verdict promote screen text to an instruction.
- **Not** for choosing the click target, grading a postcondition, or routing a task into CU: those need exact
  evidence (AX identity, a re-read value), and a probability is the wrong kind of answer.

Runtime shape: one sidecar for the whole app, started only while a CU Thread is live, counted in the live-engine
memory budget, stopped when the last CU Thread ends. Never in the always-on engine.

## Verification that ran

jest 3,222 passed / 0 failed (after the reranker; FL11 added its own test afterwards, talk and voice suites 37/37);
`test:bun` 127; `test:context` 63; context benchmark 42/42; engine `tsc --noEmit` and app typecheck clean; engine
built both ways (22 MB default, 59 MB with `BIMAX_LOCAL_RERANK=1`); packaging boundary test passes (the model is
pulled by `stage-local-rerank.sh`, never by the engine build). Not run: the installed app, a live provider, SciFact,
the CU decision study.

Guided by: README, 08 (gates), 30, 46, 47, 48, 50, 51, 59, 60; competitive README and 05.
