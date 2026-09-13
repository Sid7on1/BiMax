import {
  Outbound, RequestMsg, CompletionItem, MessageEntry, ToolCallEntry, UiSnapshot, SubAgentClaim,
  ReviewSnapshot,
} from './protocol';
import { supportsProtocolMajor } from '../../shared/protocol.compat.gen';
import {
  normalizeUiSnapshot, normalizeReviewSnapshot, normalizeSubAgents, normalizeTodos,
} from './protocol.normalize';

/**
 * The renderer's engine state machine, as a PURE module.
 *
 * Split out of useEngine.ts so it can be unit-tested. The hook calls `window.bimax.*`, and importing
 * that file from a test drags the whole preload bridge into the type graph — which is why the
 * Desktop suites could never cover the reducer, the exact place a cross-task transcript leak lived.
 * Nothing here touches `window`, React, or IPC: state in, state out.
 */
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

export interface CapabilityNotice {
  id: string; label: string; state: 'degraded' | 'unavailable' | 'ready';
  reason: string; impact: string; action: string; observedAt: string;
}

/**
 * A per-call tool failure (`tool:DocumentTool` after one refused write) or the "model never invoked the
 * requested tool" gate describes ONE turn, not an outage — the tool card in the transcript already shows
 * it. Treating those as standing alerts is how a single blocked write became a banner that never went
 * away. They clear when the next turn starts; subsystem outages stay until the engine reports ready.
 */
export const isTurnScopedCapability = (id: string): boolean => id.startsWith('tool:') || id === 'tool-activation';
export interface EngineUiState {
  threadId?: string;
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
  capabilities: Record<string, CapabilityNotice>;
  review: ReviewSnapshot | null;   // the engine's per-thread review state (review_update)
  /**
   * True between a transcript clear and the start of the next user turn.
   *
   * `/clear force` empties `items` instantly, but the engine turn that was already running does not
   * stop mid-flight: its remaining `stream_token`, `thinking`, `tool_call` and `tool_call_result`
   * events keep arriving and, because every one of those cases appends unconditionally, they landed
   * in the FRESH transcript. Measured: a new task showed the previous task's `find` and `Deleted`
   * tool lines plus its half-finished assistant sentence. `upsertTool` made it worse — a result
   * whose originating call had just been wiped matches nothing, so it appends as a brand-new item.
   *
   * Between a clear and the user's next turn there is nothing the assistant can legitimately say,
   * so anything in that window belongs to the discarded turn and is dropped.
   */
  awaitingNewTurn: boolean;
}

/** Test seam: the reducer and its initial state are pure, so task isolation is unit-testable. */
export const initialEngineState: EngineUiState = {
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
  capabilities: {},
  review: null,
  awaitingNewTurn: false,
};

type Action =
  | { type: 'outbound'; msg: Outbound }
  | { type: 'engineState'; state: string; detail: string }
  | { type: 'project'; dir: string }
  | { type: 'restoreThread'; state: EngineUiState }
  | { type: 'localUser'; text: string }
  | { type: 'turnStarted' }
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

/**
 * Events that belong to a specific assistant turn. After a clear these are, by definition, the
 * discarded turn's — the next turn cannot have produced anything before the user has spoken.
 * Everything else (`status`, `spinner_state`, `ui_snapshot`, `log`, config/mode changes, and the
 * engine's own system messages) is session-level and keeps flowing.
 */
const TURN_SCOPED_EVENTS = new Set(['stream_token', 'thinking', 'tool_call', 'tool_call_result']);

function onEvent(state: EngineUiState, name: string, args: any[]): EngineUiState {
  if (state.awaitingNewTurn) {
    if (TURN_SCOPED_EVENTS.has(name)) return state;
    // An assistant message is turn-scoped too, but `message` also carries system/user entries that
    // must still render, so it is filtered by role rather than by name.
    if (name === 'message' && (args[0] as MessageEntry | undefined)?.role === 'assistant') return state;
  }
  switch (name) {
    case 'thread_user': return engineReducer(state, { type: 'localUser', text: String(args[0]) });
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
      const notice = msg.role === 'system' ? msg.payload?.capabilityStatus : undefined;
      if (notice && typeof notice.id === 'string' && ['degraded', 'unavailable', 'ready'].includes(notice.state)
        && ['label', 'reason', 'impact', 'action', 'observedAt'].every(key => typeof notice[key] === 'string')) {
        const capabilities = { ...state.capabilities };
        if (notice.state === 'ready') delete capabilities[notice.id];
        else capabilities[notice.id] = notice;
        state = { ...state, capabilities };
      }
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
      // A clear starts a NEW TASK, so every field scoped to the old one resets — not just the
      // transcript. Previously only `items`/`streaming`/`thinking`/`streamedChars` were cleared and
      // the rest leaked into the fresh task: its todo list, its sub-agent claims, its review lane,
      // a stale spinner and status line, and — worst — `request`, a pending APPROVAL MODAL from the
      // discarded turn left on screen, inviting approval of a tool call for a task that no longer
      // exists. Session-level state (project, engine, mode, tier, snapshot, diagnostics) is
      // deliberately kept: it describes the workspace, not the task.
      return {
        ...state,
        items: [], streaming: '', thinking: '', streamedChars: 0,
        todos: [], subagents: [], review: null, request: null,
        spinner: { state: 'idle', message: '' }, status: '',
        completions: { id: 0, items: [] },
        // Arm the fence: the turn that was running when this arrived is now discarded, and its
        // in-flight events are still on their way.
        awaitingNewTurn: true,
      };
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
      return { ...state, items, streaming: '', thinking: '', awaitingNewTurn: false };
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

export function engineReducer(state: EngineUiState, action: Action): EngineUiState {
  switch (action.type) {
    case 'outbound': {
      const m = action.msg;
      switch (m.t) {
        case 'ready':
          return {
            ...state,
            engine: { state: 'ready', detail: '' },
            capabilities: {},
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
    case 'restoreThread': return action.state;
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
        capabilities: {},
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
      const capabilities = Object.fromEntries(Object.entries(state.capabilities).filter(([id]) => !isTurnScopedCapability(id)));
      return { ...state, items: [...state.items, { kind: 'msg', msg }], awaitingNewTurn: false, capabilities };
    }
    case 'turnStarted':
      return state.awaitingNewTurn ? { ...state, awaitingNewTurn: false } : state;
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
