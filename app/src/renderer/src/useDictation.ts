import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { composeDictation, HoldToTalk, isTalkKey } from './dictation';

/**
 * Dictation for a text field: click the mic or hold right ⌥, and the words appear at the cursor as they are heard.
 * Esc throws them away; stopping keeps them. The main process runs the on-device helper (main/voice.ts), one
 * session at a time, and sends its events only to the window that started it.
 */
export type DictationState = 'idle' | 'starting' | 'listening' | 'finishing';

interface VoiceEvent { event: string; text?: string; value?: number; code?: string; message?: string }

export interface DictationField {
  get: () => { text: string; caret: number };
  set: (text: string, caret: number) => void;
  /** Words the transcriber should expect, such as the task's folder name. */
  context?: () => string[];
}

export interface Dictation {
  available: boolean;
  state: DictationState;
  /** 0–1 microphone level while listening, for the button's ring. */
  level: number;
  error: string | null;
  toggle: () => void;
  stop: () => void;
  cancel: () => void;
  /** Call from the field's keydown; true when the key belonged to dictation (right ⌥, or Esc while listening). */
  onKeyDown: (e: React.KeyboardEvent) => boolean;
}

export function useDictation(field: DictationField): Dictation {
  const voice = typeof window === 'undefined' ? undefined : window.bimax?.voice;
  const [available, setAvailable] = useState(false);
  const [state, setStateValue] = useState<DictationState>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<DictationState>('idle');
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const session = useRef<{ before: string; after: string; finals: string; partial: string } | null>(null);
  // A stop or cancel that arrives before the helper is running is sent the moment it reports ready.
  const pending = useRef<'stop' | 'cancel' | null>(null);
  const setState = (next: DictationState): void => { stateRef.current = next; setStateValue(next); };

  useEffect(() => {
    if (!voice) return;
    let live = true;
    void voice.available().then((result: { available?: boolean } | null) => { if (live) setAvailable(Boolean(result?.available)); }).catch(() => {});
    return () => { live = false; };
  }, [voice]);

  useEffect(() => {
    if (!voice) return;
    const show = (): void => {
      const s = session.current;
      if (!s) return;
      const { text, caret } = composeDictation(s.before, s.finals + s.partial, s.after);
      fieldRef.current.set(text, caret);
    };
    return voice.onEvent((e: VoiceEvent) => {
      const s = session.current;
      if (e.event === 'ready') {
        if (pending.current) { const action = pending.current; pending.current = null; if (action === 'stop') voice.stop(); else voice.cancel(); return; }
        if (stateRef.current === 'starting') setState('listening');
        return;
      }
      if (e.event === 'level') { if (stateRef.current === 'listening') setLevel(Math.max(0, Math.min(1, Number(e.value) || 0))); return; }
      if (e.event === 'partial' && s) { s.partial = e.text ?? ''; show(); return; }
      if (e.event === 'final' && s) { s.finals += e.text ?? ''; s.partial = ''; show(); return; }
      if (e.event === 'error') { setError(e.message || 'Dictation stopped.'); return; }
      if (e.event === 'stopped') {
        session.current = null;
        pending.current = null;
        setLevel(0);
        setState('idle');
        if (e.message) setError(e.message);
      }
    });
  }, [voice]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const start = useCallback(async (): Promise<void> => {
    if (!voice || stateRef.current !== 'idle') return;
    const { text, caret } = fieldRef.current.get();
    session.current = { before: text.slice(0, caret), after: text.slice(caret), finals: '', partial: '' };
    pending.current = null;
    setError(null);
    setState('starting');
    const result: { ok?: boolean; error?: string } = await voice.start({ context: fieldRef.current.context?.() ?? [] })
      .catch((err: Error) => ({ ok: false, error: err.message }));
    if (!result?.ok) {
      session.current = null;
      pending.current = null;
      setState('idle');
      setError(result?.error || 'Dictation isn’t available.');
    }
  }, [voice]);

  const stop = useCallback((): void => {
    if (!voice || stateRef.current === 'idle' || stateRef.current === 'finishing') return;
    if (stateRef.current === 'starting') pending.current = 'stop';
    else voice.stop();
    setState('finishing');
  }, [voice]);

  const cancel = useCallback((): void => {
    if (!voice || stateRef.current === 'idle') return;
    if (stateRef.current === 'starting') pending.current = 'cancel';
    else voice.cancel();
    const s = session.current;
    if (s) fieldRef.current.set(s.before + s.after, s.before.length);
    session.current = null;
    setLevel(0);
    setState('idle');
  }, [voice]);

  const toggle = useCallback((): void => { if (stateRef.current === 'idle') void start(); else stop(); }, [start, stop]);

  const hold = useMemo(() => new HoldToTalk(() => void start(), () => stop()), [start, stop]);
  useEffect(() => {
    // The key can be released anywhere, or the window can lose focus mid-hold; either ends the hold.
    const up = (e: KeyboardEvent): void => { if (e.code === 'AltRight') hold.up(); };
    const blur = (): void => hold.up();
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); hold.interrupt(); };
  }, [hold]);

  useEffect(() => () => { if (stateRef.current !== 'idle') voice?.stop(); }, [voice]);

  const onKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!voice || !available) return false;
    if (e.key === 'Escape' && stateRef.current !== 'idle') { cancel(); return true; }
    if (isTalkKey(e)) { if (!e.repeat) hold.down(); return true; }
    hold.interrupt();
    return false;
  }, [voice, available, cancel, hold]);

  return { available: Boolean(voice) && available, state, level, error, toggle, stop, cancel, onKeyDown };
}
