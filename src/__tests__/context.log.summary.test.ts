import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { summarizeLog } from '../context/log.summary';
import { ContextManager } from '../memory/context.manager';
import { readArchivedOutput } from '../context/output.archive';

/**
 * Record 50 step 6d: a log keeps its shape — line count, failure lines and where they were — through compression, a cut
 * and clearing, beside a handle to the raw output (benchmark case N6).
 */

const keepsNothing = { async *chat() { yield { type: 'token', text: '## Goal\nContinue the task.' }; } } as any;
const uploadLog = (lines: number, failed: number[]) => Array.from({ length: lines }, (_, i) => (failed.includes(i)
  ? `ERROR upload chunk ${i} failed: connection reset`
  : `INFO upload chunk ${i} stored in ${100 + (i % 9)} ms`)).join('\n');
const shellExchange = (id: string, content: string) => [
  { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'BashTool', arguments: '{"command":"npm run upload"}' } }] },
  { role: 'tool', tool_call_id: id, content },
];

let temp: string;
let previousStateDir: string | undefined;
beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-log-summary-'));
  previousStateDir = process.env.BIMAX_STATE_DIR;
  process.env.BIMAX_STATE_DIR = path.join(temp, 'state');
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.BIMAX_STATE_DIR;
  else process.env.BIMAX_STATE_DIR = previousStateDir;
  fs.rmSync(temp, { recursive: true, force: true });
});

test('a log is summarized by its line count and its first failure of each kind, with line numbers', () => {
  const log = `${uploadLog(400, [37, 180])}\nERROR disk quota exceeded on volume 2`;
  expect(summarizeLog(log)).toBe(
    '[log: 401 lines, 3 failure lines; first of each kind: line 38 "ERROR upload chunk 37 failed: connection reset", line 401 "ERROR disk quota exceeded on volume 2"]',
  );
  // A shell payload is read through its stdout and stderr.
  expect(summarizeLog(JSON.stringify({ stdout: uploadLog(30, []), stderr: '' }, null, 2))).toBe('[log: 30 lines, no failure lines]');
  // Controls: code and short output are not logs.
  expect(summarizeLog(Array.from({ length: 40 }, (_, i) => `export const value${i} = () => { return ${i}; };`).join('\n'))).toBeNull();
  expect(summarizeLog(uploadLog(5, [2]))).toBeNull();
});

test('a compacted log keeps its summary and the handle to its raw output', async () => {
  const log = uploadLog(400, [37, 180, 311]);
  const messages = [
    { role: 'user', content: 'Upload the release assets and report what failed.' },
    ...shellExchange('c0', log),
    ...Array.from({ length: 9 }, (_, i) => shellExchange(`c${i + 1}`, `filler result ${i}`)).flat(),
  ];
  const out = await new ContextManager(keepsNothing, 2000).checkAndCompact(messages as any);
  const text = String(out.find((m: any) => m.tool_call_id === 'c0')?.content);
  expect(text).toContain('[log: 400 lines, 3 failure lines; first of each kind: line 38 "ERROR upload chunk 37 failed: connection reset"]');
  const handle = text.match(/archive:[0-9a-f]{32}/)?.[0];
  expect(readArchivedOutput(handle!)).toMatchObject({ ok: true, text: log });
});

test('a cleared log keeps its summary in the stub; a short result does not grow', () => {
  const manager = new ContextManager(keepsNothing);
  const messages = [
    { role: 'user', content: 'go' },
    ...shellExchange('old', uploadLog(120, [7])),
    ...shellExchange('tiny', 'ok'),
    ...Array.from({ length: 8 }, (_, i) => shellExchange(`n${i}`, `result ${i}`)).flat(),
  ];
  const { messages: out } = manager.reactiveDrain(messages as any);
  const stub = String(out.find((m: any) => m.tool_call_id === 'old')?.content);
  expect(stub).toMatch(/^\[tool result cleared to save context — archived as archive:[0-9a-f]{32}; read it back with ContextArchiveTool\]/);
  expect(stub).toContain('[log: 120 lines, 1 failure line; first of each kind: line 8 "ERROR upload chunk 7 failed: connection reset"]');
  expect(String(out.find((m: any) => m.tool_call_id === 'tiny')?.content)).toBe('[tool result cleared to save context]');
});
