import path from 'node:path';
import { arrivalMatches, type ArrivalKind } from './folder.triggers';
import type { ThreadWake } from '../shared/threads';

/**
 * Wakes (backlog F4): the app side of "resume this task when X happens". A task registers a wake through the engine's
 * WakeTool; the thread manager keeps it with the thread, so it survives a restart of the app; this module waits for the
 * event and hands the thread a "[Wake]" message saying what happened. The app waits rather than the engine because an
 * idle task's engine is shut down to save memory — the message starts it again and its conversation comes back (F2).
 *
 * Everything that touches the clock, the disk or the network comes in through `WakeDeps`, as in folder.triggers.ts.
 * Limits: a wake fires once; a CI wait ends after CI_TIMEOUT_MS with "no result"; a thread is woken at most
 * MAX_WAKES_PER_HOUR times an hour, and a wake over that waits for the hour to allow it.
 */

export const MAX_WAKES_PER_THREAD = 5;
export const MAX_WAKES_PER_HOUR = 12;
/** A folder change is reported once it has been quiet this long, so a burst of writes is one wake. */
export const FOLDER_SETTLE_MS = 2_000;
export const CI_POLL_MS = 60_000;
export const CI_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Changes in these are the tools' own bookkeeping, never what a task waits for. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.breakglass', '.bimax', '.DS_Store']);

export interface CiRun { name: string; status: string; conclusion: string; url?: string }
export type CiState = { state: 'waiting' } | { state: 'done'; runs: CiRun[] } | { state: 'error'; message: string };

export interface WakeDeps {
  now(): number;
  timer(fn: () => void, ms: number): () => void;
  /** Calls `changed` with a file name relative to `root` whenever one may have changed; returns a function that stops. */
  watch(root: string, changed: (file: string) => void): () => void;
  /** The CI runs for a commit, via the GitHub CLI in `root`. */
  ci(root: string, sha: string): Promise<CiState>;
  /** Deliver the wake: the thread manager drops it from the thread and sends `text` to the task. */
  fire(threadId: string, wake: ThreadWake, text: string): void;
}

export interface WakeEntry { threadId: string; wakes: readonly ThreadWake[] }

/** The "[Wake]" message a task receives: what happened, and what it said it would do. */
export function wakeMessage(wake: ThreadWake, happened: string): string {
  return `[Wake] ${happened}. When you registered this wake you said you would: "${wake.reason}". Continue the task from here.`;
}

/** One line on what the CI runs concluded. */
export function describeCiRuns(runs: readonly CiRun[]): string {
  const failed = runs.filter((run) => run.conclusion !== 'success' && run.conclusion !== 'skipped' && run.conclusion !== 'neutral');
  const list = runs.map((run) => `${run.name}: ${run.conclusion || run.status}${run.url && failed.includes(run) ? ` (${run.url})` : ''}`).join('; ');
  return `${failed.length ? `${failed.length} of ${runs.length} failed` : `all ${runs.length} passed`} — ${list}`;
}

interface Armed { stop: () => void }

export class Wakes {
  private armed = new Map<string, Armed>();
  private fired = new Map<string, number[]>();
  constructor(private deps: WakeDeps) {}

  /** Arm every wake in `entries` that is not armed yet, and disarm the ones that are gone. */
  sync(entries: readonly WakeEntry[]): void {
    const wanted = new Map<string, { threadId: string; wake: ThreadWake }>();
    for (const entry of entries) for (const wake of entry.wakes) wanted.set(this.key(entry.threadId, wake.id), { threadId: entry.threadId, wake });
    for (const [key, armed] of this.armed) if (!wanted.has(key)) { armed.stop(); this.armed.delete(key); }
    for (const [key, { threadId, wake }] of wanted) if (!this.armed.has(key)) this.armed.set(key, this.arm(threadId, wake));
  }

  /** How many wakes are armed (for tests and diagnostics). */
  size(): number { return this.armed.size; }

  dispose(): void {
    for (const armed of this.armed.values()) armed.stop();
    this.armed.clear();
  }

  private key(threadId: string, wakeId: string): string { return `${threadId}:${wakeId}`; }

  private arm(threadId: string, wake: ThreadWake): Armed {
    // A wake the user answers is delivered by the user's own message; there is nothing to wait for here.
    if (wake.kind === 'answer') return { stop: () => {} };
    if (wake.kind === 'at') {
      const stop = this.deps.timer(() => this.deliver(threadId, wake, `It is ${new Date(wake.at ?? 0).toLocaleString()}, the time this task asked to be woken`), Math.max(0, (wake.at ?? 0) - this.deps.now()));
      return { stop };
    }
    if (wake.kind === 'folder') return this.armFolder(threadId, wake);
    return this.armCi(threadId, wake);
  }

  private armFolder(threadId: string, wake: ThreadWake): Armed {
    const changed = new Set<string>();
    let settle: (() => void) | null = null;
    const root = wake.path ?? '';
    const stopWatch = this.deps.watch(root, (file) => {
      const parts = file.split(/[\\/]/);
      if (parts.some((part) => IGNORED_DIRS.has(part))) return;
      if (!arrivalMatches(path.basename(file), (wake.match ?? 'any') as ArrivalKind)) return;
      changed.add(file);
      settle?.();
      settle = this.deps.timer(() => {
        settle = null;
        const files = [...changed].sort();
        const shown = files.slice(0, 20).join(', ') + (files.length > 20 ? ` and ${files.length - 20} more` : '');
        this.deliver(threadId, wake, `Files changed in ${root}: ${shown}`);
      }, FOLDER_SETTLE_MS);
    });
    return { stop: () => { settle?.(); stopWatch(); } };
  }

  private armCi(threadId: string, wake: ThreadWake): Armed {
    let stopped = false;
    let next: (() => void) | null = null;
    const deadline = wake.createdAt + CI_TIMEOUT_MS;
    const commit = String(wake.sha ?? '').slice(0, 7);
    const poll = async (): Promise<void> => {
      if (stopped) return;
      const result = await this.deps.ci(wake.path ?? '', wake.sha ?? '').catch((error: Error): CiState => ({ state: 'error', message: error.message }));
      if (stopped) return;
      if (result.state === 'done') { this.deliver(threadId, wake, `CI finished for commit ${commit}: ${describeCiRuns(result.runs)}`); return; }
      if (this.deps.now() >= deadline) {
        const why = result.state === 'error' ? `the last check said: ${result.message}` : 'no run for it had finished';
        this.deliver(threadId, wake, `No CI result for commit ${commit} after ${CI_TIMEOUT_MS / HOUR} hours — ${why}`);
        return;
      }
      next = this.deps.timer(() => { void poll(); }, CI_POLL_MS);
    };
    next = this.deps.timer(() => { void poll(); }, 0);
    return { stop: () => { stopped = true; next?.(); } };
  }

  /** Deliver now, unless the thread already woke MAX_WAKES_PER_HOUR times this hour; then when the hour allows. */
  private deliver(threadId: string, wake: ThreadWake, happened: string): void {
    const key = this.key(threadId, wake.id);
    if (!this.armed.has(key)) return;
    const now = this.deps.now();
    const recent = (this.fired.get(threadId) ?? []).filter((at) => now - at < HOUR);
    if (recent.length >= MAX_WAKES_PER_HOUR) {
      // What happened is already known: stop waiting for it and only wait for the hour.
      this.armed.get(key)?.stop();
      const stop = this.deps.timer(() => this.deliver(threadId, wake, happened), recent[0] + HOUR - now + 1);
      this.armed.set(key, { stop });
      return;
    }
    this.fired.set(threadId, [...recent, now]);
    this.armed.get(key)?.stop();
    this.armed.delete(key);
    this.deps.fire(threadId, wake, wakeMessage(wake, happened));
  }
}
