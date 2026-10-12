import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpManager } from '../mcp/manager';
import { openClient } from '../mcp/client';
import { McpStderrTail } from '../mcp/stderr';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from '../core/interfaces';
import { Logger } from '../utils/logger';

const fixture = path.join(__dirname, 'fixtures/mcp-lifecycle-server.js');
const governor = { approveTaskExecution: async () => {} } as unknown as IGovernor;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-mcp-lifecycle-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('startup drains 2 MiB of backpressured stderr before the handshake', async () => {
  const log = jest.spyOn(Logger, 'warn').mockImplementation(() => {});
  let client: any;
  try {
    client = await openClient({ name: 'noisy', command: process.execPath, args: [fixture, 'noisy-start'] });
    expect((await client.listTools()).tools.map((tool: any) => tool.name)).toContain('mutate');
    // stdout and stderr are independent pipes; the initialized response can arrive first.
    for (let i = 0; i < 50 && !log.mock.calls.some(([text]) => text.includes('startup diagnostics drained')); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(log.mock.calls.some(([text]) => text.includes('startup diagnostics drained'))).toBe(true);
    expect(log.mock.calls.every(([text]) => text.length <= 4110)).toBe(true);
  } finally { await client?.close(); log.mockRestore(); }
});

test('a failed handshake closes the spawned process', async () => {
  const old = process.env.BIMAX_MCP_CONNECT_TIMEOUT_MS;
  process.env.BIMAX_MCP_CONNECT_TIMEOUT_MS = '1000';
  const file = path.join(dir, 'pid');
  try {
    await expect(openClient({ name: 'hung-start', command: process.execPath, args: [fixture, 'hang-start', file] })).rejects.toThrow(/timed out/);
    const pid = Number(fs.readFileSync(file, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (old === undefined) delete process.env.BIMAX_MCP_CONNECT_TIMEOUT_MS;
    else process.env.BIMAX_MCP_CONNECT_TIMEOUT_MS = old;
    if (fs.existsSync(file)) { try { process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGKILL'); } catch { /* already closed */ } }
  }
});

test('a tool that commits then disconnects is not replayed', async () => {
  const manager = new McpManager();
  const registry = new ToolRegistry();
  const file = path.join(dir, 'effects');
  await manager.connectSpec({ name: 'lifecycle', command: process.execPath, args: [fixture, 'normal', file] }, registry, governor);
  try {
    await expect(registry.getTool('mcp__lifecycle__mutate')!.execute({}, {})).rejects.toThrow(/completion is unknown.*not replayed/);
    expect(fs.readFileSync(file, 'utf8')).toBe('effect\n');
  } finally { await manager.disconnect('lifecycle', registry); }
});

test('Stop releases a hung SDK request promptly', async () => {
  const manager = new McpManager();
  const registry = new ToolRegistry();
  await manager.connectSpec({ name: 'lifecycle', command: process.execPath, args: [fixture, 'normal'] }, registry, governor);
  const controller = new AbortController();
  try {
    const result = registry.getTool('mcp__lifecycle__hang')!.execute({}, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow(/stopped/);
    await new Promise(resolve => setTimeout(resolve, 25));
    controller.abort(new Error('stopped'));
    await rejected;
  } finally { await manager.disconnect('lifecycle', registry); }
});

test('stderr retention stays at 64 KiB through 8 MiB of output and UTF-8 chunks decode intact', () => {
  const tail = new McpStderrTail();
  for (let i = 0; i < 1024; i++) tail.append(Buffer.alloc(8192, 'x'));
  const bytes = Buffer.from('\nlatest: café 🌍\n');
  let decoded = '';
  for (const byte of bytes) decoded += tail.append(Buffer.from([byte]));
  expect(tail.retainedBytes).toBe(64 * 1024);
  expect(tail.text().endsWith('\nlatest: café 🌍\n')).toBe(true);
  expect(decoded).toBe('\nlatest: café 🌍\n');
});
