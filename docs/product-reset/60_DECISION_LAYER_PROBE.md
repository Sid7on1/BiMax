# 60 — A Jev-style decision layer: step 1, measured on this Mac

**Date: 2026-09-21. Status: probe only. Nothing in Bimax uses it.**

The owner asked whether two open repositories are "like Jev" and what Bimax could use them for. Jev
(TypeSafe AI, September 2026) is a *System One* model: it takes state plus typed questions (choice, score,
yes/no) and returns calibrated probabilities in one pass, instead of generating text. Developers use it as a
fast decision layer beside an LLM — routing, triage, tool-call guardrails, context compaction, game and
control loops. Jev itself is API-only.

- **bespokelabsai/nimble** — Qwen3.5-9B with a LoRA that scores fixed answers; says it is inspired by Jev.
  About 18 GB unquantized: does not fit this 8 GB Mac.
- **mizorewww/laya-mlx** — an MLX port of Convai Innovations' Laya (ModernBERT-large 395M + a decision head,
  421M; a 322M multilingual variant). Code and weights are Apache-2.0 (Hugging Face `convaiinnovations/laya`).
  Its model card says the base checkpoints are "near chance on typed-decisions zero-shot".

The owner approved a plan whose step 1 was: run laya-mlx here, and measure it against the rule it would
replace before anything ships.

## What was measured

Installed outside the repository (`~/Developer/bimax-research`, Python 3.13, `laya-mlx` 0.1.0, MLX 0.32.2).
Apple M3, 8 GB.

| | Measured here | Upstream claim (M3 Max) |
|---|---|---|
| One call, three questions | **62.5 ms** median, 63.5 ms p95 | 13.4 ms |
| Multilingual 322M, same call | 25.3 ms | 7.4 ms |
| MLX peak memory | **994 MB** | 944 MB |
| Load, cached | 0.8 s | — |

The first decision tested is the plan's 3B: **is a user message a standing instruction** (a rule that should
keep applying — the kind the continuation state loses behind "continue" messages, record 48 F2's limit), a
one-off request, or chatter? Two sets, labelled by the assistant, 40/40/40 and then 20/20/20; the first
includes 23 of the owner's real messages, the second was written after the first run in new phrasing and
changed neither the questions nor the rule. The sets and scripts stay outside the repository because they
quote the owner's own conversations.

| Standing-instruction detection | First set F1 (P / R) | Fresh set F1 (P / R) | 3-way accuracy, first / fresh |
|---|---|---|---|
| Keyword rule | **0.86** (0.97 / 0.78) | 0.33 (1.00 / 0.20) | 86% / 47% |
| laya English, yes/no ≥ 0.5 | 0.75 (0.84 / 0.68) | **0.67 (1.00 / 0.50)** | 71% / 63% |
| laya typed-decisions | 0.77 via choice | 0.71 via choice | 68% / 65% |
| laya multilingual | 0.76 | — | 57% / — |
| Rule OR laya ≥ 0.3 | 0.85 (0.80 / 0.90) | **0.72 (0.81 / 0.65)** | — |

## What it says

- **The rule's first-set lead was the rule fitting the assistant's own phrasing.** On fresh phrasing it found
  one standing instruction in five.
- **Laya generalizes better but zero-shot it is mediocre.** It missed the owner's own real instruction
  ("…please dont harm any work", p = 0.15) and "make sure it works on Python 3.9"; it flagged imperative one-off
  requests ("move the screenshots to a folder called Screens", 0.83). Its choice-question confidence almost
  never passed 0.5 (4% of messages), so confidence gating would route nearly everything to the fallback.
- **The failure mode for 3B is safe.** Pinning an instruction is additive: a miss is today's behaviour, and a
  false alarm keeps a one-off request in view for a few tokens. Chatter was almost never pinned.
- **The cost is not small here.** About 1 GB resident on an 8 GB Mac where one engine is ~227 MB and the
  live-engine budget is computed from free memory. One shared sidecar, loaded on demand and counted in that
  budget, would be the only acceptable shape.
- **laya-mlx cannot train** (`RLAgent` exposes only `forward`, `predict`, `prepare`, `system_one`). Nimble's
  own numbers — 66.4% base to 90.1% after LoRA on 2,676 contrastive examples — are what fine-tuning buys, and
  training is not available through this package.

## Recommendation

Do not ship laya for 3B on these numbers: roughly +0.4 F1 over the rule on fresh phrasing is real, but it
costs 1 GB of an 8 GB machine for one decision. Before choosing, measure the ceiling — run the same 180
messages through Jev (a TypeSafe key, pennies) — and measure the plan's 3A, a local reranker when no key is
configured, against the retrieval benchmark (lexical 0.80 recall@3 / 0.767 MRR; remote rerank 1.00 / 0.900).
