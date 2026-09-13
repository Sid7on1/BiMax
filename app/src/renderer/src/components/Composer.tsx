import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp, Square, FunctionSquare, FileText, Shield, Cpu,
  ChevronUp, Sparkles, Pencil, Search, Hammer, Flame, Plus, ListChecks, X, CornerDownRight, Folder, GitBranch, AtSign, SquareSlash as SlashSquare,
} from 'lucide-react';
import { CompletionItem, ControlsMsg, UiSnapshot } from '../protocol';
import { cn } from '../lib/cn';
import { AttachmentWell, FileTile, type Attachment } from './AttachmentWell';
import { Button } from './ui/button';
import { SeedMenu, SeedMenuItem, SeedMenuLabel, SeedMenuReadout, SeedMenuSeparator } from './ui/morph/SeedMenu';
import type { SupervisorStatus } from '../global';
import {
  emptyDraft, readDraft, saveDraft, composeMessage, mentionAt, replaceMention,
  completionInsert, slashCommand, commandPrefix, readHistory, pushHistory,
  shouldAttachPaste, pastedFileName, CLIPBOARD_IMAGE_TYPES, CONTEXT_VERBS, type ComposerDraft,
} from '../composer.model';

/**
 * Code-only composer for the agentic IDE. The strip under the input contains project autonomy,
 * model routing, attachment, and live context controls; there is no host-computer lane.
 */

/**
 * The three control levels `04_FRONTEND_PLAN.md` names, and nothing else at this level.
 *
 * "Unrestricted" is deliberately NOT one of them. It used to sit here as an ordinary fourth choice,
 * one click from the default, with the description "Continue without approval gates" — a
 * normal-looking product option that removes every approval from an agent that can edit files and
 * operate the machine. It survives only inside Custom rules, where choosing it is a deliberate act.
 */
const CONTROL_LEVELS = [
  { id: 'ask', autonomy: 'ask', short: 'Ask me first', label: 'Ask before changes', desc: 'Every edit shows you a diff first' },
  { id: 'auto', autonomy: 'auto', short: 'Approve for me', label: 'Work automatically in this project', desc: 'Apply safe edits, ask before risky actions' },
  { id: 'custom', autonomy: null, short: 'Custom rules', label: 'Custom rules…', desc: 'Choose how Bimax works and what it may do unattended' },
] as const;

/**
 * Advanced only. `04_FRONTEND_PLAN.md`: "Internal names like general/explore/sketch/code/beast,
 * rollout modes, drivers, and fallback names do not belong in the default UI." These were the
 * primary workflow control; they are now behind Custom rules, where they are described by what they
 * do rather than by the engine's persona names.
 */
const ADVANCED_MODES = [
  { id: 'general', label: 'Balanced', icon: <Sparkles size={13} />, desc: 'Understand, decide, and build' },
  { id: 'explore', label: 'Research only', icon: <Search size={13} />, desc: 'Study the project without changing it' },
  { id: 'sketch', label: 'Plan first', icon: <Pencil size={13} />, desc: 'Design the approach before editing' },
  { id: 'code', label: 'Build and verify', icon: <Hammer size={13} />, desc: 'Focus on implementation and its checks' },
  { id: 'beast', label: 'Parallel team', icon: <Flame size={13} />, desc: 'Coordinate parallel work on a larger goal' },
];

const ADVANCED_AUTONOMY = [
  { id: 'plan', label: 'Read-only', desc: 'Research and propose; never write' },
  { id: 'full', label: 'Unattended', desc: 'No approval gates. Only for work you are supervising.' },
];

const TIERS = [
  { id: 'auto', short: 'Auto', label: 'Auto tier', desc: 'Router picks lite/heavy per turn' },
  { id: 'lite', short: 'Low', label: 'Lite tier', desc: 'Fast + cheap, pinned' },
  { id: 'heavy', short: 'High', label: 'Heavy tier', desc: 'Strongest model, pinned' },
];

export function Composer({
  busy, mode, tier, snapshot, streamedChars, completions, project, draftKey = project, branch,
  onSubmit, onInterrupt, onControls, onCommand, onQuery, onIngest, onClearCompletions, onOpenModels, runtime,
}: {
  busy: boolean;
  mode: string;
  tier: string;
  /** Absolute path of the open project — only its last segment is shown. */
  project: string;
  draftKey?: string;
  branch: string | null;
  snapshot: UiSnapshot | null;
  streamedChars: number;
  completions: CompletionItem[];
  onSubmit: (text: string, engineText?: string) => void;
  onInterrupt: () => void;
  onControls: (controls: Omit<ControlsMsg, 't'>) => void;
  onCommand: (cmd: string) => void;
  onQuery: (text: string) => void;
  /** Read an attached file into the Composer immediately. */
  onIngest: (filePath: string) => Promise<{ ok: boolean; chunks: number; reason: string }>;
  onClearCompletions: () => void;
  /** Opens the model window. Configuration never goes through the transcript. */
  onOpenModels: () => void;
  runtime: SupervisorStatus | null;
}): React.ReactElement {
  const [draft, setDraft] = useState<ComposerDraft>(() => readDraft(draftKey));
  const text = draft.text;
  const setText = (value: string | ((previous: string) => string)): void => {
    setDraft(current => ({ ...current, text: typeof value === 'function' ? value(current.text) : value }));
  };
  const [queued, setQueued] = useState<{ draft: ComposerDraft; attachments: Attachment[] } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(0);
  const [caret, setCaret] = useState(0);
  const [permission, setPermission] = useState('auto');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [wellOpen, setWellOpen] = useState(false);
  const [dropDepth, setDropDepth] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const historyRef = useRef<string[]>(readHistory(draftKey));
  const histIdxRef = useRef(-1);
  const mounted = useRef(true);
  const ingestJobs = useRef(new Map<string, symbol>());
  const submissionLock = useRef(false);
  const activeMention = mentionAt(text, caret);
  // Typing `/` asks for commands; typing `@` asks for context. Command suggestions used to be
  // filtered out of this list unconditionally and `onCommand` was never called, so every slash
  // command the engine offers was unreachable from the one input the product points people at.
  const activeCommand = commandPrefix(text, caret);
  const visibleCompletions = completions
    .filter(item => (activeCommand !== null ? item.kind === 'command' : item.kind !== 'command'))
    .slice(0, 8);
  const showDropdown = (!!activeMention || activeCommand !== null) && visibleCompletions.length > 0;
  const modeId = (mode || '').toLowerCase() === 'plan' ? 'general' : (mode || '').toLowerCase() || 'general';
  const activeMode = ADVANCED_MODES.find(m => m.id === modeId) ?? ADVANCED_MODES[0];
  const readOnlyMode = ['PLAN', 'EXPLORE', 'SKETCH'].includes((mode || '').toUpperCase());
  const activeLevel = CONTROL_LEVELS.find(level => level.id === permission) ?? CONTROL_LEVELS[1];
  const activeTier = TIERS.find(t => t.id === (tier || 'auto')) ?? TIERS[0];
  // Quality is no longer its own pill. The default is silent; a pinned tier is named here, so a
  // non-default can never hide inside a menu nobody opens.
  const modelLabel = shortModel(snapshot?.models.coding) + (activeTier.id === 'auto' ? '' : ` · ${activeTier.short}`);
  const modelTitle = `${snapshot?.models.coding ?? 'Model'} · ${activeTier.desc}`;
  const ctxPct = snapshot && snapshot.contextWindow > 0
    ? Math.min(100, Math.round(((snapshot.tokensBaseline + streamedChars / 4) / snapshot.contextWindow) * 100)) : null;
  const available = runtime?.phase === 'ready' || runtime?.phase === 'degraded';
  const unread = attachments.some(a => a.state !== 'read');
  const pendingCommand = attachments.length ? null : slashCommand(text);
  const canSubmit = !!text.trim() && available && !unread && !queued;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(debounceRef.current); ingestJobs.current.clear(); };
  }, []);
  useEffect(() => { setSaved(saveDraft(draftKey, draft)); }, [draftKey, draft]);
  useEffect(() => { setSel(0); }, [completions]);
  useEffect(() => { submissionLock.current = false; }, [text, busy, available]);

  // Explicit task navigation resets the composer through its keyed parent. Engine-side /clear and
  // resume are also task boundaries; stale ingestion promises must not repopulate the new draft.
  useEffect(() => window.bimax.onMessage?.(msg => {
    if (msg.t !== 'event' || (msg.name !== 'clear' && !(msg.name === 'session_restore' && available))) return;
    ingestJobs.current.clear();
    setQueued(null); setAttachments([]); setDraft(emptyDraft()); setError('');
    // History survives a task boundary. Clearing the transcript resets the ENGINE's context; what
    // the person typed is theirs, and ↑ after New Task is how a similar request gets restarted.
    historyRef.current = readHistory(draftKey); histIdxRef.current = -1;
    onClearCompletions();
  }), [onClearCompletions, available, project]);

  useEffect(() => {
    const insert = (event: Event): void => {
      const value = String((event as CustomEvent).detail ?? '');
      if (!value) return;
      setText(current => current ? `${current.trimEnd()} ${value}` : value);
      taRef.current?.focus();
    };
    window.addEventListener('bimax:compose-insert', insert);
    return () => window.removeEventListener('bimax:compose-insert', insert);
  }, []);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';
  }, [text]);

  const queryAt = (value: string, position: number): void => {
    setCaret(position);
    clearTimeout(debounceRef.current);
    onClearCompletions();
    if (!available) return;
    const command = commandPrefix(value, position);
    const mention = command === null ? mentionAt(value, position) : null;
    const request = command ?? mention?.query;
    if (request !== undefined) debounceRef.current = setTimeout(() => onQuery(request), 120);
  };
  const change = (value: string, position = value.length): void => {
    setText(value); setError(''); histIdxRef.current = -1;
    queryAt(value, position);
  };
  const send = (next: ComposerDraft, files: Attachment[]): boolean => {
    try {
      const message = composeMessage(next, files.map(file => file.path));
      const display = composeMessage(next) + (files.length ? `\n\nAttached: ${files.map(f => f.name).join(', ')}` : '');
      onSubmit(display, message);
      historyRef.current = pushHistory(draftKey, next.text);
      onClearCompletions();
      return true;
    } catch {
      setError('Your message was not sent. Your draft is still here.');
      return false;
    }
  };
  const submit = (): void => {
    if (!canSubmit || submissionLock.current) return;
    submissionLock.current = true;
    // A slash command is an instruction to the application, not a turn for the model. It runs now
    // — including mid-task, which is the whole point of `/clear` and `/model` — and is never held
    // back for review the way a follow-up message is.
    if (pendingCommand) {
      onCommand(pendingCommand);
      historyRef.current = pushHistory(draftKey, pendingCommand);
      histIdxRef.current = -1;
      setDraft(emptyDraft()); setDetailsOpen(false);
      onClearCompletions();
      submissionLock.current = false;
      return;
    }
    if (busy) {
      // This is a reviewable follow-up, never silently replayed after a crash or a task switch.
      setQueued({ draft: { ...draft }, attachments: [...attachments] });
      return;
    }
    if (!send(draft, attachments)) { submissionLock.current = false; return; }
    setDraft(emptyDraft()); setAttachments([]); setDetailsOpen(false);
    ingestJobs.current.clear(); histIdxRef.current = -1;
  };
  const sendQueued = (): void => {
    if (!queued || busy || !available || submissionLock.current) return;
    submissionLock.current = true;
    if (send(queued.draft, queued.attachments)) {
      setQueued(null); setDraft(emptyDraft()); setAttachments([]); setDetailsOpen(false);
    } else submissionLock.current = false;
  };
  const focusCaret = (position: number): void => {
    requestAnimationFrame(() => { taRef.current?.focus(); taRef.current?.setSelectionRange(position, position); });
  };
  const accept = (item?: CompletionItem): void => {
    if (!item || item.disabled) return;
    if (item.kind === 'command') {
      // `commandPrefix` only matches when everything before the caret IS the command name, so the
      // command replaces exactly that and whatever the user typed after the caret is preserved.
      const name = item.value.trim();
      const next = `${name} ${text.slice(caret).replace(/^ /, '')}`;
      setText(next); setCaret(name.length + 1); onClearCompletions();
      focusCaret(name.length + 1);
      return;
    }
    const result = replaceMention(text, caret, completionInsert(item));
    setText(result.text); setCaret(result.caret); onClearCompletions();
    focusCaret(result.caret);
  };
  const ingest = (path: string): void => {
    if (!available || queued) return;
    const job = Symbol(path);
    ingestJobs.current.set(path, job);
    setAttachments(current => current.map(a => a.path === path ? { ...a, state: 'reading', reason: '' } : a));
    void onIngest(path).then(result => {
      if (!mounted.current || ingestJobs.current.get(path) !== job) return;
      setAttachments(current => current.map(a => a.path === path
        ? { ...a, state: result.ok ? 'read' : 'failed', chunks: result.chunks, reason: result.reason } : a));
    }).catch(() => {
      if (!mounted.current || ingestJobs.current.get(path) !== job) return;
      setAttachments(current => current.map(a => a.path === path ? { ...a, state: 'failed', reason: 'Could not read this file' } : a));
    });
  };
  const addPaths = (paths: string[]): void => {
    if (!available || queued) { setError('Wait until Bimax is ready, then attach your files.'); return; }
    const usable = [...new Set(paths.filter(Boolean))].filter(path => !ingestJobs.current.has(path));
    if (!usable.length) return;
    setAttachments(current => [...current, ...usable.map(path => ({ path, name: path.split('/').pop() || path, size: 0, state: 'reading' as const }))]);
    usable.forEach(ingest);
    setWellOpen(false);
  };
  const removeAttachment = (path: string): void => {
    if (queued) return;
    ingestJobs.current.delete(path);
    setAttachments(current => current.filter(a => a.path !== path));
  };
  const attach = (): void => {
    void window.bimax.pickFiles().then(paths => { if (mounted.current) addPaths(paths); })
      .catch(() => { if (mounted.current) setError('The file picker could not open. Try again.'); });
  };
  const openWell = (): void => setWellOpen(true);
  const closeWell = (): void => { setWellOpen(false); taRef.current?.focus(); };
  const onDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = available && !queued ? 'copy' : 'none';
  };
  const onDragEnter = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files') || !available || queued) return;
    e.preventDefault(); setWellOpen(true); setDropDepth(d => d + 1);
  };
  const onDragLeave = (): void => setDropDepth(d => Math.max(0, d - 1));
  const onDrop = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); setDropDepth(0);
    const paths = Array.from(e.dataTransfer.files).map(file => window.bimax.pathForFile(file));
    if (paths.some(path => !path)) setError('Some dropped files have no local path. Save them locally and attach again.');
    addPaths(paths);
  };

  /**
   * Paste.
   *
   * A screenshot on the clipboard is a File with no path (`pathForFile` returns ''), and a pasted
   * log is not a file at all — so before this, the composer's only sources of context were the
   * picker and drag-and-drop, and pasting a screenshot into the prompt did nothing whatsoever.
   * Clipboard bytes are written out by main and then take exactly the same route a dropped file
   * takes: attached, read at attach time, and blocking send until they have actually been read.
   */
  const insertAtCaret = (value: string): void => {
    // Read the LIVE field, not the render-time `text`: this runs after an await, and someone who
    // kept typing while the clipboard was being written out must not have that typing overwritten.
    const ta = taRef.current;
    if (!ta) { setText(current => current + value); return; }
    const start = ta.selectionStart;
    const next = ta.value.slice(0, start) + value + ta.value.slice(ta.selectionEnd);
    change(next, start + value.length);
    focusCaret(start + value.length);
  };
  const stashBytes = async (name: string, bytes: Uint8Array): Promise<string> => {
    // Optional on the bridge: a renderer can run against an older packaged main process, and the
    // caller must be able to say what it could not do rather than throw on a keystroke.
    const stash = window.bimax.stashPaste;
    if (!stash) return '';
    return stash(name, bytes).catch(() => '');
  };
  const onPaste = (e: React.ClipboardEvent): void => {
    if (queued) return;
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length) {
      e.preventDefault();
      if (!available) { setError('Wait until Bimax is ready, then paste again.'); return; }
      void (async () => {
        const paths: string[] = [];
        const refused: string[] = [];
        for (const file of files) {
          const onDisk = window.bimax.pathForFile(file);
          if (onDisk) { paths.push(onDisk); continue; }
          const extension = CLIPBOARD_IMAGE_TYPES[file.type];
          if (!extension) { refused.push(file.type || 'unknown type'); continue; }
          const stashed = await stashBytes(
            pastedFileName('image', new Date(), extension),
            new Uint8Array(await file.arrayBuffer()),
          );
          if (stashed) paths.push(stashed); else refused.push(file.name || 'pasted image');
        }
        if (!mounted.current) return;
        // Never silent: a paste that produced no attachment has to say so, or the user believes
        // the screenshot is in the prompt and asks a question about something nothing can see.
        if (refused.length) setError(`Could not attach ${refused.join(', ')}. Save it to a file and attach it instead.`);
        if (paths.length) addPaths(paths);
      })();
      return;
    }
    const pasted = e.clipboardData.getData('text/plain');
    if (!shouldAttachPaste(pasted) || !available) return;
    e.preventDefault();
    void (async () => {
      const stashed = await stashBytes(pastedFileName('text'), new TextEncoder().encode(pasted));
      if (!mounted.current) return;
      // A failed stash must not eat the clipboard: the text goes into the prompt as it would have.
      if (stashed) addPaths([stashed]); else insertAtCaret(pasted);
    })();
  };

  const keyDown = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || wellOpen) return;
    if (showDropdown) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, visibleCompletions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey)) {
        e.preventDefault();
        accept(visibleCompletions[sel]);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); onClearCompletions(); return; }
    }
    // ↑/↓ recall past prompts when the input is empty or already navigating history.
    const hist = historyRef.current;
    if (e.key === 'ArrowUp' && hist.length && (text === '' || histIdxRef.current !== -1)) {
      e.preventDefault();
      histIdxRef.current = histIdxRef.current === -1 ? hist.length - 1 : Math.max(0, histIdxRef.current - 1);
      setText(hist[histIdxRef.current]);
      return;
    }
    if (e.key === 'ArrowDown' && histIdxRef.current !== -1) {
      e.preventDefault();
      histIdxRef.current = histIdxRef.current >= hist.length - 1 ? -1 : histIdxRef.current + 1;
      setText(histIdxRef.current === -1 ? '' : hist[histIdxRef.current]);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !showDropdown))) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault();
      onInterrupt();
    }
  };

  return (
    <div className="relative shrink-0 px-4 pt-1 pb-4">
      {showDropdown && (
        <div id="composer-suggestions" role="listbox" aria-label="Context suggestions" className="absolute bottom-full left-1/2 z-20 mb-1 w-[min(860px,calc(100%-48px))] -translate-x-1/2 overflow-hidden rounded-[10px] border border-line bg-raise shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
          {visibleCompletions.slice(0, 8).map((c, i) => (
            <button
              key={c.value + i}
              id={`composer-option-${i}`}
              role="option"
              aria-selected={i === sel}
              disabled={c.disabled}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setSel(i)}
              onClick={() => accept(c)}
              className={cn(
                'flex w-full cursor-pointer items-baseline gap-2.5 px-3 py-[7px] text-left text-[12.5px]',
                i === sel && 'bg-ember/15',
                c.disabled && 'opacity-40',
              )}
            >
              <span className="w-4 shrink-0 text-ember">
                {/* A context verb arrives as `kind: 'path'` because it rides mid-prompt like one,
                    but `@diff` is not a file and a document icon would say it was. */}
                {c.kind === 'command' ? <SlashSquare size={13} />
                  : CONTEXT_VERBS.includes(c.value) ? <AtSign size={13} />
                    : c.kind === 'symbol' ? <FunctionSquare size={13} /> : <FileText size={13} />}
              </span>
              <span className="font-mono">{c.label}</span>
              <span className="truncate text-faint">{c.disabled ? c.disabledReason || c.desc : c.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className="composer-column mx-auto">
        <div className="mb-2 flex min-w-0 items-center justify-between gap-3 px-2 text-[11px] text-faint">
          <span className="inline-flex min-w-0 items-center gap-1.5" title={project}>
            <Folder size={12} className="shrink-0" /><span className="truncate">{project.split('/').filter(Boolean).pop() || 'Workspace'}</span>
            {branch && <><span className="text-line">/</span><GitBranch size={11} className="shrink-0" /><span className="max-w-32 truncate">{branch}</span></>}
          </span>
          <span className="shrink-0">{busy ? 'Working · prepare your next step' : available ? 'Ready when you are' : 'Connecting · keep writing'}</span>
        </div>
        {queued && (
          <div className="mb-2 flex items-start gap-3 rounded-2xl border border-line bg-raise px-4 py-3" role="status">
            <CornerDownRight size={15} className="mt-0.5 shrink-0 text-dim" />
            <div className="min-w-0 flex-1"><p className="text-[11px] font-medium text-dim">Next message · held for your review</p><p className="mt-1 truncate text-[12px] text-ink">{queued.draft.text}</p></div>
            <button type="button" onClick={() => { setQueued(null); submissionLock.current = false; taRef.current?.focus(); }} className="text-[11px] text-dim hover:text-ink">Edit</button>
            {!busy && <button type="button" disabled={!available} onClick={sendQueued} className="text-[11px] font-medium text-ink disabled:opacity-40">Send now</button>}
            <button type="button" aria-label="Cancel next message" onClick={() => { setQueued(null); submissionLock.current = false; }} className="text-faint hover:text-ink"><X size={13} /></button>
          </div>
        )}
      <div
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          // `.launch-console` owns radius and shadow in styles.css; a utility here would be dead
          // weight that only looks like it is in charge.
          'launch-console relative rounded-[18px] border bg-raise transition-[border-color,box-shadow] focus-within:border-ember/45',
          dropDepth > 0 ? 'border-ember/70' : 'border-line',
        )}
      >
        {/*
          * The corpus readout. Two jobs: tell the user what the agent is actually working from, and
          * — the important one — surface what could NOT be read. Silence about a failed attachment
          * is the worst outcome available: the user believes the file was read and acts on an answer
          * that never saw it.
          */}
        {snapshot?.composer && (snapshot.composer.session + snapshot.composer.library) > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2.5 text-[11px] text-faint">
            <span className="inline-flex items-center gap-1.5">
              <FileText size={11} />
              {snapshot.composer.session + snapshot.composer.library} document
              {snapshot.composer.session + snapshot.composer.library === 1 ? '' : 's'}
              {' · '}
              {snapshot.composer.passages} passage{snapshot.composer.passages === 1 ? '' : 's'}
              {snapshot.composer.facts > 0 && ` · ${snapshot.composer.facts} measurement${snapshot.composer.facts === 1 ? '' : 's'}`}
            </span>
            {snapshot.composer.library > 0 && (
              <span className="text-faint/80">{snapshot.composer.library} in library</span>
            )}
            {!!snapshot.composer.lastIngest?.skipped.length && (
              <span
                className="text-ember"
                title={snapshot.composer.lastIngest.skipped
                  .map((skip) => `${skip.name} — ${skip.reason}`)
                  .join('\n')}
              >
                {snapshot.composer.lastIngest.skipped.length} could not be read
              </span>
            )}
          </div>
        )}

        {wellOpen && (
          <AttachmentWell
            attachments={attachments}
            dragging={dropDepth > 0}
            onPick={attach}
            onRemove={removeAttachment}
            onClose={closeWell}
          />
        )}

        {/* Once the well is closed the files ride ABOVE the prompt, still removable. */}
        {!wellOpen && attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {attachments.map((file) => (
              <FileTile key={file.path} file={file} compact locked={!!queued} onRemove={() => removeAttachment(file.path)} onRetry={file.state === 'failed' ? () => ingest(file.path) : undefined} />
            ))}
          </div>
        )}

        <div className="flex items-end gap-3 px-4 pt-3.5 pb-1">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            aria-label="Describe what you want Bimax to do"
            data-bimax-composer=""
            placeholder={busy ? 'Write the next step. Save it for review…' : 'Ask a question, build something, or bring your work here…'}
            readOnly={!!queued}
            aria-describedby="composer-help"
            aria-controls={showDropdown ? 'composer-suggestions' : undefined}
            aria-expanded={showDropdown}
            aria-autocomplete="list"
            aria-activedescendant={showDropdown ? `composer-option-${sel}` : undefined}
            onChange={(e) => change(e.target.value, e.target.selectionStart)}
            onSelect={e => { const position = e.currentTarget.selectionStart; if (position !== caret) queryAt(text, position); }}
            onKeyDown={keyDown}
            onPaste={onPaste}
            className="min-w-0 flex-1 resize-none border-none bg-transparent font-display text-[14.5px] leading-relaxed outline-none placeholder:text-faint"
          />
        </div>

        {detailsOpen && (
          <div id="composer-brief" className="mx-4 mb-3 grid gap-3 rounded-xl border border-line bg-bg/40 p-3 sm:grid-cols-2">
            <label className="text-[11px] text-dim">Constraints
              <textarea rows={2} value={draft.constraints} readOnly={!!queued} onChange={e => setDraft(current => ({ ...current, constraints: e.target.value }))}
                placeholder="Audience, scope, sources, things to preserve…" className="mt-1.5 block w-full resize-y rounded-lg border border-line bg-transparent p-2 text-[12px] text-ink outline-none focus:border-ember/50" />
            </label>
            <label className="text-[11px] text-dim">What does done look like?
              <textarea rows={2} value={draft.checks} readOnly={!!queued} onChange={e => setDraft(current => ({ ...current, checks: e.target.value }))}
                placeholder="Tests pass, claims cite sources, totals reconcile…" className="mt-1.5 block w-full resize-y rounded-lg border border-line bg-transparent p-2 text-[12px] text-ink outline-none focus:border-ember/50" />
            </label>
            <p className="text-[10px] text-faint sm:col-span-2">Included in your message. Output preferences keep your current permissions.</p>
          </div>
        )}
        <div className="composer-toolbar flex min-w-0 items-center gap-1 px-3 pb-2.5">
          <button
            type="button"
            title="Attach files"
            aria-label="Attach files"
            disabled={!available || !!queued}
            onClick={openWell}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-faint transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <Plus size={16} />
          </button>

          <button type="button" aria-expanded={detailsOpen} aria-controls="composer-brief" onClick={() => setDetailsOpen(value => !value)}
            title="Constraints, and what done looks like"
            className={cn('flex shrink-0 items-center gap-1.5 rounded-xl px-2 py-1.5 text-[11px] transition-colors', detailsOpen || draft.constraints || draft.checks ? 'text-ink' : 'text-faint hover:text-ink')}>
            <ListChecks size={13} />
            <span className="composer-brief-label">Brief{(draft.constraints || draft.checks) ? ` · ${Number(!!draft.constraints) + Number(!!draft.checks)}` : ''}</span>
          </button>
          {/* Widest of the strip's menus: in `custom` it grows three sections deep, and `fitHeight`
              means the surface is exactly as tall as whichever shape it is in rather than sized for
              its largest one. */}
          <SeedMenu
            label="Permission level"
            width={300}
            trigger={(open) => <ComposerPill open={open} icon={<Shield size={13} />} label={activeLevel.short} title={activeLevel.label} />}
          >
            {(close) => (
              <>
                {CONTROL_LEVELS.map((level) => (
                  <SeedMenuItem
                    key={level.id}
                    selected={level.id === activeLevel.id}
                    label={level.label}
                    desc={level.desc}
                    onClick={() => {
                      if (level.autonomy) onControls({ autonomy: level.autonomy as ControlsMsg['autonomy'] });
                      setPermission(level.id);
                      close();
                    }}
                  />
                ))}
                {permission === 'custom' && (
                  <>
                    <SeedMenuSeparator />
                    <SeedMenuLabel>How Bimax works</SeedMenuLabel>
                    {ADVANCED_MODES.map((m) => (
                      <SeedMenuItem
                        key={m.id}
                        icon={m.icon}
                        selected={m.id === activeMode.id}
                        label={m.label}
                        desc={m.desc}
                        onClick={() => { onControls({ mode: m.id as ControlsMsg['mode'] }); close(); }}
                      />
                    ))}
                    <SeedMenuSeparator />
                    <SeedMenuLabel>Approvals</SeedMenuLabel>
                    {ADVANCED_AUTONOMY.map((option) => (
                      <SeedMenuItem
                        key={option.id}
                        selected={readOnlyMode && option.id === 'plan'}
                        label={option.label}
                        desc={option.desc}
                        onClick={() => { onControls({ autonomy: option.id as ControlsMsg['autonomy'] }); close(); }}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </SeedMenu>

          <span className="flex-1" />

          {/* Context only speaks up once it is worth knowing. A meter pinned at 8% all day is
              furniture; one that appears at 60% is a warning. */}
          {ctxPct !== null && ctxPct >= 60 && (
            <span
              className={cn('shrink-0 font-mono text-[10px] tabular-nums', ctxPct >= 85 ? 'text-rust' : 'text-amber')}
              title={`Context ~${ctxPct}% of ${snapshot!.contextWindow.toLocaleString()} tokens`}
            >
              {ctxPct}% context
            </span>
          )}

          {/*
            The first surface on Seed Morph v2 (docs/motion/SEED_MORPH_BRIEF.md, Prompt 2 §72): the
            pill physically becomes the menu and folds back into it.

            It also stopped being a one-item menu. "Change model…" alone made the pill a button
            wearing a chevron: the label already showed the work model, so the only thing the menu
            could tell you was that a window existed. Naming both loaded slots means the common
            question — *what is actually running right now?* — is answered by the control that
            claims to show it, and the window is one row further on for the case that needs it.
          */}
          <SeedMenu
            label="Model"
            width={280}
            trigger={(open) => <ComposerPill open={open} icon={<Cpu size={13} />} label={modelLabel} title={modelTitle} />}
          >
            {(close) => (
              <>
                <SeedMenuLabel>Loaded</SeedMenuLabel>
                {/* Readouts, not disabled controls: the engine picks between these per turn, so
                    there is nothing to choose — but "which model is actually loaded" is the whole
                    reason to open this menu, and a disabled style would draw the answer faintest. */}
                <SeedMenuReadout label="Work" value={snapshot?.models.coding ?? 'not reported'} />
                <SeedMenuReadout label="Quick" value={snapshot?.models.lite ?? 'not reported'} />
                <SeedMenuSeparator />
                <SeedMenuLabel>Model quality</SeedMenuLabel>
                {TIERS.map((t) => (
                  <SeedMenuItem key={t.id} selected={(tier || 'auto') === t.id} label={t.label} desc={t.desc} onClick={() => { onControls({ tier: t.id as ControlsMsg['tier'] }); close(); }} />
                ))}
                <SeedMenuSeparator />
                <SeedMenuItem
                  label="Change model…"
                  desc="Slots, reasoning effort and what the engine actually kept"
                  onClick={() => { onOpenModels(); close(); }}
                />
              </>
            )}
          </SeedMenu>
          {busy && (
            <Button variant="ghost" size="icon" className="composer-stop ml-1 size-8 shrink-0 rounded-full" aria-label="Stop current task" title="Stop current task" onClick={onInterrupt}>
              <Square size={11} fill="currentColor" />
            </Button>
          )}
          <Button variant="accent" size="icon" className="composer-send ml-1 size-8 shrink-0 rounded-full"
            aria-label={pendingCommand ? `Run ${pendingCommand.split(/\s/)[0]}` : busy ? 'Save next message' : 'Send message'}
            title={unread ? 'Wait for files to finish reading, or retry/remove failed files'
              : pendingCommand ? `Run ${pendingCommand.split(/\s/)[0]} now`
                : busy ? 'Save next message for review' : 'Send (Enter)'}
            disabled={!canSubmit} onClick={submit}>
            {busy && !pendingCommand ? <CornerDownRight size={15} /> : <ArrowUp size={15} />}
          </Button>
        </div>
      </div>
        <div id="composer-help" className="mt-2 flex items-center justify-between gap-3 px-3 text-[10px] text-faint">
          <span className="truncate">{unread ? 'Files must finish reading. Retry or remove any failed files.'
            : pendingCommand ? `Enter runs ${pendingCommand.split(/\s/)[0]} now — this is a command, not a message`
              : 'Enter to send · ⇧⏎ new line · @ context · / commands'}</span>
          {!saved && <span className="shrink-0 text-amber">Draft storage unavailable · keep this window open</span>}
        </div>
        {error && <p role="alert" className="mt-2 px-2 text-[12px] text-rust">{error}</p>}
      </div>
    </div>
  );
}

/**
 * The composer strip's control shape — and, since the model menu became a Seed Morph, the shape a
 * surface has to grow out of.
 *
 * Exported so the Motion Lab can seed a real morph from the real control rather than from a copy of
 * its classes: the seed's corner radius and box are measured off this element, so a harness that
 * reproduced the markup would be verifying its own reproduction.
 */
export function ComposerPill({
  open, icon, label, mono = false, tone = 'default', title, testId,
}: {
  open: boolean;
  icon?: React.ReactNode;
  label: string;
  mono?: boolean;
  tone?: 'default' | 'mac';
  title?: string;
  testId?: string;
}): React.ReactElement {
  return (
    <span
      title={title}
      data-bimax-pill={testId}
      className={cn(
        // `min-w-0 overflow-hidden`: the toolbar lets every control shrink before it wraps, and a pill that
        // could not shrink with it painted its chevron over the send button in a ~240px chat column.
        'flex min-w-0 max-w-[190px] items-center gap-1.5 overflow-hidden rounded-xl px-2.5 py-1.5 text-[10.5px] transition-colors',
        open ? 'bg-ember/12 text-ember'
          : tone === 'mac' ? 'bg-amber/10 text-amber' : 'text-dim hover:bg-hover hover:text-ink',
      )}
    >
      {icon ? <span className={open ? 'text-ember' : 'text-faint'}>{icon}</span> : null}
      <span className={cn('composer-pill-label truncate', mono && 'font-mono text-[9.5px]')}>{label}</span>
      <ChevronUp size={9} className={cn('composer-pill-chevron shrink-0 text-faint transition-transform', open && 'rotate-180')} />
    </span>
  );
}

function shortModel(id?: string): string {
  if (!id) return 'Model';
  const tail = (id.split('/').pop() || id)
    .replace(/[:@].*$/, '')
    .replace(/-(preview|latest|instruct|chat)$/i, '')
    .replace(/-\d{6,8}$/, '');
  if (tail.length <= 18) return tail;
  // Cut at a separator so the label reads as a name — `nemotron-3.5…`, never `nemotron-3.5-lightnin…`.
  const cut = tail.slice(0, 18);
  const seam = Math.max(cut.lastIndexOf('-'), cut.lastIndexOf('.'));
  return (seam > 7 ? cut.slice(0, seam) : cut) + '…';
}
