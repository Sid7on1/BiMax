import React, { memo, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThinkingIndicator } from '../renderer/src/components/ThinkingIndicator';
import { ConversationMessage } from '../renderer/src/components/ConversationMessage';
import { type MarkdownHost } from '../renderer/src/markdown';
import './transcript.css';
const bridge = window as any;
const post = (value: unknown) => bridge.ReactNativeWebView?.postMessage(JSON.stringify(value));
const copies = new Map<number, (ok: boolean) => void>();
let serial = 0;
const host: MarkdownHost = {
  keepOutput: false,
  copy(text) {
    if (text.length > 192 * 1024 || copies.size >= 4) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        copies.delete(id);
        resolve(false);
      }, 5000);
      copies.set(id, (ok) => {
        clearTimeout(timer);
        copies.delete(id);
        resolve(ok);
      });
      post({ type: 'copy', id, text });
    });
  },
};
interface Message {
  id: string;
  role: string;
  content: string;
  reasoning?: string;
  streaming?: boolean;
  status?: string;
}
interface State {
  key: string;
  messages: Message[];
  empty?: string;
  failedId?: string;
  preferences?: {
    reduceMotion: boolean;
    showThinking: boolean;
    followReplies: boolean;
    textSize?: 'comfortable' | 'large';
  };
}
let update: (state: State) => void;
let currentKey = '';
let current: State = { key: '', messages: [] };
let stick = true;
window.addEventListener('scroll', () => {
  stick = innerHeight + scrollY >= document.documentElement.scrollHeight - 120;
});
function Transcript() {
  const [anchor, setAnchor] = useState<string | null>(null);
  const [state, setState] = useState<State>({ key: '', messages: [] });
  update = (next) => {
    if (next.key !== currentKey) {
      stick = true;
      currentKey = next.key;
      setAnchor(null);
    }
    document.documentElement.toggleAttribute('data-reduce-motion', next.preferences?.reduceMotion === true);
    document.documentElement.dataset.chatSize = next.preferences?.textSize || 'desktop';
    current = next;
    setState(next);
  };
  useLayoutEffect(() => {
    if (!stick || state.preferences?.followReplies === false) return;
    const frame = requestAnimationFrame(() => scrollTo(0, document.documentElement.scrollHeight));
    return () => cancelAnimationFrame(frame);
  });
  // Bound mounted Markdown/highlight/diagram trees, while retaining every canonical message.
  const pageSize = 80;
  const anchorIndex = anchor === null ? -1 : state.messages.findIndex((message) => message.id === anchor);
  const start = anchorIndex < 0 ? Math.max(0, state.messages.length - pageSize) : anchorIndex;
  const end = Math.min(state.messages.length, start + pageSize);
  const showPage = (index: number | null) => {
    stick = index === null;
    setAnchor(index === null ? null : (state.messages[Math.max(0, index)]?.id ?? null));
    scrollTo(0, 0);
  };
  return (
    <main aria-label="Conversation">
      {(start > 0 || end < state.messages.length) && (
        <nav className="history-navigation" aria-label="Conversation pages">
          {start > 0 && <button onClick={() => showPage(Math.max(0, start - pageSize))}>Earlier messages</button>}
          {end < state.messages.length && (
            <>
              <button onClick={() => showPage(end)}>Next messages</button>
              <button onClick={() => showPage(null)}>Latest messages</button>
            </>
          )}
        </nav>
      )}
      {!state.messages.length && <div className="empty">{state.empty || 'What can I help with?'}</div>}
      {state.messages.slice(start, end).map((m) => (
        <MessageRow
          key={m.id}
          m={m}
          failedId={state.failedId}
          showThinking={state.preferences?.showThinking !== false}
          reduceMotion={
            state.preferences?.reduceMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches
          }
        />
      ))}{' '}
    </main>
  );
}
const MessageRow = memo(function MessageRow({
  m,
  failedId,
  showThinking,
  reduceMotion,
}: {
  m: Message;
  failedId?: string;
  showThinking: boolean;
  reduceMotion: boolean;
}) {
  return (
    <article key={m.id} data-message-id={m.id} className={`message ${m.role}`}>
      {m.role === 'assistant' && m.streaming && !m.content ? (
        <ThinkingIndicator
          thinking={showThinking ? m.reasoning || '' : ''}
          reduceMotion={reduceMotion}
          status={m.status}
        />
      ) : (
        <ConversationMessage
          id={m.id}
          role={m.role}
          content={m.content}
          reasoning={m.streaming || !showThinking ? undefined : m.reasoning}
          streaming={m.streaming}
          host={host}
          actions={
            m.role !== 'tool' && !!m.content ? (
              <button
                className="message-copy"
                aria-label="Copy message"
                onClick={(e) => {
                  const button = e.currentTarget;
                  void host.copy(m.content).then((ok) => {
                    button.textContent = ok ? 'Copied' : 'Copy';
                  });
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <rect x="8" y="8" width="12" height="12" rx="2" />
                  <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                </svg>
              </button>
            ) : undefined
          }
        />
      )}
      {m.id === failedId && <button onClick={() => post({ type: 'retry' })}>Retry</button>}
    </article>
  );
});
const plugins = new Map<string, { promise: Promise<any>; resolve: (p: any) => void }>();
bridge.BimaxTranscript = {
  update(state: State) {
    update?.(state);
  },
  patch(p: any) {
    if (p.key !== current.key) return;
    let messages = current.messages;
    if (Array.isArray(p.tail)) messages = [...messages.slice(0, p.from), ...p.tail];
    else if (Number.isSafeInteger(p.index) && messages[p.index]?.id === p.id) {
      const old = messages[p.index];
      const text = (value: string, patch: any) =>
        !patch ? value : typeof patch.append === 'string' ? value + patch.append : patch.set;
      messages = messages.slice();
      messages[p.index] = {
        ...old,
        content: text(old.content, p.content),
        reasoning: text(old.reasoning || '', p.reasoning),
        streaming: p.streaming,
        status: p.status,
      };
    }
    update?.({ ...current, messages, empty: p.empty, failedId: p.failedId, preferences: p.preferences });
  },
  copyResult(id: number, ok: boolean) {
    copies.get(id)?.(ok === true);
  },
  plugin(name: string) {
    if (!plugins.has(name)) {
      let resolve!: (p: any) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      plugins.set(name, { promise, resolve });
      post({ type: 'plugin', name });
    }
    return plugins.get(name)!.promise;
  },
  registerPlugin(name: string, plugin: any) {
    plugins.get(name)?.resolve(plugin);
  },
};
document.addEventListener(
  'click',
  (event) => {
    const target = (event.target as Element)?.closest?.('a');
    if (!target) return;
    event.preventDefault();
    if (event.isTrusted && /^https?:\/\//i.test(target.href)) post({ type: 'link', url: target.href });
  },
  true,
);
createRoot(document.getElementById('root')!).render(<Transcript />);
requestAnimationFrame(() => post({ type: 'ready' }));
