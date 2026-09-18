import { globalCommandRegistry } from '../engine/commands/registry';
import { suggestAtSymbols, suggestPaths, looksLikePath } from '../engine/atMention';
import { IGraphStore } from '../graph/models';
import { CompletionItem } from './protocol';

// Engine-side autocomplete — the data behind the Go client's dropdown. Reuses the exact sources the
// Ink UI uses (the live command registry + the @-mention symbol/path suggesters), so completions
// can never drift from what actually exists.

/**
 * The fixed context references `expandFileAtMentions` understands.
 *
 * They have been expandable since that function was written and were offered by nothing: this
 * suggester returned only paths and symbols, so the only way to learn that `@diff` exists was to
 * read the source. A capability nothing advertises is a capability nobody uses.
 *
 * `kind` is 'path' rather than 'command': these are context references that ride in the middle of
 * a prompt, whereas a 'command' replaces the whole input and is offered only after a leading '/'.
 */
const CONTEXT_VERBS: readonly Omit<CompletionItem, 'kind'>[] = [
  { value: '@diff', label: '@diff', desc: 'uncommitted changes' },
  { value: '@staged', label: '@staged', desc: 'staged changes' },
  { value: '@selection', label: '@selection', desc: 'the selection in your editor' },
  { value: '@url', label: '@url', desc: 'a web page — follow it with the address' },
];

export function completeInput(text: string, store: IGraphStore, cwd: string, limit = 8): CompletionItem[] {
  // Slash command: only while the whole input is a single /token (no space yet).
  if (text.startsWith('/') && !text.includes(' ')) {
    const kw = text.toLowerCase();
    // The slash palette is a scrollable component on the client, so don't truncate it to the small
    // @-mention cap — surface the whole matching command set (just "/" lists every command).
    const cmdLimit = Math.max(limit, 60);
    return globalCommandRegistry.getPaletteOptions(store)
      .filter(o => o.value.toLowerCase().startsWith(kw))
      .slice(0, cmdLimit)
      .map(o => ({ value: o.value, label: o.label, desc: o.desc, kind: 'command' as const, disabled: o.disabled, disabledReason: o.disabledReason }));
  }

  // @-mention: a trailing @token (context verb, filesystem path, or symbol).
  const m = text.match(/@([A-Za-z0-9_./~-]*)$/);
  if (m) {
    const token = m[1];
    const seen = new Set<string>();
    const out: CompletionItem[] = [];
    const add = (item: CompletionItem): void => {
      if (seen.has(item.value)) return;
      seen.add(item.value);
      out.push(item);
    };

    const keyword = token.toLowerCase();
    for (const verb of CONTEXT_VERBS) {
      if (verb.value.slice(1).startsWith(keyword)) add({ ...verb, kind: 'path' });
    }

    // Files, for ANY token — not only one that already contains a slash.
    //
    // `looksLikePath` used to gate this branch, so `@Team` fell through to the symbol suggester and
    // a person looking for "Team report.md" was shown a list of functions. That made the whole
    // @-flow code-only: every non-code file in the project root was unreachable until the user
    // guessed at `./`. `suggestPaths` itself has always handled a bare prefix — only the gate was
    // wrong.
    for (const row of suggestPaths(token, cwd, limit)) {
      const [value, type] = row.split(/\s{2,}/); // suggestPaths returns "@<path>  <type>"
      add({ value, label: value, desc: type || 'path', kind: 'path' });
    }

    // Symbols still follow, so a code query keeps working; a token containing a slash is a path by
    // construction and never a symbol name.
    if (!looksLikePath(token)) {
      for (const name of suggestAtSymbols(store, token, limit)) {
        add({ value: '@' + name, label: name, desc: 'symbol', kind: 'symbol' });
      }
    }

    return out.slice(0, limit);
  }

  return [];
}
