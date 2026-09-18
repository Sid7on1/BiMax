import { EventEmitter } from 'events';
import { appStore } from '../state/app.state';
import { recordToolCall } from './toolHistory';

class AppEventEmitter extends EventEmitter {
  emit(event: string | symbol, ...args: any[]): boolean {
    const result = super.emit(event, ...args);
    
    // Bridge to new appStore state
    try {
      if (event === 'log') {
        const payload = args[0];
        if (typeof payload === 'string') {
          appStore.setState(prev => ({
            logs: [...prev.logs, { id: Date.now() + Math.random(), level: 'info', text: payload, timestamp: new Date() }]
          }));
        } else if (payload && payload.text) {
          appStore.setState(prev => ({
            logs: [...prev.logs, payload]
          }));
        }
      } else if (event === 'message') {
        appStore.setState(prev => ({
          messages: [...prev.messages, args[0]]
        }));
      } else if (event === 'spinner_state') {
        appStore.setState({ spinner: { status: args[0], message: args[1] || '' } });
      } else if (event === 'status') {
        appStore.setState({ statusText: args[0] });
      } else if (event === 'veto_prompt') {
        appStore.setState({ vetoResolver: { question: args[0], options: args[1], resolve: args[2] } });
      } else if (event === 'tool_call') {
        const tc = args[0];
        appStore.setState(prev => {
          const arr = [...prev.streamingToolCalls];
          const idx = arr.findIndex(t => t.id === tc.id);
          if (idx !== -1) arr[idx] = tc; else arr.push(tc);
          return { streamingToolCalls: arr };
        });
      } else if (event === 'todo_update') {
        appStore.setState({ todos: args[0] || [] });
      } else if (event === 'tool_call_result') {
        const tc = args[0];
        appStore.setState(prev => {
          const arr = [...prev.streamingToolCalls];
          const idx = arr.findIndex(t => t.id === tc.id);
          if (idx !== -1) arr[idx] = tc;
          return { streamingToolCalls: arr };
        });
        // Capture the finished call (with its full, untruncated output) for the /output viewer.
        try { recordToolCall(tc); } catch { /* best-effort */ }
      }
    } catch (e) {
      // Ignore bridging errors
    }
    
    return result;
  }
}

export const engineEvents = new AppEventEmitter();
// Several components subscribe per-render/per-turn; raise the cap so Node
// doesn't print MaxListenersExceededWarning during long sessions.
engineEvents.setMaxListeners(50);

// Central session-usage accumulator. `cost_update` fires the streamed-char count at the end of
// every turn; the Footer renders the live rate, but commands (e.g. /cost) need the running total
// too — so we accumulate it once here instead of locking the number inside one component.
let _sessionChars = 0;
engineEvents.on('cost_update', (chars: number) => { if (typeof chars === 'number' && chars > 0) _sessionChars += chars; });
/** Rough running token estimate for the session (≈ chars/4). 0 before any output streams. */
export function getSessionTokenEstimate(): number {
  return Math.round(_sessionChars / 4);
}

export type AgentState = 'idle' | 'thinking' | 'decomposing' | 'executing' | 'vetoing' | 'blocked' | 'responding';

export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';

export interface LogEntry {
  id: number;
  level: LogLevel;
  text: string;
  timestamp: Date;
}

export interface ToolCallEntry {
  id: string;
  toolName: string;
  input: string;
  output: string;
  status: 'running' | 'success' | 'error';
  startTime: Date;
  endTime?: Date;
  // Set when this call was made by a sub-agent (worker thread) rather than the main loop. The UI
  // indents and labels such calls so /swarm & /speculate work is legible instead of an opaque
  // "Subagent (running…)" line. `parentId` is the spawning task id; `agentLabel` is the agent type.
  parentId?: string;
  agentLabel?: string;
}

export interface MessageEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  level?: 'info' | 'warn' | 'error' | 'success';
  uiComponent?: string;
  payload?: any;
  content: string;
  toolCalls?: ToolCallEntry[];
  // Wall-clock the model spent in its reasoning channel this turn. Rendered as a collapsed
  // "Thought for Ns" line (Claude Code style) once thinking finishes.
  thoughtMs?: number;
  timestamp: Date;
}

// Events (live wires — keep this list in sync with actual emit/on sites):
// - log: (entry: LogEntry) => Appends to log stream
// - message: (msg: MessageEntry) => New chat message
// - tool_call: (call: ToolCallEntry) => A tool started running
// - tool_call_result: (call: ToolCallEntry) => A tool finished (status success/error)
// - veto_prompt: (question, options, resolve, isAskPrompt?) => Triggers permission overlay
// - spinner_state: (state: AgentState, message?: string) => Updates the footer status indicator
// - status: (text: string) => Status bar update
// - mode_change: (mode: string) => Governor mode change (footer)
// - model_tier: ({ tier, pinned }) => Active routing tier changed (footer)
// - set_tier: ('auto'|'lite'|'heavy') => Manual tier pin request (/tier command → FullScreen)
// - cost_update: (chars: number) => End-of-turn streamed-char count (footer + session accumulator)
// - todo_update: (todos) => TodoWrite tool updated the task list (appStore → /todos panel)
// - config_changed / graph_changed / cwd_changed / mcp_changed => live UI refresh signals
// - rerun_onboarding: () => Re-open the first-run onboarding flow
// - thinking: (text: string) => Model's internal reasoning stream (status display only)
// - thinking_clear: () => Reset the thinking display between turns
// - shutdown: () => Graceful shutdown
// - loop_detected: (signal: LoopSignal) => Agent loop detected a repetition pattern (Footer flash)
// - goals_changed: () => Active goals changed (Footer goal counter refresh)
// - outcome_update: (snapshot|null) => Active outcome contract + completion-gate progress
