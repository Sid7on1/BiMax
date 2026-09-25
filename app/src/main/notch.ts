import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { isQuickThread, threadActivity, type ThreadSummary } from '../shared/threads';
import type { ShelfFrom, ShelfInput, ShelfView } from './shelf';
import { nextGlassChange, notchGlass, outcomeOf, type Glass, type Unseen } from './glass';
import type { ClipView } from './clipboard';
import { isTransmutation, transmutationsFor, type Transmutation } from './transmute';
import { HISTORY, memoryGroups, mostRecent, predict, verdict as judge, type Activity, type ActivityKind, type Verdict } from './recall';

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

/** The extension each local action writes (the rest keep the source's). */
const OUT_EXT: Record<string, string> = { compress: '.jpg', avif: '.avif', heic: '.heic', png: '.png', jpeg: '.jpg', 'remove-background': '.png', 'pdf-compress': '.pdf', 'pdf-page1': '.pdf', 'pdf-flatten': '.pdf' };

/** A new, unused file name in `dir` for a result made from `source`: "report (compressed).jpg" style, numbered. */
export function madeName(dir: string, source: string, ext: string, exists: (file: string) => boolean = existsSync, keepExtension = false): string {
  const base = keepExtension ? path.basename(source) : path.basename(source, path.extname(source));
  // No leading dot: a result named ".env.example" would be hidden in Finder, where it is meant to be dragged from.
  const stem = base.replace(/^\.+/, '') || 'file';
  let candidate = path.join(dir, `${stem}${ext}`);
  for (let i = 2; exists(candidate); i++) candidate = path.join(dir, `${stem} ${i}${ext}`);
  return candidate;
}

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
  /** A sealed secret copy's plain text (stage 6), only for a reveal or a copy the person asked for. */
  reveal?(id: string): string | null;
}

/** Stage 7: one-tap conversions on shelf cards — the learned order, where results go, the one done in the app. */
export interface NotchTransmute {
  counts(): Record<string, number>;
  record(file: string, id: string): void;
  /** Where results are written: the helper may only write here, and a result elsewhere is refused. */
  madeDir: string;
  /** `.env` → `.env.example`, done in the app (it reads secret values, which stay in this process). Returns the file. */
  envExample(source: string, out: string): string | null;
}

/** Stage 8: the activity log (recall.ts) and the person's on/off choice. */
export interface NotchRecall {
  enabled(): boolean;
  record(input: { kind: ActivityKind; path: string; app?: string; task?: string }): unknown;
  all(): readonly Activity[];
  /** The replay's verdict each time it is worked out, so it can be kept beside the log. */
  onVerdict?(verdict: Verdict): void;
}
/** How many "Probably next" cards, and how many new events before the replay is worked out again. */
export const RECALL_NEXT = 3;
export const VERDICT_EVERY = 20;
/** Shelf cards already in view, which "Probably next" does not repeat. */
const SHELF_IN_VIEW = 6;

export interface RecallCard { id: string; kind: 'file'; title: string; path: string; missing: false; amber: false }
export interface RecallView { t: 'recall'; enabled: boolean; next: { label: string; items: RecallCard[] }; groups: Array<{ cue: string; items: RecallCard[] }> }

const recallCard = (file: string): RecallCard => ({ id: `recall:${file}`, kind: 'file', title: path.basename(file), path: file, missing: false, amber: false });

/**
 * What stage 8 shows: "Probably next" (the ranker's picks once it has beaten most-recent-first on this person's own
 * log, else plainly "Recent"), and the log grouped by the cues people remember. Only files that still exist.
 */
export function recallView(events: readonly Activity[], input: { enabled: boolean; now: number; app?: string; inView: readonly string[]; use: Verdict['use']; exists: (file: string) => boolean }): RecallView {
  if (!input.enabled) return { t: 'recall', enabled: false, next: { label: 'Recent', items: [] }, groups: [] };
  const recent = events.slice(-HISTORY).filter((e) => e.at <= input.now);
  const last = recent[recent.length - 1]?.path;
  const exclude = new Set([...input.inView, ...recent.map((e) => e.path).filter((p) => !input.exists(p))]);
  const rank = input.use === 'predict' ? predict : mostRecent;
  const next = rank(recent, { now: input.now, app: input.app, last, exclude }, RECALL_NEXT);
  return {
    t: 'recall', enabled: true,
    next: { label: input.use === 'predict' ? 'Probably next' : 'Recent', items: next.map(recallCard) },
    groups: memoryGroups(recent, input.now, input.exists).map((g) => ({ cue: g.cue, items: g.paths.map(recallCard) })),
  };
}

/** Stage 6: secrets found in `.env` files of the folders opened in Bimax (secrets.ts). */
export interface NotchSecrets {
  scan(): Array<{ id: string; label: string; key: string; masked: string; where: string; value: string }>;
}
/** How often opening the notch may rescan the folders. */
export const SECRET_RESCAN_MS = 30_000;

export interface NotchDeckOptions {
  helper: string;
  onOpenTask: (id: string) => void;
  /** The shelf (stage 2); without one the notch has no shelf. */
  shelf?: NotchShelf;
  /** Files handed to "Edit with Bimax" (stage 3): the app plays the Droplet and opens the ⌘2 bar with them — and, from a
   * stage 7 action, the request already written. */
  onEdit?: (paths: string[], prompt?: string) => void;
  /** Stage 7: one-tap conversions. */
  transmute?: NotchTransmute;
  /** Stage 5: the smart clipboard. Off until the person turns it on; without it the notch has no clipboard. */
  clipboard?: NotchClipboard;
  /** Stage 6: secrets from `.env` files; values stay here until the notch asks for one. */
  secrets?: NotchSecrets;
  /** Stage 8: find by vague memory, and predictive cards. */
  recall?: NotchRecall;
  /** Whether a file is still there (tests pass their own). */
  exists?: (file: string) => boolean;
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
  private lastSecrets = '';
  private secretValues = new Map<string, string>();
  private lastScan = -Infinity;
  private landing: (() => void) | null = null;
  /** Stage 4: results the person has not looked at (cleared when the notch opens), and the next timed change. */
  private unseen = new Map<string, Unseen>();
  private threadsNow: readonly ThreadSummary[] = [];
  private glassTimer: NodeJS.Timeout | null = null;
  private previous = new Map<string, ThreadSummary>();
  /** Stage 8: the app in front (the helper reports each change), the replay's last verdict, and what recall shows. */
  private frontApp: string | undefined;
  private recallVerdict: Verdict | null = null;
  private verdictAt = 0;
  private recallPaths = new Set<string>();
  private lastRecall = '';

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
      this.lastSecrets = '';
      this.lastRecall = '';
      if (this.stopped) return;
      this.options.log?.(`notch helper exited code=${code} signal=${signal ?? '-'}`);
      this.crashes.push(Date.now());
      if (mayRestart(this.crashes, Date.now())) setTimeout(() => this.start(), 1_000);
      else this.options.log?.('notch helper keeps exiting; left off until Bimax restarts');
    });
  }

  private received(line: string): void {
    let message: { t?: string; id?: unknown; items?: unknown; ids?: unknown; amber?: unknown; open?: unknown; text?: unknown; source?: unknown; pinned?: unknown; purpose?: unknown; action?: unknown; path?: unknown; note?: unknown; copied?: unknown; error?: unknown; app?: unknown };
    try { message = JSON.parse(line); } catch { return; }
    const shelf = this.options.shelf;
    if (message.t === 'open-task' && typeof message.id === 'string') this.options.onOpenTask(message.id);
    else if (message.t === 'ready') {
      this.options.log?.(`notch helper ready: ${line}`);
      if (typeof message.app === 'string') this.frontApp = message.app.slice(0, 60) || undefined;
      this.sendShelf(); this.sendClips(true); this.refreshSecrets(true); this.sendRecall();
    }
    else if (message.t === 'front') this.frontApp = typeof message.app === 'string' ? message.app.slice(0, 60) || undefined : undefined;
    else if (message.t === 'hover' && message.open === true) {
      this.sendShelf(); // amber and missing change with time
      this.refreshSecrets();
      this.sendRecall(); // "Probably next" depends on the app in front and the time
      // Opening the notch is looking: the unseen results have been seen.
      if (this.unseen.size) { this.unseen.clear(); this.sendContent(); }
    }
    else if (shelf && message.t === 'shelf-add') {
      const inputs = shelfInputs(message.items);
      shelf.add(inputs);
      for (const i of inputs) if (i.kind === 'file' && i.path && path.isAbsolute(i.path)) this.note('drop', i.path);
      this.sendShelf();
    }
    else if (message.t === 'shelf-touch' && typeof message.id === 'string' && message.id.startsWith('recall:')) {
      // A recall card looked at, copied or dragged out: only a file recall is showing counts.
      const file = message.id.slice('recall:'.length);
      if (this.recallPaths.has(file)) this.note('use', file);
    }
    else if (shelf && message.t === 'shelf-touch' && typeof message.id === 'string') {
      const card = shelf.view().items.find((c) => c.id === message.id);
      if (shelf.touch(message.id)) { if (card?.kind === 'file' && card.path) this.note('use', card.path); this.sendShelf(); }
    }
    else if (shelf && message.t === 'recall-keep' && typeof message.path === 'string' && this.recallPaths.has(message.path)) {
      shelf.add([{ kind: 'file', path: message.path }]);
      this.note('use', message.path);
      this.sendShelf();
      this.sendRecall();
    }
    else if (shelf && message.t === 'shelf-archive') {
      const ids = Array.isArray(message.ids) ? message.ids.filter((id): id is string => typeof id === 'string') : undefined;
      if (shelf.archive({ ids, amber: message.amber === true })) this.sendShelf();
    }
    else if (shelf && message.t === 'shelf-restore' && typeof message.id === 'string') { if (shelf.restore(message.id)) this.sendShelf(); }
    else if (message.t === 'edit') {
      // Absolute paths only: a relative one would resolve against wherever the app happens to run.
      const paths = shelfInputs(message.items).filter((i) => i.kind === 'file' && i.path && path.isAbsolute(i.path)).map((i) => i.path!);
      for (const file of paths) this.note('edit', file);
      if (paths.length) this.options.onEdit?.(paths);
    }
    else if (message.t === 'droplet-landed') { this.landing?.(); this.landing = null; }
    else if (message.t === 'transmute' && typeof message.id === 'string' && typeof message.action === 'string') this.transmute(message.id, message.action);
    else if (message.t === 'made') this.made(message);
    else if (message.t === 'secret-value' && typeof message.id === 'string') this.sendSecret(message.id, message.purpose === 'copy' ? 'copy' : 'reveal');
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

  /**
   * Stage 6. The secrets list the helper shows — masked, with where each came from — rescanned when the notch opens, at
   * most every SECRET_RESCAN_MS. The values stay in this process.
   */
  refreshSecrets(force = false): void {
    if (!this.options.secrets) return;
    const now = this.options.now?.() ?? Date.now();
    if (!force && now - this.lastScan < SECRET_RESCAN_MS) return;
    this.lastScan = now;
    let entries: ReturnType<NotchSecrets['scan']>;
    try { entries = this.options.secrets.scan(); } catch (error) { this.options.log?.(`secret scan failed: ${String(error)}`); return; }
    this.secretValues = new Map(entries.map((e) => [e.id, e.value]));
    const view = { t: 'secrets', items: entries.map(({ id, label, key, masked, where }) => ({ id, label, key, masked, where })) };
    const serialized = JSON.stringify(view);
    if (serialized === this.lastSecrets) return;
    this.lastSecrets = serialized;
    this.send(view);
  }

  /** One secret's value, because the person pressed to reveal it or authenticated to copy it. Never logged. */
  private sendSecret(id: string, purpose: 'reveal' | 'copy'): void {
    const value = this.secretValues.get(id) ?? this.options.clipboard?.reveal?.(id) ?? null;
    this.send(value === null ? { t: 'secret', id, purpose, missing: true } : { t: 'secret', id, purpose, value });
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

  /**
   * Stage 7. A card's action, checked against that file's own actions (the helper's word is not trusted). A task opens
   * the ⌘2 bar with the request written; `.env.example` is made here; anything else the helper makes, into madeDir.
   */
  private transmute(cardId: string, action: string): void {
    const tools = this.options.transmute;
    const card = this.options.shelf?.view().items.find((c) => c.id === cardId);
    if (!tools || !card || card.kind !== 'file' || !card.path || card.missing) return;
    const known = isTransmutation(card.path, action);
    if (!known) return;
    tools.record(card.path, action);
    this.note(known.kind === 'task' ? 'edit' : 'use', card.path);
    if (known.kind === 'task') {
      this.options.onEdit?.([card.path], known.prompt);
    } else if (action === 'env-example') {
      const out = madeName(tools.madeDir, card.path, '.example', existsSync, true);
      const made = tools.envExample(card.path, out);
      if (made) this.dock([made], { task: `${known.label} from ${path.basename(card.path)}` }, 'made');
      this.send({ t: 'say', text: made ? `Made ${path.basename(out)} — secrets replaced` : 'Could not make the example file', tone: made ? 'done' : 'failed', seconds: 2.5 });
    } else {
      this.send({ t: 'transmute-run', id: cardId, action, source: card.path, out: madeName(tools.madeDir, card.path, OUT_EXT[action] ?? path.extname(card.path)), label: known.label });
    }
    this.sendShelf(true);
  }

  /** The helper made something. Only a file inside madeDir is kept; a copy to the clipboard only counts. */
  private made(message: { source?: unknown; path?: unknown; note?: unknown; copied?: unknown; error?: unknown }): void {
    const tools = this.options.transmute;
    if (!tools || typeof message.path !== 'string' || message.copied === true || typeof message.error === 'string') return;
    const inside = path.resolve(message.path).startsWith(path.resolve(tools.madeDir) + path.sep);
    if (!inside) { this.options.log?.(`made file outside ${tools.madeDir} refused`); return; }
    const note = typeof message.note === 'string' ? message.note.slice(0, 120) : 'Made';
    this.dock([message.path], { task: note }, 'made');
  }

  private sendShelf(force = false): void {
    if (!this.options.shelf) return;
    let view: ShelfView;
    try { view = this.options.shelf.view(); } catch (error) { this.options.log?.(`shelf unreadable: ${String(error)}`); return; }
    // Stage 7: each usable file card carries its actions, most used first for its type.
    const counts = this.options.transmute?.counts() ?? {};
    if (this.options.transmute) {
      view = { ...view, items: view.items.map((c) => (c.kind === 'file' && c.path && !c.missing ? { ...c, actions: transmutationsFor(c.path, counts) } : c)) };
    }
    if (force) this.lastShelf = '';
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
  dock(paths: readonly string[], from: ShelfFrom, kind: 'task-out' | 'made' = 'task-out'): void {
    if (!this.options.shelf || !paths.length) return;
    this.options.shelf.add(paths.map((path) => ({ kind: 'file' as const, path, from })));
    // A task's files are remembered by its name; a one-tap result's "task" is only a note ("Compressed −40%").
    for (const file of paths) this.note(kind, file, kind === 'task-out' ? from.task : undefined);
    this.sendShelf();
  }

  /** Stage 8: one thing done with a file, with the app in front — only while the person has recall on. */
  private note(kind: ActivityKind, file: string, task?: string): void {
    const recall = this.options.recall;
    if (!recall?.enabled()) return;
    try { recall.record({ kind, path: file, ...(this.frontApp ? { app: this.frontApp } : {}), ...(task ? { task } : {}) }); }
    catch (error) { this.options.log?.(`activity not recorded: ${String(error)}`); }
  }

  /** Stage 8: "Probably next" and the recall groups, worked out when the notch opens; the replay every few events. */
  sendRecall(): void {
    const recall = this.options.recall;
    if (!recall) return;
    const events = recall.enabled() ? recall.all() : [];
    if (recall.enabled() && (!this.recallVerdict || events.length - this.verdictAt >= VERDICT_EVERY)) {
      this.recallVerdict = judge(events);
      this.verdictAt = events.length;
      recall.onVerdict?.(this.recallVerdict);
    }
    const inView = (this.options.shelf?.view().items ?? []).slice(0, SHELF_IN_VIEW).flatMap((c) => (c.path ? [c.path] : []));
    const view = recallView(events, {
      enabled: recall.enabled(), now: this.options.now?.() ?? Date.now(), app: this.frontApp, inView,
      use: this.recallVerdict?.use ?? 'recent', exists: this.options.exists ?? existsSync,
    });
    this.recallPaths = new Set([...view.next.items, ...view.groups.flatMap((g) => g.items)].map((c) => c.path));
    const serialized = JSON.stringify(view);
    if (serialized === this.lastRecall) return;
    this.lastRecall = serialized;
    this.send(view);
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
