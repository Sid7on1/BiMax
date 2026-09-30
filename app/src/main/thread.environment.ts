import path from 'node:path';
import type { ThreadSummary } from '../shared/threads';

// What a Bimax Thread's engine starts with on top of the broker's environment, by the kind of thread. Split out of
// thread.manager.ts (flaw list C16): pure functions of the thread, tested on their own.

/**
 * What a thread engine starts with on top of the broker's environment. A ⌘2 thread works in whatever folder
 * Finder showed — often ~/Desktop or ~/Downloads, with tens of thousands of files — so it runs no code index:
 * on the Desktop the index skipped 96,155 files and flagged every reply "degraded". A project opened in the
 * main window keeps code search. A thread saved before origins existed is treated as a ⌘2 thread.
 */
export function threadIndexEnvironment(origin: ThreadSummary['origin']): Record<string, string> {
  return origin === 'project' ? {} : { BIMAX_CODE_INDEX: '0' };
}

/**
 * The optional engine subsystems a thread may run: codebase memory (the semantic layer), background
 * indexing, and the drives boot the learning loop rides on.
 *
 * These were switched off for EVERY thread at the spawn site, which was right when a thread meant a
 * ⌘2 task: a folder-bound job dropped on Downloads must not index Downloads or boot drives to do it.
 * But `createSupervisor` is only ever called with a thread id, so once every conversation became a
 * thread the override quietly became product-wide — codebase memory and drives were off everywhere,
 * which is why the learning substrate measured 0 claims and semantic retrieval was hard to observe.
 *
 * A project thread is the opposite case: the user opened a repo to work in it, and indexing it is
 * the point. So the distinction follows `origin`, exactly as threadIndexEnvironment above already
 * does for the code index — this extends an accepted split rather than inventing one.
 *
 * Returning `{}` for a project thread does not force anything ON. It declines to override, and lets
 * supervisor/resources.ts decide from measured free memory — a ladder that only started reading the
 * right number once availableBytes() replaced os.freemem(). If that judgement is wrong on a given
 * machine, policy.ts shedProfile steps the next launch down after a single resource death and to
 * `minimal` after two, so the failure mode is a quieter engine rather than a crash loop.
 */
export function threadCapabilityEnvironment(origin: ThreadSummary['origin']): Record<string, string> {
  // Carried so engine.log can say WHY a plan looks the way it does. A ⌘2 task's "all off" and a
  // starved project thread's "all off" are the same four values meaning entirely different things,
  // and reading one as the other is exactly the confusion that hid this override in the first place.
  if (origin === 'project') return { BIMAX_THREAD_ORIGIN: 'project' };
  return {
    BIMAX_THREAD_ORIGIN: 'quick',
    BIMAX_AUTO_INDEX: '0',
    BIMAX_DISABLE_CODEMEM: '1',
    BIMAX_DISABLE_CODEBASE_MEMORY: '1',
    BIMAX_DRIVES_BOOT: '0',
  };
}

/**
 * One machine-wide budget for sub-agent **workers** (real `worker_threads` OS threads), shared by
 * every engine this app spawns.
 *
 * WHY this exists. `MAX_CONCURRENT_SUBAGENTS` is enforced per engine, against the lease
 * ledger `resolveCapacityContext` resolves. That ledger defaults to
 * `<cwd>/.bimax/subagent-capacity.json` — per FOLDER. Bimax Threads are folder-exclusive, so every
 * live Thread used to get its own private ledger and its own private ceiling of four. The ceiling
 * therefore MULTIPLIED: four live Threads meant up to sixteen concurrent workers on a machine whose
 * adaptive policy had carefully computed a per-machine number (floor(cores / 2) = 3 on an 8-core
 * M3) and then handed that same number to each of them.
 *
 * The ledger was always the right mechanism — it is a cross-process, fail-closed, O_EXCL-locked
 * counting semaphore with expiring leases. It was simply never pointed at a shared path. Pointing
 * it at one file under userData makes the budget mean what the policy already thinks it means.
 *
 * Deliberately NOT derived from the Bimax Thread cap (`MAX_LIVE_ENGINES`): that is a memory budget
 * over engines, this is a CPU budget over sub-agent workers, and a machine can be at one and nowhere
 * near the other. See the glossary in AGENTS.md.
 *
 * The env NAME is a literal rather than an import from `src/core/subagent.capacity.ts`, because the
 * desktop build must not compile the engine — the engine is an input, not a dependency. It is
 * pinned by a test that reads the engine's own constant, so the two cannot drift silently.
 */
export function workerCapacityEnvironment(userData: string): Record<string, string> {
  return { BIMAX_AGENT_CAPACITY_PATH: path.join(userData, 'subagent-capacity.json') };
}

/**
 * One money ledger for the Mac, and this Bimax Thread's own share of it (backlog F5).
 *
 * The same defect as `workerCapacityEnvironment` above, in the expensive direction. The engine's
 * `BudgetVeto` keeps its daily total under `stateDir('.breakglass')`, and `stateDir` follows
 * `BIMAX_STATE_DIR` — which `threadStateEnvironment` sets to a per-folder directory for every ⌘2
 * Thread. So each Thread got a private `spend.json` and a private full daily cap. MEASURED
 * 2026-09-19: four independent spend files already existed on this machine, two of them under
 * `thread-state/`. The effective ceiling was $5 × (folders ever opened as a Thread).
 *
 * `perScopeCap` is the second half, and it is what F5 actually asked for: one unattended Thread
 * must not be able to spend the whole day's budget before the others start. Omitted when the caller
 * has no opinion, in which case only the machine ceiling applies.
 *
 * Scoped by THREAD ID rather than by folder, so re-running a folder tomorrow does not inherit
 * yesterday's share, and two Threads on one folder are billed apart.
 */
export function spendLedgerEnvironment(
  userData: string,
  threadId: string | undefined,
  perScopeCap?: number,
): Record<string, string> {
  const env: Record<string, string> = {
    BIMAX_SPEND_LEDGER_PATH: path.join(userData, 'spend-ledger.json'),
  };
  if (threadId) env.BIMAX_SPEND_SCOPE = threadId;
  if (perScopeCap && perScopeCap > 0) env.BIMAX_SPEND_SCOPE_CAP = String(perScopeCap);
  return env;
}

/** A talk-mode task's engine writes every reply to be heard (src/tools/thread.voice.ts). */
export function threadVoiceEnvironment(voice: ThreadSummary['voice']): Record<string, string> {
  return voice ? { BIMAX_THREAD_VOICE: '1' } : {};
}
