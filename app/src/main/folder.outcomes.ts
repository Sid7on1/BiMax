import path from 'node:path';
import { insideFolder } from './quick.context';

/**
 * Folders with an outcome (backlog FL1, part 2): "keep this folder ready for my accountant". The person states the
 * outcome once. Bimax then runs a task on every file that arrives (a folder trigger whose words carry the outcome),
 * and each run reports, file by file, whether it now meets the outcome or needs the person, through the engine's
 * FolderStatusTool — never from the wording of an answer. The folder's queue is what is ready and what needs you.
 *
 * Kept in Bimax's settings (`folderOutcomes`, keyed by the folder's real path), never in the folder, like its rules.
 */

export type OutcomeState = 'ready' | 'needs-you';
export interface OutcomeItem { state: OutcomeState; reason?: string; at: number; threadId?: string }
export interface FolderOutcome {
  root: string;
  goal: string;
  createdAt: number;
  /** The folder trigger that runs the outcome on arrivals (folder.triggers.ts). */
  triggerId: string;
  /** Each file's last reported state, by its path inside the folder. */
  items: Record<string, OutcomeItem>;
}

export const MAX_GOAL = 600;
export const MAX_OUTCOMES = 20;
const MAX_ITEMS = 2000;

/** The goal as saved: one paragraph, capped; empty means "no outcome". */
export function cleanGoal(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_GOAL) : '';
}

/** The words every run on this folder starts with: the outcome, and how to report against it. */
export function outcomeTaskWords(goal: string): string {
  return `Keep this folder ready: ${goal}\n\nBring each file below in line with that where you can — ask before changing anything, as usual. Then report every file you handled with FolderStatusTool: "ready" when it meets the goal, or "needs-you" with exactly what I must do.`;
}

/** The engine's view of the outcome: its FolderStatusTool exists only where there is one. */
export function outcomeEnvironment(outcome: FolderOutcome | undefined): Record<string, string> {
  return outcome?.goal ? { BIMAX_FOLDER_OUTCOME: outcome.goal } : {};
}

/** A run's report merged into the queue. Paths outside the folder, or the folder itself, are ignored. */
export function applyReport(
  outcome: FolderOutcome,
  report: ReadonlyArray<{ path?: unknown; state?: unknown; reason?: unknown }>,
  threadId: string,
  now: number,
): FolderOutcome {
  const items = { ...outcome.items };
  for (const entry of report) {
    if (typeof entry?.path !== 'string' || !path.isAbsolute(entry.path)) continue;
    if (entry.state !== 'ready' && entry.state !== 'needs-you') continue;
    const full = path.resolve(entry.path);
    if (full === path.resolve(outcome.root) || !insideFolder(outcome.root, full)) continue;
    const reason = entry.state === 'needs-you' && typeof entry.reason === 'string' ? entry.reason.trim().slice(0, 300) : '';
    items[path.relative(outcome.root, full)] = { state: entry.state, ...(reason ? { reason } : {}), at: now, threadId };
  }
  return { ...outcome, items };
}

/** Files that are no longer there (renamed, moved, deleted) leave the queue; a run reports their new paths. */
export function forgetGone(outcome: FolderOutcome, exists: (file: string) => boolean): FolderOutcome {
  const items = Object.fromEntries(Object.entries(outcome.items).filter(([rel]) => exists(path.join(outcome.root, rel))));
  return Object.keys(items).length === Object.keys(outcome.items).length ? outcome : { ...outcome, items };
}

export interface OutcomeQueue { ready: string[]; needsYou: Array<{ path: string; reason: string }> }

/** What needs you (oldest report first, so nothing waits forever at the bottom) and what is ready (by name). */
export function outcomeQueue(outcome: FolderOutcome): OutcomeQueue {
  const entries = Object.entries(outcome.items);
  return {
    needsYou: entries.filter(([, item]) => item.state === 'needs-you').sort((a, b) => a[1].at - b[1].at)
      .map(([rel, item]) => ({ path: rel, reason: item.reason ?? 'Needs a look.' })),
    ready: entries.filter(([, item]) => item.state === 'ready').map(([rel]) => rel).sort((a, b) => a.localeCompare(b)),
  };
}

/** "3 need you · 12 ready", or "Nothing checked yet". */
export function queueLine(queue: OutcomeQueue): string {
  if (!queue.needsYou.length && !queue.ready.length) return 'Nothing checked yet';
  return [queue.needsYou.length ? `${queue.needsYou.length} need${queue.needsYou.length === 1 ? 's' : ''} you` : '', queue.ready.length ? `${queue.ready.length} ready` : '']
    .filter(Boolean).join(' · ');
}

/** Saved outcomes are re-checked: a real goal, an absolute folder that is not the disk or home, sane items. */
export function validOutcomes(raw: unknown, home: string): Record<string, FolderOutcome> {
  const out: Record<string, FolderOutcome> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_OUTCOMES)) {
    const o = value as Partial<FolderOutcome> | null;
    const goal = cleanGoal(o?.goal);
    if (!o || !goal || o.root !== key || !path.isAbsolute(key) || key === '/' || path.resolve(key) === path.resolve(home)) continue;
    if (typeof o.triggerId !== 'string' || !o.triggerId) continue;
    const items: Record<string, OutcomeItem> = {};
    for (const [rel, item] of Object.entries(o.items ?? {}).slice(0, MAX_ITEMS)) {
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (item?.state !== 'ready' && item?.state !== 'needs-you') continue;
      items[rel] = { state: item.state, ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, 300) } : {}), at: Number(item.at) || 0, ...(typeof item.threadId === 'string' ? { threadId: item.threadId } : {}) };
    }
    out[key] = { root: key, goal, createdAt: Number(o.createdAt) || 0, triggerId: o.triggerId, items };
  }
  return out;
}

/** The files a first check looks at: what is directly in the folder now, not hidden, at most 50. */
export function filesToCheck(names: readonly string[], root: string, limit = 50): string[] {
  return names.filter((name) => !name.startsWith('.') && !name.startsWith('~$')).sort((a, b) => a.localeCompare(b)).slice(0, limit).map((name) => path.join(root, name));
}
