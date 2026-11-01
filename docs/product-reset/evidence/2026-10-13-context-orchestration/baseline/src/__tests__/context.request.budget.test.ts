import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encode } from 'gpt-tokenizer';
import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { buildTool } from '../tools/tool.factory';
import { CONTINUATION_PREFIX, ContinuationState } from '../context/continuation';

/**
 * Record 50 step 6c: one budget at the request boundary. The request that leaves fits the window, what gave way is
 * recorded, and a request that cannot fit is not sent.
 */

const governor = { approveTaskExecution: async () => {} } as any;
const QUESTION = 'Which file sets the retry limit for uploads?';

function prose(chars: number): string {
  const sentence = 'Follow the project rules carefully and verify every change before reporting it. ';
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
}

/** Tokens in a request as sent, measured independently of the engine: system prompt, schemas, every message. */
function sentTokens(request: { messages: any[]; options: any }): number {
  return encode(String(request.options.system ?? '')).length
    + encode(JSON.stringify(request.options.tools ?? [])).length
    + request.messages.reduce((sum, m) => sum + 4 + encode(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).length
      + (m.tool_calls ? encode(JSON.stringify(m.tool_calls)).length : 0), 0);
}

async function turn(shape: { window: number; systemChars: number; toolChars: number; history: any[]; question?: string }) {
  const requests: Array<{ messages: any[]; options: any }> = [];
  const llm = {
    async *chat(messages: any[], options: any = {}) {
      const main = options.system !== undefined;
      if (main) requests.push({ messages: messages.map((m) => ({ ...m })), options });
      yield { type: 'token', text: main ? 'It is src/config/limits.ts.' : '## Goal\nContinue the task.' };
    },
  } as any;
  const tools = new ToolRegistry();
  tools.register(buildTool({
    name: 'GrepTool', description: prose(shape.toolChars), isDestructive: false,
    schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    execute: async () => 'no matches',
  }, governor));
  const loop = new AgentLoop(llm, tools, undefined, shape.window);
  let text = '';
  const question = shape.question ?? QUESTION;
  for await (const chunk of loop.execute([...shape.history, { role: 'user', content: question }], prose(shape.systemChars), { maxIterations: 1 })) {
    text += chunk;
  }
  return { requests, text, manager: (loop as any).contextManager };
}

let temp: string;
let previousStateDir: string | undefined;
beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-request-budget-'));
  previousStateDir = process.env.BIMAX_STATE_DIR;
  process.env.BIMAX_STATE_DIR = path.join(temp, 'state');
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.BIMAX_STATE_DIR;
  else process.env.BIMAX_STATE_DIR = previousStateDir;
  fs.rmSync(temp, { recursive: true, force: true });
});

test('the request sent fits the window, carries the question, and records what gave way', async () => {
  const history = [
    { role: 'user', content: 'Constraint: never touch the migrations folder.' },
    ...Array.from({ length: 29 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `Earlier turn ${i}: ${prose(200)}` })),
  ];
  const { requests, manager } = await turn({ window: 3000, systemChars: 6000, toolChars: 6000, history });

  expect(requests).toHaveLength(1);
  expect(sentTokens(requests[0])).toBeLessThanOrEqual(3000);
  expect(requests[0].messages.at(-1)).toMatchObject({ role: 'user', content: QUESTION });
  // What gave way is still carried: the constraint is quoted in the continuation state that went with the request.
  const continuation = requests[0].messages.find((m) => String(m.content).startsWith(CONTINUATION_PREFIX));
  expect(String(continuation?.content)).toContain('never touch the migrations folder');
  expect(manager.lastRequest).toMatchObject({ window: 3000, sent: true });
  expect(manager.lastRequest.steps.length).toBeGreaterThan(0);
});

test('with room to spare nothing gives way', async () => {
  const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Turn ${i}: ${prose(120)}` }));
  const { requests, manager } = await turn({ window: 128000, systemChars: 2000, toolChars: 500, history });
  expect(requests[0].messages.filter((m) => m.role !== 'system')).toHaveLength(7);
  expect(manager.lastRequest.steps).toEqual([]);
});

test('a request whose instructions alone exceed the window is not sent, and the turn says why', async () => {
  const { requests, text, manager } = await turn({ window: 1000, systemChars: 8000, toolChars: 400, history: [] });
  expect(requests).toHaveLength(0);
  expect(text).toContain("does not fit the model's context window, so nothing was sent");
  expect(text).toContain('instructions and tool definitions alone');
  expect(manager.lastRequest).toMatchObject({ sent: false });
});

test('the latest message is never dropped to make room: a turn too large to send is refused instead', async () => {
  const { requests, text } = await turn({ window: 2000, systemChars: 400, toolChars: 200, history: [], question: prose(12000) });
  expect(requests).toHaveLength(0);
  expect(text).toContain('The latest message and the work since it are too large');
});

test('rendered within a character budget, the continuation state keeps the task and changes nothing', () => {
  const archived = new Map<string, string>();
  const archive = (saved: string) => {
    const handle = `archive:${String(archived.size + 1).padStart(32, '0')}`;
    archived.set(handle, saved);
    return handle;
  };
  const state = new ContinuationState();
  state.absorb([
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `instruction number ${i}: ${prose(60)}` })),
    ...Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', content: `Attempt ${i} failed because the fixture was stale.` })),
  ] as any, archive);
  const full = state.render(archive)!;
  const small = state.render(archive, 700)!;
  expect(full.length).toBeGreaterThan(700);
  expect(small.length).toBeLessThanOrEqual(700);
  expect(small).toContain('"instruction number 0:');
  expect(small).toContain('left out to fit the request');
  // Rendering small is not destructive: the full state renders the same again.
  expect(state.render(archive)).toBe(full);
});
