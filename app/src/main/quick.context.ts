import fs from 'node:fs/promises';
import path from 'node:path';
import type { QuickAttachment } from '../shared/threads';

/**
 * Context for a ⌘2 task: what the person had open when they pressed ⌘2 (finder.context.ts), plus anything they
 * dropped on the bar. Pure helpers, so the wording and the checks can be tested without Electron or AppleScript.
 */

/** Whether `target` is `root` itself or inside it. */
export function insideFolder(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Attachments sent back by the bar are re-checked: known kinds, real paths that still exist, http(s) pages only. */
export async function validAttachments(raw: unknown): Promise<QuickAttachment[]> {
  if (!Array.isArray(raw)) return [];
  const out: QuickAttachment[] = [];
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const { kind, label, path: target, url } = item as Record<string, unknown>;
    if (kind === 'page') {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 4000) continue;
      out.push({ kind, label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 300) : url, url });
    } else if ((kind === 'file' || kind === 'document') && typeof target === 'string' && path.isAbsolute(target)) {
      try {
        const real = await fs.realpath(target);
        out.push({ kind, label: path.basename(real), path: real });
      } catch { /* gone since it was attached */ }
    }
  }
  return out;
}

/**
 * What the engine receives: what the person had open or dropped, then their own words. The bar shows only the
 * words; the context line tells the model what "this", "these" or "the page" refers to.
 */
export function withContext(prompt: string, attachments: readonly QuickAttachment[]): string {
  if (!attachments.length) return prompt;
  const lines = attachments.map((a) =>
    a.kind === 'page' ? `- Web page open in the browser: “${a.label}” <${a.url}>`
      : a.kind === 'document' ? `- Document open in Preview: ${a.path}`
        : `- ${a.path}`);
  return `[What the user had open or dropped on the ⌘2 bar — "this", "these" or "the page" refers to it:\n${lines.join('\n')}]\n\n${prompt}`;
}

/** Finder script output: the folder on the first line (possibly empty), then one selected item per line. */
export function parseFinderOutput(stdout: string): { folder: string | null; selection: string[] } {
  const lines = stdout.replace(/\s+$/, '').split(/\r?\n/);
  return { folder: lines[0]?.trim() || null, selection: lines.slice(1).map((line) => line.trim()).filter(Boolean).slice(0, 50) };
}

/** Browser script output: the URL on the first line, the page title after it. */
export function parseBrowserOutput(stdout: string): { url: string; title: string } | null {
  const [first = '', ...rest] = stdout.split(/\r?\n/);
  const url = first.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, title: rest.join(' ').trim() };
}
