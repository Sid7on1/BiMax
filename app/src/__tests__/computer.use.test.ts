import { existsSync, readFileSync, statSync } from 'node:fs';
import { screenshotFromToolResult, buildScreenshotObservation } from '../../../src/core/multimodal';
import { checkToolArgs } from '../../../src/tools/args.validate';
import { ComputerUseService } from '../main/computer.use';

const tools = ['status', 'apps', 'windows', 'observe', 'act', 'settle', 'wait', 'commands', 'run_command', 'release', 'screenshot', 'click_at', 'drag', 'scroll_at', 'press', 'type_text'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {}, required: [] } }));
function fixture() {
  let active = true, now = 1000, closed = 0, inputs = 0, app = { pid: 42, name: 'Test Fixture', bundle_id: 'org.arc.proof.fixture' };
  let elements: any[] = [{ id: 'field', role: 'AXTextField', name: 'Message', actions: ['SET_VALUE'] }];
  const requests: any[] = [];
  const approve = jest.fn(async () => true);
  const driver = { close: () => { closed++; }, request: jest.fn(async (_method: string, params: any) => {
    const name = _method;
    requests.push({ name, arguments: params });
    let data: any = {};
    if (name === 'apps') data = { apps: [app] };
    if (name === 'observe' || name === 'settle') data = { snapshot: 's1', pid: 42, window_id: 5, elements: structuredClone(elements) };
    if (name === 'commands') data = { commands: [{ path: 'File > Save' }] };
    if (['act', 'press', 'type_text', 'run_command'].includes(name)) { inputs++; data = { status: 'done' }; }
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  }) };
  const service = new ComputerUseService({ runtime: '/bundled/arc', tools, active: () => active, accessibility: () => true, approve, driver: () => driver, identify: async () => ({ path: '/fixture/app', sha256: 'fixture' }), now: () => now });
  const call = async (name: string, args: any = {}, id = 'a', signal = new AbortController().signal) => await service.perform(id, name, args, signal);
  const observe = async (id = 'a') => (await call('observe', { pid: 42 }, id)).structuredContent.snapshot;
  return { service, call, observe, approve, requests, driver, inputs: () => inputs, closed: () => closed,
    stop: () => { active = false; service.end('a'); }, time: (value: number) => { now = value; }, app: (value: typeof app) => { app = value; }, elements: (value: any[]) => { elements = value; } };
}

test('tool discovery does not spawn a native helper or request permission', async () => {
  const f = fixture();
  const binding = f.service.binding('a');
  expect(binding.tools.map(t => t.name)).toEqual(['BimaxCuTool']);
  expect(f.driver.request).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled();
  await expect(f.service.perform('a', 'tools/list', {}, new AbortController().signal)).rejects.toThrow(/Unknown/);
});
test('approved observed action reaches the driver once and consumes the observation', async () => {
  const f = fixture(), snapshot = await f.observe();
  await f.call('act', { snapshot, action: 'SET_VALUE', element: 'field', value: 'hello' });
  expect(f.inputs()).toBe(1); expect(f.approve).toHaveBeenCalledTimes(2);
  expect(f.requests.find(r => r.name === 'act').arguments).toMatchObject({ snapshot: 's1', settle: true });
  await expect(f.call('act', { snapshot, action: 'SET_VALUE', element: 'field' })).rejects.toThrow(/expired/);
  expect(f.inputs()).toBe(1);
});
test('app read denial reaches no observation or input', async () => {
  const f = fixture(); f.approve.mockResolvedValue(false);
  await expect(f.observe()).rejects.toThrow(/denied/);
  expect(f.requests.map(r => r.name)).toEqual(['apps']); expect(f.inputs()).toBe(0);
});
test('input denial reaches no input', async () => {
  const f = fixture(), snapshot = await f.observe(); f.approve.mockResolvedValue(false);
  await expect(f.call('act', { snapshot, action: 'SET_VALUE', element: 'field' })).rejects.toThrow(/denied/);
  expect(f.inputs()).toBe(0);
});
test('Stop while the approval is open prevents native dispatch after approval', async () => {
  const f = fixture(), snapshot = await f.observe();
  let allow!: (v: boolean) => void; f.approve.mockImplementation(() => new Promise(resolve => { allow = resolve; }));
  const action = f.call('act', { snapshot, action: 'SET_VALUE', element: 'field' });
  while (!allow) await new Promise(resolve => setImmediate(resolve));
  f.stop(); allow(true);
  await expect(action).rejects.toThrow(/expired/); expect(f.inputs()).toBe(0); expect(f.closed()).toBe(1);
});
test('transport cancellation revokes the session and denies pending approval', async () => {
  const f = fixture(), snapshot = await f.observe(), cancel = new AbortController();
  let allow!: (v: boolean) => void; f.approve.mockImplementation(() => new Promise(resolve => { allow = resolve; }));
  const action = f.call('act', { snapshot, action: 'SET_VALUE', element: 'field' }, 'a', cancel.signal);
  while (!allow) await new Promise(resolve => setImmediate(resolve));
  cancel.abort(); allow(true);
  await expect(action).rejects.toThrow(/expired/); expect(f.inputs()).toBe(0); expect(f.closed()).toBe(1);
});
test('another Bimax Thread cannot spend a snapshot even if native IDs collide', async () => {
  const f = fixture(), snapshot = await f.observe(); await f.observe('b');
  await expect(f.call('act', { snapshot, action: 'SET_VALUE', element: 'field' }, 'b')).rejects.toThrow(/another/);
  expect(f.inputs()).toBe(0);
});
test.each([{ pid: 43 }, { window_id: 6 }])('raw input cannot change the bound target %j', async extra => {
  const f = fixture(), snapshot = await f.observe();
  await expect(f.call('press', { snapshot, pid: 42, keys: 'ENTER', ...extra })).rejects.toThrow(/differs/); expect(f.inputs()).toBe(0);
});
test('invented elements never reach the driver', async () => {
  const f = fixture(), snapshot = await f.observe();
  await expect(f.call('act', { snapshot, action: 'SET_VALUE', element: 'fake' })).rejects.toThrow(/not in/); expect(f.inputs()).toBe(0);
});
test('delayed input approval requires a new observation', async () => {
  const f = fixture(), snapshot = await f.observe(); f.approve.mockImplementation(async () => { f.time(32000); return true; });
  await expect(f.call('act', { snapshot, action: 'SET_VALUE', element: 'field' })).rejects.toThrow(/expired/); expect(f.inputs()).toBe(0);
});
test('PID reuse during approval cannot inherit a grant', async () => {
  const f = fixture(); f.approve.mockImplementation(async () => { f.app({ pid: 42, name: 'Other', bundle_id: 'other.app' }); return true; });
  await expect(f.observe()).rejects.toThrow(/changed/); expect(f.inputs()).toBe(0);
});
test('protected apps are refused before permission request', async () => {
  const f = fixture(); f.app({ pid: 42, name: 'Passwords', bundle_id: 'com.apple.Passwords' });
  await expect(f.observe()).rejects.toThrow(/protected/); expect(f.approve).not.toHaveBeenCalled();
});
test('password values are not returned and that form cannot receive input or screenshots', async () => {
  const f = fixture(); f.elements([{ id: 'secret', role: 'AXSecureTextField', name: 'Password', value: 'secret-value', actions: ['SET_VALUE'] }]);
  const result = await f.call('observe', { pid: 42, screenshot: false });
  expect(JSON.stringify(result)).not.toContain('secret-value');
  expect(f.requests.find(r => r.name === 'observe').arguments.screenshot).toBe(false);
  await expect(f.call('press', { pid: 42, keys: 'ENTER', snapshot: result.structuredContent.snapshot })).rejects.toThrow(/password/);
  await expect(f.call('screenshot', { pid: 42, snapshot: result.structuredContent.snapshot })).rejects.toThrow(/password/);
  expect(f.inputs()).toBe(0);
});
test('menu input must name an observed command and strips the host snapshot from native arguments', async () => {
  const f = fixture(), snapshot = await f.observe();
  await expect(f.call('run_command', { pid: 42, snapshot, path: 'File > Delete' })).rejects.toThrow(/List commands/);
  await f.call('commands', { pid: 42 });
  await f.call('run_command', { pid: 42, snapshot, path: 'File > Save' });
  expect(f.inputs()).toBe(1); expect(f.requests.find(r => r.name === 'run_command').arguments.snapshot).toBeUndefined();
});
test('a failed native input is never automatically repeated', async () => {
  const f = fixture(), snapshot = await f.observe(), original = f.driver.request.getMockImplementation()!;
  f.driver.request.mockImplementation(async (method, params) => { if (method === 'act') throw new Error('Connection lost after input'); return original(method, params); });
  await expect(f.call('act', { snapshot, action: 'SET_VALUE', element: 'field' })).rejects.toThrow(/Connection lost/);
  expect(f.driver.request.mock.calls.filter(c => c[0] === 'act')).toHaveLength(1);
  await expect(f.call('act', { snapshot, action: 'SET_VALUE', element: 'field' })).rejects.toThrow(/expired|another/);
});


test('arc screenshots enter the existing vision pipeline and their private files end with the turn', async () => {
  const f = fixture(), snapshot = await f.observe(), original = f.driver.request.getMockImplementation()!;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=';
  f.driver.request.mockImplementation(async (method, params) => method === 'screenshot'
    ? { structuredContent: { screenshot: { width: 1, height: 1, scale: 1, window_id: 5 } }, content: [{ type: 'image', mimeType: 'image/png', data: png }] } as any
    : original(method, params));
  const result = await f.call('screenshot', { pid: 42, snapshot });
  const file = screenshotFromToolResult('BimaxCuTool', JSON.stringify(result.structuredContent))!;
  expect(file).toBeTruthy(); expect(readFileSync(file).toString('base64')).toBe(png);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(buildScreenshotObservation(file)?.content.some(p => p.type === 'image_url')).toBe(true);
  expect(result.content.some((c: any) => c.type === 'image')).toBe(false);
  f.service.end('a'); expect(existsSync(file)).toBe(false);
});


test('strict models may send null for optional arguments without blocking a real observation', async () => {
  const f = fixture();
  // Use the actual upstream schema, not the abbreviated behavioral fixture schemas.
  const service = new ComputerUseService({ runtime: '/bundled/arc', tools: [{ name: 'observe', description: 'Read', inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, window_id: { type: 'integer' }, query: { type: 'string' } }, required: ['pid'] } }], active: () => true, accessibility: () => true, approve: f.approve, driver: () => f.driver });
  const args = { pid: 42, window_id: null, query: null };
  expect(checkToolArgs(service.tools[0].inputSchema, args).violations).toEqual([]);
  const reply = await service.perform('a', 'observe', args, new AbortController().signal);
  expect(reply.structuredContent.elements).toHaveLength(1);
  expect(f.requests.find(r => r.name === 'observe').arguments).toEqual({ pid: 42, screenshot: false });
  expect(checkToolArgs(service.tools[0].inputSchema, { ...args, pid: null }).violations.length).toBeGreaterThan(0);
  service.close();
});


test('status reports the actual Mac host permission and cannot confuse the helper grant with Bimax authority', async () => {
  const permission = jest.fn(() => false);
  const driver = { close: jest.fn(), request: jest.fn(async () => ({ structuredContent: { permissions: { accessibility: true, screen_recording: true } }, content: [] })) };
  const service = new ComputerUseService({ runtime: '/bundled/arc', tools, active: () => true, accessibility: permission, approve: jest.fn(), driver: () => driver });
  const reply = await service.perform('a', 'status', {}, new AbortController().signal);
  expect(reply.structuredContent.permissions).toMatchObject({ accessibility: false, host_accessibility: false, driver_accessibility: true });
  expect(permission).toHaveBeenCalledWith(false); service.close();
});


test('observe does not advertise or silently accept a screenshot before its form has been inspected', async () => {
  const f = fixture();
  const service = new ComputerUseService({ runtime: '/bundled/arc', tools: [{ name: 'observe', description: 'Read', inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, screenshot: { type: 'boolean' } }, required: ['pid'] } }], active: () => true, accessibility: () => true, approve: f.approve, driver: () => f.driver });
  expect(checkToolArgs(service.tools[0].inputSchema, { pid: 42, screenshot: true }).violations.length).toBeGreaterThan(0);
  await expect(service.perform('a', 'observe', {pid:42,screenshot:true}, new AbortController().signal)).rejects.toThrow(/First observe|invalid value/);
  expect(f.driver.request).not.toHaveBeenCalled(); service.close();
});
