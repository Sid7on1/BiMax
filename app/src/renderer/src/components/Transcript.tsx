import React, { useMemo, useRef, useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import {
  Loader, CircleCheck, CircleX, ChevronRight, ChevronDown, Pencil, SearchCode, ArrowDown,
  Copy, Check, Volume2, ThumbsUp, ThumbsDown,
} from 'lucide-react';
import { TranscriptItem } from '../useEngine';
import { MessageEntry, ToolCallEntry } from '../protocol';
import { Markdown } from '../markdown';
import { Dashboard } from './Dashboards';
import { cn } from '../lib/cn';
import { inspectActionReceipt, type ActionReceiptView } from '../receipt.inspector';
import { isMacToolCall, describeMacAction, describeMacActionIntent } from '../mac.session.model';

/** Plain-language label for a Mac provider call, or '' when the call is ordinary coding work. */
function macCallView(call: ToolCallEntry): { label: string; failed: boolean } | null {
  if (!isMacToolCall(call)) return null;
  let payload: Record<string, unknown> | null = null;
  let input: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(call.output);
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { payload = null; }
  try {
    const parsed = JSON.parse(call.input);
    input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { input = null; }
  const action = String(payload?.action || input?.action || '');
  if (!action) return null;
  const displayPayload = { ...input, ...payload };
  const failed = payload?.ok === false;
  const label = payload?.code === 'computer_use_paused'
    || payload?.code === 'computer_use_takeover_intervened'
    ? `Refused ${describeMacActionIntent(action, displayPayload)} — you have control`
    : failed
      ? `Blocked: ${describeMacActionIntent(action, displayPayload)}`
      : describeMacAction(action, displayPayload);
  return { label, failed };
}

/**
 * Transcript v2 — virtualized scrollback (day-long sessions stay smooth), consecutive tool
 * calls folded into activity chips ("Edited 3 files · 5 edits"), dashboards, menus, and a
 * "Thought for Ns" expander holding the turn's actual reasoning text.
 */

type Row =
  | { kind: 'msg'; key: string; item: Extract<TranscriptItem, { kind: 'msg' }> }
  | { kind: 'tool'; key: string; call: ToolCallEntry }
  | { kind: 'group'; key: string; kindOf: 'edit' | 'explore'; calls: ToolCallEntry[] };

const MUTATING = /edit|write|patch/i;
const READONLY = /read|grep|glob|search|graph|list|^ls$|find|related|map|impact/i;

function classify(name: string): 'edit' | 'explore' | null {
  if (MUTATING.test(name)) return 'edit';
  if (READONLY.test(name)) return 'explore';
  return null;
}

/** Fold consecutive same-category tool calls (per agent) into groups of ≥2. */
function buildRows(items: TranscriptItem[]): Row[] {
  const rows: Row[] = [];
  let run: { kindOf: 'edit' | 'explore'; parent: string; calls: ToolCallEntry[] } | null = null;

  const flush = (): void => {
    if (!run) return;
    if (run.calls.length >= 2) {
      rows.push({ kind: 'group', key: `g-${run.calls[0].id}`, kindOf: run.kindOf, calls: run.calls });
    } else {
      run.calls.forEach((c) => rows.push({ kind: 'tool', key: `t-${c.id}`, call: c }));
    }
    run = null;
  };

  for (const it of items) {
    if (it.kind === 'tool') {
      const cat = classify(it.call.toolName);
      const parent = it.call.parentId || '';
      if (cat && run && run.kindOf === cat && run.parent === parent) {
        run.calls.push(it.call);
        continue;
      }
      flush();
      if (cat) {
        run = { kindOf: cat, parent, calls: [it.call] };
      } else {
        rows.push({ kind: 'tool', key: `t-${it.call.id}`, call: it.call });
      }
    } else {
      // "Conversation cleared", "checkpoint created" and friends are confirmations, and
      // DESIGN_LANGUAGE.md is explicit that those do not belong in scrollback: "The best status
      // message is none… Only turn-relevant content enters the transcript." Warnings and errors are
      // turn-relevant, so those stay.
      const chatter = it.msg.role === 'system'
        && it.msg.level !== 'warn'
        && it.msg.level !== 'error'
        && !it.msg.uiComponent;
      if (chatter) continue;
      flush();
      rows.push({ kind: 'msg', key: it.msg.id, item: it });
    }
  }
  flush();
  return rows;
}

function fileOf(input: string): string | null {
  const m = (input || '').match(/[\w@~./\\-]+\.[A-Za-z]\w{0,5}/);
  return m ? m[0] : null;
}

/**
 * A tool call as a sentence: what happened, and to what.
 *
 * The old row printed `ReadFileTool` next to 120 characters of raw JSON arguments, which is the
 * engine's vocabulary, not the user's — and the argument blob pushed the one useful token (the
 * file, the command, the pattern) off the end of the line. Verb plus subject puts it first.
 */
const TOOL_VERBS: Array<[RegExp, string]> = [
  [/multiedit|edit|patch/i, 'Edited'],
  [/write|create.*file/i, 'Wrote'],
  [/delete|remove/i, 'Deleted'],
  [/createdirectory|mkdir/i, 'Created folder'],
  [/read|cat/i, 'Read'],
  [/grep|search.*text/i, 'Searched for'],
  [/glob|find|^ls$|listdir/i, 'Listed'],
  [/bash|shell|terminal|command/i, 'Ran'],
  [/websearch/i, 'Searched the web for'],
  [/webfetch|fetch/i, 'Fetched'],
  [/browser/i, 'Browsed'],
  [/todo|task/i, 'Updated the plan'],
  [/git/i, 'Ran git'],
  [/test/i, 'Ran tests in'],
  [/graph|related|impact|map|symbol/i, 'Analysed'],
];

function toolVerb(name: string): string {
  for (const [pattern, verb] of TOOL_VERBS) if (pattern.test(name)) return verb;
  return name.replace(/Tool$/, '');
}

/** The one argument worth reading: a path, a command, or a query. */
function toolSubject(call: ToolCallEntry): string {
  const raw = call.input || '';
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(raw);
    parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { parsed = null; }
  for (const key of ['file_path', 'path', 'filePath', 'file', 'command', 'cmd', 'pattern', 'query', 'url', 'directory']) {
    const value = parsed?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fileOf(raw) || truncate(raw.replace(/[{}"]/g, ' ').trim(), 80);
}

export function Transcript({
  items, streaming, thinking, busy, onMenuSelect,
}: {
  items: TranscriptItem[];
  streaming: string;
  thinking: string;
  /** The run is in flight. Drives the one liveness cue left after the task strip was removed. */
  busy: boolean;
  onMenuSelect: (id: string, value: string) => void;
}): React.ReactElement {
  const rows = useMemo(() => buildRows(items), [items]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);

  if (items.length === 0 && !streaming) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 select-none">
        <div className="bimax-wordmark text-[20px]">BiMAX</div>
        <div className="text-dim">
          Ask anything about this project — or type{' '}
          <code className="font-mono text-ember">/</code> for commands.
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        data={rows}
        computeItemKey={(_, row) => row.key}
        followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={48}
        initialTopMostItemIndex={Math.max(rows.length - 1, 0)}
        className="h-full overscroll-contain"
        itemContent={(_, row) => <RowView row={row} onMenuSelect={onMenuSelect} />}
        components={{
          Header: () => <div className="h-4" />,
          Footer: () => (
            <div className="px-4 pb-3">
              {thinking && (
                <div className="reading-column mx-auto mb-3.5 truncate text-xs text-faint italic">
                  <span className="mr-1.5 inline-block size-1.5 animate-soft-blink rounded-full bg-ember" />
                  thinking… <span className="opacity-70">{thinking.slice(-200)}</span>
                </div>
              )}
              {/* The only liveness cue left now that the task strip is gone. It sits in the flow of
                  the conversation rather than in a bar above it, and it says nothing but that the
                  run is alive — which is exactly the thing a silent two-minute wait cannot say. */}
              {busy && !streaming && !thinking && (
                <div className="reading-column mx-auto mb-3.5 flex items-center gap-2 text-xs text-faint">
                  <span className="inline-block size-1.5 animate-soft-blink rounded-full bg-ember" />
                  Working…
                </div>
              )}
              {streaming && (
                <div className="reading-column mx-auto">
                  <Markdown text={streaming} />
                  <span className="animate-soft-blink text-ember">▋</span>
                </div>
              )}
            </div>
          ),
        }}
      />
      {!atBottom && (
        <button
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-raise px-3 py-1 text-xs text-dim shadow-lg hover:text-ink"
        >
          <ArrowDown size={12} />
          Jump to latest
        </button>
      )}
    </div>
  );
}

function RowView({ row, onMenuSelect }: { row: Row; onMenuSelect: (id: string, value: string) => void }): React.ReactElement {
  // The gap lives here, once, so every row type is spaced identically — a message, a tool card and
  // a folded activity group used to each carry their own margin and none of them agreed.
  return (
    <div className="px-4 pb-5">
      {row.kind === 'msg' && <Message item={row.item} onMenuSelect={onMenuSelect} />}
      {row.kind === 'tool' && <ToolCard call={row.call} />}
      {row.kind === 'group' && <ActivityGroup kindOf={row.kindOf} calls={row.calls} />}
    </div>
  );
}

function Message({
  item, onMenuSelect,
}: {
  item: Extract<TranscriptItem, { kind: 'msg' }>;
  onMenuSelect: (id: string, value: string) => void;
}): React.ReactElement {
  const { msg, menuChosen, thought } = item;
  if (msg.uiComponent === 'menu' && msg.payload) {
    return <MenuCard msg={msg} chosen={menuChosen} onSelect={onMenuSelect} />;
  }
  if (msg.uiComponent && msg.uiComponent.endsWith('Dashboard')) {
    return (
      <div className="reading-column mx-auto">
        <Dashboard msg={msg} />
      </div>
    );
  }
  // A system line that survived `buildRows` is a warning or an error, and is tinted as one.
  if (msg.role === 'system') {
    return (
      <div className={cn(
        'reading-column mx-auto text-[12.5px]',
        msg.level === 'error' ? 'text-rust' : 'text-amber',
      )}>
        <Markdown text={msg.content} />
      </div>
    );
  }

  // What you said sits right, in a bubble; what Bimax said sits left as plain prose. That is the
  // whole speaker cue — a role caption above every single message was louder than the messages.
  if (msg.role === 'user') {
    return (
      <div className="group reading-column mx-auto flex flex-col items-end">
        <div className="max-w-[78%] rounded-[18px] bg-raise px-4 py-2.5 text-ink">
          <Markdown text={msg.content} />
        </div>
        <MessageActions text={msg.content} id={msg.id} align="right" />
      </div>
    );
  }

  return (
    <div className="group reading-column mx-auto">
      {msg.thoughtMs ? <ThoughtLine ms={msg.thoughtMs} text={thought} /> : null}
      <Markdown text={msg.content} />
      <MessageActions text={msg.content} id={msg.id} align="left" rate />
    </div>
  );
}

/**
 * The row of actions that fades in when you point at a message.
 *
 * Copy and Read aloud are real — the clipboard and `speechSynthesis` both live in the renderer.
 * The ratings are honest about their scope: they remember your verdict locally and nothing more.
 * There is no feedback message in the engine protocol yet, so a thumb that claimed to "send
 * feedback" would be a lie told by a button.
 */
function MessageActions({
  text, id, align, rate,
}: {
  text: string;
  id: string;
  align: 'left' | 'right';
  rate?: boolean;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [vote, setVote] = useState<'up' | 'down' | null>(
    () => (localStorage.getItem(`bimax:vote:${id}`) as 'up' | 'down' | null) ?? null,
  );

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const speak = (): void => {
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const setRating = (next: 'up' | 'down'): void => {
    const value = vote === next ? null : next;
    if (value) localStorage.setItem(`bimax:vote:${id}`, value);
    else localStorage.removeItem(`bimax:vote:${id}`);
    setVote(value);
  };

  return (
    <div
      className={cn(
        // The height is reserved, so revealing the row never nudges the message above it.
        'mt-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-150',
        'group-hover:opacity-100 focus-within:opacity-100',
        align === 'right' && 'justify-end',
      )}
    >
      <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={copy} active={copied}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </ActionButton>
      {rate && (
        <>
          <ActionButton label={speaking ? 'Stop reading' : 'Read aloud'} onClick={speak} active={speaking}>
            <Volume2 size={13} />
          </ActionButton>
          <ActionButton label="Good response" onClick={() => setRating('up')} active={vote === 'up'}>
            <ThumbsUp size={13} />
          </ActionButton>
          <ActionButton label="Bad response" onClick={() => setRating('down')} active={vote === 'down'}>
            <ThumbsDown size={13} />
          </ActionButton>
        </>
      )}
    </div>
  );
}

function ActionButton({
  label, onClick, active, children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-2 focus-visible:outline-ember',
        active ? 'text-ember' : 'text-faint hover:bg-hover hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

function ThoughtLine({ ms, text }: { ms: number; text?: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <button
        onClick={() => text && setOpen((v) => !v)}
        className={cn('flex items-center gap-1 text-xs text-faint italic', text && 'cursor-pointer hover:text-dim')}
      >
        {text ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}
        Thought for {(ms / 1000).toFixed(1)}s
      </button>
      {open && text ? (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-well px-3 py-2 text-xs whitespace-pre-wrap text-dim">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** "Edited 3 files · 5 edits" / "Explored 7 files" chip folding a run of tool calls. */
function ActivityGroup({ kindOf, calls }: { kindOf: 'edit' | 'explore'; calls: ToolCallEntry[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const files = new Set<string>();
  calls.forEach((c) => { const f = fileOf(c.input); if (f) files.add(f); });
  const running = calls.some((c) => c.status === 'running');
  const failed = calls.some((c) => c.status === 'error');
  const nested = !!calls[0].parentId;

  const label = kindOf === 'edit'
    ? `Edited ${files.size || calls.length} file${(files.size || calls.length) === 1 ? '' : 's'} · ${calls.length} edit${calls.length === 1 ? '' : 's'}`
    : `Explored ${files.size || calls.length} ${files.size ? 'file' : 'location'}${(files.size || calls.length) === 1 ? '' : 's'}`;

  return (
    <div className={cn('reading-column mx-auto', nested && 'pl-[22px]')}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="-ml-1 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12px] text-dim transition-colors hover:bg-hover/55 hover:text-ink"
      >
        {running
          ? <Loader size={12} className="animate-spin text-amber" />
          : failed
            ? <CircleX size={12} className="text-rust" />
            : kindOf === 'edit' ? <Pencil size={12} className="text-moss" /> : <SearchCode size={12} className="text-dim" />}
        <span>{label}</span>
        {open ? <ChevronDown size={12} className="text-faint" /> : <ChevronRight size={12} className="text-faint" />}
      </button>
      {open && (
        <div className="mt-1 border-l border-line/70 pl-3">
          {calls.map((c) => <ToolCard key={c.id} call={c} inGroup />)}
        </div>
      )}
    </div>
  );
}

function MenuCard({
  msg, chosen, onSelect,
}: {
  msg: MessageEntry;
  chosen?: string;
  onSelect: (id: string, value: string) => void;
}): React.ReactElement {
  const { title, options } = msg.payload as { title: string; options: { label: string; value: string; desc?: string }[] };
  return (
    <div className="reading-column mx-auto rounded-[10px] border border-line bg-raise p-3">
      <div className="mb-2.5 font-semibold">{title}</div>
      {(options || []).map((o, i) => (
        <button
          key={i}
          disabled={chosen !== undefined}
          onClick={() => onSelect(msg.id, o.value)}
          className={cn(
            'mb-1.5 flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-line px-3 py-2 text-left',
            'enabled:hover:border-ember enabled:hover:bg-ember/15',
            chosen !== undefined && 'cursor-default opacity-45',
            chosen === o.value && 'border-ember opacity-100',
          )}
        >
          <span className="font-medium">{o.label}</span>
          {o.desc ? <span className="text-xs text-dim">{o.desc}</span> : null}
        </button>
      ))}
    </div>
  );
}

function ToolCard({ call, inGroup }: { call: ToolCallEntry; inGroup?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const screenshot = computerScreenshot(call);
  const receipt = call.status === 'success' ? inspectActionReceipt(call.output) : null;
  const mac = macCallView(call);
  const visualStatus = call.status === 'success' && mac?.failed ? 'error' : call.status;
  const icon =
    visualStatus === 'running' ? <Loader size={13} className="animate-spin text-amber" />
    : visualStatus === 'success' ? <CircleCheck size={13} className="text-moss" />
    : <CircleX size={13} className="text-rust" />;
  const secs = call.endTime
    ? Math.max(0, (new Date(call.endTime).getTime() - new Date(call.startTime).getTime()) / 1000)
    : null;
  const subject = mac ? '' : toolSubject(call);
  return (
    <div className={cn(inGroup && 'mb-1.5', !inGroup && 'reading-column mx-auto', !inGroup && call.parentId && 'pl-[22px]')}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'group -ml-1 flex min-h-7 w-[calc(100%+4px)] cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors',
          visualStatus === 'error' ? 'text-rust hover:bg-rust/5' : 'text-dim hover:bg-hover/55',
        )}
      >
        <span className="shrink-0">{icon}</span>
        {/* A Mac action reads as an intent, not as a tool name plus its JSON arguments. */}
        {mac ? (
          <span className="min-w-0 flex-1 truncate text-dim group-hover:text-ink">{mac.label}</span>
        ) : (
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="shrink-0 text-dim">{toolVerb(call.toolName)}</span>
            {subject ? <span className="min-w-0 truncate font-mono text-[11px] text-ink/85">{subject}</span> : null}
          </span>
        )}
        {call.agentLabel ? (
          <span className="shrink-0 text-[10px] text-faint">
            {call.agentLabel}
          </span>
        ) : null}
        {secs !== null && secs >= 0.1 ? (
          <span className="shrink-0 text-[10.5px] text-faint tabular-nums">{secs < 10 ? secs.toFixed(1) : Math.round(secs)}s</span>
        ) : null}
        <ChevronRight size={12} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
      </button>
      {/* Everything below the one-line summary is behind the disclosure. A screenshot, a receipt
          table and an output dump used to render unconditionally, so a single tool call could take
          over the conversation before you had decided you cared about it. */}
      {open && (
        <div className="anim-fade-up mt-1 ml-4 space-y-1 border-l border-line/70 pl-3">
          {screenshot ? (
            <img
              src={localImageUrl(screenshot)}
              alt="Latest computer screen"
              className="max-h-[360px] w-auto max-w-full rounded-lg border border-line object-contain"
            />
          ) : null}
          {receipt ? <ActionReceiptCard receipt={receipt} /> : null}
          <pre className="max-h-[280px] overflow-auto rounded-md bg-well/70 px-3 py-2.5 font-mono text-[11px] leading-normal whitespace-pre-wrap text-dim">
            {call.input ? `» ${call.input}\n\n` : ''}
            {call.output || (call.status === 'running' ? 'running…' : '(no output)')}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * A Mac action in the task stream.
 *
 * `04_FRONTEND_PLAN.md` is explicit that "raw JSON, element handles, coordinates, AX/OCR source,
 * retries, and fallback codes are inside a Diagnostics disclosure. Normal users see intent and
 * evidence, not plumbing." The receipt used to render its whole table inline, so every Mac action
 * put `Observation f7-4211-88 · Executor semantic · Focus none` into the conversation. The claim
 * now reads as a sentence and the table lives one disclosure down — the same split the Live Target
 * inspector uses, with the same words.
 */
function ActionReceiptCard({ receipt }: { receipt: ActionReceiptView }): React.ReactElement {
  const verified = receipt.postcondition.startsWith('matched');
  const rows: Array<[string, string]> = [
    ['Target', receipt.target],
    ['Observation', receipt.observation],
    ['Executor', receipt.executor],
    ['Focus', receipt.focus],
    ['Timing', receipt.timing],
    ['Postcondition', receipt.postcondition],
  ];
  return (
    <div
      className={cn(
        'mt-1 rounded-lg border px-3 py-1.5 text-[11.5px]',
        verified ? 'border-moss/20 bg-moss/5' : 'border-line bg-raise',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={verified ? 'text-moss' : 'text-dim'}>
          {verified
            ? `Confirmed on ${receipt.target.split(' · ')[0]}`
            : `Not confirmed — ${receipt.postcondition}`}
        </span>
        <span className="ml-auto shrink-0 text-faint">{receipt.outcome}</span>
      </div>
      <details className="mt-0.5">
        <summary className="cursor-pointer text-[10px] text-faint hover:text-dim">Details</summary>
        <dl className="mt-1 grid grid-cols-[82px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10.5px]">
          {rows.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-faint">{label}</dt>
              <dd className="min-w-0 break-words font-mono text-dim">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      </details>
    </div>
  );
}

/**
 * A Mac action's own screenshot, when the Desktop provider attached one.
 *
 * The old check was `toolName === 'ComputerTool'`, which Phase 4 deleted along with the engine's
 * Computer Use ownership — so this had been rendering nothing at all. `isMacToolCall` is the same
 * predicate the Live Target inspector uses, so the transcript and the inspector can never disagree
 * about which calls are Mac work.
 */
function computerScreenshot(call: ToolCallEntry): string {
  if (!isMacToolCall(call) || call.status !== 'success' || !call.output) return '';
  try {
    const parsed = JSON.parse(call.output);
    return typeof parsed?.screenshot === 'string' ? parsed.screenshot : '';
  } catch {
    return '';
  }
}

function localImageUrl(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized)}`;
}

function truncate(s: string, n: number): string {
  const one = (s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}
