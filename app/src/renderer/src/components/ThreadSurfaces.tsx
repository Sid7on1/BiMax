import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, ExternalLink, Folder, PenLine, Search, Square, X } from 'lucide-react';
import type { QuickContext, QuickThread, ThreadApproval } from '../../../shared/threads';
import { engineReducer, initialEngineState, type TranscriptItem } from '../engine.state';
import type { Outbound, RequestMsg, ToolCallEntry } from '../protocol';
import { DiffView, Markdown } from '../markdown';
import { applyAppearance, savedAppearance } from '../appearance';
import { cn } from '../lib/cn';
import { ThinkingIndicator } from './ThinkingIndicator';

/**
 * The two floating surfaces of Bimax Threads: the ⌘2 bar and the approval popup.
 *
 * Both are frameless, transparent panels whose glass is native (main/index.ts `auxiliaryWindow`), so the page
 * paints no background — only a light tint, a rim and the content. The header and footer move the window;
 * every control opts out of the drag region.
 */

/** A folder's own name is what a person recognises; the full path stays in the tooltip. */
const folderName = (root: string | null | undefined): string => root?.split('/').filter(Boolean).pop() ?? 'Choose a folder';

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
  const input = useRef<HTMLTextAreaElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const adopt = (value: QuickThread | null): void => {
      setThread(value ? { id: value.id, title: value.title, root: value.root } : null);
      dispatch({ type: 'restoreThread', state: value ? value.state : initialEngineState });
    };
    const offContext = window.bimax.threads.onContext((value: QuickContext) => { setContext(value); setError(''); input.current?.focus(); });
    const offThread = window.bimax.threads.onQuickThread(adopt);
    const offMsg = window.bimax.threads.onQuickMsg((msg: Outbound) => dispatch({ type: 'outbound', msg }));
    void window.bimax.threads.context().then(setContext);
    void window.bimax.threads.quickCurrent().then(adopt);
    return () => { offContext(); offThread(); offMsg(); };
  }, []);

  const busy = state.spinner.state !== 'idle' && state.spinner.state !== '';
  const hasConversation = Boolean(thread) || state.items.length > 0;
  const request = state.request as (RequestMsg & { approvalToken?: string }) | null;
  const root = thread?.root ?? context.root;
  // Like Spotlight, the empty bar is only the pill. A missing Finder folder is already said by the folder chip,
  // so its explanation appears only when someone tries to send without one.
  const status = error;
  const showFooter = hasConversation || Boolean(status);

  // The window is exactly as tall as what it shows, so report the NATURAL height — header, the whole
  // conversation, footer — not the scroll box, which the window itself caps. Main clamps it to the screen.
  useLayoutEffect(() => {
    let frame = 0;
    const report = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = (header.current?.offsetHeight ?? 0) + (body.current ? body.current.offsetHeight + 1 : 0) + (footer.current?.offsetHeight ?? 0);
        window.bimax.threads.quickResize(height);
      });
    };
    report();
    const observer = new ResizeObserver(report);
    for (const el of [header.current, body.current, footer.current]) if (el) observer.observe(el);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [hasConversation, showFooter]);

  // Follow the answer as it streams, unless the reader has scrolled up to look at something.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [state.items.length, state.streaming, state.thinking, request?.id]);

  async function submit(): Promise<void> {
    const text = prompt.trim();
    if (!text || sending) return;
    if (!thread && !context.root) { setError(context.error || 'Choose a folder for this task first.'); return; }
    setSending(true); setError('');
    dispatch({ type: 'localUser', text });
    setPrompt('');
    try {
      const result = await window.bimax.threads.quickSubmit(text);
      if (!result?.ok) setError(result?.error || 'Could not start the task.');
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

  async function chooseFolder(): Promise<void> {
    const picked = await window.bimax.threads.pickFolder();
    if (picked) { setContext({ root: picked, source: 'Selected folder' }); setError(''); input.current?.focus(); }
  }

  return (
    <div
      className="quick-root"
      data-glass={glass}
      data-expanded={hasConversation || undefined}
      onKeyDown={(e) => {
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
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
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

      {hasConversation ? (
        <div ref={scroller} className="quick-scroll">
          <div ref={body} className="quick-body">
            <QuickConversation items={state.items} />
            {busy && !state.streaming && !request ? <ThinkingIndicator thinking={state.thinking} /> : null}
            {state.streaming ? <div className="quick-answer"><Markdown text={state.streaming} /></div> : null}
            {request ? <QuickRequest key={request.id} req={request} onReply={(value) => void reply(value)} /> : null}
          </div>
        </div>
      ) : null}

      {showFooter ? (
        <div ref={footer} className="quick-footer quick-drag">
          <span className={cn('quick-status', status && 'quick-error')} role="status">
            {status || (busy ? `Working in ${folderName(root)}` : thread ? folderName(root) : '')}
          </span>
          {thread ? (
            <>
              <button type="button" className="quick-link" onClick={() => window.bimax.threads.quickOpen()}>
                <ExternalLink size={12} aria-hidden />Open in Bimax
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
    else if ((msg.level === 'error' || msg.level === 'warn') && !msg.payload?.capabilityStatus) blocks.push(<p key={msg.id} className="quick-note">{msg.content}</p>);
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
