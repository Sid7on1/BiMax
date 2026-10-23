import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpManager } from '../mcp/manager';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from '../core/interfaces';

const fixture = path.join(__dirname, 'fixtures/mcp-ownership-server.js');
const governor = { approveTaskExecution: async () => {} } as unknown as IGovernor;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-mcp-owned-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
async function markerValue(file: string, expected?: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const value = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (value && (!expected || value === expected)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Fixture did not reach ${expected || 'ready'}`);
}

test('disconnect during real catalog discovery closes the process before returning', async () => {
  const marker = path.join(dir, 'pid'); const manager = new McpManager(); const registry = new ToolRegistry();
  const pending = manager.connectSpec({ name: 'owned', command: process.execPath, args: [fixture, 'catalog-hang', marker] }, registry, governor);
  const pid = Number(await markerValue(marker));
  try {
    expect(await manager.disconnect('owned', registry)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await pending).toBeNull();
    expect(manager.getPendingServers()).toEqual([]);
    expect(manager.list()).toEqual([]);
    expect(registry.getToolNames()).toEqual([]);
  } finally {
    await manager.disconnect('owned', registry);
    try { process.kill(pid, 'SIGKILL'); } catch { /* already closed */ }
  }
});

test('a real resource-only server reads exact content and observes remote Stop cancellation', async () => {
  const marker = path.join(dir, 'read'); const manager = new McpManager(); const registry = new ToolRegistry();
  const connected = await manager.connectSpec({ name: 'owned', command: process.execPath, args: [fixture, 'resources', marker] }, registry, governor);
  try {
    expect(connected).not.toBeNull();
    expect(registry.getToolNames()).toEqual(['mcp__owned__list_resources', 'mcp__owned__read_resource']);
    expect(await registry.getTool('mcp__owned__list_resources')!.execute({}, {})).toContain('memo://one');
    const read = registry.getTool('mcp__owned__read_resource')!;
    expect(await read.execute({ uri: 'memo://one' }, {})).toBe('resource-only content');
    const controller = new AbortController();
    const pending = read.execute({ uri: 'memo://hang' }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('stopped');
    await markerValue(marker, 'started'); controller.abort(new Error('stopped')); await rejected;
    expect(await markerValue(marker, 'cancelled')).toBe('cancelled');
  } finally { await manager.disconnect('owned', registry); }
});
