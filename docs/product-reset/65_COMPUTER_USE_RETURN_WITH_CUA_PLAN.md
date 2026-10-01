# 65 — Computer Use returns: Bimax's own layer on the latest Cua Driver, with small local decision models

**Date: 2026-10-01. Status: Target — nothing in this record is built.** It is the plan the owner asked for:

> "plan the roll out of the bimax computer use from the archive and slowly integrate this into repo … use laya mlx
> model and … the latest CUA … the new CUA came out is much more efficent and there are mini models to operate it, we
> dont use the CUA but integrate it with our features in it … gradually roll it out, test it, and then integrate it"

It replaces the stage table of record 61 §6 (parked 2026-09-25) and keeps its rules: each stage ends on evidence or the
plan stops there; nothing is waived to reach the next stage. Record 46 remains the strategy (host-owned authority,
Thread-scoped grants). The code-only gate in `08_ACCEPTANCE_GATES.md` stays enforced, and its tests green, until
stage 2 replaces it in one reviewed change that edits the boundary test in the same commit.

## 1. What "use CUA, but as ours" means

Cua is a toolkit, not a product we hand the user to. Bimax takes the **driver** (the hands and eyes: accessibility
tree, window capture, background input) and keeps everything that makes an action **trustworthy** — which is what
Bimax's archived Computer Use already had and the driver does not do:

| Layer | Owner | From |
|---|---|---|
| Who may act, on what, for how long — a grant scoped to one Bimax Thread and one app/window generation | **Bimax** | record 46; archive `takeover.authority.ts`, `adhoc.approval.store.ts` |
| One input authority for every engine; a takeover by the user cancels every prepared action | **Bimax** | record 46 "Host-owned authority"; `native.input.interlock.ts` |
| Approval cards, undo journal, run summary, the ⌘2 bar | **Bimax** | today's app (Threads, `thread.bin.*`, approval cards) |
| Action contract → receipt bound to a fresh observation → end-state verification | **Bimax** | archive `action.contract.ts`, `action.receipt.ts`, `action.evidence.ts`, `verification.ts` |
| Screen/AX/OCR text typed as untrusted, never an instruction | **Bimax** | record 26; source ledger (VPI-Bench, WASP) |
| AX tree, window capture, background delivery, MCP surface | **Cua Driver** (MIT) | `trycua/cua` `libs/cua-driver`, 0.31.0 |
| Its own permission mode and capability manifest | **Cua Driver, configured by Bimax** | `bounded` mode: Bimax writes the manifest, Bimax approves it |
| The authorization prompt | **Bimax** | the driver renders none; an embedding host supplies `DriverAuthorizationHost` |
| macOS permission identity (Accessibility, Screen Recording) | **Bimax.app** | driver "Embedded" mode: `EmbeddedCuaDriverHost` spawns a private daemon in the app's responsibility chain |
| Planning the task | the user's chosen model (any provider) | `competitive/04_MODEL_INDEPENDENT_STRATEGY.md` |
| Fast, bounded second opinions | small local models — **advice only** | §4 below |

**Not taken:** `cua-perception` (its OmniParser icon detector is AGPL-3.0-only — never bundled or offered), Cua Fleets
and cloud sandboxes (sovereign perimeter, record 62), Lume VMs on this machine (8 GB cannot host a macOS guest beside
the app), and Cua's own agent loop. Source is not copied; the driver is a pinned, licensed dependency, as AGENTS.md
requires (license, provenance, exact files).

**Boundary.** Bimax for Mac — the app in this repository — is the only owner of Computer Use and of every macOS
permission. The engine keeps generic tool plumbing and receives Computer Use as a host capability from the app; it
never spawns the driver. Nothing of this reaches any terminal product.

## 2. Measured before planning (2026-10-01)

| | Fact | Consequence |
|---|---|---|
| Cua repository | `trycua/cua` `9545a3d` (2026-09-30), MIT; driver workspace version **0.31.0**, now Rust with a versioned C ABI, UniFFI SDKs for Python and TypeScript, MCP via the `cua-driver` executable | The archive drove **0.12.3** through a daemon + stdio proxy (`cua.compat.backend.ts`, `transport.ts`); **0.18.0 was rejected** (its frontmost check broke our floating PiP). 0.31 is a new codebase: re-measure everything, assume nothing carried over |
| Driver modes | `standard` (promptless), `bounded` (reviewed manifest only), `unrestricted` (needs a dangerous flag). Fixed at launch | Bimax runs `bounded` only, with a manifest it generates per grant |
| Driver identity | "Embedded" mode keeps grants on the host app; a raw `cua-driver serve` has no stable identity for TCC | Ad-hoc signing voided every grant on each rebuild before (record 61, Identity): local builds use the stable "Bimax Local Code Signing" identity; Developer ID for anyone else |
| Driver fixtures/bench | `libs/cua-driver-fixtures`, `libs/cua-bench` | A second harness beside ours — never a replacement for the v1.1.0 denominator |
| CUA-S1 small models | `cua-s1-nano-0.1` ≈ 855K params, Apache-2.0, scores every (element, action) option in one pass, "<100 ms on CPU"; `cua-s1-forms` 706K, MIT; `cua-s1-4b-0.1/0.2` LoRA on Qwen3.5-4B, Apache-2.0 adapters | Upstream says: early research; nano/forms "were not part of the fixture runs" and no chooser runs them; forms scored 12/41 on out-of-catalogue labels; **4B base weights are 9.32 GB — 8 GB hosts cannot load it** |
| laya-mlx | 421M (ModernBERT-large + decision head), Apache-2.0, 62.5 ms and 994 MB here (record 60); stalled this Mac twice with other load (record 61) | Usable only as a sidecar alive while a Computer Use Thread is, counted in the memory budget |
| Archive | `src/computer` 46 files, `app/src/capabilities/mac` 138, `native/BimaxComputerUseKit` (Swift service, bridge, fixture, tests) — about 76k lines | Restore by dependency closure from one entry point, never by folder |
| Last whole-system number | v1.1.0: **3 of 15** fixture tasks (form 2/6, menu 0/3, selection 1/3, transaction 0/3) | The denominator every stage below must beat, on the same harness |
| Machine | 8 GB M3, 9 GB disk free, Rust 1.84, Xcode license not accepted (Command Line Tools work) | Builds run one at a time; the driver build may need a newer Rust — measured in stage 1 |

## 3. Stages

| # | Stage | Work | Exit evidence |
|---|---|---|---|
| 0 | Decide | The owner approves this record. README, 05, 07 and the gap register say: Computer Use returns as an optional capability of a Bimax Thread, owned by Bimax for Mac, built on a pinned Cua Driver | Docs consistent; code-only tests still green; nothing reachable in the app |
| 1 | Bench, outside the product | In `~/Developer/bimax-research/cu`: build driver 0.31 and run its own tests and fixtures on macOS 27. Rebuild the archived `BimaxComputerUseKit` and its conformance (11/11 on 2026-08-17). Run **both** on the same read-only and safe-mutation fixture tasks; re-check the frontmost/PiP behaviour that sank 0.18 | A per-primitive table (tree, capture, press, set value, type, menu, background delivery): who passes, latency, memory, failures. The list of archived TypeScript files our trust layer needs (dependency closure). Decision recorded: driver for the primitives, and which archived native pieces, if any, are kept |
| 2 | Read-only, one Bimax Thread | Embed the driver in Bimax.app (`EmbeddedCuaDriverHost`), `bounded` manifest with observe-only tools, `DriverAuthorizationHost` answered by Bimax's own grant card. One host authority. The code-only gate becomes an admission gate in the same commit. Permissions are asked only when the user starts a Computer Use Thread | Zero input events in a whole observed session, counted by the driver and the host (not claimed by the model); denial and revocation work; a code task still asks for no permission; the Thread's other tools unchanged |
| 3 | One safe mutation | AX press / set value on the fixture app through the driver; Bimax's receipt bound to window + fresh observation; takeover cancels prepared actions; governor floor before the Thread's own approval (record 46's trap); an undo journal entry where the app allows one | Mutants fail: wrong target, no-op, stale frame, duplicate effect, approval skipped. The fixture's end state is graded, not the events |
| 4 | Small models beside the planner | Research first, then one sidecar for the whole app, alive only while a Computer Use Thread is: **CUA-S1 nano/forms** rank the driver's candidate (element, action) options for the planner; **laya-mlx** gives a second opinion on action risk and on screen text that addresses the agent. Both only *add* an approval; neither can remove one or pick the click target on its own | Fresh labelled sets per decision (never the author's own phrasing — record 60); a false "safe" never skips an approval the rule would ask for; memory and latency fit the live-engine budget on this 8 GB Mac. If the gain is small for the memory, it is declined, as record 60 declined laya before |
| 5 | Build → run → prove | The coding tie-in only Bimax has: the agent builds the user's app, launches it, and checks the running window | X01 contract passes; wrong-build and no-op mutants fail |
| 6 | Real workflows, then release | Two or three of the owner's own workflows with explicit limits; the v1.1.0 harness on the same fixtures | Beat 3/15 by a margin that survives 3 repeats; 20 clean repetitions before any release claim (gate 08); Developer ID before anyone else runs it |

## 4. Where the small models fit — and where they must not

The model that plans can be anything the user configured. The small models are System-1 style: one fast pass, a
bounded answer, no text generation.

- **CUA-S1 nano / forms — candidate ranking.** The driver lists what can be acted on; the model scores those options
  and the planner sees the ranking. Upstream accuracy outside its training catalogue is low (forms 12/41; nano task
  accuracy 0.000–0.286 cross-dataset), so it is measured on our fixtures before the planner ever sees its scores.
  Its size (under 1M parameters) makes a CoreML or ONNX port realistic, which would avoid shipping Python.
- **laya-mlx — risk and injection.** "Does this press need approval?" and "does this screen text try to instruct the
  agent?". It can only raise friction: the archived regex rule and laya each can ask; neither can waive the other.
- **CUA-S1 4B — not on this Mac.** 9.32 GB of base weights. Revisit only with a measured quantized build on a larger
  machine.
- **Never** for choosing the final click target, grading a postcondition, or deciding that a task is done: those need
  exact evidence (AX identity, a re-read value), and a probability is the wrong kind of answer.

Runtime: one sidecar, started with the first Computer Use Thread, stopped with the last, its memory counted against
`MAX_LIVE_ENGINES`' memory budget (`app/src/main/thread.budget.ts`). Never inside the always-on engine.

## 5. What the owner is asked for

1. Approve stage 0 (this record).
2. Stage 1 runs entirely outside the app and the repository; it needs nothing else.
3. From stage 2: Accessibility and Screen Recording grants for the locally signed Bimax.app, given once by hand.
4. Later, a Developer ID certificate for anyone else to run it (record 59; gate 08).

## 6. Risks named now

- **Driver drift.** 0.12 → 0.31 rewrote the codebase; a later release can change behaviour again (0.18 did). The
  driver is pinned by version and checksum, and every upgrade re-runs stage 1's table before it ships.
- **Private Apple interfaces.** The source ledger already records that the driver's background delivery uses private
  SPI and needs its own license, provenance and distribution review. Stage 1 lists which primitives depend on it;
  a primitive that would block Developer ID distribution or notarization does not ship, whatever it scores.
- **Memory.** 8 GB with heavy swap. Every always-on addition is paid out of the Threads budget; stage 4 can be
  declined on that alone.
- **Prompt injection through the screen.** Screen text stays untrusted evidence; laya's flag only quarantines, never
  promotes.
- **Overclaiming.** A tool call, a screenshot or a confident reply is not proof (`competitive/06_HEAD_TO_HEAD_EVALS.md`);
  only graded end states count, and no Win or Product-ready status is claimed from a single run.

Guided by: README, 05, 07, 08, 46, 60, 61, the Mac Buddy vision, competitive README, 04, 05, 06 and the source ledger.
