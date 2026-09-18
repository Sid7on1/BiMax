import { threadCapabilityEnvironment, threadIndexEnvironment } from '../main/thread.manager';
import { availableBytes, planCapabilities } from '../main/supervisor/resources';

/**
 * A ⌘2 task dropped on a folder must not index that folder or boot drives to do its job. A project
 * thread is the opposite: the repo was opened to be worked in, and indexing it is the point.
 *
 * Both used to get the ⌘2 answer, because the override lived at the spawn site and applied to every
 * thread — and `createSupervisor` is only ever called with a thread id, so that was every engine in
 * the product. These tests pin the DISTINCTION rather than the values, so the split cannot collapse
 * back to one answer without a failure here.
 */
describe('optional engine subsystems follow the thread origin', () => {
  test('a ⌘2 quick task keeps codebase memory, indexing and drives off', () => {
    const env = threadCapabilityEnvironment('quick');
    expect(env.BIMAX_AUTO_INDEX).toBe('0');
    expect(env.BIMAX_DISABLE_CODEMEM).toBe('1');
    expect(env.BIMAX_DISABLE_CODEBASE_MEMORY).toBe('1');
    expect(env.BIMAX_DRIVES_BOOT).toBe('0');
  });

  test('a project thread overrides none of the gates, leaving the memory profile to decide', () => {
    const env = threadCapabilityEnvironment('project');
    // Asserted as ABSENCE of each gate rather than an empty object: the function also carries an
    // origin marker for the log, and pinning the exact shape would make that a breaking change.
    for (const gate of ['BIMAX_AUTO_INDEX', 'BIMAX_DISABLE_CODEMEM', 'BIMAX_DISABLE_CODEBASE_MEMORY', 'BIMAX_DRIVES_BOOT']) {
      expect(env[gate]).toBeUndefined();
    }
  });

  test('both origins are identifiable in the spawn env, so the log can say which it is', () => {
    expect(threadCapabilityEnvironment('project').BIMAX_THREAD_ORIGIN).toBe('project');
    expect(threadCapabilityEnvironment('quick').BIMAX_THREAD_ORIGIN).toBe('quick');
  });

  test('the two origins genuinely differ — a single shared answer is the bug this guards', () => {
    expect(threadCapabilityEnvironment('project')).not.toEqual(threadCapabilityEnvironment('quick'));
  });

  test('declining to override is not the same as forcing on: a starved machine still sheds', () => {
    // What a project thread contributes, merged over a plan built for a machine with no headroom.
    const starved = planCapabilities({ freeBytes: 200 * 1024 * 1024, totalBytes: 8 * 1024 ** 3 }, {});
    const merged = { ...starved.env, ...threadCapabilityEnvironment('project') };
    expect(starved.profile).toBe('minimal');
    expect(merged.BIMAX_AUTO_INDEX).toBe('0');       // the ladder's answer survives the merge
    expect(merged.BIMAX_DRIVES_BOOT).toBe('0');
  });

  test('on a machine with real headroom a project thread gets the subsystems', () => {
    const roomy = planCapabilities(
      { freeBytes: availableBytes({ total: 8_388_608, free: 188_448, fileBacked: 1_835_328, purgeable: 10_704 }), totalBytes: 8 * 1024 ** 3 },
      {},
    );
    const merged = { ...roomy.env, ...threadCapabilityEnvironment('project') };
    expect(roomy.profile).toBe('full');
    expect(merged.BIMAX_AUTO_INDEX).not.toBe('0');
    expect(merged.BIMAX_DRIVES_BOOT).not.toBe('0');
  });

  test('the code index keeps its own origin split, unchanged', () => {
    expect(threadIndexEnvironment('project')).toEqual({});
    expect(threadIndexEnvironment('quick')).toEqual({ BIMAX_CODE_INDEX: '0' });
  });
});
