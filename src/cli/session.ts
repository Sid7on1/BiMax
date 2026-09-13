import { stateDir } from '../utils/state.dir';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MessageEntry } from './events';
import { Message } from '../core/llm.provider';

/**
 * Convert persisted UI transcript entries (MessageEntry) into clean LLM history (Message[]).
 *
 * Sessions store the UI shape: `content` can be a React node, tool exchanges are collapsed onto the
 * assistant entry as `toolCalls` (not the API's `tool_calls` + separate `tool` role), and there are
 * UI-only fields (id, timestamp). Assigning those straight to `persona.messages` sent malformed
 * payloads to the provider (non-string content, orphaned tool shapes). This produces text-only
 * user/assistant turns — folding each collapsed tool call into a readable note so context survives —
 * which every provider accepts. System/divider entries are dropped (re-derived per turn).
 */
export function messageEntriesToLLM(entries: MessageEntry[]): Message[] {
  const out: Message[] = [];
  // The session recorder persists finished tool calls as standalone `role:'tool'` lines between the
  // user message and the assistant answer. Fold pending tool lines into the NEXT assistant turn
  // (chronologically: the agent used the tools, then answered), so resumed context keeps what the
  // agent actually did without sending the provider a role it doesn't accept.
  let toolNotes: string[] = [];
  const drainNotes = (): string => { const s = toolNotes.join('\n'); toolNotes = []; return s; };
  for (const e of entries as any[]) {
    if (e?.role === 'tool') {
      toolNotes.push(`[used ${e.toolName ?? 'tool'}(${String(e.input ?? '').slice(0, 200)}) → ${String(e.output ?? '').slice(0, 800)}]`);
      continue;
    }
    if (e?.role !== 'user' && e?.role !== 'assistant') continue; // drop system/UI dividers
    let text = typeof e.content === 'string' ? e.content : '';
    if (e.role === 'assistant' && e.toolCalls && e.toolCalls.length > 0) {
      const note = e.toolCalls
        .map((tc: any) => `[used ${tc.toolName}(${(tc.input || '').slice(0, 200)}) → ${(tc.output || '').slice(0, 800)}]`)
        .join('\n');
      text = text ? `${text}\n\n${note}` : note;
    }
    if (e.role === 'assistant' && toolNotes.length > 0) {
      const notes = drainNotes();
      text = text ? `${notes}\n\n${text}` : notes;
    } else if (e.role === 'user' && toolNotes.length > 0) {
      // Tools ran but no assistant answer was persisted (interrupted turn) — close the exchange
      // with an assistant-side note so user turns never collapse into each other.
      out.push({ role: 'assistant', content: drainNotes() });
    }
    if (!text.trim()) continue; // skip empty turns the model can't use
    out.push({ role: e.role, content: text });
  }
  if (toolNotes.length > 0) out.push({ role: 'assistant', content: drainNotes() });
  return out;
}

// Lazy (not module-load) cwd resolution: the engine chdir()s to BIMAX_CWD during boot and tests
// chdir to tmpdirs — a captured-at-import path would point sessions at the wrong project.
export function sessionDir(): string {
  return path.join(stateDir('.breakglass'), 'sessions');
}
function branchDir(): string {
  return path.join(sessionDir(), 'branches');
}

/** Timestamped session id, e.g. "2026-07-11_14-05-33" — also the JSONL filename stem. */
export function newSessionId(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}-${String(d.getSeconds()).padStart(2, '0')}`;
}

export class SessionStore {
  private id: string;
  private path: string;

  constructor() {
    this.id = newSessionId();
    this.path = path.join(sessionDir(), `${this.id}.jsonl`);
  }

  async init(): Promise<MessageEntry[]> {
    await fs.mkdir(sessionDir(), { recursive: true });
    return [];
  }

  async append(msg: MessageEntry): Promise<void> {
    const line = JSON.stringify(msg) + '\n';
    await fs.appendFile(this.path, line, 'utf-8').catch(() => {});
  }

  getId(): string { return this.id; }

  async loadAll(): Promise<MessageEntry[]> {
    const items: MessageEntry[] = [];
    try {
      const files = await fs.readdir(sessionDir());
      const sessionFiles = files.filter(f => f.endsWith('.jsonl')).sort().reverse();
      for (const file of sessionFiles.slice(0, 1)) {
        const data = await fs.readFile(path.join(sessionDir(), file), 'utf-8');
        const lines = data.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try { items.push(JSON.parse(line)); } catch { /* skip malformed line */ }
        }
      }
    } catch { /* no session dir yet */ }
    return items;
  }

  async listSessions(): Promise<string[]> {
    try {
      const files = await fs.readdir(sessionDir());
      return files.filter(f => f.endsWith('.jsonl')).sort().reverse();
    } catch { return []; }
  }

  async loadSession(file: string): Promise<MessageEntry[]> {
    const items: MessageEntry[] = [];
    try {
      const data = await fs.readFile(path.join(sessionDir(), file), 'utf-8');
      const lines = data.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try { items.push(JSON.parse(line)); } catch { /* skip malformed line */ }
      }
    } catch { /* session file missing or unreadable */ }
    return items;
  }

  // --- Branch support ---

  /** Fork the current live messages into a named branch for later resumption. */
  async saveBranch(name: string, messages: MessageEntry[]): Promise<void> {
    await fs.mkdir(branchDir(), { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const branchPath = path.join(branchDir(), `${safeName}.jsonl`);
    const lines = messages.map(m => JSON.stringify(m)).join('\n');
    await fs.writeFile(branchPath, lines + '\n', 'utf-8');
  }

  /** List all saved branch names (without extension). */
  async listBranches(): Promise<string[]> {
    try {
      const files = await fs.readdir(branchDir());
      return files.filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)).sort();
    } catch { return []; }
  }

  /** Load a named branch's messages. */
  async loadBranch(name: string): Promise<MessageEntry[]> {
    const items: MessageEntry[] = [];
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    try {
      const data = await fs.readFile(path.join(branchDir(), `${safeName}.jsonl`), 'utf-8');
      const lines = data.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try { items.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    } catch { /* branch missing */ }
    return items;
  }

  /** Delete a named branch. */
  async deleteBranch(name: string): Promise<boolean> {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    try {
      await fs.rm(path.join(branchDir(), `${safeName}.jsonl`));
      return true;
    } catch { return false; }
  }
}
