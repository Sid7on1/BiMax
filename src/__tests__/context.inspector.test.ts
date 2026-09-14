import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../cli/commands/meta';
import { globalCommandRegistry } from '../cli/commands/registry';
import { describeContext } from '../context/inspector';
import { derivedEvidence, fileEvidence, fileVersion } from '../context/evidence';
import { CONTINUATION_PREFIX, ContinuationState } from '../context/continuation';
import { ContextManager } from '../memory/context.manager';

/**
 * Record 50 step 8: the evidence inspector explains in plain words what the model was shown, what is out of date and what
 * gave way to fit; a context manager rebuilt mid-task keeps the continuation state (benchmark L5).
 */

const keepsNothing = { async *chat() { yield { type: 'token', text: '## Goal\nContinue the task.' }; } } as any;
const blocks = (messages: any[]) => messages.filter((m) => m.role === 'system' && String(m.content).startsWith(CONTINUATION_PREFIX));

let temp: string;
let previousStateDir: string | undefined;
beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-inspector-'));
  previousStateDir = process.env.BIMAX_STATE_DIR;
  process.env.BIMAX_STATE_DIR = path.join(temp, 'state');
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.BIMAX_STATE_DIR;
  else process.env.BIMAX_STATE_DIR = previousStateDir;
  fs.rmSync(temp, { recursive: true, force: true });
});

test('the report says in plain words what no longer matches, what gave way, and what is carried', async () => {
  const manager = new ContextManager(keepsNothing);
  const changed = path.join(temp, 'changed.ts');
  const gone = path.join(temp, 'gone.ts');
  fs.writeFileSync(changed, 'export const a = 1;\n');
  fs.writeFileSync(gone, 'export const b = 2;\n');
  const read = manager.evidence.admit(fileEvidence(changed, 'export const a = 1;', (await fileVersion(changed))!, { startLine: 1, endLine: 1 }));
  manager.evidence.admit(fileEvidence(gone, 'export const b = 2;', (await fileVersion(gone))!));
  const block = manager.evidence.admit(derivedEvidence('recall-block', 'a block built from the read', [read]));
  fs.writeFileSync(changed, 'export const a = 42;\n');
  fs.rmSync(gone);
  await manager.evidence.refreshFileSources();
  manager.recordRequest({
    window: 8000, system: 1200, tools: 900, outputReserve: 1200, margin: 240, messageBudget: 4460, messages: 3100,
    sent: true, steps: ['cleared old tool results', 'summarized older turns'], residentEvidenceIds: [read.id, block.id], at: new Date().toISOString(),
  });
  manager.continuation.absorb([{ role: 'user', content: 'Never touch the migrations folder.' }] as any, () => null);

  const report = describeContext(manager);
  expect(report).toContain('Last request: sent.');
  expect(report).toContain('the conversation 3,100 of the 4,460 left for it');
  expect(report).toContain('To fit, Bimax cleared old tool results; then summarized older turns.');
  expect(report).toContain('It carried 2 tracked pieces of evidence: 1 file, 1 recall block.');
  expect(report).toContain('3 of 3 recorded pieces of evidence no longer match their sources.');
  expect(report).toContain(`- ${changed} (lines 1-1): it changed after the model saw it.`);
  expect(report).toContain(`- ${gone}: it was deleted or can no longer be read.`);
  expect(report).toContain('- a recall block built from other evidence: it was built from something that changed.');
  expect(report).toContain('Carried across compaction: 1 of your messages, 0 commands and 0 of the assistant\'s claims.');

  // Controls: a refused request is reported as refused, and a session with nothing yet says so.
  manager.recordRequest({ ...manager.lastRequest!, sent: false });
  expect(describeContext(manager)).toContain("Last request: not sent, because it did not fit the model's context window.");
  expect(describeContext(new ContextManager(keepsNothing))).toContain('No request has been sent in this session yet.');
  expect(describeContext(null)).toContain('send a message first');
});

test('/evidence shows the engine report, and says when there is none', async () => {
  expect(await globalCommandRegistry.execute('/evidence', { contextReport: () => 'REPORT FROM THE ENGINE' } as any))
    .toMatchObject({ type: 'message', content: 'REPORT FROM THE ENGINE' });
  expect(await globalCommandRegistry.execute('/evidence', { options: {} } as any))
    .toMatchObject({ type: 'message', content: 'The evidence record is not available in this session.' });
});

test('adopting reads back exactly what render wrote, and only into an empty state', () => {
  const archive = (saved: string) => `archive:${String(saved.length).padStart(32, '0')}`;
  const state = new ContinuationState();
  state.absorb([
    { role: 'user', content: 'Constraint: never modify package.json.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'BashTool', arguments: '{"command":"npm test"}' } }] },
    { role: 'tool', tool_call_id: 't', content: JSON.stringify({ stdout: 'Tests: 212 passed', stderr: '' }) },
    { role: 'assistant', content: 'Tried raising the test timeout; it did not fix the flaky upload test.' },
  ] as any, archive);
  const text = state.render(archive)!;
  const copy = new ContinuationState();
  expect(copy.adopt(text)).toBe(true);
  expect(copy.render(archive)).toBe(text);
  expect(copy.adopt(text)).toBe(false);
});

test('a context manager rebuilt mid-task keeps the continuation state its predecessor left', async () => {
  const first = new ContextManager(keepsNothing);
  let messages: any[] = [
    { role: 'system', content: 'You are Bimax, a coding agent.' },
    { role: 'user', content: 'Constraint: never modify package.json, and work only inside src/.' },
    { role: 'assistant', content: 'Tried raising the test timeout; it did not fix the flaky upload test.' },
  ];
  for (let round = 0; round < 3; round++) {
    for (let turn = 0; turn < 20; turn++) messages.push({ role: turn % 2 ? 'assistant' : 'user', content: `Round ${round}, turn ${turn}: routine progress.` });
    messages = await first.compact(messages);
  }
  // As on a model switch: a new manager, a different window, the same window of messages.
  const rebuilt = new ContextManager(keepsNothing, 64000);
  for (let turn = 0; turn < 20; turn++) messages.push({ role: turn % 2 ? 'assistant' : 'user', content: `After the switch, turn ${turn}: routine progress.` });
  messages = await rebuilt.compact(messages);
  expect(blocks(messages)).toHaveLength(1);
  const carried = String(blocks(messages)[0].content);
  expect(carried).toContain('"Constraint: never modify package.json, and work only inside src/."');
  expect(carried).toContain('"Tried raising the test timeout; it did not fix the flaky upload test."');
  expect(carried).toContain('"After the switch, turn 0: routine progress."');
});
