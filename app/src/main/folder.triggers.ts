import path from 'node:path';

/**
 * Folders that act (backlog FL1; design in docs/product-reset/53_FOLDER_TRIGGERS_DESIGN.md): "when a PDF arrives in
 * Downloads, rename it and file it". A trigger runs a ⌘2 task on files that arrive directly inside its folder while
 * Bimax is open. Each run is a new task that asks before changing anything, like every task, and ends with a list of
 * what it changed.
 *
 * Everything that touches the disk, the clock or Electron comes in through `TriggerDeps`, so arrivals, settling,
 * limits and loop protection are tested without them. What stops a trigger from feeding itself:
 * - a file is known by its inode, so renaming a file in place is not an arrival;
 * - what a run changed through Bimax's undo journal is its own output, never an arrival;
 * - anything else that appeared while a run was working makes the next run a follow-up, and a follow-up that also
 *   leaves new files pauses the trigger instead of running a third time;
 * - one run at a time, at most six an hour, and none while another task works in the folder (the app says 'busy').
 */

export type ArrivalKind = 'any' | 'pdf' | 'image' | 'document';

export interface FolderTrigger {
  id: string;
  /** The task's title, for menus and notifications. */
  title: string;
  root: string;
  prompt: string;
  model?: string;
  kind: ArrivalKind;
  enabled: boolean;
  createdAt: number;
  /** Why a limit paused it, shown in the menu until it is resumed. */
  pausedReason?: string;
}

export const ARRIVAL_KINDS: readonly ArrivalKind[] = ['any', 'pdf', 'image', 'document'];
export const MAX_TRIGGERS = 20;
export const MAX_RUNS_PER_HOUR = 6;
export const MAX_FILES_PER_RUN = 50;
/** A new file must keep its size and modification time this long before a run takes it: a download may still be growing. */
export const SETTLE_MS = 3_000;
/** A run stops waiting for a file that has been changing for this long. */
export const MAX_BATCH_WAIT_MS = 60_000;
/** A folder watch can drop events, so the folder is also listed this often. */
export const RESCAN_MS = 60_000;
/** After the watch reports a change, look this much later, so a burst of events is one listing. */
export const CHANGE_DELAY_MS = 1_000;
/** Four tasks are running, or a task works in the folder: try again this much later. */
export const BUSY_RETRY_MS = 30_000;

const HOUR = 60 * 60 * 1000;

const KIND_EXTENSIONS: Record<Exclude<ArrivalKind, 'any'>, ReadonlySet<string>> = {
  pdf: new Set(['.pdf']),
  image: new Set(['.png', '.jpg', '.jpeg', '.heic', '.heif', '.gif', '.webp', '.tif', '.tiff', '.bmp']),
  document: new Set(['.pdf', '.doc', '.docx', '.pages', '.txt', '.rtf', '.md', '.odt', '.xls', '.xlsx', '.numbers', '.csv', '.ppt', '.pptx', '.key']),
};
const KIND_WORDS: Record<ArrivalKind, string> = { any: 'a new file', pdf: 'a new PDF', image: 'a new image', document: 'a new document' };
const KIND_LABELS: Record<ArrivalKind, string> = { any: 'Any new file', pdf: 'A new PDF', image: 'A new image', document: 'A new document' };
/** Downloads still in progress, by browser and download manager. */
const UNFINISHED = /\.(crdownload|download|part|partial|tmp|opdownload|aria2)$/i;

/** A file a trigger may take: not hidden, not an Office lock file, not an unfinished download, and of the trigger's kind. */
export function arrivalMatches(name: string, kind: ArrivalKind): boolean {
  if (!name || name.startsWith('.') || name.startsWith('~$') || name === 'Icon\r' || UNFINISHED.test(name)) return false;
  return kind === 'any' || KIND_EXTENSIONS[kind].has(path.extname(name).toLowerCase());
}

export const arrivalLabel = (kind: ArrivalKind): string => KIND_LABELS[kind];

export function describeTrigger(trigger: Pick<FolderTrigger, 'kind' | 'root'>): string {
  return `When ${KIND_WORDS[trigger.kind]} arrives in ${path.basename(trigger.root) || trigger.root}`;
}

/** A trigger never watches the whole disk or the whole home folder. */
export function triggerFolderProblem(root: string, home: string): string | null {
  const folder = path.resolve(root);
  return folder === path.parse(folder).root || folder === path.resolve(home) ? 'Choose a specific folder, not your whole home folder' : null;
}

export function newTrigger(input: { id: string; title: string; root: string; prompt: string; model?: string; kind: ArrivalKind; now: number }): FolderTrigger {
  return {
    id: input.id, title: input.title, root: input.root, prompt: input.prompt, ...(input.model ? { model: input.model } : {}),
    kind: input.kind, enabled: true, createdAt: input.now,
  };
}

/** Triggers read back from settings are re-checked, since settings.json can be edited by hand. */
export function validTriggers(raw: unknown, home: string): FolderTrigger[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t: any): t is FolderTrigger => !!t && typeof t === 'object'
    && typeof t.id === 'string' && typeof t.title === 'string' && typeof t.prompt === 'string' && !!t.prompt.trim()
    && typeof t.root === 'string' && path.isAbsolute(t.root) && !triggerFolderProblem(t.root, home)
    && ARRIVAL_KINDS.includes(t.kind) && typeof t.enabled === 'boolean' && typeof t.createdAt === 'number')
    .slice(0, MAX_TRIGGERS);
}

/** What a run's task receives (the task's words, then the files) and what its thread shows. */
export function runMessage(trigger: FolderTrigger, files: string[]): { text: string; display: string } {
  const folder = path.basename(trigger.root) || trigger.root;
  const names = files.map((file) => path.basename(file));
  const shown = names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
  const which = files.length === 1 ? 'this file' : `these ${files.length} files`;
  return {
    text: `${trigger.prompt}\n\n[Folder trigger: ${which} just arrived in ${folder}. Work on ${files.length === 1 ? 'it' : 'them'} only, not on other files in the folder.]\n${files.map((file) => `- ${file}`).join('\n')}`,
    display: `${trigger.prompt}\n\nNew in ${folder}: ${shown}`,
  };
}

export interface RunChanges {
  /** The journal's titles, oldest first, for the run's change list. */
  titles: string[];
  /** Every path a change created, moved to or replaced: the run's own output. */
  paths: Set<string>;
}

/** The changes recorded in a folder's undo journal (src/tools/thread.journal.ts) between two times, inclusive. */
export function changesDuring(journal: string, from: number, to: number): RunChanges {
  const titles: string[] = [];
  const paths = new Set<string>();
  for (const line of journal.split('\n')) {
    if (!line.trim()) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'change' || typeof record.at !== 'number' || record.at < from || record.at > to || !Array.isArray(record.ops)) continue;
    if (typeof record.title === 'string') titles.push(record.title);
    for (const op of record.ops) {
      if ((op?.op === 'create' || op?.op === 'restore') && typeof op.path === 'string') paths.add(op.path);
      else if (op?.op === 'move' && typeof op.to === 'string') paths.add(op.to);
    }
  }
  return { titles, paths };
}

/** The note a run's task ends with. Shell commands are not in the journal, so the note never calls them undoable. */
export function changeListNote(titles: string[]): string {
  if (!titles.length) return 'This run made no changes that ↶ Undo can reverse.';
  const more = titles.length > 10 ? `; and ${titles.length - 10} more` : '';
  return `What this run changed (↶ Undo reverses them one at a time, newest first): ${titles.slice(0, 10).join('; ')}${more}.`;
}

export interface FolderEntry { name: string; ino: number; size: number; mtimeMs: number }
export type StartResult = { threadId: string } | 'busy' | { error: string };

export interface TriggerDeps {
  /** The files directly inside a folder, not in its subfolders. Throws when the folder cannot be read. */
  list(root: string): Promise<FolderEntry[]> | FolderEntry[];
  /** Calls `changed` when something in the folder may have changed; returns a function that stops watching. */
  watch(root: string, changed: () => void): () => void;
  /** Runs `fn` after `ms`; returns a function that cancels it. */
  timer(fn: () => void, ms: number): () => void;
  now(): number;
  /** Starts a run as a new ⌘2 task. 'busy' when it cannot start yet: four tasks running, or a task working in the folder. */
  start(trigger: FolderTrigger, files: string[], followUp: boolean): StartResult;
  /** Whether a run's task is still starting, working, waiting for the person or holding a message. */
  active(threadId: string): boolean;
  /** What the folder's undo journal recorded between two times. */
  changes(trigger: FolderTrigger, from: number, to: number): RunChanges;
  /** A run is over: show its change list in its task. */
  report(threadId: string, titles: string[]): void;
  /** A limit or an unreadable folder paused the trigger: save that and tell the person, naming the files it did not take. */
  paused(trigger: FolderTrigger, reason: string, files: string[]): void;
}

interface Arrival { name: string; size: number; mtimeMs: number; firstSeen: number; stableSince: number }

interface Watch {
  trigger: FolderTrigger;
  ready: boolean;
  closed: boolean;
  /** Inodes of complete files that were already in the folder, were handed to a run, or are not of the trigger's kind. */
  seen: Set<number>;
  /** New files of the trigger's kind, not yet handed to a run. */
  arrivals: Map<number, Arrival>;
  /** New files that appeared while a run was working and were not its journaled output: their run is a follow-up. */
  duringRun: Set<number>;
  run?: { threadId: string; startedAt: number; followUp: boolean };
  /** When runs started, for the hourly limit. */
  runs: number[];
  unwatch: () => void;
  cancelTimer?: () => void;
  dueAt?: number;
  scanning: boolean;
  again: boolean;
}

const pathKey = (p: string, platform: NodeJS.Platform): string =>
  platform === 'darwin' || platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);

const unreadable = (trigger: FolderTrigger, error: unknown): string =>
  `Bimax can’t read ${path.basename(trigger.root) || trigger.root}: ${(error as Error)?.message ?? String(error)}`;

export class FolderTriggers {
  private watches = new Map<string, Watch>();
  constructor(private deps: TriggerDeps, private platform: NodeJS.Platform = process.platform) {}

  /** Watch the enabled triggers in `list` and stop watching the rest. A trigger that starts or resumes counts from now. */
  async sync(list: readonly FolderTrigger[]): Promise<void> {
    const wanted = new Map(list.filter((t) => t.enabled).map((t) => [t.id, t]));
    for (const [id, w] of this.watches) {
      const next = wanted.get(id);
      if (!next || next.root !== w.trigger.root || next.kind !== w.trigger.kind) this.close(w);
      else w.trigger = next;
    }
    await Promise.all([...wanted.values()].filter((t) => !this.watches.has(t.id)).map((t) => this.open(t)));
  }

  /** The ids of the triggers being watched. */
  watching(): string[] {
    return [...this.watches.keys()];
  }

  /** A task's turn ended: its run may be over, and a trigger that waited for the folder may start now. */
  finished(threadId: string): void {
    for (const w of this.watches.values()) {
      if (w.run?.threadId === threadId || (!w.run && w.arrivals.size)) this.later(w, CHANGE_DELAY_MS);
    }
  }

  stop(): void {
    for (const w of [...this.watches.values()]) this.close(w);
  }

  private async open(trigger: FolderTrigger): Promise<void> {
    const w: Watch = {
      trigger, ready: false, closed: false, seen: new Set(), arrivals: new Map(), duringRun: new Set(), runs: [],
      unwatch: () => {}, scanning: false, again: false,
    };
    this.watches.set(trigger.id, w);
    let entries: FolderEntry[];
    try {
      entries = await this.deps.list(trigger.root);
    } catch (error) {
      return this.pause(w, unreadable(trigger, error), []);
    }
    if (w.closed) return;
    // What is already there is never an arrival. An unfinished download is not a file yet, so finishing it is one.
    for (const entry of entries) if (arrivalMatches(entry.name, 'any')) w.seen.add(entry.ino);
    w.ready = true;
    w.unwatch = this.deps.watch(trigger.root, () => this.later(w, CHANGE_DELAY_MS));
    this.later(w, RESCAN_MS);
  }

  /** Look at the folder in `ms`, unless a look is already due sooner. */
  private later(w: Watch, ms: number): void {
    if (w.closed) return;
    const at = this.deps.now() + ms;
    if (w.cancelTimer && w.dueAt !== undefined && w.dueAt <= at) return;
    w.cancelTimer?.();
    w.dueAt = at;
    w.cancelTimer = this.deps.timer(() => {
      w.cancelTimer = undefined;
      w.dueAt = undefined;
      void this.scan(w);
    }, ms);
  }

  private async scan(w: Watch): Promise<void> {
    if (w.closed || !w.ready) return;
    if (w.scanning) {
      w.again = true;
      return;
    }
    w.scanning = true;
    let delay = RESCAN_MS;
    try {
      let entries: FolderEntry[];
      try {
        entries = await this.deps.list(w.trigger.root);
      } catch (error) {
        this.pause(w, unreadable(w.trigger, error), [...w.arrivals.values()].map((a) => path.join(w.trigger.root, a.name)));
        return;
      }
      if (w.closed) return;
      const now = this.deps.now();
      this.update(w, entries, now);
      if (w.run && !this.deps.active(w.run.threadId) && !this.finishRun(w, entries, now)) return;
      if (!w.run) delay = this.dispatch(w, now);
    } finally {
      w.scanning = false;
      if (w.again) {
        w.again = false;
        this.later(w, 0);
      } else {
        this.later(w, delay);
      }
    }
  }

  /** Record new files and how they changed; forget files that are gone, so a reused inode counts as new. */
  private update(w: Watch, entries: FolderEntry[], now: number): void {
    const present = new Set(entries.map((entry) => entry.ino));
    for (const ino of w.seen) if (!present.has(ino)) w.seen.delete(ino);
    for (const ino of w.duringRun) if (!present.has(ino)) w.duringRun.delete(ino);
    for (const ino of w.arrivals.keys()) if (!present.has(ino)) w.arrivals.delete(ino);
    for (const entry of entries) {
      if (w.seen.has(entry.ino) || !arrivalMatches(entry.name, 'any')) continue;
      if (!arrivalMatches(entry.name, w.trigger.kind)) {
        w.seen.add(entry.ino);
        w.arrivals.delete(entry.ino);
        continue;
      }
      const known = w.arrivals.get(entry.ino);
      if (known && known.name === entry.name && known.size === entry.size && known.mtimeMs === entry.mtimeMs) continue;
      w.arrivals.set(entry.ino, { name: entry.name, size: entry.size, mtimeMs: entry.mtimeMs, firstSeen: known?.firstSeen ?? now, stableSince: now });
    }
  }

  /**
   * The run's task is over. New files it recorded in the undo journal are its own output; any other file that appeared
   * during the run makes the next run a follow-up. Returns false when the trigger paused.
   */
  private finishRun(w: Watch, entries: FolderEntry[], now: number): boolean {
    const run = w.run!;
    w.run = undefined;
    const changes = this.deps.changes(w.trigger, run.startedAt, now);
    this.deps.report(run.threadId, changes.titles);
    const own = new Set([...changes.paths].map((p) => pathKey(p, this.platform)));
    const left: string[] = [];
    for (const entry of entries) {
      const arrival = w.arrivals.get(entry.ino);
      // Files that were already waiting when the run started (over the 50-file limit, or still growing) are not its doing.
      if (!arrival || arrival.firstSeen <= run.startedAt) continue;
      const file = path.join(w.trigger.root, entry.name);
      if (own.has(pathKey(file, this.platform))) {
        w.arrivals.delete(entry.ino);
        w.seen.add(entry.ino);
      } else {
        w.duringRun.add(entry.ino);
        left.push(file);
      }
    }
    if (run.followUp && left.length) {
      this.pause(w, 'Its runs keep leaving new files in the folder, so it may be starting itself again and again.', left);
      return false;
    }
    return true;
  }

  /** Start a run on the files that stopped changing, or say how long to wait before looking again. */
  private dispatch(w: Watch, now: number): number {
    if (!w.arrivals.size) return RESCAN_MS;
    const growing = [...w.arrivals.values()].filter((a) => now - a.stableSince < SETTLE_MS);
    // An empty file is not ready: Firefox creates one as a placeholder before the download lands.
    const ready = [...w.arrivals].filter(([, a]) => a.size > 0 && now - a.stableSince >= SETTLE_MS);
    if (!ready.length) return growing.length ? SETTLE_MS : RESCAN_MS;
    // Files arriving together go in one run: wait for ones still being written, unless they have been changing for a minute.
    if (growing.some((a) => now - a.firstSeen < MAX_BATCH_WAIT_MS)) return SETTLE_MS;
    const batch = ready
      .sort(([, a], [, b]) => a.firstSeen - b.firstSeen || a.name.localeCompare(b.name))
      .slice(0, MAX_FILES_PER_RUN);
    const files = batch.map(([, a]) => path.join(w.trigger.root, a.name));
    w.runs = w.runs.filter((at) => now - at < HOUR);
    if (w.runs.length >= MAX_RUNS_PER_HOUR) {
      this.pause(w, `It already ran ${MAX_RUNS_PER_HOUR} times in the last hour.`, files);
      return RESCAN_MS;
    }
    const followUp = batch.some(([ino]) => w.duringRun.has(ino));
    const result = this.deps.start(w.trigger, files, followUp);
    if (result === 'busy') return BUSY_RETRY_MS;
    if ('error' in result) {
      this.pause(w, `Bimax could not start it: ${result.error}`, files);
      return RESCAN_MS;
    }
    for (const [ino] of batch) {
      w.arrivals.delete(ino);
      w.duringRun.delete(ino);
      w.seen.add(ino);
    }
    w.runs.push(now);
    w.run = { threadId: result.threadId, startedAt: now, followUp };
    return RESCAN_MS;
  }

  private pause(w: Watch, reason: string, files: string[]): void {
    this.close(w);
    this.deps.paused(w.trigger, reason, files);
  }

  private close(w: Watch): void {
    if (w.closed) return;
    w.closed = true;
    w.cancelTimer?.();
    w.cancelTimer = undefined;
    w.unwatch();
    if (this.watches.get(w.trigger.id) === w) this.watches.delete(w.trigger.id);
  }
}
