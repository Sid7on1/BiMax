import * as fs from 'fs';
import * as path from 'path';
import { engineEvents, MessageEntry, ToolCallEntry, getSessionTokenEstimate } from './events';
import { sessionDir, newSessionId } from './session';
import {
  startSessionMeta, recordFirstUserMessage, recordSessionProgress, endSessionMeta, resumeSessionMeta,
} from '../db/session.meta';

/**
 * The session recorder — the single producer behind every session surface (/sessions, /resume,
 * the desktop sidebar/gallery/home, ui_snapshot.sessions). It listens on engineEvents and appends the
 * live transcript to `<project>/.breakglass/sessions/<id>.jsonl`, one JSON line per entry:
 *
 *   - chat messages as their MessageEntry shape (the format SessionStore has always read), and
 *   - finished tool calls as `{ role: 'tool', toolName, input, output, … }` lines, which
 *     messageEntriesToLLM folds into context on resume and front-ends replay as tool cards.
 *
 * The session (file + meta record) is created LAZILY on the first user/assistant message, so boot
 * chatter and onboarding menus never litter the list with empty "Untitled" threads. `/clear`
 * rotates to a fresh session (the previous one stays resumable — that's what makes "New task"
 * non-destructive), and a true `/resume` calls switchTo() so new turns append to the resumed
 * thread's own file instead of forking a parallel one.
 *
 * Ink-era history: FullScreen owned session persistence; when Ink was retired the producers went
 * with it, leaving every consumer reading files nothing wrote. This restores the producer at the
 * engine layer, where every front-end (TUI, desktop) shares it.
 */

// Persisted tool output is capped so a noisy day-long session can't balloon the file; the /output
// viewer keeps the full text in memory via toolHistory.
const TOOL_OUTPUT_CAP = 20_000;

export class SessionRecorder {
  private id: string | null = null;
  private msgCount = 0;

  /** The active session id, or null before the first message of a fresh thread. */
  currentId(): string | null {
    return this.id;
  }

  onMessage(msg: MessageEntry): void {
    if (!msg || typeof msg !== 'object' || !msg.role) return;
    // Before the thread exists, system chatter (boot notices, onboarding menus, status lines) is
    // not a task — only a user or assistant message starts one.
    if (!this.id && msg.role !== 'user' && msg.role !== 'assistant') return;
    this.append(msg);
    if (msg.role === 'user' && typeof msg.content === 'string') {
      if (recordFirstUserMessage(msg.content)) engineEvents.emit('session_changed');
    }
    if (msg.role === 'user' || msg.role === 'assistant') {
      this.msgCount++;
      recordSessionProgress(this.msgCount, getSessionTokenEstimate());
    }
  }

  onToolResult(call: ToolCallEntry): void {
    if (!this.id || !call || !call.id) return; // no thread yet → nothing to attach tools to
    this.append({
      role: 'tool',
      id: call.id,
      toolName: call.toolName,
      input: call.input,
      output: String(call.output ?? '').slice(0, TOOL_OUTPUT_CAP),
      status: call.status,
      startTime: call.startTime,
      endTime: call.endTime,
      parentId: call.parentId,
      agentLabel: call.agentLabel,
      timestamp: new Date(),
    });
  }

  /** `/clear` — close the current thread (it stays resumable) and lazily start a fresh one. */
  rotate(): void {
    if (!this.id) return;
    endSessionMeta();
    this.id = null;
    this.msgCount = 0;
    engineEvents.emit('session_changed');
  }

  /** True resume: continue an EXISTING thread — new entries append to its file, meta reattaches. */
  switchTo(id: string, msgCount: number, fallbackTitle?: string): void {
    if (!id || id === this.id) return;
    endSessionMeta();
    this.id = id;
    this.msgCount = msgCount;
    resumeSessionMeta(id, fallbackTitle);
    engineEvents.emit('session_changed');
  }

  /** Engine shutdown — flush the meta record's final counts and mark the session ended. */
  shutdown(): void {
    endSessionMeta();
  }

  private append(line: object): void {
    try {
      const id = this.ensureSession();
      fs.appendFileSync(path.join(sessionDir(), `${id}.jsonl`), JSON.stringify(line) + '\n', 'utf8');
    } catch { /* persistence is best-effort — never break the live turn */ }
  }

  private ensureSession(): string {
    if (this.id) return this.id;
    fs.mkdirSync(sessionDir(), { recursive: true });
    // Ids are second-resolution timestamps, so rotating threads quickly ("New task" twice within a
    // second) would collide and silently append the new thread onto the old file — suffix until free.
    let id = newSessionId();
    for (let n = 2; fs.existsSync(path.join(sessionDir(), `${id}.jsonl`)); n++) id = `${newSessionId()}-${n}`;
    this.id = id;
    this.msgCount = 0;
    startSessionMeta(this.id, process.cwd());
    engineEvents.emit('session_changed');
    return this.id;
  }
}

let recorder: SessionRecorder | null = null;

/** Attach the recorder to engineEvents (idempotent). Called once from the headless entry. */
export function startSessionRecorder(): SessionRecorder {
  if (recorder) return recorder;
  recorder = new SessionRecorder();
  engineEvents.on('message', (m: MessageEntry) => recorder?.onMessage(m));
  engineEvents.on('tool_call_result', (c: ToolCallEntry) => recorder?.onToolResult(c));
  engineEvents.on('clear', () => recorder?.rotate());
  engineEvents.on('shutdown', () => recorder?.shutdown());
  return recorder;
}

/** The live recorder, or null when no front-end session is being recorded (workers, tests). */
export function getSessionRecorder(): SessionRecorder | null {
  return recorder;
}
