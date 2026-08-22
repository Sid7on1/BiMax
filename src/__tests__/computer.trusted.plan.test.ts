import {
  getActiveTrustedComputerPlan,
  normalizeTrustedInstruction,
  runWithTrustedComputerPlan,
  signTrustedComputerPlan,
} from '../mind/computer.trusted.plan';

describe('engine-owned trusted Computer Use plan', () => {
  const previous = process.env.BIMAX_CU_TRUSTED_PLAN_SECRET;
  beforeAll(() => { process.env.BIMAX_CU_TRUSTED_PLAN_SECRET = 'engine-plan-test'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.BIMAX_CU_TRUSTED_PLAN_SECRET;
    else process.env.BIMAX_CU_TRUSTED_PLAN_SECRET = previous;
  });

  test('binds only actions expressed before observations arrive', () => {
    const envelope = signTrustedComputerPlan(
      'Open Fixture and click Continue, then type hello',
      'engine-plan-test', 1_000, 'task-one',
    )!;
    expect(envelope.plan.allowedActions).toEqual(expect.arrayContaining(['open', 'click', 'type']));
    expect(envelope.plan.allowedActions).not.toContain('close');
    expect(envelope.signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('strips bidi controls without rejecting benign text', () => {
    expect(normalizeTrustedInstruction('\u202aClick Send\u202c')).toBe('click send');
  });

  test('isolates the authenticated plan to the async Computer Use turn', async () => {
    expect(getActiveTrustedComputerPlan()).toBeUndefined();
    await runWithTrustedComputerPlan('open Fixture', async () => {
      expect(getActiveTrustedComputerPlan()?.plan.normalizedInstruction).toBe('open fixture');
      await Promise.resolve();
      expect(getActiveTrustedComputerPlan()?.plan.taskId).toBeTruthy();
    });
    expect(getActiveTrustedComputerPlan()).toBeUndefined();
  });
});
