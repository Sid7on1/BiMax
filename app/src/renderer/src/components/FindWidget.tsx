import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view';
import { EditorSelection, type EditorState, type Extension } from '@codemirror/state';
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, search, setSearchQuery,
} from '@codemirror/search';
import { ArrowDown, ArrowUp, CaseSensitive, ChevronRight, Regex, Replace, ReplaceAll, TextSelect, WholeWord, X } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Find and replace in the editor, Cursor-style (UI fix list item 9).
 *
 * The owner's words: "the ui of it is soo bad and does not match it at all, either remove it or make a good ui of it
 * like a cursor has" — and they chose the second. What was there was CodeMirror's stock panel: a full-width bar docked
 * across the top of the file, pushing the code down, with its own text fields and word buttons ("next", "previous",
 * "all", "match case", "by word", "regexp", "replace", "replace all") in the browser's default form styling.
 *
 * This is the widget from Appendix A of the fix list: one compact card floating at the top right INSIDE the editor,
 * over the code rather than pushing it, in the app's own floating surface. Row one: the find field with case, whole
 * word and regex toggles inside it, a live "3 of 12", previous and next, find in selection, close. Row two, behind the
 * chevron: the replace field, replace and replace all. Esc closes it and hands the keyboard back to the code; opening
 * it pre-fills the selection (CodeMirror's `openSearchPanel` does that). It moves to the nearest match as you type.
 *
 * It is CodeMirror's own search underneath — `search({ createPanel })` swaps only the panel — so the matching, the
 * highlighting, ⌘G / ⇧⌘G and the replace commands are the library's, not a second implementation.
 */

/** Matches past this are not counted: the count walks the whole document on every change. */
export const MATCH_COUNT_CAP = 1000;

export interface MatchStatus {
  count: number;
  /** 1-based index of the match the selection is on; 0 when it is on none. */
  current: number;
  capped: boolean;
}

/** How many matches, and which one is selected. */
export function matchStatus(state: EditorState, query: SearchQuery): MatchStatus {
  if (!query.valid) return { count: 0, current: 0, capped: false };
  const selection = state.selection.main;
  const cursor = query.getCursor(state);
  let count = 0;
  let current = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    count += 1;
    if (next.value.from === selection.from && next.value.to === selection.to) current = count;
    if (count >= MATCH_COUNT_CAP) return { count, current, capped: true };
  }
  return { count, current, capped: false };
}

/** The words beside the find field. Empty until something is typed. */
export function statusText(query: SearchQuery, status: MatchStatus): string {
  if (!query.search) return '';
  if (!query.valid) return 'Invalid pattern';
  if (status.count === 0) return 'No results';
  const total = `${status.count}${status.capped ? '+' : ''}`;
  return status.current ? `${status.current} of ${total}` : `${total} found`;
}

/** The first match at or after `from`, wrapping round to the top — where find-as-you-type lands. */
export function nearestMatch(state: EditorState, query: SearchQuery, from: number): { from: number; to: number } | null {
  if (!query.valid) return null;
  const after = query.getCursor(state, from).next();
  if (!after.done) return after.value;
  const wrapped = query.getCursor(state, 0, from).next();
  return wrapped.done ? null : wrapped.value;
}

type QuerySpec = {
  search: string; caseSensitive: boolean; literal: boolean; regexp: boolean; wholeWord: boolean; replace: string;
  test?: SearchQuery['test'];
};

function specOf(query: SearchQuery): QuerySpec {
  return {
    search: query.search, caseSensitive: query.caseSensitive, literal: query.literal, regexp: query.regexp,
    wholeWord: query.wholeWord, replace: query.replace, test: query.test,
  };
}

/** Change the query, and — when asked — move to the nearest match, as Cursor does while you type. */
function commit(view: EditorView, patch: Partial<QuerySpec>, jump: boolean): void {
  const query = new SearchQuery({ ...specOf(getSearchQuery(view.state)), ...patch });
  const match = jump ? nearestMatch(view.state, query, view.state.selection.main.from) : null;
  view.dispatch({
    effects: match ? [setSearchQuery.of(query), EditorView.scrollIntoView(match.from, { y: 'nearest' })] : setSearchQuery.of(query),
    selection: match ? EditorSelection.single(match.from, match.to) : undefined,
  });
}

function Toggle({ on, label, keys, onClick, disabled, children }: {
  on: boolean; label: string; keys?: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="find-toggle hit-24"
      data-on={on || undefined}
      aria-pressed={on}
      aria-label={label}
      title={keys ? `${label} (${keys})` : label}
      disabled={disabled}
      // Keep the caret in the field: a toggle is a modifier on what is being typed, not a place to go.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Action({ label, keys, onClick, disabled, children }: {
  label: string; keys?: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="find-action"
      aria-label={label}
      title={keys ? `${label} (${keys})` : label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function FindWidget({ view, state }: { view: EditorView; state: EditorState }): React.ReactElement {
  const query = getSearchQuery(state);
  const [replaceOpen, setReplaceOpen] = useState(query.replace !== '');
  /** Find in selection: the range chosen when it was turned on. The selection itself moves to each match. */
  const [scope, setScope] = useState<{ from: number; to: number } | null>(null);

  // The fields hold their own text, so typing never waits on a round trip through the editor's state; they follow
  // the query only when it changes from outside — ⌘F with a selection, which pre-fills the find field.
  const [findText, setFindText] = useState(query.search);
  const [replaceText, setReplaceText] = useState(query.replace);
  useEffect(() => { setFindText(query.search); }, [query.search]);
  useEffect(() => { setReplaceText(query.replace); }, [query.replace]);

  const status = useMemo(() => matchStatus(state, query), [state.doc, state.selection, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = statusText(query, status);
  const selection = state.selection.main;
  const findRef = useRef<HTMLInputElement>(null);

  const close = (): void => { closeSearchPanel(view); view.focus(); };
  const toggleScope = (): void => {
    const next = scope ? null : { from: selection.from, to: selection.to };
    setScope(next);
    commit(view, { test: next ? (_match, _state, from, to) => from >= next.from && to <= next.to : undefined }, true);
  };
  const flags = (event: React.KeyboardEvent): boolean => {
    // ⌥⌘C / ⌥⌘W / ⌥⌘R, Cursor's keys for the three toggles on a Mac.
    if (!(event.metaKey && event.altKey)) return false;
    const key = event.code;
    if (key === 'KeyC') commit(view, { caseSensitive: !query.caseSensitive }, true);
    else if (key === 'KeyW') commit(view, { wholeWord: !query.wholeWord }, true);
    else if (key === 'KeyR') commit(view, { regexp: !query.regexp }, true);
    else return false;
    return true;
  };

  return (
    <div className="find-widget" role="dialog" aria-label="Find and replace in this file">
      <button
        type="button"
        className="find-expand hit-24"
        aria-expanded={replaceOpen}
        aria-label={replaceOpen ? 'Hide replace' : 'Show replace'}
        title={replaceOpen ? 'Hide replace' : 'Show replace'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setReplaceOpen((open) => !open)}
      >
        <ChevronRight size={12} className={cn('transition-transform', replaceOpen && 'rotate-90')} />
      </button>

      <div className="find-rows">
        <div className="find-row">
          <label className="find-field">
            <input
              ref={findRef}
              main-field="true"
              value={findText}
              placeholder="Find"
              aria-label="Find"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => { setFindText(event.target.value); commit(view, { search: event.target.value }, true); }}
              onKeyDown={(event) => {
                if (flags(event)) { event.preventDefault(); return; }
                if (event.key === 'Enter') { event.preventDefault(); (event.shiftKey ? findPrevious : findNext)(view); return; }
                // ⌘G, ⇧⌘G, Esc and the rest of CodeMirror's search keys.
                if (runScopeHandlers(view, event.nativeEvent, 'search-panel')) event.preventDefault();
              }}
            />
            <Toggle on={query.caseSensitive} label="Match case" keys="⌥⌘C" onClick={() => commit(view, { caseSensitive: !query.caseSensitive }, true)}>
              <CaseSensitive size={14} />
            </Toggle>
            <Toggle on={query.wholeWord} label="Match whole word" keys="⌥⌘W" onClick={() => commit(view, { wholeWord: !query.wholeWord }, true)}>
              <WholeWord size={14} />
            </Toggle>
            <Toggle on={query.regexp} label="Use regular expression" keys="⌥⌘R" onClick={() => commit(view, { regexp: !query.regexp }, true)}>
              <Regex size={13} />
            </Toggle>
          </label>
          <span className={cn('find-status', text === 'No results' || text === 'Invalid pattern' ? 'text-rust' : '')} aria-live="polite">
            {text}
          </span>
          <Action label="Previous match" keys="⇧↩" onClick={() => findPrevious(view)} disabled={status.count === 0}>
            <ArrowUp size={13} />
          </Action>
          <Action label="Next match" keys="↩" onClick={() => findNext(view)} disabled={status.count === 0}>
            <ArrowDown size={13} />
          </Action>
          <Toggle
            on={scope !== null}
            label={scope || !selection.empty ? 'Find in selection' : 'Find in selection — select some text first'}
            onClick={toggleScope}
            disabled={!scope && selection.empty}
          >
            <TextSelect size={13} />
          </Toggle>
          <Action label="Close" keys="Esc" onClick={close}>
            <X size={13} />
          </Action>
        </div>

        {replaceOpen && (
          <div className="find-row">
            <label className="find-field">
              <input
                value={replaceText}
                placeholder="Replace"
                aria-label="Replace"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => { setReplaceText(event.target.value); commit(view, { replace: event.target.value }, false); }}
                onKeyDown={(event) => {
                  if (flags(event)) { event.preventDefault(); return; }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    (event.metaKey ? replaceAll : replaceNext)(view);
                    return;
                  }
                  if (runScopeHandlers(view, event.nativeEvent, 'search-panel')) event.preventDefault();
                }}
              />
            </label>
            <Action label="Replace" keys="↩" onClick={() => replaceNext(view)} disabled={status.count === 0}>
              <Replace size={13} />
            </Action>
            <Action label="Replace all" keys="⌘↩" onClick={() => replaceAll(view)} disabled={status.count === 0}>
              <ReplaceAll size={13} />
            </Action>
          </div>
        )}
      </div>
    </div>
  );
}

/** The CodeMirror panel that hosts the widget. React owns what is inside; CodeMirror owns where and when. */
class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly root: Root;

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'find-widget-host';
    this.root = createRoot(this.dom);
    // Synchronously, so the field exists by the time `mount` focuses it.
    flushSync(() => this.root.render(<FindWidget view={view} state={view.state} />));
  }

  mount(): void {
    const field = this.dom.querySelector<HTMLInputElement>('[main-field]');
    field?.focus();
    field?.select();
  }

  update(update: ViewUpdate): void {
    this.root.render(<FindWidget view={this.view} state={update.state} />);
  }

  destroy(): void {
    // After the current update: unmounting a root while React may be rendering it is refused.
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}

/** The editor's search, with this widget as its panel. */
export function findWidget(): Extension {
  return search({ top: true, createPanel: (view) => new FindPanel(view) });
}
