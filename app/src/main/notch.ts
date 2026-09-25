import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { isQuickThread, threadActivity, type ThreadSummary } from '../shared/threads';
import type { ShelfFrom, ShelfInput, ShelfView } from './shelf';
import { nextGlassChange, notchGlass, outcomeOf, type Glass, type Unseen } from './glass';
import type { ClipView } from './clipboard';

/**
 * God's Land, stage 1 (docs/product-reset/gods-land/03_PLAN.md): the notch talks. This is the app's half — what the
 * notch shows and when it speaks up — and the lifecycle of the native helper that draws it (native/notch/main.swift).
 * The pure parts are separate so the wording and the moments can be tested without Electron or the helper.
 *
 * The notch never listens: no text box, no shortcut, no model calls. Anything that needs the person's words becomes
 * a ⌘2 task instead.
 */

export interface NotchTask { id: string; title: string; state: 'working' | 'waiting' | 'done' | 'failed' | 'idle'; detail: string }
export interface NotchContent { t: 'content'; active: number; waiting: number; tasks: NotchTask[]; glass?: Glass }
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

/**
 * ⌘2 tasks that just stopped working with a result — completed (whatever its check said), failed or cut off by its
 * time limit. The Hatchback (stage 3) brings a notch task's files back to the shelf at exactly this moment.
 */
export function justFinished(previous: ReadonlyMap<string, ThreadSummary>, next: readonly ThreadSummary[]): ThreadSummary[] {
  return next.filter((t) => {
    const before = previous.get(t.id);
    if (!isQuickThread(t) || !before) return false;
    const wasBusy = before.status === 'working' || before.status === 'starting';
    const stillBusy = t.status === 'working' || t.status === 'starting' || t.status === 'needs-you';
    return wasBusy && !stillBusy && (t.outcome === 'completed' || t.outcome === 'failed' || t.outcome === 'time-limit');
  });
}

/** Where the Droplet lands, in Electron's screen coordinates (top-left origin). */
export interface DropletTarget { x: number; y: number; width: number; height: number }
/** The longest the app waits for the helper's Droplet before opening the bar anyway. */
export const DROPLET_TIMEOUT_MS = 1_200;

export function notchHelperPath(input: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.packaged ? path.join(input.resourcesPath, 'notch', 'bimax-notch') : path.join(input.appPath, 'notch', 'bimax-notch');
}

/** Restarts allowed in a window: a helper that keeps dying is left off rather than respawned forever. */
export const NOTCH_RESTARTS = { max: 3, windowMs: 5 * 60_000 };

export function mayRestart(crashes: readonly number[], now: number, limit = NOTCH_RESTARTS): boolean {
  return crashes.filter((at) => now - at < limit.windowMs).length < limit.max;
}

/** The shelf store (shelf.ts), as the deck uses it. */
export interface NotchShelf {
  add(inputs: readonly ShelfInput[]): string[];
  touch(id: string): boolean;
  archive(target: { ids?: readonly string[]; amber?: boolean }): number;
  restore(id: string): boolean;
  view(): ShelfView;
}

const SHELF_KINDS = new Set(['file', 'url', 'text']);
/** Only well-formed inputs from the helper reach the store; the store validates the values themselves. */
export function shelfInputs(raw: unknown): ShelfInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((i): i is ShelfInput => !!i && typeof i === 'object' && SHELF_KINDS.has((i as ShelfInput).kind)).slice(0, 50)
    .map((i) => ({ kind: i.kind, ...(typeof i.path === 'string' ? { path: i.path } : {}), ...(typeof i.url === 'string' ? { url: i.url } : {}), ...(typeof i.text === 'string' ? { text: i.text } : {}) }));
}

/** The clipboard history (clipboard.ts), as the deck uses it, and the person's on/off choice. */
export interface NotchClipboard {
  enabled(): boolean;
  setEnabled(on: boolean): void;
  add(text: string, source?: string): boolean;
  pin(id: string, pinned: boolean): boolean;
  remove(id: string): boolean;
  view(enabled: boolean): ClipView;
}

export interface NotchDeckOptions {
  helper: string;
  onOpenTask: (id: string) => void;
  /** The shelf (stage 2); without one the notch has no shelf. */
  shelf?: NotchShelf;
  /** Files handed to "Edit with Bimax" (stage 3): the app plays the Droplet and opens the ⌘2 bar with them. */
  onEdit?: (paths: string[]) => void;
  /** Stage 5: the smart clipboard. Off until the person turns it on; without it the notch has no clipboard. */
  clipboard?: NotchClipboard;
  /** Stage 4: which tasks have a Night Shift running, for the night glass. */
  nightIds?: () => ReadonlySet<string>;
  /** The clock, for tests. */
  now?: () => number;
  log?: (line: string) => void;
  spawnHelper?: (file: string) => ChildProcessWithoutNullStreams;
}

/** The helper process: started once, told what to show, restarted a bounded number of times, stopped with the app. */
export class NotchDeck {
  private child: ChildProcessWithoutNullStreams | null = null;
  private crashes: number[] = [];
  private stopped = false;
  private lastContent = '';
  private lastShelf = '';
  private lastClips = '';
  private landing: (() => void) | null = null;
  /** Stage 4: results the person has not looked at (cleared when the notch opens), and the next timed change. */
  private unseen = new Map<string, Unseen>();
  private threadsNow: readonly ThreadSummary[] = [];
  private glassTimer: NodeJS.Timeout | null = null;
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
      this.lastShelf = '';
      this.lastClips = '';
      if (this.stopped) return;
      this.options.log?.(`notch helper exited code=${code} signal=${signal ?? '-'}`);
      this.crashes.push(Date.now());
      if (mayRestart(this.crashes, Date.now())) setTimeout(() => this.start(), 1_000);
      else this.options.log?.('notch helper keeps exiting; left off until Bimax restarts');
    });
  }

  private received(line: string): void {
    let message: { t?: string; id?: unknown; items?: unknown; ids?: unknown; amber?: unknown; open?: unknown; text?: unknown; source?: unknown; pinned?: unknown };
    try { message = JSON.parse(line); } catch { return; }
    const shelf = this.options.shelf;
    if (message.t === 'open-task' && typeof message.id === 'string') this.options.onOpenTask(message.id);
    else if (message.t === 'ready') { this.options.log?.(`notch helper ready: ${line}`); this.sendShelf(); this.sendClips(true); }
    else if (message.t === 'hover' && message.open === true) {
      this.sendShelf(); // amber and missing change with time
      // Opening the notch is looking: the unseen results have been seen.
      if (this.unseen.size) { this.unseen.clear(); this.sendContent(); }
    }
    else if (shelf && message.t === 'shelf-add') { shelf.add(shelfInputs(message.items)); this.sendShelf(); }
    else if (shelf && message.t === 'shelf-touch' && typeof message.id === 'string') { if (shelf.touch(message.id)) this.sendShelf(); }
    else if (shelf && message.t === 'shelf-archive') {
      const ids = Array.isArray(message.ids) ? message.ids.filter((id): id is string => typeof id === 'string') : undefined;
      if (shelf.archive({ ids, amber: message.amber === true })) this.sendShelf();
    }
    else if (shelf && message.t === 'shelf-restore' && typeof message.id === 'string') { if (shelf.restore(message.id)) this.sendShelf(); }
    else if (message.t === 'edit') {
      // Absolute paths only: a relative one would resolve against wherever the app happens to run.
      const paths = shelfInputs(message.items).filter((i) => i.kind === 'file' && i.path && path.isAbsolute(i.path)).map((i) => i.path!);
      if (paths.length) this.options.onEdit?.(paths);
    }
    else if (message.t === 'droplet-landed') { this.landing?.(); this.landing = null; }
    else if (this.options.clipboard) this.clipboardMessage(message);
  }

  /** Stage 5. A copy is kept only while the person has history on, whatever the helper sends. */
  private clipboardMessage(message: { t?: string; id?: unknown; text?: unknown; source?: unknown; pinned?: unknown }): void {
    const clipboard = this.options.clipboard!;
    if (message.t === 'clip' && typeof message.text === 'string') {
      if (clipboard.enabled() && clipboard.add(message.text, typeof message.source === 'string' ? message.source.slice(0, 80) : undefined)) this.sendClips();
    } else if (message.t === 'clip-enable' || message.t === 'clip-disable') {
      clipboard.setEnabled(message.t === 'clip-enable');
      this.sendClips(true);
    } else if (message.t === 'clip-pin' && typeof message.id === 'string') {
      if (clipboard.pin(message.id, message.pinned === true)) this.sendClips();
    } else if (message.t === 'clip-remove' && typeof message.id === 'string') {
      if (clipboard.remove(message.id)) this.sendClips();
    }
  }

  /** The history and whether it is on; `config` also tells the helper to start or stop watching. */
  sendClips(config = false): void {
    const clipboard = this.options.clipboard;
    if (!clipboard) return;
    const enabled = clipboard.enabled();
    if (config) this.send({ t: 'clip-config', enabled });
    const view = clipboard.view(enabled);
    const serialized = JSON.stringify(view);
    if (serialized === this.lastClips) return;
    this.lastClips = serialized;
    this.send(view);
  }

  private sendShelf(): void {
    if (!this.options.shelf) return;
    let view: ShelfView;
    try { view = this.options.shelf.view(); } catch (error) { this.options.log?.(`shelf unreadable: ${String(error)}`); return; }
    const serialized = JSON.stringify(view);
    if (serialized === this.lastShelf) return;
    this.lastShelf = serialized;
    this.send(view);
  }

  private send(message: object): void {
    if (!this.child) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * The Droplet (stage 3): the notch retracts and a drop falls to where the ⌘2 bar is about to open. Resolves when the
   * helper says it landed, or after DROPLET_TIMEOUT_MS — the bar must open even if the animation never reports back.
   */
  playDroplet(to: DropletTarget, icon?: string): Promise<'landed' | 'timeout' | 'no-helper'> {
    if (!this.child) return Promise.resolve('no-helper');
    this.landing?.();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.landing = null; resolve('timeout'); }, DROPLET_TIMEOUT_MS);
      this.landing = () => { clearTimeout(timer); resolve('landed'); };
      this.send({ t: 'droplet', to, ...(icon ? { icon } : {}) });
    });
  }

  /** The Hatchback: a finished notch task's files onto the shelf, carrying the task and its check. */
  dock(paths: readonly string[], from: ShelfFrom): void {
    if (!this.options.shelf || !paths.length) return;
    this.options.shelf.add(paths.map((path) => ({ kind: 'file' as const, path, from })));
    this.sendShelf();
  }

  /**
   * The current tasks: always sent when they change, and anything worth saying about how they changed. Returns the
   * ⌘2 tasks that just finished, for the Hatchback.
   */
  update(threads: readonly ThreadSummary[]): ThreadSummary[] {
    const now = this.options.now?.() ?? Date.now();
    const finished = justFinished(this.previous, threads);
    for (const t of finished) this.unseen.set(t.id, { outcome: outcomeOf(t), title: t.title, at: now });
    this.threadsNow = threads;
    this.sendContent();
    for (const say of notchSays(this.previous, threads)) this.send(say);
    this.previous = new Map(threads.map((t) => [t.id, t]));
    return finished;
  }

  /** The tasks and the glass, sent when they differ from what the helper has; then the next timed change is armed. */
  private sendContent(): void {
    const now = this.options.now?.() ?? Date.now();
    const content: NotchContent = { ...notchContent(this.threadsNow), glass: notchGlass({ threads: this.threadsNow, now, night: this.options.nightIds?.(), unseen: this.unseen }) };
    const serialized = JSON.stringify(content);
    if (serialized !== this.lastContent) {
      this.lastContent = serialized;
      this.send(content);
    }
    if (this.glassTimer) clearTimeout(this.glassTimer);
    this.glassTimer = null;
    const next = nextGlassChange({ threads: this.threadsNow, now, unseen: this.unseen });
    // Only while the helper runs: a stopped notch has no glass to keep current.
    if (next !== null && this.child) this.glassTimer = setTimeout(() => { this.glassTimer = null; this.sendContent(); }, Math.max(1_000, next - now + 50));
  }

  stop(): void {
    this.stopped = true;
    if (this.glassTimer) clearTimeout(this.glassTimer);
    this.glassTimer = null;
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
