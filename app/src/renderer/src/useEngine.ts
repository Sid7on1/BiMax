import { useEffect, useReducer, useRef, useCallback } from 'react';
import {
  Outbound, RequestMsg, CompletionItem, MessageEntry, ToolCallEntry, UiSnapshot, SubAgentClaim,
  ReviewSnapshot, EngineConfig, EngineCatalog,
  ControlsMsg,
} from './protocol';
import { engineReducer, initialEngineState } from './engine.state';

// The state machine now lives in engine.state.ts (pure, testable). Re-exported here because the
// rest of the renderer has always imported these from useEngine.
export type { TranscriptItem, DiagnosticEntry, EngineUiState } from './engine.state';
export { engineReducer, initialEngineState } from './engine.state';

/**
 * How long the renderer waits for the engine to answer a catalogue request. Comfortably past a cold
 * start; a hung engine still surfaces rather than spinning forever.
 */
const CATALOG_TIMEOUT_MS = 30_000;

export function useEngine() {
  const [state, dispatch] = useReducer(engineReducer, initialEngineState);
  const queryId = useRef(0);
  // Config round-trips (protocol v3) resolve promises instead of flowing through the reducer —
  // settings pages await them directly; nothing renders in the transcript.
  const configId = useRef(0);
  const configPending = useRef(new Map<number, (cfg: EngineConfig) => void>());
  // Catalogue round-trips share the shape but not the map: a `catalogResult` and a `configResult`
  // can be in flight at the same time (the model window opens both at once) and their ids are
  // allocated from separate counters, so one keyed map would let a config reply resolve a catalogue
  // promise with the wrong payload.
  const catalogId = useRef(0);
  const catalogPending = useRef(new Map<number, (result: EngineCatalog) => void>());

  useEffect(() => {
    const offMsg = window.bimax.onMessage((msg) => {
      if (msg.t === 'configResult') {
        const resolve = configPending.current.get(msg.id);
        if (resolve) { configPending.current.delete(msg.id); resolve(msg.config as EngineConfig); }
        return;
      }
      if (msg.t === 'catalogResult') {
        const resolve = catalogPending.current.get(msg.id);
        if (resolve) {
          catalogPending.current.delete(msg.id);
          resolve({
            providers: (msg as any).providers ?? [],
            models: (msg as any).models ?? [],
            error: (msg as any).error,
          });
        }
        return;
      }
      dispatch({ type: 'outbound', msg });
    });
    const offState = window.bimax.onEngineState((s, d) => dispatch({ type: 'engineState', state: s, detail: d }));
    const offProject = window.bimax.onProject((dir) => dispatch({ type: 'project', dir }));
    void window.bimax.getProject().then((dir) => dispatch({ type: 'project', dir }));
    window.bimax.rendererReady();
    return () => { offMsg(); offState(); offProject(); };
  }, []);

  // Footer statuses are ephemeral (TUI parity): self-clear ~10s after the last update.
  useEffect(() => {
    if (!state.status) return;
    const id = setTimeout(() => dispatch({ type: 'statusClear' }), 10000);
    return () => clearTimeout(id);
  }, [state.status]);

  const submit = useCallback((text: string, engineText = text) => {
    const trimmed = text.trim();
    const engineTrimmed = engineText.trim();
    if (!trimmed) return;
    dispatch({ type: 'localUser', text: trimmed });
    window.bimax.send({ t: 'input', text: engineTrimmed || trimmed });
    dispatch({ type: 'clearCompletions' });
  }, []);

  const interrupt = useCallback(() => window.bimax.send({ t: 'interrupt' }), []);

  const setControls = useCallback((controls: Omit<ControlsMsg, 't'>) => {
    window.bimax.send({ t: 'controls', ...controls });
  }, []);

  // Chrome-initiated commands (/mode, /clear, palette executions): straight to the engine, no
  // local user bubble — the engine's own messages/status are the feedback.
  const sendCommand = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // A palette command issued AFTER a clear is a real interaction and its output must render, so
    // the fence lifts here too. `newTask` sends `/clear force` through this same path, but the
    // engine's `clear` event lands afterwards and re-arms the fence — the ordering works out.
    dispatch({ type: 'turnStarted' });
    window.bimax.send({ t: 'input', text: trimmed });
  }, []);

  const query = useCallback((text: string) => {
    const id = ++queryId.current;
    window.bimax.send({ t: 'query', id, text });
  }, []);

  const reply = useCallback((id: number, value: string) => {
    window.bimax.send({ t: 'reply', id, value });
    dispatch({ type: 'closeRequest' });
  }, []);

  const menuSelect = useCallback((id: string, value: string) => {
    window.bimax.send({ t: 'menuSelect', id, value });
    dispatch({ type: 'menuChosen', id, value });
  }, []);

  const clearCompletions = useCallback(() => dispatch({ type: 'clearCompletions' }), []);

  const configRoundTrip = useCallback((send: (id: number) => void): Promise<EngineConfig> => {
    const id = ++configId.current;
    return new Promise<EngineConfig>((resolve) => {
      configPending.current.set(id, resolve);
      send(id);
      // Old engine (pre-v3) never answers — resolve empty after 3s so settings shows its
      // "engine too old" state instead of spinning forever.
      setTimeout(() => {
        if (configPending.current.has(id)) { configPending.current.delete(id); resolve({}); }
      }, 3000);
    });
  }, []);

  const configGet = useCallback(
    () => configRoundTrip((id) => window.bimax.send({ t: 'configGet', id })),
    [configRoundTrip],
  );

  const configSet = useCallback(
    (patch: EngineConfig) => configRoundTrip((id) => window.bimax.send({ t: 'configSet', id, patch: patch as any })),
    [configRoundTrip],
  );

  /**
   * Catalogue round-trip. The timeout is far longer than config's 3s because this one can go out to
   * the provider's `/models` endpoint over the network — cutting it off at 3s would report "this
   * engine has no catalogue" for what is really a slow provider, and the model window would show an
   * empty list on a perfectly healthy setup.
   */
  const catalogRoundTrip = useCallback((send: (id: number) => void): Promise<EngineCatalog> => {
    const id = ++catalogId.current;
    return new Promise<EngineCatalog>((resolve) => {
      catalogPending.current.set(id, resolve);
      send(id);
      // 9s was shorter than this app's own measured cold start (15-20s, see the prewarm/boot-phase
      // work) — so opening the model picker soon after launch timed out while the engine was still
      // coming up, and the message blamed the provider key. Measured 2026-09-04 on a healthy setup:
      // the provider's /models answered in 0.14s, the picker still showed "0 available models", and
      // the stated cause sent the user to check a key that was never the problem.
      //
      // The window now clears a cold start, and the message says what the timeout actually proves —
      // that the ENGINE did not answer — instead of naming a cause it has no evidence for.
      setTimeout(() => {
        if (catalogPending.current.has(id)) {
          catalogPending.current.delete(id);
          resolve({
            providers: [],
            models: [],
            error: `The engine did not answer the catalogue request within ${Math.round(CATALOG_TIMEOUT_MS / 1000)} seconds. `
              + 'It may still be starting up — retry in a moment. If it keeps failing, check the provider key or endpoint.',
          });
        }
      }, CATALOG_TIMEOUT_MS);
    });
  }, []);

  const catalogGet = useCallback(
    (refresh = false) => catalogRoundTrip((id) => window.bimax.send({ t: 'catalogGet', id, refresh })),
    [catalogRoundTrip],
  );

  const providerSet = useCallback(
    (input: { name: string; baseURL?: string; apiKey?: string }) =>
      catalogRoundTrip((id) => window.bimax.send({ t: 'providerSet', id, ...input })),
    [catalogRoundTrip],
  );

  return {
    state, submit, interrupt, setControls, sendCommand, query, reply, menuSelect, clearCompletions,
    configGet, configSet, catalogGet, providerSet,
  };
}
