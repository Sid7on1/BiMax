import { useCallback, useEffect, useState } from 'react';
import type { TalkView } from '../../shared/talk';

/**
 * Talk mode for the ⌘2 bar: a spoken conversation with the bar's task (main/talk.session.ts). The main process owns the
 * microphone, the voice and the turn-taking; this follows its state and offers the controls.
 */
export interface Talk {
  view: TalkView;
  active: boolean;
  error: string | null;
  start: () => void;
  end: () => void;
  interrupt: () => void;
}

const OFF: TalkView = { state: 'off', heard: '', level: 0, voice: null, error: null, threadId: null };

export function useTalk(): Talk {
  const api = typeof window === 'undefined' ? undefined : window.bimax?.talk;
  const [view, setView] = useState<TalkView>(OFF);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    void api.current().then((value: TalkView | null) => { if (live && value) setView(value); }).catch(() => {});
    const off = api.onState((value: TalkView) => {
      setView(value);
      if (value.error) setError(value.error);
    });
    return () => { live = false; off(); };
  }, [api]);

  const start = useCallback((): void => {
    if (!api) return;
    setError(null);
    void api.start()
      .then((result: { ok?: boolean; error?: string } | null) => { if (!result?.ok && result?.error) setError(result.error); })
      .catch((err: Error) => setError(err.message));
  }, [api]);
  const end = useCallback((): void => { api?.end(); }, [api]);
  const interrupt = useCallback((): void => { api?.interrupt(); }, [api]);

  return { view, active: view.state !== 'off', error, start, end, interrupt };
}
