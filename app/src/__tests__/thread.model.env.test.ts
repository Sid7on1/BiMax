import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildEngineChildEnv } from '../main/coding.runtime.paths';
import { threadVoiceEnvironment } from '../main/thread.manager';

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

test('a talk-mode task’s engine is told its replies are spoken, and no other engine is', () => {
  const base = { parentEnv: { BIMAX_THREAD_VOICE: '1' }, path: '/usr/bin', projectDir: '/x' };
  expect(buildEngineChildEnv({ ...base, extraEnv: threadVoiceEnvironment(true) } as any).BIMAX_THREAD_VOICE).toBe('1');
  expect(buildEngineChildEnv({ ...base, extraEnv: threadVoiceEnvironment(undefined) } as any).BIMAX_THREAD_VOICE).toBeUndefined();
});

test('these tests cover the builder the app really spawns engines with', () => {
  // runtime.paths.ts has its own buildEngineChildEnv; the per-task model shipped there, tested green, and never reached an engine.
  const engine = readFileSync(path.join(__dirname, '..', 'main', 'engine.ts'), 'utf8');
  expect(engine).toMatch(/buildEngineChildEnv,[\s\S]*?\} from '\.\/coding\.runtime\.paths';/);
});
