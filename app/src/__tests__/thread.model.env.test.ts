import { buildEngineChildEnv } from '../main/runtime.paths';

/**
 * A task's own model (the ⌘2 model menu, "Retry with…") reaches its engine as the engine's volatile overrides,
 * which are never written back to the user's configuration. A model pinned in the parent shell still does not.
 */
test('a thread model becomes the engine overrides; an inherited shell pin is still cleared', () => {
  const base = { parentEnv: { BGW_MODEL: 'stale/shell-pin', BGW_LITE_MODEL: 'stale/lite' }, path: '/usr/bin', projectDir: '/x' };
  const plain = buildEngineChildEnv({ ...base, extraEnv: {} } as any);
  expect(plain.BGW_MODEL).toBeUndefined();
  expect(plain.BGW_LITE_MODEL).toBeUndefined();
  const pinned = buildEngineChildEnv({ ...base, extraEnv: { BIMAX_THREAD_MODEL: 'meta/llama-3.3-70b-instruct' } } as any);
  expect(pinned.BGW_MODEL).toBe('meta/llama-3.3-70b-instruct');
  expect(pinned.BGW_LITE_MODEL).toBe('meta/llama-3.3-70b-instruct');
  expect(pinned.BIMAX_THREAD_MODEL).toBeUndefined();
});
