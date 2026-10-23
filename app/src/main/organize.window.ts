import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IpcGate } from './ipc.gate';
import type { ThreadSummary } from '../shared/threads';
import { applyPlan, cleanFolder, includeKept, keepFile, keepManual, manualEdits, moveFile, moveGroup, planConflicts, previewTree, receivePlan, type AppliedPlan, type OrganizePlan } from './organize.plan';
import { insideFolder } from './quick.context';
import { journalFile, threadStateRoot } from './thread.undo';

/**
 * The Organize preview (backlog FL2; FL3 revisions): the window, the plan waiting in it, and its channels. Moved out
 * of main/index.ts (flaw list C13); the plan logic itself is organize.plan.ts.
 */
export interface OrganizeHost {
  /** A new preview window — main/index.ts's auxiliaryWindow('organize'), which carries the app's window hardening. */
  createWindow(): BrowserWindow;
  summary(threadId: string): Pick<ThreadSummary, 'root' | 'origin'>;
  addNote(threadId: string, text: string): void;
  /** What the folder's rules protect; a plan that would move any of it is refused. */
  protectedIn(root: string): readonly string[];
}

let host: OrganizeHost = {
  createWindow: () => { throw new Error('The Organize preview is not set up yet.'); },
  summary: () => { throw new Error('The Organize preview is not set up yet.'); },
  addNote: () => undefined,
  protectedIn: () => [],
};
export function setOrganizeHost(next: OrganizeHost): void { host = next; }

/** The preview window's renderer, for the app's sender check and its channel allowlist; null while it is closed. */
export function organizeWebContentsId(): number | null {
  return organizeWindow && !organizeWindow.isDestroyed() ? organizeWindow.webContents.id : null;
}

let organizeWindow: BrowserWindow | null = null;
let organizing: OrganizePlan | null = null;
/** What the preview window shows: the tree, what blocks applying, and how many moves the person changed. */
export function organizeView(): unknown {
  if (!organizing) return null;
  return {
    id: organizing.id, title: organizing.title, root: organizing.root, total: organizing.moves.length,
    byYou: organizing.moves.filter((m) => m.byYou).length,
    tree: previewTree(organizing), conflicts: planConflicts(organizing, (file) => existsSync(file)),
    kept: (organizing.kept ?? []).map((m) => ({ from: path.relative(organizing!.root, m.from), to: path.relative(organizing!.root, m.to) })),
  };
}
/** The last plan applied in each folder, with each file's inode, so a revision can tell what the person moved since (FL3). */
const organizeHistoryFile = (): string => path.join(app.getPath('userData'), 'organize-history.json');
export function loadOrganizeHistory(): Record<string, AppliedPlan> {
  try { const raw = JSON.parse(readFileSync(organizeHistoryFile(), 'utf8')); return raw && typeof raw === 'object' ? raw : {}; } catch { return {}; }
}
function rememberApplied(plan: OrganizePlan): void {
  const placements = plan.moves.filter((m) => existsSync(m.to) && !existsSync(m.from)).map((m) => ({ path: m.to, ino: statSync(m.to).ino }));
  const all = loadOrganizeHistory();
  all[plan.root] = { root: plan.root, threadId: plan.threadId, at: Date.now(), title: plan.title, placements };
  try { writeFileSync(organizeHistoryFile(), JSON.stringify(all)); } catch { /* a revision then simply keeps nothing aside */ }
}
/** Where each wanted inode is now inside the folder, from one bounded walk (skipping .git and node_modules). */
function locateInodes(root: string, wanted: ReadonlySet<number>, limit = 20_000): Map<number, string> {
  const found = new Map<number, string>();
  const queue = [root];
  let seen = 0;
  while (queue.length && found.size < wanted.size && seen < limit) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > limit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '.git' && entry.name !== 'node_modules') queue.push(full); continue; }
      if (!entry.isFile()) continue;
      try { const ino = statSync(full).ino; if (wanted.has(ino)) found.set(ino, full); } catch { /* gone */ }
    }
  }
  return found;
}
function showOrganize(): void {
  if (!organizeWindow || organizeWindow.isDestroyed()) organizeWindow = host.createWindow();
  organizeWindow.setResizable(true);
  organizeWindow.webContents.send('organize:plan', organizeView());
  organizeWindow.show(); organizeWindow.focus();
}
/** A task proposed a plan: it replaces any plan still waiting (that task is told), and the preview opens. */
export function receiveOrganizePlan(threadId: string, raw: unknown): void {
  const root = host.summary(threadId).root;
  let plan = receivePlan(raw, threadId, root);
  if (!plan) return;
  // FL3: a revision keeps the files the person moved by hand since the last plan here where they put them.
  const applied = loadOrganizeHistory()[plan.root];
  if (applied) {
    const inodeAt = (file: string): number | null => { try { return statSync(file).ino; } catch { return null; } };
    const missing = applied.placements.filter((p) => inodeAt(p.path) !== p.ino);
    const where = missing.length ? locateInodes(plan.root, new Set(missing.map((p) => p.ino))) : new Map<number, string>();
    const byHand = new Set(manualEdits(applied, inodeAt, (ino) => where.get(ino) ?? null).map((e) => e.now).filter((p): p is string => !!p));
    plan = keepManual(plan, byHand);
    if (plan.kept?.length) host.addNote(threadId, `${plan.kept.length} file${plan.kept.length === 1 ? '' : 's'} you moved yourself since “${applied.title}” ${plan.kept.length === 1 ? 'is' : 'are'} kept where you put ${plan.kept.length === 1 ? 'it' : 'them'} (“Include anyway” in the preview).`);
    if (!plan.moves.length && !plan.kept?.length) return;
  }
  if (organizing && organizing.threadId !== threadId) host.addNote(organizing.threadId, 'Its organize plan was replaced by a newer one from another task, and nothing was moved.');
  organizing = plan;
  host.addNote(threadId, `A plan to move ${plan.moves.length} files is waiting in the Organize preview. Nothing moves until you apply it.`);
  showOrganize();
}
export async function applyOrganizePlan(): Promise<{ ok: boolean; error?: string }> {
  const plan = organizing;
  if (!plan) return { ok: false, error: 'There is no plan to apply.' };
  const summary = host.summary(plan.threadId);
  // Protected items (folder rules) never move, whoever planned it.
  const protect = host.protectedIn(plan.root);
  const guarded = plan.moves.find((m) => protect.some((p) => insideFolder(p, m.from) || insideFolder(p, m.to)));
  if (guarded) return { ok: false, error: `${path.relative(plan.root, guarded.from)} is protected by this folder's rules.` };
  const stateRoot = threadStateRoot(app.getPath('userData'), summary.root, summary.origin);
  try {
    const result = await applyPlan(plan, {
      exists: (file) => existsSync(file),
      mkdirp: async (dir) => { await fsp.mkdir(dir, { recursive: true }); },
      rename: (from, to) => fsp.rename(from, to),
      journal: async (line) => {
        await fsp.mkdir(path.dirname(journalFile(stateRoot)), { recursive: true });
        await fsp.appendFile(journalFile(stateRoot), `${JSON.stringify(line)}\n`, 'utf8');
      },
    }, Date.now());
    organizing = null;
    organizeWindow?.hide();
    rememberApplied(plan);
    const yours = plan.moves.filter((m) => m.byYou).length;
    host.addNote(plan.threadId, result.failed.length
      ? `Moved ${result.moved} of ${plan.moves.length} files, then stopped: ${path.basename(result.failed[0]!.from)} — ${result.failed[0]!.error}. ↶ Undo reverses the ones that moved.`
      : `Applied “${plan.title}”: moved ${result.moved} files${yours ? `, ${yours} where you put them` : ''}. ↶ Undo reverses the whole plan in one step.`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export function registerOrganizeIpc(ipc: IpcGate): void {
  // FL2: the Organize preview. Every change comes back as the whole view, so the window never holds its own copy.
  ipc.handle('organize:current', null as unknown, () => organizeView());
  ipc.handle('organize:move', null as unknown, (_e, from: unknown, rawFolder: unknown) => {
    const folder = cleanFolder(rawFolder);
    if (!organizing || typeof from !== 'string' || folder === null) return null;
    const moved = moveFile(organizing, path.resolve(organizing.root, from), folder);
    if (!moved) return null;
    organizing = moved.plan;
    return { view: organizeView(), offer: moved.others ? { group: moved.group, count: moved.others, folder } : null };
  });
  ipc.handle('organize:move-group', null as unknown, (_e, group: unknown, rawFolder: unknown) => {
    const folder = cleanFolder(rawFolder);
    if (!organizing || typeof group !== 'string' || folder === null) return null;
    organizing = moveGroup(organizing, group, folder);
    return organizeView();
  });
  ipc.handle('organize:keep', null as unknown, (_e, from: unknown) => {
    if (!organizing || typeof from !== 'string') return null;
    organizing = keepFile(organizing, path.resolve(organizing.root, from));
    if (!organizing.moves.length) { host.addNote(organizing.threadId, 'Every file was left where it is; nothing moved.'); organizing = null; organizeWindow?.hide(); }
    return organizeView();
  });
  ipc.handle('organize:include', null as unknown, (_e, from: unknown) => {
    if (!organizing || typeof from !== 'string') return null;
    organizing = includeKept(organizing, path.resolve(organizing.root, from));
    return organizeView();
  });
  ipc.handle('organize:apply', { ok: false } as { ok: boolean; error?: string }, () => applyOrganizePlan());
  ipc.handle('organize:cancel', false, () => {
    if (organizing) host.addNote(organizing.threadId, 'The organize plan was dismissed; nothing moved.');
    organizing = null;
    organizeWindow?.hide();
    return true;
  });
}
