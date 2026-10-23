import path from 'node:path';
import { Marked } from 'marked';
import type { TranscriptItem } from '../renderer/src/engine.state';
import type { MessageEntry, ToolCallEntry } from '../renderer/src/protocol';
import type { ThreadSummary } from '../shared/threads';

/**
 * Export a conversation (backlog N4): Markdown to keep or send, and a PDF drawn from the same Markdown.
 *
 * The export is the conversation as the thread shows it: the person's words and Bimax's answers in full, each tool
 * run as one line (with its error when it failed), and Bimax's warnings and errors. Tool output is left out — it can
 * be megabytes, and it is the part most likely to hold something the person did not mean to send.
 *
 * The PDF page is built so the conversation cannot act: raw HTML in a message is shown as text (as the app's own
 * Markdown view does), and the page carries a Content-Security-Policy that allows no script and no network load —
 * the window that prints it also has JavaScript turned off (index.ts).
 */

const TOOL_INPUT_CHARS = 120;
const ERROR_CHARS = 400;

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A readable summary of a tool call's arguments: the command, path or query when there is one. */
function toolInput(input: string): string {
  try {
    const args = JSON.parse(input) as Record<string, unknown>;
    const main = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.url ?? args.action;
    if (typeof main === 'string' && main) return oneLine(main, TOOL_INPUT_CHARS);
  } catch { /* not JSON: show it as it is */ }
  return oneLine(input, TOOL_INPUT_CHARS);
}

export function conversationMarkdown(summary: Pick<ThreadSummary, 'title' | 'root' | 'model'>, items: readonly TranscriptItem[], exportedAt = new Date()): string {
  const lines: string[] = [
    `# ${summary.title || 'Bimax conversation'}`,
    '',
    `Folder: \`${summary.root}\`${summary.model ? ` · Model: \`${summary.model}\`` : ''} · Exported ${exportedAt.toLocaleString()}`,
    '',
    '---',
  ];
  for (const item of items) {
    if (item.kind === 'tool') {
      const { toolName, input, status, output } = item.call;
      const mark = status === 'error' ? '✕' : status === 'running' ? '…' : '✓';
      lines.push('', `> ${mark} \`${toolName}\` ${toolInput(String(input ?? ''))}`.trimEnd());
      if (status === 'error' && output) lines.push(`> ${oneLine(String(output), ERROR_CHARS)}`);
      continue;
    }
    const { role, content, level } = item.msg;
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) continue;
    if (role === 'user') lines.push('', '**You**', '', text);
    else if (role === 'assistant') lines.push('', '**Bimax**', '', text);
    else if (level === 'error' || level === 'warn') lines.push('', `> ⚠ ${oneLine(text, ERROR_CHARS)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** A saved engine session's id (session.ts newSessionId, with the recorder's "-2" suffix when a second collides). */
const SESSION_ID = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?$/;

/** Where the Sessions gallery's session `id` is saved under a project, or null for anything that is not a session id. */
export function sessionFile(root: string, id: string): string | null {
  return root && SESSION_ID.test(id) ? path.join(root, '.breakglass', 'sessions', `${id}.jsonl`) : null;
}

/**
 * A saved engine session (the recorder's JSONL) as the items a thread shows, so the Sessions gallery exports through
 * the same conversationMarkdown. Tool runs are `role: 'tool'` lines; older sessions folded them onto the assistant
 * entry as `toolCalls`, shown before that answer. A line that does not parse is skipped.
 */
export function sessionItems(jsonl: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolItem = (call: Record<string, unknown>): TranscriptItem => ({ kind: 'tool', call: {
    id: String(call.id ?? ''), toolName: String(call.toolName ?? 'tool'), input: String(call.input ?? ''),
    output: String(call.output ?? ''), status: call.status === 'error' ? 'error' : 'success', startTime: String(call.startTime ?? ''),
  } satisfies ToolCallEntry });
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.role === 'tool') { items.push(toolItem(entry)); continue; }
    if (entry.role === 'assistant' && Array.isArray(entry.toolCalls)) for (const call of entry.toolCalls) items.push(toolItem(call));
    if (entry.role === 'user' || entry.role === 'assistant' || entry.role === 'system') items.push({ kind: 'msg', msg: entry as unknown as MessageEntry });
  }
  return items;
}

/** A file name for the export: the title, made safe for any disk, and the date. */
export function exportFileName(title: string, ext: 'md' | 'pdf', now = new Date()): string {
  const safe = (title || 'Bimax conversation').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Bimax conversation';
  return `${safe} ${now.toISOString().slice(0, 10)}.${ext}`;
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({ renderer: { html: (token: { text: string }) => escapeHtml(token.text) } });

/** The page the PDF is printed from. No script and no network load can run in it, whatever the conversation holds. */
export function conversationHtml(markdown: string, title: string): string {
  const body = marked.parse(markdown, { async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 11pt -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1d1d1f; margin: 0 auto; max-width: 42em; line-height: 1.5; }
  h1 { font-size: 18pt; margin-bottom: .2em; }
  blockquote { margin: .4em 0; padding: 0 .8em; color: #555; border-left: 3px solid #ccc; font-size: 9.5pt; }
  pre { background: #f5f5f7; padding: .6em .8em; border-radius: 6px; white-space: pre-wrap; word-break: break-word; font-size: 9pt; }
  code { font: 9.5pt ui-monospace, Menlo, monospace; }
  hr { border: 0; border-top: 1px solid #ddd; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: .2em .5em; }
</style></head><body>${body}</body></html>`;
}
