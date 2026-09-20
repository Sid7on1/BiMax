import React, { useEffect, useRef, useState } from 'react';
import { THINKING_VERBS, isDegenerate, nextVerb, reasoningTail } from '../thinking.model';
import { isQuietRendering, prefersReducedMotion } from './ui/motion';

/** How long each word stays before the next one decodes in. */
const VERB_MS = 2600;
/** How long the letters take to settle into the new word. */
const DECODE_MS = 320;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** The word on screen, settling letter by letter from left to right whenever `word` changes. */
function useDecodingWord(word: string): string {
  const [text, setText] = useState(word);
  useEffect(() => {
    if (prefersReducedMotion() || isQuietRendering()) { setText(word); return; }
    const started = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - started) / DECODE_MS);
      const settled = Math.floor(word.length * t);
      let next = word.slice(0, settled);
      for (let i = settled; i < word.length; i++) next += LETTERS[Math.floor(Math.random() * LETTERS.length)];
      setText(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [word]);
  return text;
}

/**
 * The row a turn shows while it is in flight and no answer text has arrived yet.
 *
 * A rotating status word, how long the turn has been running, and the tail of the reasoning stream as
 * it arrives. The reasoning is shown unless it has degenerated into a token loop — see `isDegenerate`
 * — in which case the row says so instead of rendering the loop. The full reasoning is still kept on
 * the finished message, behind its "Thought for Ns" line.
 */
export function ThinkingIndicator({ thinking }: { thinking: string }): React.ReactElement {
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [verb, setVerb] = useState<string>(() => THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)]);
  const [open, setOpen] = useState(true);
  const shown = useDecodingWord(verb);

  useEffect(() => {
    // The elapsed counter is information — how long this turn has been running — so it keeps ticking
    // under quiet rendering. The rotating verb is decoration, and stops (WP-2, record 57).
    const clock = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    if (isQuietRendering()) return () => window.clearInterval(clock);
    const words = window.setInterval(() => setVerb((current) => nextVerb(current)), VERB_MS);
    return () => { window.clearInterval(clock); window.clearInterval(words); };
  }, []);

  const degenerate = thinking ? isDegenerate(thinking) : false;
  return (
    <div className="reading-column mx-auto mb-3.5 text-xs text-faint">
      <div className="flex items-center gap-2">
        <span className="inline-block size-1.5 animate-soft-blink rounded-full bg-ember" aria-hidden />
        <span role="status" className="sr-only">Bimax is working</span>
        <span className="thinking-verb font-medium" aria-hidden>{shown}…</span>
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
