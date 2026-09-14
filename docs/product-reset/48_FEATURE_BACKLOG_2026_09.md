# 48 — Feature backlog, September 2026

**Status: Target. None of this is built.** Collected on 2026-09-14 and marked by the owner as the next major
build, starting 2026-09-15.

Sources: the Claude Code session that shipped talk mode (automation, results, context and voice suggestions), plus
three research write-ups pasted into that session: "Bimax Missions", "app superpowers and muscle memory", and
"edit the outcome". The ratings are that session's judgement against the code at commit `0dc3a6e`. They are
proposals, not measurements.

**Merged later on 2026-09-14:** the open items from three records that were written into the stale
`~/Desktop/Bimax` copy and are now copied here: [46](46_COMPUTER_USE_RETURN_AND_THREADS_STRATEGY.md) (Threads audit
and a Computer Use return), [47](47_RAG_AND_CONTEXT_COMPILER_UPGRADE.md) (RAG and a context compiler) and
[49](49_CHAT_TOOL_ISOLATION_RECORD.md) (a chat and tool cancellation fix that was never ported). Items from them
carry those records' finding IDs (T01–T06, A01–A08).

## Verdicts

| Verdict | Meaning |
|---|---|
| **Must** | A foundation. Anything that runs unattended is unsafe to promise without it. |
| **Next** | Small, fits today's code, clear value. Days. |
| **Flagship** | A big visible step that builds on foundations. Weeks. |
| **Later** | Valuable, but needs a foundation or a narrower first version first. |
| **Parked** | Needs Computer Use, which is archived under the code-only reset, or is research. |

Each item lists **Value** (high, medium, low), **Effort** (S: days, M: 1–2 weeks, L: several weeks) and what it **Needs**.

## Facts the ratings rest on (checked 2026-09-14)

- **An engine restart drops queued messages.** `ThreadManager.lifecycle()` clears `r.queue` on
  `failed`, `exited`, `restarting` and `stopping` (`app/src/main/thread.manager.ts`).
- **Scheduled ⌘2 tasks are time-only:** `Cadence = 'daily' | 'weekdays' | 'weekly'` (`app/src/main/schedules.ts`).
- **Missing from `app/src`:** a `bimax://` URL scheme, Shortcuts actions, a Finder Quick Action, conversation
  export, screen capture, calendar and mail.
- **Undo:** the ⌘2 bar's Undo offers only the newest change, while `thread.undo.ts` journals every change.
- **Cost:** Bimax records measured turn time per model (`settings.modelTimes`) but shows no cost. The engine
  has its own hard spend cap (`docs/FEATURES.md`).
- **Existing building blocks:**
  - sub-agent worktree isolation (ROADMAP, INFRA P1–3)
  - the evidence store (`app/src/main/evidence.store.ts`)
  - read-only workflow dependency evidence (`42_WORKFLOW_EVIDENCE_RECORD.md`; continuous watching is still Target)
  - the embedded browser, plus the puppeteer UI harness (`app/scripts/ui`)
- **Archived:** Computer Use and the Go TUI moved to `~/Developer/bimax-archive` on 2026-09-06
  (`30_CODE_ONLY_AGENTIC_IDE_RESET_RECORD.md`).
- **This Mac has 8 GB of RAM.** Features that run several builds or browsers at once must budget for that.
- **Talk mode's `openai/gpt-oss-20b`:** time from question to speech ranged 1.3–17 s across test runs, and once
  the model called a tool named `AskUserTool<|channel|>commentary`.
- **Records 46 and 47 audited the older Desktop copy.** Checked against this repository:
  - T01 and T03 still hold. `lifecycle()` empties the queue on failure and does not clear `r.engine`, `start()`
    returns early while `r.engine` is set, and `thread.storage.ts` never mentions the queue.
  - T05 still applies: `app/src/main/thread.storage.ts` is byte-identical to the audited file.
  - T02, T04 and T06 were not re-checked.
  - A01–A08: `pagerank.ts`, `context.planner.ts`, `bm25.ts`, `headroom.compress.ts`, `file-state-cache.ts` and
    `context.manager.ts` are byte-identical to the audited files. `recall.ts`, `code.index.ts`, `vector.store.ts`
    and `sqlite.code.store.ts` changed here only for capability notices and the state directory.
  - The eight A probes were rerun here on 2026-09-14 and **all eight still reproduce**
    (`competitive/evidence/2026-09-14-context-audit/rerun-results-in-bimax.json`). The T probes were not rerun.
- **Record 49's fix is not in this repository.** In the Desktop copy, `headless.session.ts`, `host.ts` and
  `meta.ts` match the record's hashes exactly; here none of them has its edits.

## Start here on 2026-09-15

**The owner decided on 2026-09-14: the RAG upgrade comes first, then the other features.**

1. **C0–C1:** record 50 steps 1–5: acceptance tests and fixes for all eight defects A01–A08 (steps 1–3, C0, done 2026-09-14), then a
   repaired baseline, and the evidence foundation.
2. **F8:** port the chat and tool cancellation fix from record 49. Record 50's step 6 edits the same files
   (`agent.loop.ts`, `base.persona.ts`), so the port has to land first.
3. **C2–C4:** record 50 steps 6–8.
4. **F1:** queued messages survive an engine restart and an app reload (T01).
5. **Q1–Q4:** the quick fixes, about an hour together.
6. **F9–F12:** the Threads reliability defects T02–T05.
7. **N1:** approve from the notification.
8. **N2:** `bimax://` links and Shortcuts actions.
9. **FL1:** write the folder-trigger design (events, loop protection, undo, limits) before any code.

---

## Foundations: Must

**F1. Queued messages survive an engine restart and a reload (T01).** A crash or restart silently throws away
whatever the user queued. Record 46 found it is wider than restarts: the queue is never saved, so reloading the app
loses it too. Save each accepted input with a queued, dispatched or settled state before acknowledging it; on
recovery, show what was never sent, and check whether anything may already have run before retrying it. Drop the
queue only on an explicit Stop.
Value high · Effort S–M · Needs nothing. *Why:* the talk-mode restart work showed how easily this loses words;
overnight work would lose instructions.

**F2. Durable task state.** Goal, milestones, progress, blockers and next step survive an app restart and a full
context window. *First version:* a per-thread state file the engine reads on resume.
Value high · Effort M · Needs F1. *Why:* Night Shift, Guardian and living deliverables all depend on it. Design it
together with C2's continuation state; they are the same record.

**F3. Completion checks.** "Done" means a stated check passed (tests, file present, output validated),
recorded as evidence. Value high · Effort M · Needs F2.

**F4. Event wakeups.** One mechanism resumes a task on a folder change, a time, a CI result or a user's
answer. Value high · Effort M · Needs F2. *Why:* folder triggers, Guardian and living deliverables share it,
so build it once.

**F5. Per-task limits.** Spend, retries, concurrency and wall-clock time, with the cost visible (see N6).
Value high · Effort S–M.

**F6. Recovery before retry.** Before repeating an action, check whether it already happened, using the
undo journal as the record. Value medium · Effort M.

**F7. Mid-run steering.** Change a running task's scope or priority without restarting it.
Value medium · Effort M.

**F8. Port the chat and tool cancellation fix (record 49).** Written and tested in the stale Desktop copy on
2026-09-13 and never ported. It makes `/clear force` wait for the running turn to finish instead of announcing a
clear that did not happen, resets every persona's history, resolves pending approvals on Stop, lets provider retry
backoff be cancelled, checks cancellation again after an approval before a tool acts, and stops telling PDF tasks
to investigate code and run builds. Record 49's third mutant shows why the post-approval check matters: without
it, a cancelled tool wrote the protected fixture file.
Value high · Effort S–M · Needs an edit-by-edit port, not a file copy: `agent.loop.ts`, `base.persona.ts` and
`tool.factory.ts` have changed here since. `competitive/evidence/2026-09-13-chat-tool-isolation/UNPORTED.md`
says where the exact edits are.

**F9. A resume that can fail visibly (T02).** When a saved session is missing or unreadable, the thread waits for a
`session_restore` that never arrives, and a queued Continue never resolves. Add a typed success or failure with a
deadline, keep the prompt, and offer: resume failed, start fresh, or inspect. Value high · Effort S–M.

**F10. One restart path (T03).** After an engine failure, the sidebar's Resume does nothing, because the dead
engine reference makes `start()` return early. Value high · Effort S.

**F11. Stop waits for the engine to exit (T04).** `stop()` starts the next task in the same folder before the old
process is confirmed gone. Release the folder only after termination is confirmed. Value medium–high · Effort M.
The probe proved the early dispatch, not an actual collision between two processes.

**F12. Storage survives one write error (T05).** One failed write rejects the save chain, so no later save runs,
even after the disk problem is fixed. Retry within bounds, keep pending writes, show unsaved state, and wait for the
final flush on quit. Value high · Effort S.

**F13. State the folder scope honestly (T06).** A thread's shell can read files outside its folder; the folder
limits writes, not reads. Say so now, and design declared read roots and a task-private temp folder before making
any privacy claim. Value medium, high before any privacy claim · Effort S to document, L to enforce.

## Quick fixes: Next (about an hour together)

**Q1. gpt-oss tool-call name leak.** Strip harmony channel tokens from tool names in the engine (for example
`AskUserTool<|channel|>commentary`). Talk mode should also discourage check-in questions like "Is that all you need?".

**Q2. Folder-rules env leak.** `coding.runtime.paths.buildEngineChildEnv` spreads the parent environment, so a
`BIMAX_THREAD_RULES` or `BIMAX_THREAD_PROTECTED` left in the shell that started Bimax reaches every engine. This is
the same leak fixed for `BIMAX_THREAD_VOICE` in `6ad2586`.

**Q3. Archive `app/src/main/runtime.paths.ts`.** The app never loads it, and the per-task model fix shipped
into it with green tests. Move it to the archive with `desktop.bundle.resolution.test.ts`, the only thing still
importing it. The rule is move, don't delete.

**Q4. Dictation error messages.** `VoiceSessions` finishes on the helper's `exit` rather than `close`, so it can
lose the reason the microphone failed. Talk mode already uses `close`.

## Next: small, high value (days)

**N1. Approve from the notification.** Allow and Deny buttons on the "needs your decision" notification.
Value high · Effort S · Needs a check of how macOS shows action buttons (alert style versus banners).

**N2. `bimax://` links and Shortcuts actions.** Start a ⌘2 task in a folder with a prompt from Shortcuts, Raycast,
Stream Deck or a Focus mode. Value high · Effort S. *Why:* every other tool can then trigger Bimax.
A link must never run anything unconfirmed.

**N3. Finder Quick Action: "Ask Bimax".** Opens the ⌘2 bar with the selected files attached, using the existing
attachment path. Value medium · Effort S.

**N4. Export or share a conversation.** Markdown and PDF (the engine already writes PDFs), from the sessions
gallery and the bar. Value medium · Effort S.

**N5. Attach a screenshot to the ⌘2 bar.** The task reads a picture only, with no control of the Mac, so it
stays code-only. Value medium · Effort S · Needs a vision-capable model in the vision slot.

**N6. Cost per task, model and day, plus a limit in Settings.** Value medium · Effort S–M · Feeds F5.

**N7. Voice settings.** Choose the voice and speaking speed, and show when a Premium voice is installed.
Value medium · Effort S.

**N8. Hold a key anywhere to talk.** A global push-to-talk that answers by notification or out loud.
Value medium · Effort S–M.

**N9. Spoken updates when tasks finish.** "Your Downloads cleanup is done, 6 GB freed."
Value low–medium · Effort S.

**N10. Correct once, teach deliberately.** For example, a correction becomes "Use ACME for this client from now
on?", with sample applications shown before saving. Preferences stay visible, editable and scoped.
Value medium · Effort M.

**N11. Remove, archive and search threads.** Creating a thread fails at 200 saved threads and tells the user to
remove one, but record 46 found no way to remove one. Add archive, search, rename and a retention policy.
Value high once Threads is used daily · Effort S.

**N12. Show why a task is waiting.** A task with queued work can show "idle". Separate idle, completed, failed,
interrupted, waiting for a folder and waiting for approval, with the pending count and a cancel.
Value medium · Effort S.

**N13. Approve a described change set once.** Threads ask afresh for every existing-file write and mutating
command, even under bypass or persistent rules. Offer task-scoped permission for an explicitly described change,
reused while the target, scope and risk stay the same. Value medium–high · Effort M · The governor's
non-bypassable floors must still run first.

**N14. Make Threads discoverable.** Record 46 saw no way into Threads from the installed app's welcome screen. Add
"Start a task in a folder" and a configurable shortcut, and check ⌘2 against other apps' shortcuts. Check the
current build first. Value medium · Effort S.

## Flagships: weeks, in suggested order

**FL1. Folders that act.** Start with folder triggers ("when a PDF lands in Downloads, rename it and file it").
Grow into *folders with an outcome*: "keep this folder ready for my accountant", with a queue of what is ready and
what needs you. Value high · Effort M then L · Needs F1, F4, F5 · Builds on folder rules, schedules and undo.
*Must design first:* loop protection (a task's own edits must not re-trigger it), debouncing, and a
reviewable change list.

**FL2. A preview you can rearrange.** Before organizing 300 files, show the proposed tree. Dragging one invoice
leads to "Put all invoices here?", and the whole preview updates. *First version:* an editable organization
preview. Value high · Effort M.

**FL3. "Actually…": revise a finished result.** "Actually, by project, and keep invoices together." It works out
the changes from the current state and keeps the user's manual edits. *First version:* file moves and renames.
Value high · Effort M–L · Needs FL2, the undo journal.

**FL4. Change history, then selective undo.** A timeline to restore any point, then "undo the renames but keep the
conversions", which needs dependency detection between actions. Record 46's *honest undo* adds reversibility
classes: say which changes can be restored and which cannot (a sent message), and keep later human edits during a
rollback. Value medium–high · Effort M then L.

**FL5. Night Shift.** "Work on this migration tonight, at most $12, a reviewable branch by morning." Milestones,
an isolated checkout, a check per milestone, and a morning briefing. Independent work continues while one
question waits. Value high · Effort L · Needs F1–F7 · Only while the Mac is awake unless a remote worker is added.

**FL6. Muscle memory.** After a task succeeds and passes its checks, offer to save it as a versioned skill with
inputs, sample data and output checks. When an input stops matching, it goes back to reasoning.
Merges "teach Bimax a job once" (file workflows) and "apply this before/after change to the other 40".
Value high · Effort L · Needs F3.

**FL7. "Where was I?"** Bookmarks, plus changes since your last visit: what was compared, what was rejected
and why, what arrived, the next step. *First version:* an explicit "leave myself a bookmark" button.
Value medium · Effort M.

**FL8. Disposable tools inside a task.** A contact sheet for choosing photos, a matching table for
reconciling, a batch editor for naming. *First version:* three reliable templates. Value medium · Effort M.

**FL9. Pick the model by measured speed.** Talk mode and ⌘2 use the fastest model that handles tools well,
from `modelTimes`, instead of a hard-coded one. Value medium · Effort S–M.

**FL10. Interrupt talk mode by speaking (barge-in).** Apple's voice-processing echo cancellation should let
the microphone stay on while Bimax speaks. Value medium–high for talk · Effort M · Needs measuring on the
built-in speakers.

**FL11. Talk in the background.** A floating orb or menu bar control while the window is hidden.
Value low–medium · Effort M.

## Later: valuable, needs a foundation or a narrower first version

**L1. Living deliverables.** "Keep this report accurate until Friday": when a source spreadsheet changes, only
the affected chart and conclusions are flagged and updated. *First version:* one CSV to one report.
Value high · Effort L · Needs F4, dependency tracking (42 record), and C1's dependency invalidation, which is the
same mechanism.

**L2. Contradiction radar.** "What doesn't agree?" across a folder's documents: amounts, dates, names, versions,
each finding opening both sources. Value medium · Effort M–L.

**L3. "What would this break?"** References to a file or folder inside the project, found before a rename, with the
repairs included in the preview. Value medium · Effort M.

**L4. "How did this get here?"** Provenance for artifacts Bimax created: source, transformation, output, and the
task that made it, with "origin unknown" for changes it did not observe. Value medium · Effort M ·
Builds on the evidence store.

**L5. Project Guardian.** "For two weeks, watch CI, reproduce new failures, prepare fixes within this scope."
Value medium–high · Effort L · Needs F2, F4, GitHub access.

**L6. Parallel futures.** Three isolated approaches evaluated the same way, with measured trade-offs, and only the
winner applied. Value medium–high · Effort L · Worktree isolation exists; 8 GB limits concurrent builds.

**L7. Rehearsal mode.** Run a file workflow on copies with injected faults (duplicate names, missing input,
interruption) before touching real data. Value medium · Effort M–L.

**L8. A tiny population tries your web app.** Scripted personas with goals run bounded journeys against a
local website, with state checks and replays. Local websites only, via the puppeteer harness.
Value medium · Effort M–L.

**L9. Drag the result, change the cause.** Adjust spacing, size or alignment in a running local web project and
trace it to the source, offering alternatives when ambiguous. Value medium (a striking demo) · Effort L.

**L10. Semantic paste, inside Bimax first.** Copy an invoice and paste it into a task as structured fields,
with uncertain values highlighted. Value medium · Effort M. Pasting into other apps is parked (P5).

**L11. Calendar-aware tasks.** "Prepare notes 10 minutes before each meeting." Value medium · Effort L ·
Needs explicit privacy choices.

**L12. Find repeated work from Bimax's own task history.** Suggest shortcuts from patterns in past
tasks, in a quiet review queue. Value low–medium · Effort M.

**L13. App Relay, code-only first.** One task's output is handed to another as a typed artifact (hash, source,
purpose, freshness), with a separate grant for each receiving task; tampering or unlinking before dispatch stops
the delivery. The native-app leg is parked with Computer Use. Value medium · Effort M · Needs F2, L14.

**L14. Typed messages between linked threads.** Peer messages are ordinary input carrying a warning string, which
labels them but is not a boundary. Add provenance, message IDs, expiry, acknowledgements and a link check at
dispatch; unlinking should also retract messages still queued. Value medium · Effort M.

**L15. Who can see other threads.** The broker's `list` shows every thread's title before any link exists. That is
fine for one person's Mac; shared or private tasks would need discovery scopes. Value low now · Effort S.

**L16. Budget by workload, not engine count.** Four engines plus their workers is heavy on 8 GB. Schedule by CPU,
memory and model budget; allow independent reads and isolated checkouts, and lock only shared writes. Benchmark
before choosing limits. Value medium · Effort M–L.

**L17. An isolated-checkout mode for threads.** Threads always work in the live folder, and the engine's sub-agent
worktrees are a different feature. Offer a worktree mode and keep the changes on handoff.
Value medium · Effort M · Shares its mechanism with L6.

## Context and retrieval (record 47)

Record 47 proposes a **Context Compiler**: a bounded, versioned package of evidence for each step, built from the
existing stores and tools with the models already configured. The stages are in order, and each needs the one
before it. The verdicts and efforts are this merge's proposals; record 47 gives none. The step-by-step build flow,
with the code location of each defect, is [record 50](50_CONTEXT_COMPILER_BUILD_PLAN.md).

**C0. Repair the eight reproduced defects.** Each probe becomes an acceptance test, paired with a mutant that
restores the defect. Value high · Effort M · Verdict Next · **Done 2026-09-14** (record 50 steps 1–3).
- **A01:** a rewrite that keeps size and modification time is not re-indexed, and compaction restores the old
  bytes labelled "verified unchanged".
- **A02:** the scope filter runs after the result limit, and the path prefix `wanted` also matches `wantedExtra/`.
- **A03:** recall retrieves the right document but injects its beginning, not the chunk that answers.
- **A04:** recalled text survives compaction with no freshness check, and asking again is suppressed.
- **A05:** a 100-token graph context request returns about 1,805 tokens, marked not truncated.
- **A06:** the graph rank cache misses rewired edges, and dangling-node mass is not conserved.
- **A07:** a Hindi query tokenizes to nothing and gets no lexical hit.
- **A08:** log compression keeps the first value and drops the maximum.

**C1. Evidence foundation.** Shared evidence span, locator and version types; raw tool output archived; dependency
invalidation, so a changed source dirties only what used it. Verdict Flagship · Effort L · Needs C0.

**C2. Prompt compiler.** One token budget for the whole request, a representation chosen per item (locator,
signature, exact span or neighbourhood), a structured continuation state, and a ledger of what is actually in the
prompt. Verdict Flagship · Effort L · Needs C1 · Shares its continuation state with F2.

**C3. Adaptive retrieval.** Evidence requirements per step, query-seeded graph search, selective counter-evidence,
and bounded read-only operations over large outputs (select, fetch, join, aggregate, diff).
Verdict Later · Effort L · Needs C2.

**C4. Qualification.** An evidence inspector, explanations for stale or missing evidence, restart behaviour,
packaged integration and the R02 journey. Verdict Later · Needs C3.

## Parked: needs Computer Use back, or research

- **P1. "Show me the bug" → verified fix** by demonstrating in a native app. A local-web version could become
  Later through the browser harness.
- **P2. "Give this app a new superpower"**: companion panels acting through another app's interface.
- **P3. Teach a job by demonstrating it across other apps.**
- **P4. Observing other apps to find repeated work.**
- **P5. Semantic paste into other apps' forms.**
- **P6. "Borrow my screen politely"**: prepare work in the background, then ask for a bounded turn in the
  foreground and hand control back (record 46).
- **P7. The Computer Use return program** in record 46, slices 0–6: reconcile the docs, dependable Threads, bounded
  observation, one safe mutation journey, build → run → prove, app packs, selective expansion. Its slice 1
  (dependable Threads) is F1, F9–F12, N11–N13 and L14 here, and needs no Computer Use.

## Overlaps merged

| Kept as | Also appeared as |
|---|---|
| FL1 Folders that act | run tasks when a folder changes; folders with an outcome attached |
| FL4 Change history | undo one decision, keep everything else; record 46's honest undo |
| FL6 Muscle memory | teach Bimax a job once; make this happen from a before/after example |
| L1 Living deliverables | a report that knows when it becomes wrong; record 46's Living Threads |
| L6 Parallel futures | three possible futures; record 46's parallel possible futures |
| L7 Rehearsal mode | practice on a fake version first |
| P1 Show me the bug | record 46's Show me the bug |
| P3 Teach a job by demonstrating | record 46's teach a result once |
| F1 Queue survives | record 46's T01 |

## Where the research lives

Records 46, 47 and 49, their evidence, and the additions to the source ledger and gap register were copied from the
stale `~/Desktop/Bimax` copy on 2026-09-14 and checked byte for byte:

- `46_COMPUTER_USE_RETURN_AND_THREADS_STRATEGY.md`, evidence in `evidence/2026-09-13-threads-audit/`
- `47_RAG_AND_CONTEXT_COMPILER_UPGRADE.md`, evidence in `competitive/evidence/2026-09-14-context-audit/`
- `49_CHAT_TOOL_ISOLATION_RECORD.md` (numbered 45 there), evidence in
  `competitive/evidence/2026-09-13-chat-tool-isolation/`
- `competitive/08_SOURCE_LEDGER.md` and `competitive/05_GAP_REGISTER.md`: both copies' sections merged, with nothing
  dropped from either

The probes in 46 and 47 ran against the Desktop copy, not this repository; see the facts above for what was
re-checked. The three write-ups say they were document research plus web checks, with no implementation and no
tests.

External references as the write-ups cited them, not re-checked here:

- Anthropic, "Effective harnesses for long-running agents"
- Microsoft UFO; Adobe DynaSaur (arXiv 2411.01747); Sketch-n-Sketch
- Proactive Agent (arXiv 2410.12361); Pare (arXiv 2604.00842)
- WebArena; Generative Agents (arXiv 2304.03442); AppWorld (arXiv 2407.18901)
- Screenpipe; Raycast AI Commands; Claude Cowork
