/**
 * The memory budget over live engines: how many Bimax Threads may hold an engine at once, and when an idle one is handed
 * back. Split out of thread.manager.ts (flaw list C16); the manager applies it.
 */
import type { ThreadSummary } from '../shared/threads';

/**
 * The ceiling on live **Bimax Threads** — the product feature: folder-bound conversations, each
 * with its own engine worker, run instantly from the ⌘2 bar or from a project window.
 *
 * This is a MEMORY budget (see ENGINE_BUDGET_BYTES / RESERVE_BYTES below and `maxLiveEngines`).
 * It is NOT the CPU budget, and the two must never be conflated just because both happen to be 4:
 * `MAX_CONCURRENT_SUBAGENTS` (src/core/subagent.capacity.ts) caps sub-agent *workers*, which are
 * real `worker_threads` OS threads inside one engine. A machine can therefore be at this cap and
 * still have idle cores, or under it and still be CPU-saturated. See the glossary in AGENTS.md.
 */
export const MAX_LIVE_ENGINES = 4;
const ENGINE_BUDGET_BYTES = 320 * 1024 * 1024;
const RESERVE_BYTES = 512 * 1024 * 1024;

/**
 * How many threads may hold a live engine at once: MAX_LIVE_ENGINES, or fewer when free memory cannot carry that many.
 *
 * The ceiling stays 4 — that is the product's behaviour and raising it is a separate decision — but
 * on a machine without the memory for 4 it now comes DOWN instead of letting the user start engines
 * until the OS starts killing them. The supervisor has computed a memory-aware profile per launch
 * for a long while (supervisor/resources.ts, "adaptive, not hardcoded"); this cap sat beside it as a
 * bare `4` and consulted none of it.
 *
 * BOTH constants are measured, 2026-09-18 on this source, because a guessed one here silently costs
 * the user concurrent tasks:
 *
 *   engine RSS at idle    295 MB shipped bundle · 272 MB the bun binary it replaced · 214 MB tsc dev
 *   Electron's own tree   242 MB across 6 processes in development, 85 MB packaged and idle
 *
 * So 320 MB per engine — a little above the worst engine reading, since an engine mid-turn is not an
 * engine at idle — and a 512 MB reserve, which is the measured Electron shell plus roughly as much
 * again for the OS. The first reserve written here was 1 GB, picked by feel; that is four times what
 * Electron actually uses and it cut this machine from four concurrent tasks to one. Measure the
 * thing, including the part that looks too obvious to measure.
 *
 * Deliberately NOT a ratio of total RAM: what matters is what is free right now, which on macOS
 * means counting reclaimable pages (see availableBytes in supervisor/resources.ts — reading
 * os.freemem() here would put every 8 GB Mac at the floor permanently, which is the bug that
 * policy had).
 */
export function maxLiveEngines(availableBytes: number): number {
  const affordable = Math.floor((availableBytes - RESERVE_BYTES) / ENGINE_BUDGET_BYTES);
  // Never below 1: refusing to start any thread at all is worse than starting one and letting the
  // supervisor shed capabilities or restart it. The floor is what keeps this a budget, not a gate.
  return Math.max(1, Math.min(MAX_LIVE_ENGINES, affordable));
}

/**
 * How long an engine may sit idle before it is handed back.
 *
 * MEASURED 2026-09-19: an engine costs **227 MB** whatever it is doing — a finished ⌘2 task's engine
 * weighs exactly as much as a project engine mid-turn, because that figure is the bundle, the V8
 * heap and the tool registry, not the optional subsystems (the ⌘2 capability profile saves nothing
 * at all on this number). Until now nothing reclaimed one: `start()` evicted an idle engine only
 * when a NEW task hit the limit, so four finished tasks sat on 868 MB of an 8 GB machine
 * indefinitely, doing nothing.
 *
 * Ten minutes, because restarting is cheap and non-destructive: the thread's state is already
 * persisted, `start()` resumes its session, and the manager marks its own restarts quiet so the
 * transcript does not grow a "Resumed …" line the user did not ask for. The user-visible cost of
 * being wrong is ~350 ms on the next message; the cost of not reaping is a quarter of a gigabyte
 * per abandoned task.
 */
export const IDLE_ENGINE_TTL_MS = 10 * 60_000;

/** How often the sweep runs. Cheap: it walks the record map and compares two numbers. */
export const IDLE_ENGINE_SWEEP_MS = 60_000;

/** A high-priority task goes first and is stopped last (backlog F7). */
export const priorityRank = (summary: Pick<ThreadSummary, 'priority'>): number =>
  (summary.priority === 'high' ? 2 : summary.priority === 'low' ? 0 : 1);

/** What the budget reads of a thread to decide whether its engine can be handed back. */
export interface EngineHolder {
  summary: Pick<ThreadSummary, 'id' | 'status' | 'updatedAt' | 'priority'>;
  engine?: unknown;
  inputs: readonly unknown[];
  pending: { readonly size: number };
  draining?: unknown;
}

/**
 * The engines that can be handed back right now without costing the user work, least recently
 * used first.
 *
 * One predicate, two callers, because they were drifting apart and the divergence was the bug:
 * the idle sweep (`ttlMs = IDLE_ENGINE_TTL_MS`) was careful, and `start()`'s make-room eviction
 * (`ttlMs = 0`, since it needs the memory now, not eventually) was not — it ordered by creation
 * instead of use and threw away queued messages. A thread is reclaimable only when every one of
 * these holds, because a wrong reclaim costs a restart mid-thought.
 *
 * `updatedAt` is the recency signal `list()` and `ensureRoom()` already sort by, so all three
 * agree on what "least recently used" means. `onScreen` holds the main window's selection and
 * whatever the ⌘2 bar shows.
 */
export function reclaimableEngines<T extends EngineHolder>(
  threads: Iterable<T>,
  { now, ttlMs, onScreen }: { now: number; ttlMs: number; onScreen: ReadonlyArray<string | null> },
): T[] {
  return [...threads]
    .filter((r) =>
      !!r.engine
      && !onScreen.includes(r.summary.id)        // not visible in a window or the ⌘2 bar
      && r.summary.status === 'idle'             // never working, needs-you or starting
      && !r.inputs.length                        // nothing queued
      && !r.pending.size                         // no approval waiting on the user
      && !r.draining                             // its previous engine is not still draining
      && now - r.summary.updatedAt >= ttlMs)
    // A low-priority task is stopped first and a high-priority one last (F7); least recently used within each.
    .sort((a, b) => (priorityRank(a.summary) - priorityRank(b.summary)) || (a.summary.updatedAt - b.summary.updatedAt));
}
