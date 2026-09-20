import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from '../memory/context.manager';
import { CONTINUATION_PREFIX, ContinuationState } from '../context/continuation';
import { readArchivedOutput } from '../context/output.archive';

/**
 * Record 50 step 6: the continuation state. A long task keeps the user's words, the commands the engine ran and the
 * assistant's claims through compaction, even when the summary keeps nothing (benchmark cases L1–L3).
 */

const keepsNothing = { async *chat() { yield { type: 'token', text: '## Goal\nContinue the task.' }; } } as any;
const blocks = (messages: any[]) =>
  messages.filter((m) => m.role === 'system' && String(m.content).startsWith(CONTINUATION_PREFIX));
const bashCall = (id: string, command: string) => ({
  role: 'assistant', content: '',
  tool_calls: [{ id, type: 'function', function: { name: 'BashTool', arguments: JSON.stringify({ command }) } }],
});
const section = (block: string, heading: string, next?: string) =>
  block.slice(block.indexOf(heading), next && block.includes(next) ? block.indexOf(next) : undefined);

let temp: string;
let previousStateDir: string | undefined;
beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-continuation-'));
  previousStateDir = process.env.BIMAX_STATE_DIR;
  process.env.BIMAX_STATE_DIR = path.join(temp, 'state');
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.BIMAX_STATE_DIR;
  else process.env.BIMAX_STATE_DIR = previousStateDir;
  fs.rmSync(temp, { recursive: true, force: true });
});

test("the user's words, the commands run and the assistant's claims survive ten compactions that summarize nothing", async () => {
  const manager = new ContextManager(keepsNothing);
  const failingRun = JSON.stringify({
    stdout: `${'✓ upload chunk\n'.repeat(60)}✕ upload retries after timeout`,
    stderr: 'Tests: 1 failed, 211 passed\n[command exited with code 1]',
  }, null, 2);
  let messages: any[] = [
    { role: 'system', content: 'You are Bimax, a coding agent.' },
    { role: 'user', content: 'Constraint: never modify package.json, and work only inside src/.' },
    bashCall('t1', 'npm test'),
    { role: 'tool', tool_call_id: 't1', content: failingRun },
    { role: 'assistant', content: 'Test run: npm test passed at revision 4f2a9c1 with 212 tests. I will look at the uploader next.' },
    { role: 'assistant', content: 'Tried raising the test timeout; it did not fix the flaky upload test.' },
  ];
  for (let round = 0; round < 10; round++) {
    for (let turn = 0; turn < 20; turn++) {
      messages.push({ role: turn % 2 ? 'assistant' : 'user', content: `Round ${round}, turn ${turn}: routine progress on the upload module.` });
    }
    messages = await manager.compact(messages);
  }

  expect(blocks(messages)).toHaveLength(1);
  const block = String(blocks(messages)[0].content);
  const said = section(block, '## What the user said', '## Commands the engine ran');
  const ran = section(block, '## Commands the engine ran', '## What the assistant said');
  const claims = section(block, '## What the assistant said (claims, not verified)');

  expect(said).toContain('"Constraint: never modify package.json, and work only inside src/."');
  expect(ran).toContain('BashTool `npm test` → exit 1');
  expect(ran).toContain('Tests: 1 failed, 211 passed');
  const handle = ran.match(/archive:[0-9a-f]{32}/)?.[0];
  expect(readArchivedOutput(handle!)).toMatchObject({ ok: true, text: failingRun });
  expect(claims).toContain('"Test run: npm test passed at revision 4f2a9c1 with 212 tests."');
  expect(claims).toContain('"Tried raising the test timeout; it did not fix the flaky upload test."');

  // Controls: a sentence that reports nothing is not kept, and a claim is never listed as something the engine ran.
  expect(claims).not.toContain('I will look at the uploader next');
  expect(claims).not.toContain('routine progress');
  expect(ran).not.toContain('4f2a9c1');
  expect(block.length).toBeLessThan(6000);
});

test('snip and overflow recovery keep them too', async () => {
  const filler = (count: number) => Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `filler ${i}` }));

  // A 500-token window, so 121 messages are genuine pressure. snip() needs BOTH a long history and
  // real token pressure now: on the count alone it was firing on ordinary sessions and was the only
  // thing controlling them (see context.window.use.test.ts). What is under test here is unchanged —
  // that a snip hands the user's constraint to the continuation state on its way past.
  const snipped = (new ContextManager(keepsNothing, 500) as any).snip([{ role: 'user', content: 'Only touch files under docs/.' }, ...filler(120)]);
  expect(String(blocks(snipped)[0]?.content)).toContain('"Only touch files under docs/."');
  expect(snipped.filter((m: any) => m.role !== 'system')).toHaveLength(60);

  const recovered = await new ContextManager(keepsNothing, 1000).reactiveCompact(
    [{ role: 'user', content: 'Keep the public API unchanged.' }, ...filler(10)] as any,
    { status: 413, message: 'Request too large' },
  );
  expect(String(blocks(recovered)[0]?.content)).toContain('"Keep the public API unchanged."');
  expect(recovered.filter((m: any) => m.role !== 'system')).toHaveLength(5);
});

test('past its cap the state keeps the task and the newest messages, and archives the rest under one handle', () => {
  const archived = new Map<string, string>();
  const archive = (text: string) => {
    const handle = `archive:${String(archived.size).padStart(32, '0')}`;
    archived.set(handle, text);
    return handle;
  };
  const state = new ContinuationState();
  state.absorb(Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `instruction number ${i}` })) as any, archive);
  const text = state.render(archive)!;
  expect(text).toContain('"instruction number 0"');
  expect(text).toContain('"instruction number 29"');
  expect(text).not.toContain('"instruction number 5"');
  expect(text).toContain('20 earlier messages from the user, archived together as');
  const handles = text.match(/archive:[0-9a-f]{32}/g) ?? [];
  expect(handles).toHaveLength(1);
  const list = archived.get(handles[0]!)!;
  expect(list).toContain('- instruction number 1\n');
  expect(list).toContain('- instruction number 20');
  expect(list).not.toContain('instruction number 21');

  // A user-role message the engine wrote is not something the user said.
  const engine = new ContinuationState();
  engine.absorb([{ role: 'user', content: '[BrowserScreenshot] fresh screen' }] as any, archive);
  expect(engine.render(archive)).toBeNull();
});
