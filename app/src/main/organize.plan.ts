import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { insideFolder } from './quick.context';

/**
 * A preview you can rearrange (backlog FL2). A task proposes how to organize files (the engine's OrganizePlanTool);
 * Bimax shows the proposed folder tree. Dragging one file to another folder moves it there and offers "Put all
 * <its group> here?", which moves every file of that group; the preview updates each time. Nothing moves until the
 * person applies the plan, and then the moves are made in one step that ↶ Undo reverses as a whole.
 *
 * Pure except `applyPlan`, whose file operations are injected, so every rule is tested without a disk.
 */

export interface PlanMove { from: string; to: string; group: string; /** The person put it here, not the task. */ byYou?: boolean }
export interface OrganizePlan {
  id: string; threadId: string; root: string; title: string; moves: PlanMove[];
  /** A revision's moves of files the person had placed by hand since the last plan: kept out unless included (FL3). */
  kept?: PlanMove[];
}

/** A plan from the engine, re-checked: paths absolute and inside the folder, a group each, at most 2000 moves. */
export function receivePlan(raw: unknown, threadId: string, root: string): OrganizePlan | null {
  const value = raw as { id?: unknown; title?: unknown; moves?: unknown } | null;
  if (!value || !Array.isArray(value.moves)) return null;
  const moves: PlanMove[] = [];
  for (const m of value.moves.slice(0, 2000) as Array<Record<string, unknown>>) {
    if (typeof m?.from !== 'string' || typeof m?.to !== 'string' || !path.isAbsolute(m.from) || !path.isAbsolute(m.to)) continue;
    const from = path.resolve(m.from);
    const to = path.resolve(m.to);
    if (from === to || !insideFolder(root, from) || !insideFolder(root, to) || from === path.resolve(root) || to === path.resolve(root)) continue;
    moves.push({ from, to, group: typeof m.group === 'string' && m.group.trim() ? m.group.trim().slice(0, 60) : 'Other files' });
  }
  if (!moves.length) return null;
  return {
    id: typeof value.id === 'string' ? value.id.slice(0, 40) : randomUUID().slice(0, 8),
    threadId, root: path.resolve(root),
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 120) : `Organize ${moves.length} files`,
    moves,
  };
}

export interface PreviewFolder { folder: string; files: Array<{ name: string; from: string; group: string; byYou: boolean }> }

/** The proposed tree: each destination folder (relative, '' for the top) with the files that would land there. */
export function previewTree(plan: OrganizePlan): PreviewFolder[] {
  const folders = new Map<string, PreviewFolder>();
  for (const move of plan.moves) {
    const folder = path.relative(plan.root, path.dirname(move.to));
    if (!folders.has(folder)) folders.set(folder, { folder, files: [] });
    folders.get(folder)!.files.push({ name: path.basename(move.to), from: path.relative(plan.root, move.from), group: move.group, byYou: move.byYou === true });
  }
  for (const entry of folders.values()) entry.files.sort((a, b) => a.name.localeCompare(b.name));
  return [...folders.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

/** A destination folder the person typed or dropped on: relative, inside the plan's folder, no "..". */
export function cleanFolder(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const folder = raw.trim().replace(/^\/+|\/+$/g, '');
  if (folder.length > 200 || /[\u0000-\u001f]/.test(folder) || folder.split('/').some((part) => part === '..' || part === '.')) return null;
  return folder;
}

/** Move one file (by where it comes from) into a folder. Returns the new plan and how many others share its group. */
export function moveFile(plan: OrganizePlan, from: string, folder: string): { plan: OrganizePlan; group: string; others: number } | null {
  const target = plan.moves.find((m) => m.from === from);
  if (!target) return null;
  const moves = plan.moves.map((m) => (m === target ? { ...m, to: path.join(plan.root, folder, path.basename(m.to)), byYou: true } : m));
  const others = moves.filter((m) => m.group === target.group && m.from !== from && path.dirname(m.to) !== path.join(plan.root, folder)).length;
  return { plan: { ...plan, moves }, group: target.group, others };
}

/** "Put all Invoices here?" — every file of the group goes to the folder, keeping its name. */
export function moveGroup(plan: OrganizePlan, group: string, folder: string): OrganizePlan {
  const dir = path.join(plan.root, folder);
  return { ...plan, moves: plan.moves.map((m) => (m.group === group && path.dirname(m.to) !== dir ? { ...m, to: path.join(dir, path.basename(m.to)), byYou: true } : m)) };
}

/** Leave a file where it is: its move is dropped from the plan. */
export function keepFile(plan: OrganizePlan, from: string): OrganizePlan {
  return { ...plan, moves: plan.moves.filter((m) => m.from !== from) };
}

/** What stops the plan from being applied: two files onto one name, or onto a file that stays. */
export function planConflicts(plan: OrganizePlan, exists: (file: string) => boolean): string[] {
  const problems: string[] = [];
  const sources = new Set(plan.moves.map((m) => m.from));
  const seen = new Map<string, string>();
  for (const move of plan.moves) {
    const key = move.to.toLowerCase();
    const rel = path.relative(plan.root, move.to);
    if (seen.has(key)) problems.push(`Two files would be named ${rel}`);
    seen.set(key, move.from);
    if (move.to !== move.from && exists(move.to) && !sources.has(move.to)) problems.push(`${rel} already exists`);
  }
  return [...new Set(problems)];
}

export interface PlanFs {
  exists(file: string): boolean;
  mkdirp(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Append one line to the thread's undo journal (thread.undo.ts reads it). */
  journal(line: object): Promise<void>;
}

/**
 * Apply the plan: moves ordered so a file can take a place another is leaving (a swap goes through a temporary name),
 * recorded in the thread's undo journal before anything moves. When a move fails, the ones already made stay made and
 * the journal is corrected to exactly those, so ↶ Undo reverses what happened and nothing else.
 */
export async function applyPlan(plan: OrganizePlan, fs: PlanFs, now: number): Promise<{ moved: number; failed: Array<{ from: string; error: string }> }> {
  const conflicts = planConflicts(plan, fs.exists);
  if (conflicts.length) throw new Error(conflicts[0]);
  const steps = orderMoves(plan.moves.filter((m) => m.from !== m.to));
  const title = `${plan.title} (${plan.moves.length} file${plan.moves.length === 1 ? '' : 's'})`;
  const id = randomUUID();
  await fs.journal({ type: 'change', id, at: now, title, tool: 'OrganizePlan', ops: steps.map((s) => ({ op: 'move', from: s.from, to: s.to })) });
  const done: Array<{ from: string; to: string }> = [];
  const failed: Array<{ from: string; error: string }> = [];
  for (const step of steps) {
    try {
      await fs.mkdirp(path.dirname(step.to));
      if (fs.exists(step.to)) throw new Error(`${path.basename(step.to)} is already there`);
      await fs.rename(step.from, step.to);
      done.push(step);
    } catch (error) {
      failed.push({ from: step.from, error: (error as Error).message });
      break;
    }
  }
  if (failed.length) {
    await fs.journal({ type: 'undo', id, at: now });
    if (done.length) await fs.journal({ type: 'change', id: randomUUID(), at: now, title: `${plan.title} (partly: ${done.length} moved)`, tool: 'OrganizePlan', ops: done.map((s) => ({ op: 'move', from: s.from, to: s.to })) });
  }
  return { moved: done.filter((s) => !s.to.includes('.bimax-swap-')).length, failed };
}

/** An order in which every move's target is free when it runs; a cycle is broken by parking one file under a temporary name. */
export function orderMoves(moves: readonly PlanMove[]): Array<{ from: string; to: string }> {
  const pending = moves.map((m) => ({ from: m.from, to: m.to }));
  const out: Array<{ from: string; to: string }> = [];
  while (pending.length) {
    const sources = new Set(pending.map((m) => m.from));
    const ready = pending.findIndex((m) => !sources.has(m.to));
    if (ready >= 0) { out.push(...pending.splice(ready, 1)); continue; }
    // Every remaining target is still occupied by another pending source: a cycle. Park the first file aside.
    const first = pending[0]!;
    const parked = `${first.from}.bimax-swap-${out.length}`;
    out.push({ from: first.from, to: parked });
    first.from = parked;
  }
  return out;
}

// ── "Actually…": revising a finished result (backlog FL3) ─────────────────────────────────────────
//
// After a plan is applied, Bimax remembers where it put each file and the file's inode. When a revised plan arrives
// for the same folder ("actually, by project"), a file that is no longer where Bimax put it was moved by the person;
// it is found again by its inode, and any move of it is taken out of the revision — kept where the person put it —
// unless they choose "Include anyway". The revision is worked out from the current state by the task itself.

export interface Placement { path: string; ino: number }
export interface AppliedPlan { root: string; threadId: string; at: number; title: string; placements: Placement[] }

/**
 * A message that revises what was just done: "Actually, …", "Instead, …", "Rather …", "On second thought …". A bare
 * "No, …" is left out: it corrects all kinds of things (N10), not only a plan of moves.
 */
export function isRevision(message: string): boolean {
  return /^\s*(?:(?:hmm|wait|ok|okay)[,.!]?\s+)?(?:actually|instead|rather|on second thought)\b/i.test(message);
}

/** The hint a revision carries to the task, so a weak model re-plans from the current state instead of starting over. */
export function revisionHint(applied: AppliedPlan): string {
  return `[This revises “${applied.title}”, which was applied: look at where the files are now and propose the changes with OrganizePlanTool. Files the person moved by hand since then are kept where they put them.]`;
}

/**
 * Files the person moved (or renamed, or deleted) after the plan was applied: each placement no longer at its path,
 * with where it is now when its inode is still in the folder.
 */
export function manualEdits(applied: AppliedPlan, inodeAt: (file: string) => number | null, locate: (ino: number) => string | null): Array<{ placed: string; now: string | null }> {
  const edits: Array<{ placed: string; now: string | null }> = [];
  for (const placement of applied.placements) {
    if (inodeAt(placement.path) === placement.ino) continue;
    edits.push({ placed: placement.path, now: locate(placement.ino) });
  }
  return edits;
}

/** A revision without the moves of files the person placed by hand; those are kept aside so the preview can offer them. */
export function keepManual(plan: OrganizePlan, byHand: ReadonlySet<string>): OrganizePlan {
  const kept = plan.moves.filter((m) => byHand.has(m.from));
  return kept.length ? { ...plan, moves: plan.moves.filter((m) => !byHand.has(m.from)), kept: [...(plan.kept ?? []), ...kept] } : plan;
}

/** "Include anyway": a file the person placed by hand goes back into the revision. */
export function includeKept(plan: OrganizePlan, from: string): OrganizePlan {
  const move = plan.kept?.find((m) => m.from === from);
  if (!move) return plan;
  return { ...plan, moves: [...plan.moves, move], kept: plan.kept!.filter((m) => m !== move) };
}
