import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';

/**
 * How often is each command and each tool actually used?
 *
 * WHY THIS EXISTS. On 2026-09-19 roughly 4,300 lines were retired from this engine — the whole
 * worktree-racing and dream/self-play family — and the evidence that condemned them was a one-line
 * SQLite query plus five empty state directories (docs/product-reset/58). That worked because those
 * features happened to write files. For everything else there was nothing to look at: a command
 * leaves no trace, so "is anyone using /scout?" was unanswerable and the retirement pass had to stop
 * at the features that happened to be observable.
 *
 * So: one counter per command and per tool. It exists to make the NEXT retirement pass a
 * measurement rather than an argument, and to say out loud when something has never once run.
 *
 * DESIGN NOTES, both of which are deliberate:
 *
 *  1. NOT the event ledger. `event.ledger.ts` is an append-only, hash-chained audit log with a
 *     SQLite IMMEDIATE transaction per append — the right thing for evidence, the wrong thing for a
 *     hot counter that ticks tens of times per turn. Flooding it with usage pings would cost a
 *     write lock per tool call and bury the events that matter in noise. Counters are aggregate by
 *     nature: a count and a last-seen, not a history.
 *
 *  2. Debounced, unref'd, and best-effort. Recording must never slow a turn, never hold the process
 *     open, and never fail one. Every path here swallows its own errors; a counter that throws
 *     would be a spectacularly bad trade.
 *
 * Privacy: names only. No arguments, no prompts, no paths, no output — nothing a person typed.
 * The file is per-project state under .bimax, exactly like drives.json.
 */

export type UsageKind = 'command' | 'tool';

export interface UsageEntry {
  /** Times invoked since `since`. */
  n: number;
  /** Wall-clock ms of the most recent invocation. */
  last: number;
}

export interface UsageSnapshot {
  /** When counting started — an absent file means "never", which is the interesting answer. */
  since: number;
  commands: Record<string, UsageEntry>;
  tools: Record<string, UsageEntry>;
}

const FLUSH_MS = 5_000;

function empty(now: number): UsageSnapshot {
  return { since: now, commands: {}, tools: {} };
}

export class UsageCounters {
  private readonly file: string;
  private data: UsageSnapshot | null = null;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(projectRoot?: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir('.bimax', projectRoot), 'usage.json');
  }

  /** Lazy load, so constructing the singleton at boot costs no I/O. */
  private load(): UsageSnapshot {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<UsageSnapshot>;
      this.data = {
        since: typeof parsed.since === 'number' ? parsed.since : this.now(),
        commands: parsed.commands && typeof parsed.commands === 'object' ? parsed.commands : {},
        tools: parsed.tools && typeof parsed.tools === 'object' ? parsed.tools : {},
      };
    } catch {
      // Absent or corrupt: start fresh rather than refuse to count. A corrupt counter file is not
      // worth an error path — the worst case is that the history restarts.
      this.data = empty(this.now());
    }
    return this.data;
  }

  record(kind: UsageKind, name: string): void {
    const clean = (name || '').trim();
    if (!clean) return;
    try {
      const data = this.load();
      const bucket = kind === 'command' ? data.commands : data.tools;
      const at = this.now();
      const entry = bucket[clean];
      if (entry) { entry.n += 1; entry.last = at; } else { bucket[clean] = { n: 1, last: at }; }
      this.dirty = true;
      this.schedule();
    } catch { /* counting must never break a turn */ }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS);
    // Never hold the process open for a counter.
    this.timer.unref?.();
  }

  /** Write now. Called by the debounce, by `/usage`, and at shutdown. */
  flush(): void {
    if (!this.dirty || !this.data) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Atomic: a crash mid-write must not leave a truncated file that then reads as "never used".
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch { /* best-effort */ }
  }

  snapshot(): UsageSnapshot {
    const d = this.load();
    return { since: d.since, commands: { ...d.commands }, tools: { ...d.tools } };
  }

  /**
   * Names that have NEVER been recorded, given everything currently registered.
   *
   * This is the retirement question, and it is asked in the safe direction: a name is reported as
   * unused only when it is registered AND absent from the counters. A counter file that does not
   * exist yet makes everything "unused", which is why the caller must show `since` alongside — an
   * empty file one hour old proves nothing at all.
   */
  neverUsed(kind: UsageKind, registered: string[]): string[] {
    const bucket = kind === 'command' ? this.load().commands : this.load().tools;
    return registered.filter((n) => !bucket[n]).sort();
  }
}

let singleton: UsageCounters | null = null;

export function getUsageCounters(): UsageCounters {
  if (!singleton) singleton = new UsageCounters();
  return singleton;
}

/** Tests inject their own instance; pass null to reset. */
export function __setUsageCounters(u: UsageCounters | null): void {
  singleton = u;
}

/** Fire-and-forget recorder for the two choke points. Never throws. */
export function recordUsage(kind: UsageKind, name: string): void {
  try { getUsageCounters().record(kind, name); } catch { /* best-effort */ }
}
