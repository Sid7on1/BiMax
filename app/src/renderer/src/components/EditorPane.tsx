import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Circle, AtSign, Compass, PanelRight, FileCode2 } from 'lucide-react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { go } from '@codemirror/lang-go';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { cn } from '../lib/cn';
import { insertIntoComposer } from './FilesPanel';

/**
 * IDE-style editor occupying the right pane: real CodeMirror 6, multi-file tabs, undo history
 * preserved per file (EditorStates cached in module scope), ⌘S writes to disk via the main
 * process. The user's own edits write directly like any IDE — agent edits still flow through
 * the engine's tools and Edit Shield.
 */

// --- Moonlight CodeMirror theme ---------------------------------------------------------------

const moonlightTheme = EditorView.theme({
  '&': { backgroundColor: '#0d0d0d', color: '#eeeeec', fontSize: '12.5px', height: '100%' },
  '.cm-content': { fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace", caretColor: '#ffffff', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#ffffff' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(255,255,255,0.22)' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(255,255,255,0.15)' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
  '.cm-gutters': { backgroundColor: '#0d0d0d', color: '#747470', border: 'none', borderRight: '1px solid #292929' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.05)', color: '#a0a09b' },
  '.cm-foldGutter .cm-gutterElement': { color: '#747470' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(255,255,255,0.18)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'rgba(255,255,255,0.16)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255,255,255,0.28)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(255,255,255,0.10)' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-panels': { backgroundColor: '#171717', color: '#eeeeec', border: 'none' },
  '.cm-panels input': { backgroundColor: '#0d0d0d', color: '#eeeeec', border: '1px solid #303030' },
}, { dark: true });

/**
 * Syntax colour.
 *
 * This was previously a set of greys — #ffffff for keywords, #d1d1ce for strings, #b9b9b5 for
 * numbers — so the editor "highlighted" by font weight alone and read as plain white text. Weight
 * cannot carry the distinctions an editor needs: a string, a number and an identifier all look the
 * same, which is precisely the information highlighting exists to give.
 *
 * The hues are deliberately desaturated to sit on the app's near-black ground rather than the
 * saturated primaries most themes use — the surrounding UI is monochrome, and a code pane glowing
 * in full-strength red and blue would be the loudest thing in the window. Related tokens share a
 * hue family so the eye groups them: declarations warm, data green/gold, callables blue, types
 * violet, and everything structural stays grey so it recedes.
 */
const moonlightHighlight = HighlightStyle.define([
  { tag: [t.comment, t.blockComment, t.lineComment, t.docComment], color: '#6f6f69', fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: '#e08a52', fontWeight: '600' },
  { tag: [t.definitionKeyword, t.self], color: '#e08a52' },
  { tag: [t.string, t.special(t.string)], color: '#8fb573' },
  { tag: [t.regexp, t.escape], color: '#6fae9e' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#d9b25c' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#75a7cc' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: '#b491cf' },
  { tag: [t.propertyName, t.attributeName], color: '#9dc0d4' },
  { tag: [t.variableName, t.definition(t.variableName)], color: '#e3e3e0' },
  { tag: [t.operator, t.derefOperator], color: '#c2c2bd' },
  { tag: [t.punctuation, t.bracket, t.separator, t.paren, t.brace, t.squareBracket], color: '#7d7d78' },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.tagName], color: '#c98fb0' },
  { tag: t.heading, color: '#e08a52', fontWeight: '600' },
  { tag: t.link, color: '#75a7cc', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.invalid, color: '#cc7a6f' },
  { tag: [t.inserted], color: '#8fb573' },
  { tag: [t.deleted], color: '#cc7a6f' },
]);

function langFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts': case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'js': case 'jsx': case 'mjs': case 'cjs': return javascript({ jsx: true });
    case 'py': return python();
    case 'go': return go();
    case 'json': return json();
    case 'css': case 'scss': return css();
    case 'html': case 'xml': case 'svg': case 'vue': return html();
    case 'md': case 'markdown': return markdown();
    case 'yaml': case 'yml': return yaml();
    default: return [];
  }
}

// Per-file EditorStates live OUTSIDE React so tab switches and pane close/reopen keep each
// file's undo history and cursor. Cleared when the project changes.
interface FileBuffer { state: EditorState; savedDoc: string }
const buffers = new Map<string, FileBuffer>();
let buffersProject = '';

export function resetEditorBuffers(project: string): void {
  if (project !== buffersProject) {
    buffers.clear();
    buffersProject = project;
  }
}

export function EditorPane({
  open, active, project, onSelect, onClose, onBackToPanels,
}: {
  open: string[];
  active: string | null;
  project: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onBackToPanels: () => void;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const activeRef = useRef<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [savedFlash, setSavedFlash] = useState('');
  const [loadError, setLoadError] = useState('');

  resetEditorBuffers(project);

  const markDirty = useCallback((path: string, isDirty: boolean) => {
    setDirty((d) => {
      if (d.has(path) === isDirty) return d;
      const next = new Set(d);
      if (isDirty) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    const path = activeRef.current;
    const view = viewRef.current;
    if (!path || !view) return false;
    const doc = view.state.doc.toString();
    try {
      await window.bimax.files.write(path, doc);
      const buf = buffers.get(path);
      if (buf) buf.savedDoc = doc;
      markDirty(path, false);
      setSavedFlash(path.split('/').pop() ?? path);
      setTimeout(() => setSavedFlash(''), 1800);
      return true;
    } catch {
      setLoadError(`Could not save ${path}`);
      setTimeout(() => setLoadError(''), 3000);
      return false;
    }
  }, [markDirty]);

  const stateFor = useCallback((path: string, doc: string): EditorState => {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        syntaxHighlighting(moonlightHighlight),
        moonlightTheme,
        langFor(path),
        EditorView.lineWrapping,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { void save(); return true; } },
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && activeRef.current) {
            const buf = buffers.get(activeRef.current);
            markDirty(activeRef.current, !!buf && u.state.doc.toString() !== buf.savedDoc);
          }
        }),
      ],
    });
  }, [save, markDirty]);

  // One EditorView for the pane; tab switches swap EditorStates in and out of the buffer cache.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({ parent: host });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Park the outgoing file's state so its undo history survives the switch.
    if (activeRef.current && buffers.has(activeRef.current)) {
      buffers.get(activeRef.current)!.state = view.state;
    }
    activeRef.current = active;
    if (!active) return;

    const buf = buffers.get(active);
    if (buf) {
      view.setState(buf.state);
      view.focus();
      return;
    }
    let cancelled = false;
    void window.bimax.files.read(active).then((preview) => {
      if (cancelled || activeRef.current !== active) return;
      if (preview.binary) {
        setLoadError(`${active} is a binary file`);
        setTimeout(() => setLoadError(''), 3000);
        onClose(active);
        return;
      }
      const state = stateFor(active, preview.content);
      buffers.set(active, { state, savedDoc: preview.content });
      view.setState(state);
      view.focus();
    }).catch(() => {
      if (!cancelled) { setLoadError(`Could not read ${active}`); setTimeout(() => setLoadError(''), 3000); onClose(active); }
    });
    return () => { cancelled = true; };
  }, [active, stateFor, onClose]);

  // No `bg-bg` and no `border-l` on the root below: `bg-bg` is the opaque canvas colour, so this
  // pane was a solid slab inside a glass shell, and the rule down its edge was the seam that came
  // with it. Its Panel wrapper carries `pane-surface`, which is the one place this lane is painted.
  return (
    <div className="anim-slide-in-right flex h-full min-w-0 flex-col">
      {/* Tab strip */}
      <div className="no-scrollbar flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1 py-1">
        <button
          onClick={onBackToPanels}
          title="Back to panels (⌘J)"
          className="mr-0.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink"
        >
          <PanelRight size={14} />
        </button>
        {open.map((p) => {
          const name = p.split('/').pop() ?? p;
          const isActive = p === active;
          const isDirty = dirty.has(p);
          return (
            <div
              key={p}
              className={cn(
                'group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-1.5 pl-2.5 text-[12px]',
                isActive ? 'bg-hover text-ink' : 'text-dim hover:text-ink',
              )}
              title={p}
              onClick={() => onSelect(p)}
            >
              <FileCode2 size={12} className={cn('shrink-0', isActive ? 'text-ember' : 'text-faint')} />
              <span className="max-w-[160px] truncate font-mono">{name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); buffers.delete(p); markDirty(p, false); onClose(p); }}
                title={isDirty ? 'Close (unsaved changes will be lost)' : 'Close'}
                className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-faint hover:bg-line hover:text-ink"
              >
                {isDirty ? (
                  <>
                    <Circle size={7} fill="currentColor" className="text-ember group-hover:hidden" />
                    <X size={11} className="hidden group-hover:block" />
                  </>
                ) : <X size={11} />}
              </button>
            </div>
          );
        })}
        {active && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5 pr-1">
            <button
              onClick={() => insertIntoComposer(`@${active} `)}
              title="Insert @path into composer"
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink"
            >
              <AtSign size={12} />
            </button>
            <button
              onClick={() => void window.bimax.files.reveal(active)}
              title="Reveal in Finder"
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink"
            >
              <Compass size={12} />
            </button>
          </span>
        )}
      </div>

      {/* Editor host */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full [&_.cm-editor]:h-full" />
        {(savedFlash || loadError) && (
          <div
            className={cn(
              'anim-fade-up absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line px-3 py-1 text-[11.5px] shadow-[0_6px_20px_rgba(0,0,0,0.4)]',
              loadError ? 'bg-rust/15 text-rust' : 'bg-raise text-moss',
            )}
          >
            {loadError || `Saved ${savedFlash}`}
          </div>
        )}
      </div>

      {/* Status line */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1 text-[10.5px] text-faint">
        <span className="truncate font-mono">{active ?? ''}</span>
        <span className="ml-auto shrink-0">{active && dirty.has(active) ? 'modified — ⌘S to save' : 'saved'}</span>
      </div>
    </div>
  );
}
