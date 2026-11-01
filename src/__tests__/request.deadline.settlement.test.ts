import { withRequestDeadline } from '../utils/request.deadline';

beforeEach(() => { jest.useFakeTimers({ now: 0 }); });
afterEach(() => { jest.useRealTimers(); });
const timeout = new Error('owned deadline exceeded');

test.each(['resolve', 'reject'])('an expired operation cannot %s before the delayed deadline callback', async mode => {
  const sdkError = new Error('SDK request timed out');
  const run = withRequestDeadline(1000, undefined, () => timeout, async () => {
    // Moving wall time alone leaves the timer callback queued: model an event-loop stall.
    jest.setSystemTime(1001);
    if (mode === 'reject') throw sdkError;
    return 'late result';
  });
  await expect(run).rejects.toBe(timeout);
  expect(jest.getTimerCount()).toBe(0);
});

test('an early server error keeps its identity and releases the deadline timer', async () => {
  const serverError = new Error('owned server failure');
  await expect(withRequestDeadline(1000, undefined, () => timeout, async () => {
    jest.setSystemTime(50); throw serverError;
  })).rejects.toBe(serverError);
  expect(jest.getTimerCount()).toBe(0);
});

test('Stop keeps its reason even if wall time also expires', async () => {
  const parent = new AbortController(), reason = new Error('owned Stop');
  await expect(withRequestDeadline(1000, parent.signal, () => timeout, async () => {
    parent.abort(reason); jest.setSystemTime(1001); throw new Error('late SDK error');
  })).rejects.toBe(reason);
  expect(jest.getTimerCount()).toBe(0);
});
