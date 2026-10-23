import { McpManager } from '../mcp/manager';
import { connectAndRegister, openClient } from '../mcp/client';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from '../core/interfaces';
import { Logger } from '../utils/logger';

const mockClients: any[] = [];
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn(() => {
    if (!mockClients.length) throw new Error('Unexpected MCP process launch');
    return mockClients.shift();
  }),
}));

const governor = { approveTaskExecution: async () => {} } as unknown as IGovernor;
const spec = { name: 'owned', command: process.execPath };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tools = (...names: string[]) => ({ tools: names.map(name => ({ name, annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } })) });
function client(name = 'echo', caps: any = { tools: { listChanged: true } }) {
  const value = {
    connect: jest.fn(async () => {}), close: jest.fn(async () => {}),
    setRequestHandler: jest.fn(), setNotificationHandler: jest.fn(),
    getServerCapabilities: () => caps,
    listTools: jest.fn(async () => tools(name)),
    callTool: jest.fn(async () => ({ content: [{ type: 'text', text: name }] })),
    ping: jest.fn(async () => ({})),
    listResources: jest.fn(async () => ({ resources: [] })),
    listResourceTemplates: jest.fn(async () => ({ resourceTemplates: [] })),
    readResource: jest.fn(async () => ({ contents: [{ text: 'fresh content' }] })),
  };
  mockClients.push(value);
  return value;
}
async function tick() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const changed = (c: ReturnType<typeof client>) => c.setNotificationHandler.mock.calls[0][1] as () => Promise<void>;

beforeEach(() => {
  mockClients.length = 0;
  jest.spyOn(Logger, 'info').mockImplementation(() => {});
  jest.spyOn(Logger, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('disconnect cancels a pending handshake and never publishes its late tools', async () => {
  const c = client(); const ready = deferred();
  c.connect.mockImplementation(() => ready.promise);
  const manager = new McpManager(); const registry = new ToolRegistry();
  const connecting = manager.connectSpec(spec, registry, governor);
  await tick();
  const disconnected = await manager.disconnect(spec.name, registry);
  ready.resolve();
  const result = await connecting;
  try {
    expect(disconnected).toBe(true);
    expect(result).toBeNull();
    expect(manager.list()).toEqual([]);
    expect(registry.getToolNames()).toEqual([]);
    expect(c.close).toHaveBeenCalled();
  } finally { await manager.disconnect(spec.name, registry); }
});

test('the latest connect intent wins even when an older handshake finishes last', async () => {
  const slow = client('older'); const ready = deferred();
  slow.connect.mockImplementation(() => ready.promise);
  const fast = client('newer');
  const manager = new McpManager(); const registry = new ToolRegistry();
  const older = manager.connectSpec(spec, registry, governor);
  await tick();
  const newer = await manager.connectSpec(spec, registry, governor);
  ready.resolve();
  const stale = await older;
  try {
    expect(stale).toBeNull();
    expect(manager.get(spec.name)).toBe(newer);
    expect(registry.getToolNames()).toEqual(['mcp__owned__newer']);
    expect(slow.close).toHaveBeenCalled();
    expect(fast.close).not.toHaveBeenCalled();
  } finally { await manager.disconnect(spec.name, registry); }
});

test('an obsolete connect cannot clear the newer pending marker', async () => {
  const a = client('a'); const ar = deferred(); a.connect.mockImplementation(() => ar.promise);
  const b = client('b'); const br = deferred(); b.connect.mockImplementation(() => br.promise);
  const manager = new McpManager(); const registry = new ToolRegistry();
  const first = manager.connectSpec(spec, registry, governor); await tick();
  const second = manager.connectSpec(spec, registry, governor); await tick();
  ar.resolve(); await first;
  const pending = manager.getPendingServers();
  br.resolve(); await second;
  try { expect(pending).toEqual(['owned']); }
  finally { await manager.disconnect(spec.name, registry); }
});

test('disconnect during replacement cleanup cannot resurrect the replacement', async () => {
  const old = client('old'); const closing = deferred();
  const manager = new McpManager(); const registry = new ToolRegistry();
  await manager.connectSpec(spec, registry, governor);
  old.close.mockImplementation(() => closing.promise);
  const fresh = client('fresh');
  const replacement = manager.connectSpec(spec, registry, governor); await tick();
  const disconnecting = manager.disconnect(spec.name, registry); await tick();
  closing.resolve(); await Promise.all([replacement, disconnecting]);
  try {
    expect(manager.get(spec.name)).toBeUndefined();
    expect(registry.getToolNames()).toEqual([]);
    expect(fresh.close).toHaveBeenCalled();
  } finally { await manager.disconnect(spec.name, registry); }
});

test('an in-flight watchdog probe cannot reconnect a disconnected server', async () => {
  jest.useFakeTimers();
  const c = client(); const probe = deferred<any>(); c.ping.mockImplementation(() => probe.promise);
  const manager = new McpManager(); const registry = new ToolRegistry();
  await manager.connectSpec(spec, registry, governor);
  const unexpected = client('resurrected');
  manager.startWatchdog(registry, governor, 100);
  try {
    await jest.advanceTimersByTimeAsync(100);
    await manager.disconnect(spec.name, registry);
    probe.reject(new Error('Connection closed')); await tick();
    expect(manager.list()).toEqual([]);
    expect(registry.getToolNames()).toEqual([]);
    expect(unexpected.connect).not.toHaveBeenCalled();
  } finally { manager.stopWatchdog(); await manager.disconnect(spec.name, registry); }
});

test('a retained tool reference cannot heal a deliberately disconnected server', async () => {
  const c = client();
  c.callTool.mockRejectedValue(new Error('Connection closed'));
  const manager = new McpManager(); const registry = new ToolRegistry();
  await manager.connectSpec(spec, registry, governor);
  const tool = registry.getTool('mcp__owned__echo')!;
  await manager.disconnect(spec.name, registry);
  await expect(tool.execute({}, {})).rejects.toThrow(/retired|disconnect/i);
  expect(c.callTool).not.toHaveBeenCalled();
});

test('a late catalog refresh cannot restore tools after disconnect', async () => {
  const c = client(); const listed = deferred<any>();
  const manager = new McpManager(); const registry = new ToolRegistry();
  await manager.connectSpec(spec, registry, governor);
  c.listTools.mockImplementation(() => listed.promise);
  const refresh = changed(c)(); await tick();
  await manager.disconnect(spec.name, registry);
  listed.resolve(tools('late')); await refresh;
  expect(registry.getToolNames()).toEqual([]);
});

test('catalog notifications coalesce to one active read and one follow-up read', async () => {
  const c = client(); const listed = deferred<any>();
  const manager = new McpManager(); const registry = new ToolRegistry();
  await manager.connectSpec(spec, registry, governor);
  c.listTools.mockImplementationOnce(() => listed.promise).mockResolvedValue(tools('latest'));
  const first = changed(c)(); await tick();
  const burst = Array.from({ length: 100 }, () => changed(c)()); await tick();
  const callsDuringRead = c.listTools.mock.calls.length;
  listed.resolve(tools('outdated'));
  await Promise.all([first, ...burst]);
  try {
    expect(callsDuringRead).toBe(2); // initial catalog + one active refresh
    expect(c.listTools).toHaveBeenCalledTimes(3);
    expect(registry.getToolNames()).toEqual(['mcp__owned__latest']);
  } finally { await manager.disconnect(spec.name, registry); }
});

test('retiring an old connection cannot erase a newer registration with the same name', async () => {
  const old = client(); const listed = deferred<any>();
  const manager = new McpManager(); const registry = new ToolRegistry();
  await manager.connectSpec(spec, registry, governor);
  old.listTools.mockImplementation(() => listed.promise);
  const refresh = changed(old)(); await tick();
  const fresh = client(); await manager.connectSpec(spec, registry, governor);
  const current = registry.getTool('mcp__owned__echo');
  listed.resolve(tools('zombie')); await refresh;
  try {
    expect(registry.getToolNames()).toEqual(['mcp__owned__echo']);
    expect(registry.getTool('mcp__owned__echo')).toBe(current);
    expect(await current!.execute({}, {})).toBe('echo');
    expect(fresh.callTool).toHaveBeenCalledTimes(1);
  } finally { await manager.disconnect(spec.name, registry); }
});

test('a real tool named read_resource is removed normally when it leaves the catalog', async () => {
  const c = client('read_resource'); const registry = new ToolRegistry();
  const conn = await connectAndRegister(spec, registry, governor);
  c.listTools.mockResolvedValue(tools()); await changed(c)();
  expect(conn!.toolNames).toEqual([]);
  expect(registry.getToolNames()).toEqual([]);
  await c.close();
});

test('a resource-only server connects without an unsupported tools/list request', async () => {
  const c = client('unused', { resources: {} });
  c.listTools.mockRejectedValue(new Error('Method not found'));
  const registry = new ToolRegistry();
  const conn = await connectAndRegister(spec, registry, governor);
  try {
    expect(conn).not.toBeNull();
    expect(c.listTools).not.toHaveBeenCalled();
    expect(registry.getToolNames()).toEqual(['mcp__owned__list_resources', 'mcp__owned__read_resource']);
  } finally { await c.close(); }
});

test('Stop aborts resource reads and reaches the SDK request', async () => {
  jest.useFakeTimers();
  const c = client('echo', { tools: {}, resources: {} });
  c.readResource.mockImplementation(() => new Promise(() => {}));
  const registry = new ToolRegistry(); await connectAndRegister(spec, registry, governor);
  const controller = new AbortController();
  let state = 'pending';
  const result = registry.getTool('mcp__owned__read_resource')!.execute({ uri: 'memo://one' }, { signal: controller.signal })
    .then(() => { state = 'success'; }, () => { state = 'stopped'; });
  await tick(); controller.abort(new Error('stopped')); await tick();
  try {
    expect(state).toBe('stopped');
    expect((c.readResource.mock.calls[0] as any)[1].signal.aborted).toBe(true);
  } finally { await jest.advanceTimersByTimeAsync(120000); await result; await c.close(); }
});

test('resource listing and optional templates share one total deadline', async () => {
  jest.useFakeTimers();
  const previous = process.env.BIMAX_MCP_CALL_TIMEOUT_MS; process.env.BIMAX_MCP_CALL_TIMEOUT_MS = '1000';
  const c = client('echo', { tools: {}, resources: {} });
  c.listResources.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ resources: [] }), 500)));
  c.listResourceTemplates.mockImplementation(() => new Promise(() => {}));
  const registry = new ToolRegistry(); await connectAndRegister(spec, registry, governor);
  let state = 'pending';
  const result = registry.getTool('mcp__owned__list_resources')!.execute({}, {})
    .then(() => { state = 'success'; }, () => { state = 'timed-out'; });
  await tick(); await jest.advanceTimersByTimeAsync(1000);
  try { expect(state).toBe('timed-out'); }
  finally {
    await jest.advanceTimersByTimeAsync(10000); await result; await c.close();
    if (previous === undefined) delete process.env.BIMAX_MCP_CALL_TIMEOUT_MS;
    else process.env.BIMAX_MCP_CALL_TIMEOUT_MS = previous;
  }
});

test('cancelling a remote handshake closes it and never starts an SSE fallback', async () => {
  const c = client(); c.connect.mockImplementation(() => new Promise(() => {}));
  const fallback = client('fallback');
  const controller = new AbortController();
  const pending = openClient({ name: 'remote', url: 'http://127.0.0.1:9/mcp' }, { signal: controller.signal });
  const result = expect(pending).rejects.toThrow('cancelled handshake');
  await tick(); controller.abort(new Error('cancelled handshake')); await result;
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(fallback.connect).not.toHaveBeenCalled();
});

test('initial catalog discovery has a bounded cancellable deadline', async () => {
  jest.useFakeTimers();
  const previous = process.env.BIMAX_MCP_CONNECT_TIMEOUT_MS; process.env.BIMAX_MCP_CONNECT_TIMEOUT_MS = '1000';
  const c = client(); c.listTools.mockImplementation(() => new Promise(() => {}));
  const registry = new ToolRegistry(); const manager = new McpManager();
  const pending = manager.connectSpec(spec, registry, governor);
  await tick(); await jest.advanceTimersByTimeAsync(1000);
  try {
    expect(await pending).toBeNull();
    expect(manager.getPendingServers()).toEqual([]);
    expect(registry.getToolNames()).toEqual([]);
    expect(c.close).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env.BIMAX_MCP_CONNECT_TIMEOUT_MS;
    else process.env.BIMAX_MCP_CONNECT_TIMEOUT_MS = previous;
  }
});

test('a notification during initial catalog discovery triggers a fresh follow-up', async () => {
  const c = client(); const first = deferred<any>();
  c.listTools.mockImplementationOnce(() => first.promise).mockResolvedValue(tools('current'));
  const registry = new ToolRegistry(); const manager = new McpManager();
  const pending = manager.connectSpec(spec, registry, governor); await tick();
  await changed(c)(); first.resolve(tools('old')); await pending; await tick();
  try {
    expect(registry.getToolNames()).toEqual(['mcp__owned__current']);
    expect(c.listTools).toHaveBeenCalledTimes(2);
  } finally { await manager.disconnect(spec.name, registry); }
});

test('a rejected catalog preserves the exact prior tools and a later refresh recovers', async () => {
  const c = client(); const registry = new ToolRegistry(); const manager = new McpManager();
  await manager.connectSpec(spec, registry, governor);
  const prior = registry.getTool('mcp__owned__echo');
  c.listTools.mockResolvedValue(tools('duplicate', 'duplicate')); await changed(c)();
  try {
    expect(registry.getToolNames()).toEqual(['mcp__owned__echo']);
    expect(registry.getTool('mcp__owned__echo')).toBe(prior);
    c.listTools.mockResolvedValue(tools('recovered')); await changed(c)();
    expect(registry.getToolNames()).toEqual(['mcp__owned__recovered']);
  } finally { await manager.disconnect(spec.name, registry); }
});

test('disconnect removes only tool objects owned by that connection', async () => {
  client(); const registry = new ToolRegistry(); const manager = new McpManager();
  await manager.connectSpec(spec, registry, governor);
  const replacement = { ...registry.getTool('mcp__owned__echo')!, execute: async () => 'separate owner' };
  registry.register(replacement);
  await manager.disconnect(spec.name, registry);
  expect(registry.getTool('mcp__owned__echo')).toBe(replacement);
  expect(await replacement.execute()).toBe('separate owner');
});

test('simultaneous read-only failures share one reconnect and both use its fresh client', async () => {
  const old = client(); old.callTool.mockRejectedValue(new Error('Connection closed'));
  const registry = new ToolRegistry(); const manager = new McpManager();
  await manager.connectSpec(spec, registry, governor);
  const fresh = client('fresh'); const ready = deferred(); fresh.connect.mockImplementation(() => ready.promise);
  const tool = registry.getTool('mcp__owned__echo')!;
  const a = tool.execute({}, {}); const b = tool.execute({}, {}); await tick();
  ready.resolve();
  try {
    expect(await Promise.all([a, b])).toEqual(['fresh', 'fresh']);
    expect(fresh.connect).toHaveBeenCalledTimes(1);
    expect(fresh.callTool).toHaveBeenCalledTimes(2);
    expect(old.close).toHaveBeenCalledTimes(1);
  } finally { await manager.disconnect(spec.name, registry); }
});

test('a stale health failure cannot mark the replacement connection unhealthy', async () => {
  const old = client(); const probe = deferred<any>(); old.ping.mockImplementation(() => probe.promise);
  const registry = new ToolRegistry(); const manager = new McpManager();
  await manager.connectSpec(spec, registry, governor);
  const diagnostic = manager.diagnose('/tmp/bimax-owned-health-no-config'); await tick();
  client('fresh'); await manager.connectSpec(spec, registry, governor);
  probe.reject(new Error('old server is dead')); await diagnostic;
  try {
    expect(manager.lastErrorFor(spec.name)).toBeNull();
    expect(manager.health('/tmp/bimax-owned-health-no-config')[0].state).toBe('connected');
  } finally { await manager.disconnect(spec.name, registry); }
});

test('a stopped watchdog sweep stays retired after the watchdog is started again', async () => {
  jest.useFakeTimers();
  const c = client(); const probe = deferred<any>(); c.ping.mockImplementation(() => probe.promise);
  const registry = new ToolRegistry(); const manager = new McpManager();
  await manager.connectSpec(spec, registry, governor);
  const unwanted = client('unwanted');
  manager.startWatchdog(registry, governor, 100);
  await jest.advanceTimersByTimeAsync(100);
  manager.stopWatchdog(); manager.startWatchdog(registry, governor, 1000);
  probe.reject(new Error('old probe failed')); await tick();
  try {
    expect(unwanted.connect).not.toHaveBeenCalled();
    expect(manager.lastErrorFor(spec.name)).toBeNull();
  } finally { manager.stopWatchdog(); await manager.disconnect(spec.name, registry); }
});
