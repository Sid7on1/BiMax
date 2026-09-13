/** Plain task briefs: preferences are visible instructions, never permission overrides. */
export const OUTPUTS = ['Auto', 'Code', 'Document', 'Analysis', 'Plan'] as const;
export type OutputKind = typeof OUTPUTS[number];
export interface ComposerDraft {
  text: string;
  output: OutputKind;
  constraints: string;
  checks: string;
}
export const emptyDraft = (): ComposerDraft => ({ text: '', output: 'Auto', constraints: '', checks: '' });

export function draftKey(project: string): string {
  return `bimax:composer:v1:${project}`;
}

export function readDraft(project: string): ComposerDraft {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey(project)) || 'null');
    if (!saved || Date.now() - saved.at > 7 * 86400_000) return emptyDraft();
    const draft = saved.draft;
    if (!draft || !['text', 'constraints', 'checks'].every(k => typeof draft[k] === 'string')
      || !OUTPUTS.includes(draft.output)) return emptyDraft();
    // The composer no longer offers output categories to pick, so a draft saved while it did must
    // not keep appending an invisible "Requested output:" line the user cannot see or clear.
    return { ...draft, output: 'Auto' };
  } catch { return emptyDraft(); }
}

export function saveDraft(project: string, draft: ComposerDraft): boolean {
  try {
    if (!draft.text && !draft.constraints && !draft.checks && draft.output === 'Auto') {
      localStorage.removeItem(draftKey(project));
    } else {
      localStorage.setItem(draftKey(project), JSON.stringify({ at: Date.now(), draft }));
    }
    return true;
  } catch { return false; }
}

export function clearDraft(project: string): void { saveDraft(project, emptyDraft()); }

/* ------------------------------------------------------------------ *
 * Sent-prompt history
 *
 * The draft already survives a remount; the history of what was actually sent did not, so
 * ↑ recall was empty every time the window was reopened while the half-written prompt beside it
 * came back. Same storage, same project scoping, same "device storage may be unavailable" rule.
 * ------------------------------------------------------------------ */
export const HISTORY_LIMIT = 50;

export function historyKey(project: string): string {
  return `bimax:composer:history:v1:${project}`;
}

export function readHistory(project: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(historyKey(project)) || 'null');
    if (!Array.isArray(saved)) return [];
    return saved.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()).slice(-HISTORY_LIMIT);
  } catch { return []; }
}

/** Append a sent prompt, de-duplicating a repeat of the most recent one. Returns the new history. */
export function pushHistory(project: string, entry: string): string[] {
  const value = entry.trim();
  if (!value) return readHistory(project);
  const next = [...readHistory(project).filter(previous => previous !== value), value].slice(-HISTORY_LIMIT);
  try { localStorage.setItem(historyKey(project), JSON.stringify(next)); } catch { /* device storage is optional */ }
  return next;
}

/* ------------------------------------------------------------------ *
 * @-references
 *
 * The engine parses a bare `@token` with `FILE_AT_RE` in `src/cli/atMention.ts`, whose path
 * alternative STOPS at whitespace and at `,;"'`()[]{}`. So `@./notes/Team report.md` is read as
 * the token `./notes/Team`, which does not exist, and `expandFileAtMentions` drops it with
 * `continue` — no block, no `injected` entry, no error. The user sees their file named in their
 * own message and gets an answer that never read a word of it.
 *
 * The same regex accepts a JSON-quoted alternative, which survives spaces and punctuation. One
 * rule decides between the two forms, and both the attachment route and @-completion use it, so
 * a filename cannot be safe through one path and silently truncated through the other.
 * ------------------------------------------------------------------ */

/** Exactly the engine's bare path alternative, anchored. */
const BARE_SAFE = /^(?:\.\.?\/|~\/|\/)[^\s,;"'`()[\]{}]*$/;
/** Anything the engine's quoted branch will not accept back as a path. */
const UNQUOTABLE = /[\0\r\n]/;

/** Render one filesystem path as an `@reference` the engine parses back to that exact path. */
export function mentionRef(path: string): string {
  const rooted = /^(?:\.\.?\/|~\/|\/)/.test(path) ? path : `./${path}`;
  return BARE_SAFE.test(rooted) ? `@${rooted}` : `@${JSON.stringify(rooted)}`;
}

/** A path the engine cannot be handed at all — reported to the user rather than sent and dropped. */
export function isReferenceable(path: string): boolean {
  return !!path && !UNQUOTABLE.test(path);
}

export function composeMessage(draft: ComposerDraft, paths: string[] = []): string {
  const sections = [draft.text.trim()];
  if (draft.output !== 'Auto') sections.push(`Requested output: ${draft.output}`);
  if (draft.constraints.trim()) sections.push(`Constraints:\n${draft.constraints.trim()}`);
  if (draft.checks.trim()) sections.push(`Completion checks:\n${draft.checks.trim()}`);
  const usable = [...new Set(paths)].filter(isReferenceable);
  if (usable.length) sections.push(usable.map(mentionRef).join(' '));
  return sections.filter(Boolean).join('\n\n');
}

/**
 * The `@…` token the caret sits in, if any. `query` is the whole prefix because the engine's
 * completion endpoint parses the mention itself; `token` is the reference alone.
 */
export function mentionAt(
  text: string,
  caret: number,
): { start: number; end: number; token: string; query: string } | null {
  const prefix = text.slice(0, caret);
  const match = /(?:^|\s)(@(?:"[^"\r\n]*"?|[A-Za-z0-9_./~-]*))$/.exec(prefix);
  if (!match) return null;
  const token = match[1];
  const start = caret - token.length;
  const rest = text.slice(caret);
  // A quoted reference runs to its closing quote; an unquoted one to the first delimiter. Without
  // this, completing inside `@"Team report.md"` would leave ` report.md"` stranded in the prompt.
  const quoted = token.startsWith('@"');
  const closed = quoted && token.length > 2 && token.endsWith('"');
  const tail = quoted
    ? (closed ? '' : /^[^"\r\n]*"?/.exec(rest)?.[0] ?? '')
    : /^[A-Za-z0-9_./~-]*/.exec(rest)?.[0] ?? '';
  return { start, end: caret + tail.length, token, query: prefix };
}

export function replaceMention(text: string, caret: number, value: string): { text: string; caret: number } {
  const mention = mentionAt(text, caret);
  if (!mention) return { text, caret };
  const inserted = value.trimEnd() + ' ';
  return { text: text.slice(0, mention.start) + inserted + text.slice(mention.end).replace(/^ /, ''), caret: mention.start + inserted.length };
}

/**
 * The engine's fixed context references. They are not paths and must never be rooted or quoted:
 * `@./diff` resolves to nothing.
 */
export const CONTEXT_VERBS = ['@diff', '@staged', '@selection', '@sel', '@url'];

/**
 * What a completion should actually insert.
 *
 * Every path suggestion goes through {@link mentionRef}, which both roots and quotes it. Rooting
 * is not cosmetic: the engine's parser matches a bare token only when it starts with `./ ../ ~/ /`
 * or contains a slash, so an offered `@notes.md` in the project root matched NEITHER alternative
 * and was a dead reference — accepted from the dropdown, shown in the prompt, and never resolved.
 *
 * A symbol is inserted exactly as offered, because `@handlePayment` is a graph lookup, not a path.
 */
export function completionInsert(item: { value: string; kind: string }): string {
  if (item.kind !== 'path' || !item.value.startsWith('@')) return item.value;
  if (CONTEXT_VERBS.includes(item.value)) return item.value;
  const raw = item.value.slice(1);
  return raw.startsWith('"') ? item.value : mentionRef(raw);
}

/* ------------------------------------------------------------------ *
 * Slash commands
 *
 * `onCommand` was wired into the Composer's props, and the engine already labels completions
 * `kind: 'command'` — but the component never called it and filtered every command suggestion
 * out of the list, so `/clear`, `/model` and the rest were unreachable from the one input the
 * product points people at.
 * ------------------------------------------------------------------ */

/** The command a prompt IS, or null when it is ordinary prose that merely contains a slash. */
export function slashCommand(text: string): string | null {
  const trimmed = text.trim();
  // `/Users/me/notes` is a path someone pasted, not a command: a command's name is one word.
  if (trimmed.includes('\n') || !/^\/[A-Za-z][\w-]*(?:\s|$)/.test(trimmed)) return null;
  return trimmed;
}

/** Whether the engine should be asked for command completions for what is typed so far. */
export function commandPrefix(text: string, caret: number): string | null {
  const prefix = text.slice(0, caret);
  return /^\/[A-Za-z-]*$/.test(prefix) ? prefix : null;
}

/* ------------------------------------------------------------------ *
 * Pasting
 *
 * A pasted log or transcript is the most common way a large body of text enters the composer,
 * and inlining it does two bad things at once: it buries the actual instruction under thousands
 * of characters, and it spends the context window on text the engine would rather retrieve by
 * passage. Over this size the paste becomes an attachment, which is the same route a dropped
 * file takes.
 * ------------------------------------------------------------------ */
export const INLINE_PASTE_LIMIT = 6000;

export function shouldAttachPaste(pasted: string): boolean {
  return pasted.length > INLINE_PASTE_LIMIT;
}

/** A stable, human-readable filename for pasted content. Never derived from the pasted text. */
export function pastedFileName(kind: 'text' | 'image', at = new Date(), extension?: string): string {
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    + ` ${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}${String(at.getSeconds()).padStart(2, '0')}`;
  return `Pasted ${kind} ${stamp}${extension ?? (kind === 'image' ? '.png' : '.txt')}`;
}

/**
 * Clipboard types that arrive with no file behind them and therefore have to be written out before
 * they can be attached. A type that is not here keeps its own path (a file copied in Finder) or is
 * refused out loud — the composer never invents an extension for bytes it cannot identify.
 */
export const CLIPBOARD_IMAGE_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
