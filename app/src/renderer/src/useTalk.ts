import { useCallback, useEffect, useState } from 'react';
import type { TalkView } from '../../shared/talk';

/**
 * Talk mode, in the ⌘2 bar or the main window's composer: a spoken conversation with the task or project on screen
 * (main/talk.session.ts). The main process owns the microphone, the voice and the turn-taking; this follows its state
 * and offers the controls. Only the window that started talking receives its state.
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

export const BASIC_VOICE_TIP = 'This is the Mac’s basic voice. For a more natural one, download a Premium voice in System Settings → Accessibility → Spoken Content.';

/** What the conversation shows: the words as they are heard, or what it is doing. */
export function talkLine(view: TalkView): string {
  switch (view.state) {
    case 'starting': return view.heard || 'Getting ready…';
    case 'listening': return view.heard || 'Listening…';
    case 'thinking': return 'Thinking…';
    case 'speaking': return 'Speaking…';
    case 'waiting': return 'Choose on screen to go on';
    default: return '';
  }
}

/** Words being heard are content; everything else talkLine says is a status, shown quieter. */
export const talkIsStatus = (view: TalkView): boolean => !(view.state === 'listening' && view.heard);

export function useTalk(): Talk {
  const api = typeof window === 'undefined' ? undefined : window.bimax?.talk;
  const [view, setView] = useState<TalkView>(OFF);
  const [error, setError] = useState<string | null>(null);
  // Clicked, not yet started: shown as starting at once, so the button never looks as if it ignored the click.
  const [pending, setPending] = useState(false);

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

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error]);

  const start = useCallback((): void => {
    if (!api) return;
    setError(null);
    setPending(true);
    void api.start()
      .then((result: { ok?: boolean; error?: string } | null) => { if (!result?.ok && result?.error) setError(result.error); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setPending(false));
  }, [api]);
  const end = useCallback((): void => { setPending(false); api?.end(); }, [api]);
  const interrupt = useCallback((): void => { api?.interrupt(); }, [api]);

  const shown: TalkView = pending && view.state === 'off' ? { ...OFF, state: 'starting' } : view;
  return { view: shown, active: shown.state !== 'off', error, start, end, interrupt };
}
