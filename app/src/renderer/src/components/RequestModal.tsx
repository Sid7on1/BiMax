import React, { useEffect, useRef, useState } from 'react';
import { RequestMsg } from '../protocol';
import { DiffView } from '../markdown';
import { approvalShortcut } from '../approval.keys';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';

/**
 * The GlobalPrompter round-trip: a governor veto, diff approval, or free-form ask. A locked
 * Radix dialog (focus-trapped, no Esc/overlay dismissal) — the engine is blocked awaiting the
 * reply, so the modal must be answered, not dismissed.
 */
export function RequestModal({
  req, onReply,
}: {
  req: RequestMsg;
  onReply: (id: number, value: string) => void;
}): React.ReactElement {
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText('');
    setChecked(new Set());
    inputRef.current?.focus();
  }, [req.id]);

  // ⌘↩ takes the highlighted first choice and Esc the deny choice — only on prompts that have one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const pick = approvalShortcut(e, req);
      if (pick) { e.preventDefault(); e.stopPropagation(); onReply(req.id, pick); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req, onReply]);

  const freeForm = req.kind === 'input' || (req.isAsk && req.options.length === 0);

  return (
    <Dialog open>
      <DialogContent locked aria-describedby={undefined}>
        <DialogTitle className="mb-3.5 leading-normal font-semibold whitespace-pre-wrap">
          {req.question}
        </DialogTitle>
        {req.kind === 'diff' && req.body ? <DiffView diff={req.body} /> : null}
        {req.kind !== 'diff' && req.body ? (
          <pre className="mb-3.5 max-h-[40vh] overflow-auto rounded-lg border border-line bg-well px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre-wrap">{req.body}</pre>
        ) : null}

        {freeForm ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); onReply(req.id, text); }}
          >
            <input
              ref={inputRef}
              type={req.masked ? 'password' : 'text'}
              value={text}
              placeholder={req.masked ? '••••••••' : 'Type your answer…'}
              onChange={(e) => setText(e.target.value)}
              className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 outline-none placeholder:text-faint focus:border-ember/55"
            />
            <Button type="submit" variant="accent">Send</Button>
          </form>
        ) : req.isMulti ? (
          <>
            <div className="mb-3 flex flex-col gap-1">
              {req.options.map((o) => (
                <label key={o} className="flex cursor-pointer items-center gap-2 px-0.5 py-1 accent-ember">
                  <input
                    type="checkbox"
                    checked={checked.has(o)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      e.target.checked ? next.add(o) : next.delete(o);
                      setChecked(next);
                    }}
                  />
                  {o}
                </label>
              ))}
            </div>
            <Button variant="accent" onClick={() => onReply(req.id, [...checked].join(', '))}>
              Confirm
            </Button>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            {req.options.map((o, i) => (
              <Button
                key={o + i}
                variant="outline"
                className={i === 0 ? 'justify-start border-ember/60' : 'justify-start'}
                onClick={() => onReply(req.id, o)}
              >
                {o}
              </Button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
