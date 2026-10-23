import * as fs from 'fs';
import * as path from 'path';
import { CronExpressionParser } from 'cron-parser';

export type WatchKind = 'file' | 'cron';

export interface Watcher {
  id: string;
  kind: WatchKind;
  spec: string;       // file/dir path (file) or cron expression (cron)
  action: string;     // slash command or NL prompt to run when triggered
  fires: number;
  maxFires: number;
  enabled: boolean;
  lastFired?: number;
}

type Runner = (action: string) => void;
type CircuitBreaker = () => Promise<boolean>;

const IGNORE = /(^|[\\/])(node_modules|\.git|\.breakglass|\.evolution_worktrees|dist)([\\/]|$)/;

/**
 * Background watchers. Watch a file/dir for changes or a cron schedule and wake the
 * agent to run an action. A circuit breaker (wired to the budget governor) and a
 * per-watcher fire cap prevent runaway autonomous loops.
 */
export class WatcherManager {
  private watchers = new Map<string, Watcher>();
  private handles = new Map<string, { close: () => void }>();
  private debounce = new Map<string, NodeJS.Timeout>();
  private runner: Runner | null = null;
  private notify: (msg: string) => void = () => {};
  private breaker: CircuitBreaker = async () => true;
  private seq = 0;

  registerRunner(fn: Runner | null) { this.runner = fn; }
  registerNotifier(fn: (msg: string) => void) { this.notify = fn; }
  setCircuitBreaker(fn: CircuitBreaker) { this.breaker = fn; }

  list(): Watcher[] { return Array.from(this.watchers.values()); }

  add(kind: WatchKind, spec: string, action: string, maxFires = 25): Watcher | { error: string } {
    const id = `w${++this.seq}`;
    const w: Watcher = { id, kind, spec, action, fires: 0, maxFires, enabled: true };

    if (kind === 'cron') {
      try { CronExpressionParser.parse(spec); } catch (e: any) { return { error: `Invalid cron expression: ${e.message}` }; }
      this.scheduleCron(w);
    } else {
      const target = path.resolve(spec);
      if (!fs.existsSync(target)) return { error: `Path not found: ${spec}` };
      try {
        const isDir = fs.statSync(target).isDirectory();
        const watcher = fs.watch(target, { recursive: isDir }, (_evt, filename) => {
          if (filename && IGNORE.test(filename.toString())) return;
          this.debouncedFire(w);
        });
        this.handles.set(id, { close: () => watcher.close() });
      } catch (e: any) {
        return { error: `Cannot watch ${spec}: ${e.message}` };
      }
    }

    this.watchers.set(id, w);
    return w;
  }

  remove(id: string): boolean {
    const w = this.watchers.get(id);
    if (!w) return false;
    this.handles.get(id)?.close();
    this.handles.delete(id);
    const t = this.debounce.get(id);
    if (t) clearTimeout(t);
    this.debounce.delete(id);
    this.watchers.delete(id);
    return true;
  }

  stopAll() {
    for (const id of Array.from(this.watchers.keys())) this.remove(id);
  }

  private debouncedFire(w: Watcher) {
    const existing = this.debounce.get(w.id);
    if (existing) clearTimeout(existing);
    this.debounce.set(w.id, setTimeout(() => this.fire(w), 1500));
  }

  private scheduleCron(w: Watcher) {
    try {
      const interval = CronExpressionParser.parse(w.spec);
      let delay = interval.next().toDate().getTime() - Date.now();
      if (delay <= 0) delay = 1000;
      const t = setTimeout(async () => {
        await this.fire(w);
        if (w.enabled && this.watchers.has(w.id)) this.scheduleCron(w);
      }, delay);
      this.handles.set(w.id, { close: () => clearTimeout(t) });
    } catch { /* invalid expr already rejected at add() */ }
  }

  private async fire(w: Watcher) {
    if (!w.enabled || !this.runner) return;
    if (w.fires >= w.maxFires) {
      w.enabled = false;
      this.notify(`👁️ Watcher ${w.id} hit its fire cap (${w.maxFires}) and was disabled.`);
      return;
    }
    // Circuit breaker: skip (and disable) if the budget governor is tapped out.
    let allowed = false; // deny on error
    try { allowed = await this.breaker(); } catch { /* stays denied */ }
    if (!allowed) {
      w.enabled = false;
      this.notify(`👁️ Watcher ${w.id} disabled by budget circuit breaker.`);
      return;
    }
    w.fires++;
    w.lastFired = Date.now();
    this.notify(`👁️ Watcher ${w.id} fired → ${w.action}`);
    this.runner(w.action);
  }
}

export const globalWatcherManager = new WatcherManager();
