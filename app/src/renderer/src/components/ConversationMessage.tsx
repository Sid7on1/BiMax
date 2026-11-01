import React, { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { Markdown, type MarkdownHost } from '../markdown';
import './conversation-message.css';
export interface ConversationMessageProps {
  id: string;
  role: string;
  content: string;
  reasoning?: string | null;
  thoughtMs?: number;
  streaming?: boolean;
  level?: string;
  host?: MarkdownHost;
  actions?: React.ReactNode;
}
/** Shared message presentation for Desktop and the isolated phone transcript. */
export function ConversationMessage({
  id,
  role,
  content,
  reasoning,
  thoughtMs,
  streaming,
  level,
  host,
  actions,
}: ConversationMessageProps) {
  return (
    <div
      data-message-id={id}
      className={`group reading-column mx-auto conversation-message conversation-message-${role}`}
    >
      {role === 'assistant' && (reasoning || thoughtMs) ? (
        <ThoughtLine ms={thoughtMs} text={reasoning ?? undefined} streaming={streaming} />
      ) : null}
      <div
        className={
          role === 'user'
            ? 'conversation-user-bubble'
            : role === 'system'
              ? `conversation-notice ${level === 'error' ? 'conversation-error' : ''}`
              : undefined
        }
      >
        <Markdown text={content} streaming={streaming} host={host} />
        {streaming && (
          <span className="conversation-cursor" aria-label="Receiving response">
            ▋
          </span>
        )}
      </div>
      {actions}
    </div>
  );
}
export function ThoughtLine({ ms, text, streaming }: { ms?: number; text?: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="conversation-thought">
      <button
        type="button"
        className="conversation-thought-toggle hit-24"
        aria-expanded={open}
        disabled={!text}
        onClick={() => setOpen((v) => !v)}
      >
        {text ? open ? <ChevronDown size={11} /> : <ChevronRight size={11} /> : null}
        {streaming ? 'Thinking…' : ms ? `Thought for ${(ms / 1000).toFixed(1)}s` : 'Reasoning'}
      </button>
      {open && text && <div className="conversation-thought-content">{text}</div>}
    </div>
  );
}
