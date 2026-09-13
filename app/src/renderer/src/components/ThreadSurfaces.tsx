import React, { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, Cpu, ExternalLink, FileText, Folder, Globe, PenLine, RotateCcw, Search, Square, Undo2, X } from 'lucide-react';
import { QUICK_BAR_MAX_HEIGHT_SHARE, type QuickAttachment, type QuickContext, type QuickThread, type ThreadApproval } from '../../../shared/threads';
import { engineReducer, initialEngineState, type TranscriptItem } from '../engine.state';
import type { Outbound, RequestMsg, ToolCallEntry } from '../protocol';
import { DiffView, Markdown } from '../markdown';
import { applyAppearance, savedAppearance } from '../appearance';
import { cn } from '../lib/cn';
import { ThinkingIndicator } from './ThinkingIndicator';
import { StreamCoalescer } from '../stream.coalescer';
import { approvalShortcut, denyOption } from '../approval.keys';
import { PathLinkContext } from '../path.links';
import { loadHistory, remember, stepHistory } from '../quick.history';

/**
 * The two floating surfaces of Bimax Threads: the ⌘2 bar and the approval popup.
 *
 * Both are frameless, transparent panels whose glass is native (main/index.ts `auxiliaryWindow`), so the page
 * paints no background — only a light tint, a rim and the content. The header and footer move the window;
 * every control opts out of the drag region.
 */

/** A folder's own name is what a person recognises; the full path stays in the tooltip. */
const folderName = (root: string | null | undefined): string => root?.split('/').filter(Boolean).pop() ?? 'Choose a folder';

/** How much the bar grows at a time while a reply is being written: about two lines of body text. */
const GROW_STEP_PX = 44;
/** How long text may stop arriving mid-turn before the bar shows that the turn is still working. */
const STALL_MS = 900;
/** A turn's length for the footer: seconds, then minutes and seconds. */
const formatDuration = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

function useSurface(kind: 'quick' | 'approval'): 'native' | 'vibrancy' {
  const glass = new URLSearchParams(location.search).get('glass') === 'native' ? 'native' : 'vibrancy';
  useLayoutEffect(() => {
    document.documentElement.classList.add('aux-surface', `aux-${kind}`);
    return applyAppearance(savedAppearance());
  }, [kind]);
  return glass;
}

/**
 * The ⌘2 bar. A single glass pill — like Spotlight — until a task produces output, then it grows downward into
 * the task's conversation: the thinking row, the steps it takes, the streamed answer, and any question or
 * permission the task needs, answered inline. Follow-ups continue the same thread; "New" starts another.
 */
export function ThreadQuickBar(): React.ReactElement {
  const glass = useSurface('quick');
  const [context, setContext] = useState<QuickContext>({ root: null, source: 'Reading Finder…' });
  const [thread, setThread] = useState<Omit<QuickThread, 'state'> | null>(null);
  const [state, dispatch] = useReducer(engineReducer, initialEngineState);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  // What the task gets as context: what was open when ⌘2 was pressed, plus anything dropped on the bar.
  const [attachments, setAttachments] = useState<QuickAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const attachRow = useRef<HTMLDivElement>(null);
  // ↑ / ↓ through earlier prompts (quick.history.ts); what was being typed is kept while stepping.
  const history = useRef<string[]>(loadHistory());
  const historyCursor = useRef<number | null>(null);
  const draft = useRef('');
  const input = useRef<HTMLTextAreaElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  // Whether the newest engine output was a tool step rather than text. After a tool runs, the text on screen
  // was written BEFORE it, so the activity row must show even though the stream buffer is not empty.
  const [afterTool, setAfterTool] = useState(false);
  const afterToolRef = useRef(false);
  const noteOutputKind = useRef((msg: Outbound): void => {
    const name = msg.t === 'event' ? String((msg as { name?: unknown }).name ?? '') : '';
    if (!name) return;
    const next = name === 'tool_call' || name === 'tool_call_result' ? true
      : name === 'stream_token' || name === 'message' ? false : afterToolRef.current;
    if (next !== afterToolRef.current) { afterToolRef.current = next; setAfterTool(next); }
  }).current;

  useEffect(() => {
    // Adjacent streaming deltas become one dispatch per frame, as in the main window. Dispatching every token
    // re-rendered the whole bar hundreds of times a second while a reply was written.
    const batcher = new StreamCoalescer({ emit: (msg) => dispatch({ type: 'outbound', msg }) });
    const adopt = (value: QuickThread | null): void => {
      batcher.retire(); // the snapshot already holds everything the batcher was waiting to send
      setThread(value ? { id: value.id, title: value.title, root: value.root } : null);
      if (value) setAttachments([]);
      dispatch({ type: 'restoreThread', state: value ? value.state : initialEngineState });
    };
    const offContext = window.bimax.threads.onContext((value: QuickContext) => { setContext(value); setAttachments(value.attachments ?? []); setError(''); input.current?.focus(); });
    const offThread = window.bimax.threads.onQuickThread(adopt);
    const offMsg = window.bimax.threads.onQuickMsg((msg: Outbound) => {
      noteOutputKind(msg);
      batcher.push(msg);
    });
    void window.bimax.threads.context().then((value: QuickContext) => { setContext(value); setAttachments(value.attachments ?? []); });
    void window.bimax.threads.quickCurrent().then(adopt);
    return () => { offContext(); offThread(); offMsg(); batcher.dispose(); };
  }, []);

  const busy = state.spinner.state !== 'idle' && state.spinner.state !== '';
  const hasConversation = Boolean(thread) || state.items.length > 0;
  const request = state.request as (RequestMsg & { approvalToken?: string }) | null;
  const root = thread?.root ?? context.root;
  // Text that stops arriving mid-turn means the model is running a tool or reading its result. Say so, instead
  // of leaving the last sentence looking like the end of the answer.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!busy || !state.streaming) return;
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [busy, state.streaming]);
  const showActivity = busy && !request && (!state.streaming || afterTool || stalled);
  // The newest change this thread made that can still be undone ("↶ Undo" in the footer). Looked up when the thread
  // changes and whenever a turn ends; hidden while a turn is running.
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    let live = true;
    if (!thread || busy) { setUndo(null); return; }
    void window.bimax.threads.undoInfo(thread.id).then((value: { id: string; title: string } | null) => { if (live) setUndo(value); });
    return () => { live = false; };
  }, [thread?.id, busy]);
  // Footer timing: how long the current turn has run, or the last one took, and which model is answering.
  const turnStart = useRef<number | null>(null);
  const [lastTurnMs, setLastTurnMs] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (busy) {
      if (turnStart.current === null) turnStart.current = Date.now();
      const timer = setInterval(() => setTick((n) => n + 1), 1000);
      return () => clearInterval(timer);
    }
    if (turnStart.current !== null) { setLastTurnMs(Date.now() - turnStart.current); turnStart.current = null; }
    return undefined;
  }, [busy]);
  useEffect(() => { setLastTurnMs(null); }, [thread?.id]);
  const models = (state.snapshot as { models?: { coding?: string; lite?: string } } | null)?.models;
  const modelId = state.tier === 'lite' ? models?.lite || models?.coding : models?.coding;
  const elapsed = busy && turnStart.current !== null ? Date.now() - turnStart.current : lastTurnMs;
  const timing = elapsed !== null ? formatDuration(elapsed) : '';
  const lastItem = state.items[state.items.length - 1];
  const lastIsAnswer = !!lastItem && lastItem.kind === 'msg' && lastItem.msg.role === 'assistant';
  const pathLinks = useMemo(() => ({
    open: (raw: string, mode: 'preview' | 'reveal') => {
      void window.bimax.threads.openPath(raw, mode).then((result: { ok: boolean; error?: string } | undefined) => {
        if (!result?.ok) setError(result?.error || `Could not find “${raw}”.`);
      });
    },
  }), []);
  // Like Spotlight, the empty bar is only the pill. A missing Finder folder is already said by the folder chip,
  // so its explanation appears only when someone tries to send without one.
  const status = error;
  const showFooter = hasConversation || Boolean(status);

  const busyRef = useRef(busy);
  busyRef.current = busy;
  const reportedHeight = useRef(0);
  // The window is exactly as tall as what it shows, so report the NATURAL height — header, the whole
  // conversation, footer — not the scroll box, which the window itself caps. Main clamps it to the screen.
  useLayoutEffect(() => {
    let frame = 0;
    const report = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const natural = (header.current?.offsetHeight ?? 0) + (attachRow.current?.offsetHeight ?? 0) + (body.current ? body.current.offsetHeight + 1 : 0) + (footer.current?.offsetHeight ?? 0);
        // While a reply is being written, grow two lines at a time and never shrink: resizing the window on
        // every line, and shrinking whenever half-written markdown reflowed, is what made the text jump.
        const height = busyRef.current
          ? Math.max(reportedHeight.current, Math.ceil(natural / GROW_STEP_PX) * GROW_STEP_PX)
          : natural;
        if (height === reportedHeight.current) return;
        reportedHeight.current = height;
        window.bimax.threads.quickResize(height);
      });
    };
    report();
    const observer = new ResizeObserver(report);
    for (const el of [header.current, attachRow.current, body.current, footer.current]) if (el) observer.observe(el);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [hasConversation, showFooter, busy, attachments.length]);

  // Follow the newest text only once the bar is as tall as it may get. Below that the window grows to fit,
  // and scrolling ahead of the resize is what made lines jump. A reader who scrolled up stays where they are.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (reportedHeight.current < Math.floor(window.screen.availHeight * QUICK_BAR_MAX_HEIGHT_SHARE)) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [state.items.length, state.streaming, state.thinking, request?.id, showActivity]);

  async function submit(): Promise<void> {
    const text = prompt.trim();
    if (!text || sending) return;
    if (!thread && !context.root) { setError(context.error || 'Choose a folder for this task first.'); return; }
    setSending(true); setError('');
    history.current = remember(history.current, text);
    historyCursor.current = null;
    draft.current = '';
    dispatch({ type: 'localUser', text });
    setPrompt('');
    try {
      const result = await window.bimax.threads.quickSubmit(text, { attachments, root: thread ? undefined : context.root ?? undefined });
      if (!result?.ok) setError(result?.error || 'Could not start the task.');
      else setAttachments([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function reply(value: string): Promise<void> {
    if (!thread || !request?.approvalToken) return;
    const ok = await window.bimax.threads.reply(thread.id, request.id, value, request.approvalToken);
    if (ok) dispatch({ type: 'closeRequest' });
    else setError('That request has expired. Nothing was sent.');
  }

  async function undoLastChange(): Promise<void> {
    if (!thread || !undo) return;
    setUndo(null);
    const result = await window.bimax.threads.undo(thread.id);
    setError(result?.ok ? '' : result?.error || 'That change could not be undone.');
    setUndo(await window.bimax.threads.undoInfo(thread.id));
  }

  /** Files dropped on the bar become context. A new task works in their folder; an existing one keeps its own. */
  function addDropped(files: FileList): void {
    const paths = [...files].map((file) => window.bimax.threads.pathForFile(file)).filter((p: string | undefined): p is string => Boolean(p));
    if (!paths.length) return;
    const folder = thread?.root ?? context.root;
    const within = (p: string): boolean => !!folder && (p === folder || p.startsWith(folder.endsWith('/') ? folder : `${folder}/`));
    const outside = paths.filter((p) => !within(p));
    if (thread && outside.length) {
      setError(`${outside.length === 1 ? 'That file is' : 'Those files are'} outside ${folderName(folder)}. Start a New task to use ${outside.length === 1 ? 'it' : 'them'}.`);
      return;
    }
    if (!thread && outside.length === paths.length) setContext({ root: paths[0].replace(/\/[^/]+\/?$/, '') || '/', source: 'Dropped files' });
    setAttachments((current) => [
      ...current.filter((a) => !a.path || !paths.includes(a.path)),
      ...paths.map((p): QuickAttachment => ({ kind: 'file', label: p.split('/').filter(Boolean).pop() ?? p, path: p })),
    ].slice(0, 50));
    setError('');
    input.current?.focus();
  }

  async function chooseFolder(): Promise<void> {
    const picked = await window.bimax.threads.pickFolder();
    if (picked) { setContext({ root: picked, source: 'Selected folder' }); setError(''); input.current?.focus(); }
  }

  return (
    <div
      className="quick-root"
      data-glass={glass}
      data-expanded={hasConversation || undefined}
      data-dropping={dropping || undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(e) => { e.preventDefault(); setDropping(false); addDropped(e.dataTransfer.files); }}
      onKeyDown={(e) => {
        // An approval card on screen owns ⌘↩ (allow) and Esc (deny); otherwise Esc hides the bar.
        const pick = request ? approvalShortcut(e.nativeEvent, request) : undefined;
        if (pick) { e.preventDefault(); void reply(pick); return; }
        // ⌘[ and ⌘] step through this bar's recent tasks.
        if (e.metaKey && (e.key === '[' || e.key === ']')) { e.preventDefault(); void window.bimax.threads.quickSwitch(e.key === '[' ? 'older' : 'newer'); return; }
        if (e.key === 'Escape') { e.preventDefault(); window.bimax.threads.hide(); }
        if (e.key.toLowerCase() === 'n' && e.metaKey) { e.preventDefault(); window.bimax.threads.quickReset(); input.current?.focus(); }
      }}
    >
      <div ref={header} className="quick-header quick-drag">
        <Search size={20} className="quick-icon" aria-hidden />
        <textarea
          ref={input}
          autoFocus
          rows={1}
          aria-label="Ask Bimax"
          placeholder={thread ? 'Follow up…' : 'Ask Bimax anything…'}
          value={prompt}
          onChange={(e) => { historyCursor.current = null; setPrompt(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
            // ↑ at the start (or in an empty field) recalls earlier prompts; ↓ walks back to what was being typed.
            const field = e.currentTarget;
            const atStart = field.selectionStart === 0 && field.selectionEnd === 0;
            if ((e.key === 'ArrowUp' && (atStart || !prompt)) || (e.key === 'ArrowDown' && historyCursor.current !== null && field.selectionStart === field.value.length)) {
              if (historyCursor.current === null) draft.current = prompt;
              const step = stepHistory(history.current, historyCursor.current, e.key === 'ArrowUp' ? 'back' : 'forward', draft.current);
              if (step.text !== prompt || step.cursor !== historyCursor.current) { e.preventDefault(); historyCursor.current = step.cursor; setPrompt(step.text); }
            }
          }}
          className="quick-input"
        />
        <button
          type="button"
          className="quick-folder"
          title={root ?? 'Choose the folder this task works in'}
          disabled={Boolean(thread)}
          onClick={() => void chooseFolder()}
        >
          <Folder size={13} aria-hidden />
          <span>{folderName(root)}</span>
        </button>
        {busy ? (
          <button type="button" aria-label="Stop" title="Stop this task" className="quick-circle" onClick={() => window.bimax.threads.quickInterrupt()}>
            <Square size={12} />
          </button>
        ) : prompt.trim() ? (
          <button type="button" aria-label="Send" className="quick-circle quick-send" disabled={sending} onClick={() => void submit()}>
            <ArrowUp size={17} />
          </button>
        ) : null}
      </div>

      {attachments.length ? (
        <div ref={attachRow} className="quick-attachments">
          {attachments.map((a, index) => (
            <span key={`${a.kind}:${a.path ?? a.url}:${index}`} className="quick-chip" title={a.path ?? a.url}>
              {a.kind === 'page' ? <Globe size={11} aria-hidden /> : <FileText size={11} aria-hidden />}
              <span>{a.label}</span>
              <button type="button" aria-label={`Remove ${a.label}`} onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}><X size={10} /></button>
            </span>
          ))}
        </div>
      ) : null}

      {hasConversation ? (
        <div ref={scroller} className="quick-scroll">
          <PathLinkContext.Provider value={pathLinks}>
          <div ref={body} className="quick-body">
            <QuickConversation items={state.items} />
            {state.streaming ? <div className="quick-answer"><Markdown text={state.streaming} /></div> : null}
            {showActivity ? <ThinkingIndicator thinking={state.thinking} /> : null}
            {request ? <QuickRequest key={request.id} req={request} onReply={(value) => void reply(value)} /> : null}
          </div>
          </PathLinkContext.Provider>
        </div>
      ) : null}

      {showFooter ? (
        <div ref={footer} className="quick-footer quick-drag">
          <span className={cn('quick-status', status && 'quick-error')} role="status">
            {status || [busy ? `Working in ${folderName(root)}` : thread ? folderName(root) : '', timing].filter(Boolean).join(' · ')}
          </span>
          {thread ? (
            <>
              <button type="button" className="quick-link quick-model" title="Choose the model for this task" onClick={() => window.bimax.threads.modelMenu('switch')}>
                <Cpu size={12} aria-hidden /><span>{modelId ? modelId.split('/').pop() : 'Model'}</span>
              </button>
              {!busy && lastIsAnswer ? (
                <button type="button" className="quick-link" title="Answer again with another model" onClick={() => window.bimax.threads.modelMenu('retry')}>
                  <RotateCcw size={12} aria-hidden />Retry
                </button>
              ) : null}
              {undo && !busy ? (
                <button type="button" className="quick-link quick-undo" title={`Undo: ${undo.title}`} onClick={() => void undoLastChange()}>
                  <Undo2 size={12} aria-hidden /><span>Undo: {undo.title}</span>
                </button>
              ) : null}
              <button type="button" className="quick-link" title="Open in Bimax" onClick={() => window.bimax.threads.quickOpen()}>
                <ExternalLink size={12} aria-hidden />Open
              </button>
              <button type="button" className="quick-link" title="New task (⌘N)" onClick={() => { window.bimax.threads.quickReset(); input.current?.focus(); }}>
                <PenLine size={12} aria-hidden />New
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** User turns as quiet bubbles, answers as markdown, and each run of tool calls folded into one line. */
function QuickConversation({ items }: { items: TranscriptItem[] }): React.ReactElement {
  const blocks: React.ReactNode[] = [];
  let calls: ToolCallEntry[] = [];
  const flush = (key: string): void => {
    if (!calls.length) return;
    blocks.push(<QuickSteps key={key} calls={calls} />);
    calls = [];
  };
  items.forEach((item, index) => {
    if (item.kind === 'tool') { calls.push(item.call); return; }
    flush(`steps-${index}`);
    const { msg } = item;
    if (msg.role === 'user') blocks.push(<p key={msg.id} className="quick-prompt">{msg.content}</p>);
    else if (msg.role === 'assistant') blocks.push(<div key={msg.id} className="quick-answer"><Markdown text={msg.content} /></div>);
    else if (((msg.level === 'error' || msg.level === 'warn' || msg.level === 'success') && !msg.payload?.capabilityStatus) || msg.payload?.threadNote) blocks.push(<p key={msg.id} className="quick-note">{msg.content}</p>);
  });
  flush('steps-end');
  return <>{blocks}</>;
}

/** A run of tool calls as one line — "Done · 3 steps · Read, Edit" — that opens to show each call. */
function QuickSteps({ calls }: { calls: ToolCallEntry[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const running = calls.some((call) => call.status === 'running');
  const failed = calls.filter((call) => call.status === 'error').length;
  const names = [...new Set(calls.map((call) => call.toolName.replace(/Tool$/, '')))].slice(0, 3).join(', ');
  return (
    <div className="quick-steps">
      <button type="button" className="quick-steps-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
        <span>{running ? 'Working' : failed ? `${failed} failed` : 'Done'} · {calls.length} step{calls.length === 1 ? '' : 's'} · {names}</span>
      </button>
      {open ? (
        <ul className="quick-steps-list">
          {calls.map((call) => (
            <li key={call.id} data-status={call.status}>
              {call.status === 'error' ? <X size={11} aria-hidden /> : call.status === 'success' ? <Check size={11} aria-hidden /> : <span className="quick-dot" aria-hidden />}
              <span className="quick-step-name">{call.toolName.replace(/Tool$/, '')}</span>
              <span className="quick-step-input" title={call.input}>{call.input.slice(0, 160)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The engine is blocked on this answer. The same three shapes RequestModal handles — free text (masked when it
 * is a secret), a checklist, or one button per option with any diff shown above — inline instead of modal.
 */
function QuickRequest({ req, onReply }: { req: RequestMsg; onReply: (value: string) => void }): React.ReactElement {
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const freeForm = req.kind === 'input' || (req.isAsk && req.options.length === 0);
  return (
    <section className="quick-request" aria-label="Bimax needs your answer">
      <p className="quick-request-question">{req.question}</p>
      {req.kind === 'diff' && req.body ? <div className="quick-request-diff"><DiffView diff={req.body} /></div> : null}
      {req.kind !== 'diff' && req.body ? <pre className="quick-request-body">{req.body}</pre> : null}
      {freeForm ? (
        <form className="quick-request-form" onSubmit={(e) => { e.preventDefault(); onReply(text); }}>
          <input
            autoFocus
            type={req.masked ? 'password' : 'text'}
            value={text}
            placeholder={req.masked ? '••••••••' : 'Type your answer…'}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="quick-choice quick-choice-primary">Send</button>
        </form>
      ) : req.isMulti ? (
        <>
          <div className="quick-request-checks">
            {req.options.map((option) => (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={checked.has(option)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(option); else next.delete(option);
                    setChecked(next);
                  }}
                />
                {option}
              </label>
            ))}
          </div>
          <div className="quick-request-options">
            <button type="button" className="quick-choice quick-choice-primary" onClick={() => onReply([...checked].join(', '))}>Confirm</button>
          </div>
        </>
      ) : (
        <div className="quick-request-options">
          {req.options.map((option, index) => (
            <button key={option + index} type="button" className={cn('quick-choice', index === 0 && 'quick-choice-primary')} onClick={() => onReply(option)}>
              {option}
            </button>
          ))}
          {denyOption(req.options) ? <span className="quick-request-keys">⌘↩ {req.options[0]} · Esc {denyOption(req.options)}</span> : null}
        </div>
      )}
    </section>
  );
}

/** Decisions from threads that are not on screen in the ⌘2 bar. Draggable by its header. */
export function ThreadApprovals(): React.ReactElement {
  const glass = useSurface('approval');
  const [requests, setRequests] = useState<ThreadApproval[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const off = window.bimax.threads.onApprovals(setRequests);
    void window.bimax.threads.approvals().then(setRequests);
    return off;
  }, []);
  const current = requests[0];
  useEffect(() => { setError(''); }, [current?.threadId, current?.request.id]);

  // ⌘↩ allows and Esc denies, like the card in the bar (approval.keys.ts).
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent): void => {
      const pick = approvalShortcut(e, current.request);
      if (pick) { e.preventDefault(); void reply(pick); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  async function reply(answer: string): Promise<void> {
    if (!current) return;
    const ok = await window.bimax.threads.reply(current.threadId, current.request.id, answer, current.token);
    if (!ok) setError('This request has expired. No answer was sent.');
    setRequests(await window.bimax.threads.approvals());
  }

  return (
    <div className="aux-panel" data-glass={glass}>
      <header className="aux-panel-header quick-drag">
        <span>Bimax · {requests.length} decision{requests.length === 1 ? '' : 's'} waiting</span>
        <button type="button" aria-label="Hide" className="quick-circle" onClick={() => window.bimax.threads.hide()}>
          <X size={14} />
        </button>
      </header>
      <div className="aux-panel-body">
        {current ? (
          <>
            <p className="aux-panel-title">{current.title}</p>
            <p className="aux-panel-path" title={current.root}>{current.root}</p>
            <QuickRequest key={`${current.threadId}:${current.request.id}`} req={current.request} onReply={(value) => void reply(value)} />
            <p className="aux-panel-note">Only this thread is waiting. Hiding this window does not answer it.</p>
            {error ? <p role="alert" className="quick-error">{error}</p> : null}
          </>
        ) : (
          <p className="aux-panel-note">No pending decisions.</p>
        )}
      </div>
    </div>
  );
}
