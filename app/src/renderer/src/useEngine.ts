import { useEffect, useReducer, useRef, useCallback } from 'react';
import {
  Outbound, RequestMsg, CompletionItem, MessageEntry, ToolCallEntry, UiSnapshot, SubAgentClaim,
  ReviewSnapshot, EngineConfig, EngineCatalog,
  ControlsMsg,
} from './protocol';
import { supportsProtocolMajor } from '../../shared/protocol.compat.gen';
import {
  normalizeUiSnapshot, normalizeReviewSnapshot, normalizeSubAgents, normalizeTodos,
} from './protocol.normalize';

/**
 * The renderer's engine state machine: consumes protocol Outbound messages from the preload
 * bridge and folds them into one UI state object. This is the App-side equivalent of the Go
 * TUI's model.go update loop, reduced to the foundation feature set.
 */

export type TranscriptItem =
  | { kind: 'msg'; msg: MessageEntry; menuChosen?: string; thought?: string }
  | { kind: 'tool'; call: ToolCallEntry };

export interface DiagnosticEntry {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  timestamp: string;
}

export interface EngineUiState {
  items: TranscriptItem[];
  streaming: string;            // in-flight assistant reply (stream_token accumulation)
  thinking: string;             // reasoning-channel text for the current turn
  spinner: { state: string; message: string };
  status: string;
  snapshot: UiSnapshot | null;
  todos: { content?: string; status?: string }[];
  subagents: SubAgentClaim[];
  request: RequestMsg | null;   // pending approval/ask modal
  completions: { id: number; items: CompletionItem[] };
  engine: { state: string; detail: string };
  protocolMismatch: number | null; // engine's protocol version when it differs from ours
  mode: string;
  tier: string;
  streamedChars: number;
  project: string;
  diagnostics: DiagnosticEntry[];
  review: ReviewSnapshot | null;   // the engine's per-thread review state (review_update)
}

const initial: EngineUiState = {
  items: [],
  streaming: '',
  thinking: '',
  spinner: { state: 'idle', message: '' },
  status: '',
  snapshot: null,
  todos: [],
  subagents: [],
  request: null,
  completions: { id: 0, items: [] },
  engine: { state: 'idle', detail: '' },
  protocolMismatch: null,
  mode: '',
  tier: '',
  streamedChars: 0,
  project: '',
  diagnostics: [],
  review: null,
};

type Action =
  | { type: 'outbound'; msg: Outbound }
  | { type: 'engineState'; state: string; detail: string }
  | { type: 'project'; dir: string }
  | { type: 'localUser'; text: string }
  | { type: 'closeRequest' }
  | { type: 'statusClear' }
  | { type: 'menuChosen'; id: string; value: string }
  | { type: 'clearCompletions' };

function upsertTool(items: TranscriptItem[], call: ToolCallEntry): TranscriptItem[] {
  const idx = items.findIndex((it) => it.kind === 'tool' && it.call.id === call.id);
  if (idx === -1) return [...items, { kind: 'tool', call }];
  const next = items.slice();
  next[idx] = { kind: 'tool', call };
  return next;
}

function onEvent(state: EngineUiState, name: string, args: any[]): EngineUiState {
  switch (name) {
    case 'log': {
      const raw = args[0];
      const text = String(typeof raw === 'object' && raw ? raw.text ?? '' : raw ?? '')
        // Terminal adapters may include ANSI color escapes; the desktop renderer should not.
        .replace(/\x1b\[[0-9;]*m/g, '')
        .trim();
      if (!text) return state;
      const rawLevel = typeof raw === 'object' && raw ? String(raw.level ?? 'info') : 'info';
      const level: DiagnosticEntry['level'] = rawLevel === 'error' ? 'error' : rawLevel === 'warn' ? 'warn' : 'info';
      const entry: DiagnosticEntry = {
        id: String((typeof raw === 'object' && raw?.id) || `${Date.now()}-${state.diagnostics.length}`),
        level,
        text,
        timestamp: String((typeof raw === 'object' && raw?.timestamp) || new Date().toISOString()),
      };
      return { ...state, diagnostics: [...state.diagnostics, entry].slice(-100) };
    }
    case 'message': {
      const incoming = args[0] as MessageEntry;
      if (!incoming) return state;
      const msg = incoming;
      // The engine echoes the user's turn as its own `message` event (that echo is what the session
      // file persists). The composer already painted an instant local bubble — adopt the engine's
      // entry into it instead of appending a duplicate.
      if (msg.role === 'user') {
        for (let i = state.items.length - 1; i >= 0; i--) {
          const it = state.items[i];
          if (it.kind !== 'msg' || it.msg.role !== 'user') continue;
          if (it.msg.id.startsWith('local-') && it.msg.content === msg.content) {
            const items = state.items.slice();
            items[i] = { kind: 'msg', msg };
            return { ...state, items };
          }
          break; // a different (or already-adopted) user turn — this echo is genuinely new
        }
      }
      // A final assistant message supersedes the in-flight stream buffer and adopts the turn's
      // reasoning text so the "Thought for Ns" line can expand to the actual thoughts.
      const streaming = msg.role === 'assistant' ? '' : state.streaming;
      const thought = msg.role === 'assistant' && state.thinking ? state.thinking : undefined;
      return { ...state, items: [...state.items, { kind: 'msg', msg, thought }], streaming, thinking: '' };
    }
    case 'stream_token':
      return { ...state, streaming: state.streaming + String(args[0] ?? '') };
    case 'tool_call':
    case 'tool_call_result':
      return args[0] ? { ...state, items: upsertTool(state.items, args[0] as ToolCallEntry) } : state;
    case 'thinking':
      return { ...state, thinking: state.thinking + String(args[0] ?? '') };
    case 'thinking_clear':
      return { ...state, thinking: '' };
    case 'spinner_state':
      return { ...state, spinner: { state: String(args[0] ?? 'idle'), message: String(args[1] ?? '') } };
    case 'status':
      return { ...state, status: String(args[0] ?? '') };
    case 'clear':
      return { ...state, items: [], streaming: '', thinking: '', streamedChars: 0 };
    case 'session_restore': {
      // True resume: rebuild the transcript from the saved thread's entries (messages + tool
      // lines) — the engine restored its context from the same file, so both sides agree.
      const payload = args[0] as { id?: string; entries?: any[] } | undefined;
      const entries = Array.isArray(payload?.entries) ? payload!.entries! : [];
      const items: TranscriptItem[] = [];
      for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        if (e.role === 'tool') {
          items.push({
            kind: 'tool',
            call: {
              id: String(e.id ?? `replay-${items.length}`),
              toolName: String(e.toolName ?? 'tool'),
              input: String(e.input ?? ''),
              output: String(e.output ?? ''),
              status: e.status === 'error' ? 'error' : 'success',
              startTime: String(e.startTime ?? e.timestamp ?? ''),
              endTime: e.endTime ? String(e.endTime) : undefined,
              parentId: e.parentId ? String(e.parentId) : undefined,
              agentLabel: e.agentLabel ? String(e.agentLabel) : undefined,
            },
          });
        } else if (e.role === 'user' || e.role === 'assistant' || e.role === 'system') {
          // Replayed menus are inert (their engine-side handlers died with the original process).
          // The sentinel must not equal any option's value — '' would light up "Skip"-style options.
          items.push({ kind: 'msg', msg: e as MessageEntry, menuChosen: e.uiComponent === 'menu' ? '__replayed__' : undefined });
        }
      }
      return { ...state, items, streaming: '', thinking: '' };
    }
    // Every structured payload is normalized at the boundary rather than trusted downstream — see
    // protocol.normalize.ts. A `ui_snapshot` missing `models` used to reach the composer as a
    // truthy object and blank the window.
    case 'ui_snapshot': {
      const snapshot = normalizeUiSnapshot(args[0]);
      return snapshot ? { ...state, snapshot } : state;
    }
    case 'review_update':
      return { ...state, review: normalizeReviewSnapshot(args[0]) };
    case 'todo_update':
      return { ...state, todos: normalizeTodos(args[0]) };
    case 'subagent_update':
      return { ...state, subagents: normalizeSubAgents(args[0]) };
    case 'mode_change':
      return { ...state, mode: String(args[0] ?? '') };
    case 'model_tier':
      return { ...state, tier: String(args[0]?.tier ?? '') };
    case 'cost_update':
      return { ...state, streamedChars: state.streamedChars + Number(args[0] ?? 0) };
    default:
      return state; // log, graph_changed, config_changed, … — no transcript rendering needed yet
  }
}

function reducer(state: EngineUiState, action: Action): EngineUiState {
  switch (action.type) {
    case 'outbound': {
      const m = action.msg;
      switch (m.t) {
        case 'ready':
          return {
            ...state,
            engine: { state: 'ready', detail: '' },
            protocolMismatch: !supportsProtocolMajor(m.protocol) ? m.protocol : null,
          };
        case 'event':
          return onEvent(state, m.name, m.args);
        case 'request':
          return { ...state, request: m };
        case 'queryResult':
          // Drop stale results: only the latest query id may populate the dropdown.
          return m.id >= state.completions.id
            ? { ...state, completions: { id: m.id, items: m.items } }
            : state;
        default:
          return state;
      }
    }
    case 'engineState':
      // An exited engine can never answer its own approval requests — leaving the modal up would
      // falsely show the approval as pending (and a reply would go to a process that's gone).
      return {
        ...state,
        engine: { state: action.state, detail: action.detail },
        request: action.state === 'exited' ? null : state.request,
      };
    case 'project':
      return {
        ...state,
        project: action.dir,
        items: [],
        streaming: '',
        thinking: '',
        todos: [],
        snapshot: null,
        diagnostics: [],
        review: null,
        request: null, // any pending approval belonged to the previous engine process
        engine: action.dir ? state.engine : { state: 'idle', detail: '' },
      };
    case 'localUser': {
      const msg: MessageEntry = {
        id: `local-${Date.now()}`,
        role: 'user',
        content: action.text,
        timestamp: new Date().toISOString(),
      };
      return { ...state, items: [...state.items, { kind: 'msg', msg }] };
    }
    case 'closeRequest':
      return { ...state, request: null };
    case 'statusClear':
      return { ...state, status: '' };
    case 'menuChosen':
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === 'msg' && it.msg.id === action.id ? { ...it, menuChosen: action.value } : it,
        ),
      };
    case 'clearCompletions':
      return { ...state, completions: { id: state.completions.id, items: [] } };
    default:
      return state;
  }
}

export function useEngine() {
  const [state, dispatch] = useReducer(reducer, initial);
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
    if (trimmed) window.bimax.send({ t: 'input', text: trimmed });
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
      setTimeout(() => {
        if (catalogPending.current.has(id)) {
          catalogPending.current.delete(id);
          resolve({
            providers: [],
            models: [],
            error: 'The provider catalogue did not answer within 9 seconds. Check the provider key or endpoint, then retry.',
          });
        }
      }, 9000);
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
