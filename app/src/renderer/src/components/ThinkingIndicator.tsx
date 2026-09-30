import React, { useEffect, useRef, useState } from 'react';
import { isDegenerate, reasoningTail } from '../thinking.model';

/**
 * The row a turn shows while it is in flight and no answer text has arrived yet.
 *
 * A plain working label, how long the turn has been running, and the tail of the reasoning stream as
 * it arrives. The reasoning is shown unless it has degenerated into a token loop — see `isDegenerate`
 * — in which case the row says so instead of rendering the loop. The full reasoning is still kept on
 * the finished message, behind its "Thought for Ns" line.
 */
export function ThinkingIndicator({ thinking, status }: { thinking: string; status?: string }): React.ReactElement {
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    // Elapsed time is information; the status itself stays still until the engine changes state.
    const clock = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => window.clearInterval(clock);
  }, []);

  const degenerate = thinking ? isDegenerate(thinking) : false;
  return (
    <div className="reading-column mx-auto mb-3.5 text-xs text-faint">
      <div className="flex items-center gap-2">
        <span className="inline-block size-1.5 rounded-full bg-ember" aria-hidden />
        <span role="status" className="sr-only">Bimax is working</span>
        <span className="thinking-verb font-medium" aria-hidden>Working</span>
        <span className="tabular-nums" aria-hidden>{elapsed}s</span>
        {thinking ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="ml-auto cursor-pointer rounded px-1.5 py-0.5 text-[11px] hover:bg-hover hover:text-ink"
          >
            {open ? 'Hide thinking' : 'Show thinking'}
          </button>
        ) : null}
      </div>
      {/* Why the turn is waiting, when the engine says: a provider retry, a rate-limit wait, a
          fallback model. Without it a 45-second provider stall looked exactly like a hang. */}
      {status ? <p className="thinking-status mt-1 pl-3.5 text-dim" aria-live="polite">{status}</p> : null}
      {thinking && open ? (
        degenerate ? (
          <p className="mt-1 pl-3.5 italic">The reasoning started repeating itself, so it is hidden here. The answer will still arrive.</p>
        ) : (
          <div className="thinking-tail mt-1 pl-3.5 whitespace-pre-wrap text-dim italic">{reasoningTail(thinking)}</div>
        )
      ) : null}
    </div>
  );
}
