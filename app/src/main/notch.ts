import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { isQuickThread, threadActivity, type ThreadSummary } from '../shared/threads';

/**
 * God's Land, stage 1 (docs/product-reset/gods-land/03_PLAN.md): the notch talks. This is the app's half — what the
 * notch shows and when it speaks up — and the lifecycle of the native helper that draws it (native/notch/main.swift).
 * The pure parts are separate so the wording and the moments can be tested without Electron or the helper.
 *
 * The notch never listens: no text box, no shortcut, no model calls. Anything that needs the person's words becomes
 * a ⌘2 task instead.
 */

export interface NotchTask { id: string; title: string; state: 'working' | 'waiting' | 'done' | 'failed' | 'idle'; detail: string }
export interface NotchContent { t: 'content'; active: number; waiting: number; tasks: NotchTask[] }
export interface NotchSay { t: 'say'; text: string; tone: 'done' | 'waiting' | 'failed' | 'info'; seconds: number }

const TITLE_MAX = 48;
const shortTitle = (title: string): string => (title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title);

/** One task as the notch shows it: a state the dot colours, and the same plain words the menu bar uses. */
export function notchTask(t: ThreadSummary): NotchTask {
  const { label } = threadActivity(t);
  const state: NotchTask['state'] =
    t.status === 'working' || t.status === 'starting' ? 'working'
      : t.status === 'needs-you' ? 'waiting'
        : t.outcome === 'failed' || t.check === 'failed' ? 'failed'
          : t.outcome === 'completed' ? 'done'
            : 'idle';
  return { id: t.id, title: shortTitle(t.title), state, detail: label === 'Idle' ? '' : label };
}

/** What the notch shows: ⌘2 tasks only (projects live in the main window), running and waiting first, then recent. */
export function notchContent(threads: readonly ThreadSummary[], limit = 4): NotchContent {
  const quick = threads.filter(isQuickThread);
  const live = (t: ThreadSummary): number => (t.status === 'needs-you' ? 0 : t.status === 'working' || t.status === 'starting' ? 1 : 2);
  const ordered = [...quick].sort((a, b) => live(a) - live(b) || b.updatedAt - a.updatedAt);
  return {
    t: 'content',
    active: quick.filter((t) => t.status === 'working' || t.status === 'starting' || t.status === 'needs-you').length,
    waiting: quick.filter((t) => t.status === 'needs-you').length,
    tasks: ordered.slice(0, limit).map(notchTask),
  };
}

/**
 * When the notch speaks up by itself: a ⌘2 task that just finished, just started needing the person, or just failed.
 * Only transitions count — a task that was already done when the app started, or that stays waiting, says nothing
 * again. A finished task is "done" only if its check did not fail (F3); a failed check is said as such.
 */
export function notchSays(previous: ReadonlyMap<string, ThreadSummary>, next: readonly ThreadSummary[]): NotchSay[] {
  const says: NotchSay[] = [];
  for (const t of next) {
    if (!isQuickThread(t)) continue;
    const before = previous.get(t.id);
    if (!before) continue;
    const title = shortTitle(t.title);
    const wasBusy = before.status === 'working' || before.status === 'starting';
    if (t.status === 'needs-you' && before.status !== 'needs-you') {
      says.push({ t: 'say', text: `${title} needs you`, tone: 'waiting', seconds: 6 });
    } else if (wasBusy && t.status !== 'working' && t.status !== 'starting' && t.status !== 'needs-you') {
      if (t.outcome === 'failed') says.push({ t: 'say', text: `${title} failed`, tone: 'failed', seconds: 6 });
      else if (t.outcome === 'time-limit') says.push({ t: 'say', text: `${title} reached its time limit`, tone: 'failed', seconds: 6 });
      else if (t.outcome === 'completed' && t.check === 'failed') says.push({ t: 'say', text: `${title} finished, but its check failed`, tone: 'failed', seconds: 6 });
      else if (t.outcome === 'completed') says.push({ t: 'say', text: `${title} is done${t.check === 'passed' ? ' · check passed' : ''}`, tone: 'done', seconds: 4 });
    }
  }
  return says;
}

export function notchHelperPath(input: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.packaged ? path.join(input.resourcesPath, 'notch', 'bimax-notch') : path.join(input.appPath, 'notch', 'bimax-notch');
}

/** Restarts allowed in a window: a helper that keeps dying is left off rather than respawned forever. */
export const NOTCH_RESTARTS = { max: 3, windowMs: 5 * 60_000 };

export function mayRestart(crashes: readonly number[], now: number, limit = NOTCH_RESTARTS): boolean {
  return crashes.filter((at) => now - at < limit.windowMs).length < limit.max;
}

export interface NotchDeckOptions {
  helper: string;
  onOpenTask: (id: string) => void;
  log?: (line: string) => void;
  spawnHelper?: (file: string) => ChildProcessWithoutNullStreams;
}

/** The helper process: started once, told what to show, restarted a bounded number of times, stopped with the app. */
export class NotchDeck {
  private child: ChildProcessWithoutNullStreams | null = null;
  private crashes: number[] = [];
  private stopped = false;
  private lastContent = '';
  private previous = new Map<string, ThreadSummary>();

  constructor(private readonly options: NotchDeckOptions) {}

  start(): void {
    if (this.child || this.stopped) return;
    const child = (this.options.spawnHelper ?? ((file) => spawn(file, [], { stdio: ['pipe', 'pipe', 'pipe'] })))(this.options.helper);
    this.child = child;
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        this.received(line);
      }
    });
    child.stderr.on('data', () => undefined);
    // A write racing the helper's exit must not become an uncaught EPIPE in the main process.
    child.stdin.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.lastContent = '';
      if (this.stopped) return;
      this.options.log?.(`notch helper exited code=${code} signal=${signal ?? '-'}`);
      this.crashes.push(Date.now());
      if (mayRestart(this.crashes, Date.now())) setTimeout(() => this.start(), 1_000);
      else this.options.log?.('notch helper keeps exiting; left off until Bimax restarts');
    });
  }

  private received(line: string): void {
    let message: { t?: string; id?: unknown };
    try { message = JSON.parse(line); } catch { return; }
    if (message.t === 'open-task' && typeof message.id === 'string') this.options.onOpenTask(message.id);
    else if (message.t === 'ready') this.options.log?.(`notch helper ready: ${line}`);
  }

  private send(message: object): void {
    if (!this.child) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** The current tasks: always sent when they change, and anything worth saying about how they changed. */
  update(threads: readonly ThreadSummary[]): void {
    const content = notchContent(threads);
    const serialized = JSON.stringify(content);
    if (serialized !== this.lastContent) {
      this.lastContent = serialized;
      this.send(content);
    }
    for (const say of notchSays(this.previous, threads)) this.send(say);
    this.previous = new Map(threads.map((t) => [t.id, t]));
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    this.send({ t: 'quit' });
    this.child = null;
    child.stdin.end();
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1_000);
  }

  /** Turned off in the menu: stop now, and allow a later start. */
  pause(): void {
    this.stop();
    this.stopped = false;
    this.crashes = [];
  }

  running(): boolean {
    return this.child !== null;
  }
}
