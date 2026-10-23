import { computerRequest } from '../../shared/computer';
import type { ComputerRoute } from '../../shared/computer';
import { useEffect, useState, useRef, useCallback } from 'react';
import {
  EngineConfig, EngineCatalog,
  ControlsMsg,
} from './protocol';
import { EngineStore } from './engine.store';
import { useEngineDomain } from './useEngineDomain';
import { StreamCoalescer } from './stream.coalescer';
import { EngineRequests } from './engine.requests';

// The state machine now lives in engine.state.ts (pure, testable). Re-exported here because the
// rest of the renderer has always imported these from useEngine.
export type { TranscriptItem, DiagnosticEntry, EngineUiState } from './engine.state';
export { engineReducer, initialEngineState } from './engine.state';

/**
 * How long the renderer waits for the engine to answer a catalogue request. Comfortably past a cold
 * start; a hung engine still surfaces rather than spinning forever.
 */
const CATALOG_TIMEOUT_MS = 30_000;
type AttachmentResult = { ok: boolean; chunks: number; reason: string };

export function useEngine() {
  const [store] = useState(() => new EngineStore());
  const state = useEngineDomain(store.domains.workspace);
  const dispatch = store.dispatch;
  // Adjacent streaming deltas are merged into one dispatch per frame. Held in a ref because the
  // interrupt and project paths outside the subscription effect need to flush or retire it.
  const coalescer = useRef<StreamCoalescer | null>(null);
  const queryId = useRef(0);
  const completionQueryId = useRef(-1);
  // Config round-trips (protocol v3) resolve promises instead of flowing through the reducer —
  // settings pages await them directly; nothing renders in the transcript.
  const configId = useRef(0);
  const configPending = useRef(new EngineRequests<EngineConfig>(() => ({})));
  // Catalogue round-trips share the shape but not the map: a `catalogResult` and a `configResult`
  // can be in flight at the same time (the model window opens both at once) and their ids are
  // allocated from separate counters, so one keyed map would let a config reply resolve a catalogue
  // promise with the wrong payload.
  const catalogId = useRef(0);
  const catalogPending = useRef(new EngineRequests<EngineCatalog>(error => ({ providers: [], models: [], error })));
  const attachmentPending = useRef(new EngineRequests<AttachmentResult>(reason => ({ ok: false, chunks: 0, reason })));

  useEffect(() => {
    const cancelRequests = (reason: string): void => {
      configPending.current.cancelAll(reason);
      catalogPending.current.cancelAll(reason);
      attachmentPending.current.cancelAll(reason);
      completionQueryId.current = -1;
    };
    let batchThreadId: string | undefined;
    const batcher = new StreamCoalescer({ emit: (msg) => dispatch({ type: 'outbound', msg, threadId: batchThreadId }) });
    coalescer.current = batcher;
    const offMsg = window.bimax.onMessage((msg, threadId) => {
      // Read the store at delivery time: React may not have rendered the just-selected Thread yet.
      // Check before resolving queries or buffering text, so stale replies cannot affect this view.
      if (threadId !== store.getState().threadId) return;
      if (msg.t === 'configResult') {
        configPending.current.resolve(msg.id, msg.config as EngineConfig);
        return;
      }
      if (msg.t === 'catalogResult') {
        catalogPending.current.resolve(msg.id, {
            providers: (msg as any).providers ?? [],
            models: (msg as any).models ?? [],
            error: (msg as any).error,
        });
        return;
      }
      if (msg.t === 'queryResult') {
        const item = msg.items?.[0];
        if (attachmentPending.current.resolve(msg.id, {
          ok: item?.label === 'read', chunks: Number(item?.value || 0),
          reason: item?.desc || (item?.label === 'read' ? '' : 'could not be read'),
        })) return;
      }
      if (msg.t === 'queryResult' && msg.id !== completionQueryId.current) return;
      // Everything the reducer consumes goes through the batcher, which merges only adjacent
      // same-kind text deltas and flushes before anything else — so arrival order is preserved.
      batchThreadId = threadId;
      batcher.push(msg);
    });
    const offState = window.bimax.onEngineState((s, d, threadId) => {
      if (threadId !== store.getState().threadId) return;
      if (['failed', 'exited', 'stopping', 'restarting'].includes(s)) cancelRequests(`Engine ${s}`);
      // An engine-state change is not a display delta; the text produced before it must land first.
      batcher.flush();
      dispatch({ type: 'engineState', state: s, detail: d, threadId });
    });
    const offProject = window.bimax.onProject((dir) => {
      // A different project discards the transcript, so buffered text for the old one is dropped
      // rather than flushed into the new one's state.
      batcher.retire();
      cancelRequests('Project changed');
      dispatch({ type: 'project', dir });
    });
    const offThread = window.bimax.threads.onSelected((value) => {
      batcher.retire();
      cancelRequests('Thread changed');
      dispatch({ type: 'restoreThread', state: { ...value.state, threadId: value.id } });
    });
    window.bimax.rendererReady();
    return () => {
      offMsg(); offState(); offProject(); offThread();
      cancelRequests('Renderer closed');
      batcher.retire(); batcher.dispose(); coalescer.current = null;
    };
  }, []);

  // Footer statuses are ephemeral (TUI parity): self-clear ~10s after the last update.
  useEffect(() => {
    if (!state.status) return undefined;
    const id = setTimeout(() => dispatch({ type: 'statusClear' }), 10000);
    return () => clearTimeout(id);
  }, [state.status]);

  const submit = useCallback(async (text: string, engineText = text, route?: ComputerRoute) => {
    const trimmed = text.trim();
    const engineTrimmed = engineText.trim();
    if (!trimmed) return;
    if (route || computerRequest(trimmed) !== null) {
      const id = store.domains.workspace.getSnapshot().threadId;
      if (!id || !window.bimax.computer) throw new Error('Computer Use is unavailable in this conversation.');
      const result = await window.bimax.computer.submit(id, trimmed, engineTrimmed, route || { kind: 'computer-use', mode: 'do' });
      if (!result.ok) throw new Error(result.error || 'Could not send Computer Use task. Choose the target again.');
      dispatch({ type: 'clearCompletions' });
      return;
    }
    // Painted at once, as before threads: a turn sent to a thread whose engine is still starting, or queued
    // behind another thread in the same folder, must not vanish until it is dispatched. The thread manager
    // records the same turn for history and does not echo it back to this window.
    dispatch({ type: 'localUser', text: trimmed });
    // 'steer' (F7): while the task works the thread manager hands these words to the running turn, which takes them
    // at its next step; when it is not working they are an ordinary message, exactly as 'input' was.
    window.bimax.send({ t: 'steer', text: engineTrimmed || trimmed });
    dispatch({ type: 'clearCompletions' });
  }, []);

  const interrupt = useCallback(() => {
    // The text already arrived from the engine; the user should see it. Flush at the boundary
    // rather than discarding a frame's worth of the reply they just stopped.
    coalescer.current?.flush();
    window.bimax.send({ t: 'interrupt' });
  }, []);

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
    completionQueryId.current = id;
    window.bimax.send({ t: 'query', id, text });
  }, []);

  /**
   * Read an attached file into the Composer NOW, and resolve with what came back.
   *
   * Rides the `query` request/response channel with a reserved prefix, so attaching a file needs no
   * new protocol message and no version bump. The point is timing: a file must be read the moment it
   * is attached, the way every assistant people already use behaves. Deferring to send time is what
   * made the model appear to go and find the file — the path travelled in the prompt and the reading
   * happened as visible work inside the turn.
   */
  const ingestAttachment = useCallback((filePath: string): Promise<AttachmentResult> => {
    const id = ++queryId.current;
    return attachmentPending.current.request(id, 120_000, 'engine did not answer', () => {
      window.bimax.send({ t: 'query', id, text: `\u0000composer:ingest:${filePath}` });
    });
  }, []);

  const reply = useCallback((id: number, value: string) => {
    const current = store.getState();
    const token = (current.request as any)?.approvalToken;
    if (!current.threadId || current.request?.id !== id || !token) return;
    const threadId = current.threadId;
    const close = (): void => dispatch({ type: 'closeRequest', threadId, id, approvalToken: token });
    void window.bimax.threads.reply(threadId, id, value, token).then(async (ok) => {
      if (ok) { close(); return; }
      // Refused: it was answered somewhere else or went with its turn. A card that can no longer be answered used to stay
      // on screen for good; it stays only while the thread really still waits on it.
      const open = await window.bimax.threads.approvals().catch(() => null);
      if (!open) return;
      if (!open.some((a: { threadId: string; request: { id: number } }) => a.threadId === threadId && a.request.id === id)) {
        close();
      }
    }).catch(() => { /* Leave the current card available for a retry when the bridge fails. */ });
  }, []);

  const menuSelect = useCallback((id: string, value: string) => {
    window.bimax.send({ t: 'menuSelect', id, value });
    dispatch({ type: 'menuChosen', id, value });
  }, []);

  const clearCompletions = useCallback(() => {
    completionQueryId.current = -1;
    dispatch({ type: 'clearCompletions' });
  }, []);

  const configRoundTrip = useCallback((send: (id: number) => void): Promise<EngineConfig> => {
    const id = ++configId.current;
    return configPending.current.request(id, 3000, 'engine did not answer', () => send(id));
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
    return catalogPending.current.request(id, CATALOG_TIMEOUT_MS,
      // 9s was shorter than this app's own measured cold start (15-20s, see the prewarm/boot-phase
      // work) — so opening the model picker soon after launch timed out while the engine was still
      // coming up, and the message blamed the provider key. Measured 2026-09-04 on a healthy setup:
      // the provider's /models answered in 0.14s, the picker still showed "0 available models", and
      // the stated cause sent the user to check a key that was never the problem.
      //
      // The window now clears a cold start, and the message says what the timeout actually proves —
      // that the ENGINE did not answer — instead of naming a cause it has no evidence for.
      `The engine did not answer the catalogue request within ${Math.round(CATALOG_TIMEOUT_MS / 1000)} seconds. `
        + 'It may still be starting up — retry in a moment. If it keeps failing, check the provider key or endpoint.',
      () => send(id));
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
    state, store, submit, interrupt, setControls, sendCommand, query, ingestAttachment, reply, menuSelect, clearCompletions,
    configGet, configSet, catalogGet, providerSet,
  };
}
