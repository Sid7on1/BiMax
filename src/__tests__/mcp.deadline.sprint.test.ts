import { awaitTaskResult } from '../mcp/tasks';

describe('MCP task cancellation and whole-call deadline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test.each(['tasks/get', 'tasks/result'])('bounds a hung %s request', async method => {
    const client = { request: jest.fn(() => new Promise(() => {})) };
    const status = method === 'tasks/result' ? 'completed' : 'working';
    const result = awaitTaskResult(client, 'fixture', 'build', { taskId: 'job', status }, 1000);
    const rejected = expect(result).rejects.toThrow(/did not finish within/);
    await jest.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(client.request.mock.calls).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('does not start a new poll when its wait exhausts the deadline', async () => {
    const client = { request: jest.fn(async () => ({ status: 'working' })) };
    const result = awaitTaskResult(client, 'fixture', 'build', { taskId: 'job' }, 100);
    const rejected = expect(result).rejects.toThrow(/did not finish within/);
    await jest.advanceTimersByTimeAsync(100);
    await rejected;
    expect(client.request).not.toHaveBeenCalled();
  });

  test('Stop during backoff settles immediately and cancels server work once', async () => {
    const controller = new AbortController();
    const client = { request: jest.fn(async (_request: any) => ({})) };
    const result = (awaitTaskResult as any)(client, 'fixture', 'build', { taskId: 'job' }, 60_000, controller.signal);
    const rejected = expect(result).rejects.toThrow(/stopped/);
    controller.abort(new Error('stopped'));
    await jest.advanceTimersByTimeAsync(0);
    await rejected;
    expect(client.request.mock.calls.map(call => (call[0] as any).method)).toEqual(['tasks/cancel']);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a completed result arriving after Stop cannot turn cancellation into success', async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    const client = { request: jest.fn((request: any) => request.method === 'tasks/result'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({})) };
    const result = (awaitTaskResult as any)(client, 'fixture', 'build', { taskId: 'job', status: 'completed' }, 60_000, controller.signal);
    const rejected = expect(result).rejects.toThrow(/stopped/);
    await jest.advanceTimersByTimeAsync(0);
    controller.abort(new Error('stopped'));
    finish({ content: [{ type: 'text', text: 'too late' }] });
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
  });
});
