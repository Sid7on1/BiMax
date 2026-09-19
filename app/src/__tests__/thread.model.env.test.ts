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

test('folder rules reach only the engine the app gave them to, never one that inherited them from the shell', () => {
  const base = { parentEnv: { BIMAX_THREAD_RULES: 'stale rules from a shell', BIMAX_THREAD_PROTECTED: '["/stale"]' }, path: '/usr/bin', projectDir: '/x' };
  const plain = buildEngineChildEnv({ ...base, extraEnv: {} } as any);
  expect(plain.BIMAX_THREAD_RULES).toBeUndefined();
  expect(plain.BIMAX_THREAD_PROTECTED).toBeUndefined();
  const own = buildEngineChildEnv({ ...base, extraEnv: { BIMAX_THREAD_RULES: 'Never touch DEV', BIMAX_THREAD_PROTECTED: '["/x/DEV"]' } } as any);
  expect(own.BIMAX_THREAD_RULES).toBe('Never touch DEV');
  expect(own.BIMAX_THREAD_PROTECTED).toBe('["/x/DEV"]');
});

test('these tests cover the builder the app really spawns engines with', () => {
  // runtime.paths.ts has its own buildEngineChildEnv; the per-task model shipped there, tested green, and never reached an engine.
  const engine = readFileSync(path.join(__dirname, '..', 'main', 'engine.ts'), 'utf8');
  expect(engine).toMatch(/buildEngineChildEnv,[\s\S]*?\} from '\.\/coding\.runtime\.paths';/);
});

test('the engine bundle gets a V8 compile cache when one is offered, and none when it is not', () => {
  // 22 MB of bundle is parsed on EVERY engine spawn, and Threads spawns one per task: measured
  // 424 ms to ready, ~394 ms of it before our first boot phase, falling to ~330 ms with the cache.
  // The directory is the caller's to choose — a shared env builder must not invent a path.
  const base = { parentEnv: {}, path: '/usr/bin', projectDir: '/x' };
  const cached = buildEngineChildEnv({ ...base, extraEnv: {}, compileCacheDir: '/tmp/v8cc' } as any);
  expect(cached.NODE_COMPILE_CACHE).toBe('/tmp/v8cc');
  const plainEnv = buildEngineChildEnv({ ...base, extraEnv: {} } as any);
  expect(plainEnv.NODE_COMPILE_CACHE).toBeUndefined();
});

test('both engine transports ask for the cache — a per-task cost fixed on only one path is fixed nowhere', () => {
  const engine = require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'engine.ts'), 'utf8');
  expect(engine.match(/compileCacheDir: engineCompileCacheDir\(\)/g)?.length).toBe(2);
});
