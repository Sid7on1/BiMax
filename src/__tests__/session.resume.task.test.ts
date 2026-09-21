import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../engine/commands/session';
import { globalCommandRegistry } from '../engine/commands/registry';
import { engineEvents } from '../engine/events';
import { messageEntriesToLLM, sessionDir } from '../engine/session';
import { CONTINUATION_PREFIX, ContinuationState } from '../context/continuation';
import { readArchivedOutput } from '../context/output.archive';
import { ContextManager } from '../memory/context.manager';
import { clearActiveTodos, getActiveTodos, todosTouchedThisTurn } from '../tools/implementations/todo.tool';

/**
 * Backlog F2, first version: a task's state survives an app or engine restart.
 *
 * `/resume` is how every saved task comes back — the sidebar, the boot revival after an engine crash, a model switch
 * that restarts the engine. It kept the newest 40 messages and nothing else, so on a long task the user's request, any
 * constraint stated early, the commands already run and the checklist were all gone after a restart, while the same
 * task running uninterrupted kept every one of them through compaction.
 */

let dir: string;
let previousStateDir: string | undefined;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-resume-task-'));
  previousStateDir = process.env.BIMAX_STATE_DIR;
  process.env.BIMAX_STATE_DIR = dir;
  fs.mkdirSync(sessionDir(), { recursive: true });
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.BIMAX_STATE_DIR;
  else process.env.BIMAX_STATE_DIR = previousStateDir;
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => clearActiveTodos());

/** The text of the archived list of the user's earlier messages a block names, or '' when it names none. */
function archivedList(block: string): string {
  const handle = /earlier messages? from the user, archived together as (archive:[0-9a-f]{32})/.exec(block)?.[1];
  const read = handle ? readArchivedOutput(handle) : null;
  return read && 'text' in read ? read.text : '';
}

const TASK = 'Migrate the billing module to the new invoice API. Do not touch anything under migrations/.';
const CONSTRAINT = 'Also: keep every public function name in billing/ unchanged, callers depend on them.';

let seq = 0;
const at = () => new Date(Date.UTC(2026, 8, 21, 9, 0, seq++));
const user = (content: string) => ({ id: `m${seq}`, role: 'user', content, timestamp: at() });
const assistant = (content: string) => ({ id: `m${seq}`, role: 'assistant', content, timestamp: at() });
const tool = (id: string, toolName: string, input: unknown, output: string, status: 'success' | 'error' = 'success') => ({
  role: 'tool', id, toolName, input: JSON.stringify(input), output, status, timestamp: at(),
});
const todos = (id: string, list: Array<[string, string]>, status: 'success' | 'error' = 'success') =>
  tool(id, 'TodoWriteTool', { todos: list.map(([content, s]) => ({ content, status: s })) }, `Tasks (${list.length})`, status);

function save(name: string, entries: object[]): string {
  fs.writeFileSync(path.join(sessionDir(), `${name}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return name;
}

async function resume(name: string): Promise<any[]> {
  let restored: any[] = [];
  const result = await globalCommandRegistry.execute(`/resume ${name}`, {
    restoreMessages: (messages: any[]) => { restored = messages; return true; },
    addSystemMessage: () => {},
  } as any);
  expect((result as any)?.level).not.toBe('error');
  return restored;
}

/** A task long enough that its start falls outside the 40 messages a resume keeps live. */
function longTask(extra: object[] = []): object[] {
  const entries: object[] = [
    user(TASK),
    todos('todo-1', [['Read the invoice API', 'completed'], ['Port billing/charge.ts', 'in_progress'], ['Run the billing tests', 'pending']]),
    assistant('I will start with charge.ts.'),
    user(CONSTRAINT),
    tool('bash-1', 'BashTool', { command: 'npm test -- billing' }, JSON.stringify({
      stdout: '✕ charge rounds to the cent', stderr: 'Tests: 1 failed, 40 passed\n[command exited with code 1]',
    })),
    assistant('The billing tests failed on rounding. Tried Math.round; it did not fix the half-cent case.'),
  ];
  for (let turn = 0; turn < 30; turn++) {
    entries.push(user(`Continue with step ${turn}.`), assistant(`Step ${turn} is in progress on the invoice client.`));
  }
  return [...entries, ...extra];
}

test("after a restart a long task still has the user's request, their constraint and the commands already run", async () => {
  const entries = longTask();
  const restored = await resume(save('2026-09-21_09-00-00', entries));

  const [block, ...live] = restored;
  expect(block.role).toBe('system');
  expect(String(block.content).startsWith(CONTINUATION_PREFIX)).toBe(true);
  // Quoted exactly, never paraphrased. The request is always kept; the constraint, older than the newest ten of the
  // user's messages, is in their archived list — exactly where a task that never restarted would have it.
  expect(block.content).toContain(`"${TASK}"`);
  expect(archivedList(block.content)).toContain(CONSTRAINT);
  expect(block.content).not.toMatch(/no longer kept/);
  // What the engine ran and saw, not what the assistant said about it.
  expect(block.content).toMatch(/BashTool `npm test -- billing` → exit 1/);
  expect(block.content).toContain('it did not fix the half-cent case');
  // The live window is exactly what a resume showed before; the state only adds what fell out of it.
  expect(live).toEqual(messageEntriesToLLM(entries as any).slice(-40));
});

test('the checklist comes back as the task last wrote it, and the resume itself does not count as working it', async () => {
  const published = jest.fn();
  engineEvents.on('todo_update', published);
  try {
    await resume(save('2026-09-21_09-10-00', longTask([
      todos('todo-2', [['Read the invoice API', 'completed'], ['Port billing/charge.ts', 'completed'], ['Run the billing tests', 'in_progress']]),
      // A write that failed never replaced the list.
      todos('todo-3', [['Something else entirely', 'pending']], 'error'),
      assistant('Running the billing tests now.'),
    ])));
  } finally {
    engineEvents.off('todo_update', published);
  }
  const expected = [
    { content: 'Read the invoice API', status: 'completed' },
    { content: 'Port billing/charge.ts', status: 'completed' },
    { content: 'Run the billing tests', status: 'in_progress' },
  ];
  expect(getActiveTodos()).toEqual(expected);
  expect(published).toHaveBeenLastCalledWith(expected);
  expect(todosTouchedThisTurn()).toBe(false);
});

test('a checklist the task had finished is not brought back', async () => {
  await resume(save('2026-09-21_09-20-00', longTask([
    todos('todo-2', [['Read the invoice API', 'completed'], ['Port billing/charge.ts', 'completed'], ['Run the billing tests', 'completed']]),
  ])));
  expect(getActiveTodos()).toEqual([]);
});

test("resuming a task that never had a checklist clears the previous task's", async () => {
  await resume(save('2026-09-21_09-30-00', longTask()));
  expect(getActiveTodos().length).toBe(3);
  await resume(save('2026-09-21_09-40-00', [user('What does billing/charge.ts export?'), assistant('It exports charge() and refund().')]));
  expect(getActiveTodos()).toEqual([]);
});

test('a conversation that fits resumes exactly as before, with no state block', async () => {
  const entries = [
    user('What does billing/charge.ts export?'),
    tool('read-1', 'FileReadTool', { path: 'billing/charge.ts' }, 'export function charge() {}'),
    assistant('It exports charge().'),
  ];
  const restored = await resume(save('2026-09-21_09-50-00', entries));
  expect(restored).toEqual(messageEntriesToLLM(entries as any));
});

test("the engine's context manager takes the state over, so it survives the task's next compactions", async () => {
  let messages: any[] = await resume(save('2026-09-21_10-00-00', longTask()));
  const manager = new ContextManager({ async *chat() { yield { type: 'token', text: '## Goal\nContinue.' }; } } as any);
  for (let round = 0; round < 3; round++) {
    for (let turn = 0; turn < 20; turn++) {
      messages.push({ role: turn % 2 ? 'assistant' : 'user', content: `After the restart, round ${round}, turn ${turn}.` });
    }
    messages = await manager.compact(messages);
  }
  const blocks = messages.filter((m) => m.role === 'system' && String(m.content).startsWith(CONTINUATION_PREFIX));
  expect(blocks).toHaveLength(1);
  expect(blocks[0].content).toContain(`"${TASK}"`);
  expect(blocks[0].content).toMatch(/npm test -- billing/);
  // Nothing was dropped, so nothing may be reported as dropped; the constraint is one list inside the other.
  expect(blocks[0].content).not.toMatch(/no longer kept/);
  const outer = archivedList(String(blocks[0].content));
  const inner = /archived as (archive:[0-9a-f]{32})/.exec(outer)?.[1];
  const read = inner ? readArchivedOutput(inner) : null;
  expect(read && 'text' in read ? read.text : '').toContain(CONSTRAINT);
});

test('a handed-over list that had already dropped messages says so again, and counts only those', () => {
  const archive = (text: string) => `archive:${require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
  const first = new ContinuationState();
  first.absorb([{ role: 'user', content: 'The task.' }, ...Array.from({ length: 14 }, (_, i) => ({ role: 'user', content: `Message ${i}.` }))] as any, archive);
  const block = `${first.render(archive)}`.replace(/archived together as (archive:[0-9a-f]{32}) \(read with ContextArchiveTool\)/,
    'archived together as $1 (read with ContextArchiveTool); the oldest 2 are no longer kept');
  expect(block).toMatch(/5 earlier messages from the user, .*the oldest 2 are no longer kept/);

  const next = new ContinuationState();
  expect(next.adopt(block)).toBe(true);
  next.absorb(Array.from({ length: 3 }, (_, i) => ({ role: 'user', content: `Later ${i}.` })) as any, archive);
  // 5 + 3 counted; the 3 held in the old list and the 3 just moved are still kept; only the 2 are gone.
  expect(next.render(archive)).toMatch(/- 8 earlier messages from the user, archived together as archive:[0-9a-f]{32} \(read with ContextArchiveTool\); the oldest 2 are no longer kept\./);
});

test("a sub-agent's commands and checklist are its own, not the task's", async () => {
  const worker = (entry: object) => ({ ...entry, parentId: 'spawn-1', agentLabel: 'explorer' });
  const restored = await resume(save('2026-09-21_10-10-00', longTask([
    worker(tool('w-bash', 'BashTool', { command: 'rm -rf worker-scratch' }, JSON.stringify({ stdout: '', stderr: '' }))),
    worker(todos('w-todo', [['Scan the repo', 'in_progress']])),
    ...Array.from({ length: 25 }, (_, i) => [user(`More work ${i}.`), assistant(`Done ${i}.`)]).flat(),
  ])));
  expect(restored[0].content).not.toContain('worker-scratch');
  expect(getActiveTodos().map((t) => t.content)).toEqual(['Read the invoice API', 'Port billing/charge.ts', 'Run the billing tests']);
});

test('tool calls folded into the first live message stay live, and are not also carried by the block', () => {
  const { resumeTaskState } = require('../engine/session.resume');
  const entries = [
    user(TASK),
    user('Run the linter.'),
    tool('lint', 'BashTool', { command: 'npm run lint' }, JSON.stringify({ stdout: '0 problems', stderr: '' })),
    assistant('The linter passed.'),
  ];
  const task = resumeTaskState(entries, () => null, 1);
  expect(task.carried).toBe(2);
  expect(task.messages[0].content).toContain(`"${TASK}"`);
  expect(task.messages[0].content).not.toContain('npm run lint');
  expect(task.messages[1].content).toContain('npm run lint');
});
