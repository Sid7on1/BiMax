import { classifyAxReadiness } from '../ax.readiness';

describe('AX readiness classification', () => {
  it('does not turn a cold sparse sample into a permanent app capability', () => {
    const cold = classifyAxReadiness({ targetableCount: 0, namedTargetableCount: 0, editableCount: 0 }, undefined, 0);
    expect(cold.state).toBe('warming');
    const ready = classifyAxReadiness(
      { targetableCount: 1400, namedTargetableCount: 800, editableCount: 1 },
      { targetableCount: 0, namedTargetableCount: 0, sparseSamples: 1 },
      1,
    );
    expect(ready.state).toBe('ready');
    expect(ready.reason).toContain('ready now');
  });

  it('classifies a hidden app as background-restricted, not AX-poor', () => {
    const state = classifyAxReadiness(
      { targetableCount: 0, namedTargetableCount: 0, editableCount: 0, backgroundBlockedBy: 'Claude' },
      undefined,
      0,
    );
    expect(state.state).toBe('background_restricted');
    expect(state.reason).toContain('not a permanent');
  });
});

