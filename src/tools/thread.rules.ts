import * as path from 'path';
import type { ChangePlan } from './thread.changes';

/**
 * A folder's own rules, set by the user in the Bimax app for the folder a thread works in.
 *
 * Two parts arrive from the app when the engine starts: free-text rules (BIMAX_THREAD_RULES) that join the prompt on
 * every turn, and protected items (BIMAX_THREAD_PROTECTED, a JSON array of absolute paths) that the governor enforces.
 * A change that touches a protected item is refused before any approval card, so the rule never depends on the model
 * remembering it.
 */
const MAX_RULES = 4000;

export function folderRulesText(): string {
  return String(process.env.BIMAX_THREAD_RULES ?? '').trim().slice(0, MAX_RULES);
}

export function protectedPaths(): string[] {
  try {
    const value = JSON.parse(process.env.BIMAX_THREAD_PROTECTED || '[]');
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)).map((p) => path.resolve(p)) : [];
  } catch {
    return [];
  }
}

/** The prompt section: the rules in the user's own words, and the protected items by name. */
export function folderRulesSection(root = process.env.BIMAX_THREAD_ROOT || process.cwd()): string {
  const text = folderRulesText();
  const guarded = protectedPaths();
  if (!text && !guarded.length) return '';
  const lines = [`### FOLDER RULES — set by the user for ${root} (always follow them)`];
  if (text) lines.push(text);
  if (guarded.length) {
    lines.push(`Protected — never move, rename, delete, replace or add anything in these; any attempt is refused:\n${guarded.map((p) => `- ${path.relative(root, p) || p}`).join('\n')}`);
  }
  return lines.join('\n\n');
}

// Mac (and Windows) folders are case-insensitive by default, so "dev" there is the protected "DEV".
const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
const fold = (text: string): string => (caseInsensitive ? text.toLowerCase() : text);
const inside = (parent: string, child: string): boolean => {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The protected item a change would touch, if any. A move, Bin move, copy target, replacement or new item at or inside
 * a protected path counts, and so does moving or deleting a folder that CONTAINS one. A command the change parser
 * could not read counts when it names a protected item.
 */
export function protectedTouchedBy(plan: ChangePlan | null, command: string, guarded: readonly string[], root: string): string | null {
  if (!guarded.length || !plan) return null;
  if (plan.kind !== 'command') {
    const touched = [...plan.moves.flatMap((m) => [m.from, m.to]), ...plan.trash, ...plan.creates, ...plan.overwrites].map((p) => path.resolve(p));
    return guarded.find((g) => touched.some((t) => inside(g, t) || inside(t, g))) ?? null;
  }
  return guarded.find((g) => {
    if (fold(command).includes(fold(g))) return true;
    const rel = path.relative(root, g);
    return !!rel && !rel.startsWith('..') && new RegExp(`(^|[\\s'"=/])${escapeRegex(rel)}(?=$|[\\s'"/])`, caseInsensitive ? 'i' : '').test(command);
  }) ?? null;
}

/** What the model is told when a change is refused. */
export function protectedRefusal(hit: string): string {
  return `The user protected “${path.basename(hit)}” in the rules for this folder, so it can’t be changed. Nothing was changed — leave it as it is.`;
}
