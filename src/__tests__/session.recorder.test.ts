import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionRecorder } from '../engine/session.recorder';
import { messageEntriesToLLM } from '../engine/session';
import { endSessionMeta, flushSessionMeta, listSessionMeta, getCurrentSessionId } from '../db/session.meta';
import { MessageEntry, ToolCallEntry } from '../engine/events';

/**
 * The session recorder is the single producer behind every session surface (/sessions, /resume,
 * the desktop sidebar/gallery/home). These tests pin its lifecycle: lazy thread creation, live
 * appends, /clear rotation, true-resume continuation, and the meta records the UIs list.
 */

const SESSIONS = path.join('.breakglass', 'sessions');
const META = path.join(SESSIONS, 'sessions-meta.jsonl');

let dir: string;
let prevCwd: string;

function msg(role: MessageEntry['role'], content: string): MessageEntry {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role, content, timestamp: new Date() };
}

function tool(name: string, input: string, output: string): ToolCallEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    toolName: name, input, output, status: 'success',
    startTime: new Date(), endTime: new Date(),
  };
}

function sessionFiles(): string[] {
  try {
    return fs.readdirSync(path.join(dir, SESSIONS)).filter(f => f.endsWith('.jsonl') && !f.startsWith('sessions-meta'));
  } catch { return []; }
}

function readLines(file: string): any[] {
  return fs.readFileSync(path.join(dir, SESSIONS, file), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

beforeEach(() => {
  prevCwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-sessrec-'));
  process.chdir(dir);
});

afterEach(() => {
  endSessionMeta(); // never leak a live meta tracker into the next test
  process.chdir(prevCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionRecorder lifecycle', () => {
  it('lazily creates the thread on the first user message — boot chatter never litters the list', () => {
    const r = new SessionRecorder();
    r.onMessage(msg('system', 'Indexing codebase…'));
    expect(r.currentId()).toBeNull();
    expect(sessionFiles()).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, META))).toBe(false);

    r.onMessage(msg('user', 'fix the login bug'));
    const id = r.currentId()!;
    expect(id).toBeTruthy();
    expect(sessionFiles()).toEqual([`${id}.jsonl`]);
    const meta = listSessionMeta();
    expect(meta).toHaveLength(1);
    expect(meta[0].id).toBe(id);
    expect(meta[0].title).toBe('fix the login bug');
    expect(getCurrentSessionId()).toBe(id);
  });

  it('appends messages, system lines, and finished tool calls to the live file in order', () => {
    const r = new SessionRecorder();
    r.onToolResult(tool('read_file', 'a.ts', 'contents')); // pre-thread tool → dropped
    r.onMessage(msg('user', 'do the thing'));
    r.onToolResult(tool('edit_file', 'a.ts', 'ok'));
    r.onMessage(msg('assistant', 'done'));
    r.onMessage(msg('system', '◇ ledger · verified 1 change this turn'));

    const lines = readLines(`${r.currentId()}.jsonl`);
    expect(lines.map((l: any) => l.role)).toEqual(['user', 'tool', 'assistant', 'system']);
    expect(lines[1].toolName).toBe('edit_file');
    flushSessionMeta(); // progress writes are debounced 10s in production
    const meta = listSessionMeta()[0];
    expect(meta.messageCount).toBe(2); // chat turns only, not tools/system
  });

  it('caps persisted tool output so a noisy session cannot balloon the file', () => {
    const r = new SessionRecorder();
    r.onMessage(msg('user', 'hi'));
    r.onToolResult(tool('bash', 'yes | head -c 100000', 'x'.repeat(100_000)));
    const toolLine = readLines(`${r.currentId()}.jsonl`).find((l: any) => l.role === 'tool');
    expect(toolLine.output.length).toBe(20_000);
  });

  it('rotate() (= /clear) closes the thread and the next message starts a fresh one', () => {
    const r = new SessionRecorder();
    r.onMessage(msg('user', 'first task'));
    const first = r.currentId()!;
    r.rotate();
    expect(r.currentId()).toBeNull();
    expect(listSessionMeta()[0].endedAt).toBeTruthy(); // closed, still resumable

    r.onMessage(msg('user', 'second task'));
    const second = r.currentId()!;
    expect(second).not.toBe(first);
    expect(sessionFiles().sort()).toEqual([`${first}.jsonl`, `${second}.jsonl`].sort());
    const meta = listSessionMeta(); // newest first
    expect(meta[0].title).toBe('second task');
    expect(meta[1].title).toBe('first task');
  });

  it('rotate() before any message is a no-op (no empty threads)', () => {
    const r = new SessionRecorder();
    r.rotate();
    expect(sessionFiles()).toHaveLength(0);
    expect(listSessionMeta()).toHaveLength(0);
  });

  it('switchTo() continues an existing thread: appends land in ITS file and meta reattaches', () => {
    const r = new SessionRecorder();
    r.onMessage(msg('user', 'original task'));
    const original = r.currentId()!;
    r.rotate();
    r.onMessage(msg('user', 'detour'));
    const detour = r.currentId()!;
    expect(detour).not.toBe(original);

    // True resume: back to the original thread.
    r.switchTo(original, 1, 'original task');
    expect(r.currentId()).toBe(original);
    expect(getCurrentSessionId()).toBe(original);
    r.onMessage(msg('assistant', 'picking the task back up'));

    const lines = readLines(`${original}.jsonl`);
    expect(lines).toHaveLength(2);
    expect(lines[1].content).toBe('picking the task back up');
    flushSessionMeta();
    const meta = listSessionMeta().find(m => m.id === original)!;
    expect(meta.endedAt).toBeUndefined(); // live again
    expect(meta.messageCount).toBe(2);
  });

  it('switchTo() a session that predates meta tracking creates its record with the fallback title', () => {
    const r = new SessionRecorder();
    r.switchTo('2025-01-01_00-00-00', 3, 'ancient thread');
    r.onMessage(msg('user', 'continue'));
    flushSessionMeta();
    const meta = listSessionMeta().find(m => m.id === '2025-01-01_00-00-00')!;
    expect(meta.title).toBe('ancient thread');
    expect(meta.messageCount).toBe(4);
  });
});

describe('messageEntriesToLLM with persisted tool lines', () => {
  it('folds tool lines into the following assistant turn (chronological: tools, then answer)', () => {
    const entries: any[] = [
      msg('user', 'what does foo do?'),
      { role: 'tool', toolName: 'read_file', input: 'foo.ts', output: 'export function foo() {}' },
      { role: 'tool', toolName: 'grep', input: 'foo(', output: '3 matches' },
      msg('assistant', 'foo is an exported function.'),
    ];
    const out = messageEntriesToLLM(entries);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: 'user', content: 'what does foo do?' });
    expect(out[1].role).toBe('assistant');
    expect(out[1].content).toContain('[used read_file(foo.ts) → export function foo() {}]');
    expect(out[1].content).toContain('[used grep(foo() → 3 matches]');
    expect(String(out[1]?.content).endsWith('foo is an exported function.')).toBe(true);
  });

  it('closes an interrupted turn (tools but no answer) with an assistant note so user turns never merge', () => {
    const entries: any[] = [
      msg('user', 'try A'),
      { role: 'tool', toolName: 'bash', input: 'npm test', output: 'FAIL' },
      msg('user', 'never mind, try B'),
    ];
    const out = messageEntriesToLLM(entries);
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(out[1].content).toContain('[used bash(npm test) → FAIL]');
  });

  it('emits trailing tool activity (crash mid-turn) as a final assistant note', () => {
    const entries: any[] = [
      msg('user', 'refactor it'),
      { role: 'tool', toolName: 'edit_file', input: 'a.ts', output: 'ok' },
    ];
    const out = messageEntriesToLLM(entries);
    expect(out.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(out[1].content).toContain('edit_file');
  });

  it('still drops system/menu entries and truncates long tool payloads', () => {
    const entries: any[] = [
      { ...msg('system', ''), uiComponent: 'menu', payload: { title: 'pick' } },
      msg('user', 'hello'),
      { role: 'tool', toolName: 'bash', input: 'x'.repeat(500), output: 'y'.repeat(2000) },
      msg('assistant', 'hi'),
    ];
    const out = messageEntriesToLLM(entries);
    expect(out).toHaveLength(2);
    const note = out[1].content;
    expect(note).not.toContain('x'.repeat(201));
    expect(note).not.toContain('y'.repeat(801));
  });
});
