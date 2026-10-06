import { buildEngineChildEnv } from '../main/coding.runtime.paths';
import { ThreadManager } from '../main/thread.manager';

test('parent and explicitly supplied retired settings cannot reach an engine', () => {
  const keys = ['BIMAX_COMPUTER_LOOK', 'BIMAX_COMPUTER_USE', 'BIMAX_COMPUTER_PRESS',
    'BIMAX_COMPUTER_PIP', 'BIMAX_COMPUTER_VISIBLE', 'BIMAX_COMPUTER_RECORD', 'BIMAX_COMPUTER_APPROVALS'];
  const old = Object.fromEntries(keys.map(k => [k, '1']));
  const env = buildEngineChildEnv({ parentEnv: old, extraEnv: old, path: '/usr/bin', projectDir: '/project' });
  keys.forEach(k => expect(env[k]).toBeUndefined());
  expect(env.BIMAX_CWD).toBe('/project');
  expect(env.BIMAX_HEADLESS).toBe('1');
});

test('the app denies an old engine host request without showing an approval or changing its chat', () => {
  const engine = { sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() };
  const approval = jest.fn();
  const manager = new ThreadManager({ engine: () => engine, save: jest.fn(), changed: jest.fn(), message: jest.fn(),
    selected: jest.fn(), approval });
  const id = manager.create('/project', 'coding question');
  manager.receive(id, { t: 'ready', protocol: 3 });
  engine.sendFromRenderer.mockClear();
  for (const capability of ['look', 'press', 'type', 'scroll'] as const) {
    manager.receive(id, { t: 'host_call', id: 71, capability, op: 'old_operation', args: {} });
    expect(engine.sendFromRenderer).toHaveBeenLastCalledWith({ t: 'host_result', id: 71, ok: false,
      error: 'Computer Use has been removed from Bimax.', value: { code: 'unavailable' } });
  }
  expect(approval).not.toHaveBeenCalled();
  manager.dispose();
});
