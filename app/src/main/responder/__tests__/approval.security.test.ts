import { ApprovalHook } from '../approval-hook';
import { RealEngineAdapter, type ThreadManagerLike } from '../adapter';
import type { ThreadApproval } from '../../../shared/threads';

test('F04 independent engine request 1 cards route by immutable card capability, including restart', async () => {
  const hook = new ApprovalHook(),
    sent: Array<{ id: string; msg: unknown }> = [],
    requests: string[] = [];
  const threads = {
    activeId: 'A',
    list: () => [],
    submit: () => {},
    send: (id: string, msg: unknown) => sent.push({ id, msg }),
  } as unknown as ThreadManagerLike;
  const adapter = new RealEngineAdapter(threads, hook);
  adapter.onApprovalRequest((request) => requests.push(request.approvalId));
  await adapter.sendInstruction({ idempotencyKey: 'one', instruction: 'fixture' });
  threads.activeId = 'B';
  await adapter.sendInstruction({ idempotencyKey: 'two', instruction: 'fixture' });
  const card = (threadId: string, token: string): ThreadApproval => ({
    threadId,
    token,
    title: threadId,
    root: '/tmp',
    request: { t: 'request', id: 1, kind: 'prompt', question: threadId, options: ['Yes', 'No'] },
  });
  const a = card('A', 'generation-A'),
    b = card('B', 'generation-B');
  adapter.handleThreadApproval(a);
  adapter.handleThreadApproval(b);
  adapter.handleThreadApproval(a);
  expect(requests).toEqual(['generation-A', 'generation-B']);
  a.token = 'mutated';
  a.request.id = 99;
  adapter.resolveApproval(requests[0], 'approved');
  adapter.resolveApproval(requests[1], 'denied');
  await new Promise((resolve) => setImmediate(resolve));
  expect(sent).toEqual([
    { id: 'A', msg: { t: 'reply', id: 1, value: 'Yes', approvalToken: 'generation-A' } },
    { id: 'B', msg: { t: 'reply', id: 1, value: 'No', approvalToken: 'generation-B' } },
  ]);
  adapter.handleThreadApproval(card('B', 'restarted-B'));
  adapter.resolveApproval('generation-B', 'approved');
  expect(hook.isPending('restarted-B')).toBe(true);
  adapter.resolveApproval('restarted-B', 'denied');
  await new Promise((resolve) => setImmediate(resolve));
});
test('F04 duplicate pending capability cannot replace its owner; args are snapshotted', async () => {
  const hook = new ApprovalHook(),
    execute = jest.fn(async (args: unknown) => args),
    args = { value: 'approved' };
  const first = hook.intercept({
    approvalId: 'unique',
    sessionId: 'A',
    tool: 'fixture',
    args,
    summary: 'one',
    detail: 'one',
    execute,
  });
  await expect(
    hook.intercept({
      approvalId: 'unique',
      sessionId: 'B',
      tool: 'fixture',
      args: {},
      summary: 'two',
      detail: 'two',
      execute,
    }),
  ).rejects.toThrow('Duplicate');
  args.value = 'changed';
  hook.resolveApproval('unique', 'approved');
  expect(await first).toEqual({ value: 'approved' });
  expect(execute).toHaveBeenCalledTimes(1);
});
test('F04 Stop after approval delivery but before execution microtask still denies', async () => {
  const hook = new ApprovalHook(),
    execute = jest.fn(async () => true);
  const call = hook.intercept({
    approvalId: 'unique',
    sessionId: 'A',
    tool: 'fixture',
    args: {},
    summary: 'one',
    detail: 'one',
    execute,
    onDeny: () => false,
  });
  hook.resolveApproval('unique', 'approved');
  hook.abortSession('A');
  expect(await call).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});
test('F04 an expired decision cannot execute merely because its timer has not fired', async () => {
  jest.useFakeTimers();
  try {
    const hook = new ApprovalHook(),
      execute = jest.fn(async () => true);
    const call = hook.intercept({
      approvalId: 'unique',
      sessionId: 'A',
      tool: 'fixture',
      args: {},
      summary: 'one',
      detail: 'one',
      execute,
      onDeny: () => false,
      expiresAt: Date.now() + 100,
    });
    jest.setSystemTime(Date.now() + 101);
    hook.resolveApproval('unique', 'approved');
    expect(await call).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
