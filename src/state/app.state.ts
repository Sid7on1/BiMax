import { createStore } from './store';
import type { SessionPermissionMode } from '../governor/governor';

export interface MessageEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export interface LogEntry {
  id: string | number;
  level: 'info' | 'warn' | 'error' | 'success';
  text: string;
  timestamp: Date;
}

export interface ToolCallEntry {
  id: string;
  name: string;
  args: any;
  status: 'pending' | 'success' | 'error';
  result?: string;
  error?: string;
}

export interface UIState {
  input: string;
  view: 'transcript' | 'tasks' | 'settings';
  searchQuery: string;
  activeMenu: {
    type: string;
    title: string;
    options: any[];
  } | null;
}

export interface TodoEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface AppState {
  ui: UIState;
  messages: MessageEntry[];
  logs: LogEntry[];
  spinner: { status: 'idle' | 'executing' | 'thinking' | 'responding' | 'vetoing'; message: string };
  statusText: string;
  vetoResolver: { question: string; options: string[]; resolve: (ans: string) => void } | null;
  streamingText: string;
  streamingToolCalls: ToolCallEntry[];
  streamMeta: { chars: number; elapsed: number };
  todos: TodoEntry[];
}

export const appStore = createStore<AppState>({
  ui: {
    input: '',
    view: 'transcript',
    searchQuery: '',
    activeMenu: null
  },
  messages: [],
  logs: [],
  spinner: { status: 'idle', message: 'Ready' },
  statusText: '',
  vetoResolver: null,
  streamingText: '',
  streamingToolCalls: [],
  streamMeta: { chars: 0, elapsed: 0 },
  todos: []
});

// Helper action to emit a log (similar to old EventBus)
export function dispatchLog(level: 'info' | 'warn' | 'error' | 'success', text: string) {
  appStore.setState(prev => ({
    logs: [...prev.logs, { id: Date.now() + Math.random(), level, text, timestamp: new Date() }]
  }));
}

// Helper action to emit a message
export function dispatchMessage(msg: MessageEntry) {
  appStore.setState(prev => ({
    messages: [...prev.messages, msg]
  }));
}

// Helper for spinner
export function dispatchSpinner(status: 'idle' | 'executing' | 'thinking' | 'responding' | 'vetoing', message: string) {
  appStore.setState({ spinner: { status, message } });
}

// Helper for status text
export function dispatchStatus(text: string) {
  appStore.setState({ statusText: text });
}

// Helper for veto
export function dispatchVeto(question: string, options: string[], resolve: (ans: string) => void) {
  appStore.setState({ vetoResolver: { question, options, resolve } });
}
