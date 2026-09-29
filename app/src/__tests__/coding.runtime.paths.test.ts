import fs from 'node:fs';
import path from 'node:path';
import { PackagedRuntimeError } from '../main/coding.runtime.paths';
import { EngineSupervisor } from '../main/supervisor/supervisor';
import { CrashJournal } from '../main/supervisor/journal';

/**
 * What is left of `coding.runtime.paths.ts`, the module `engine.ts` really loads: the error an app missing its engine
 * raises, and the environment builder. How the app finds its engine module is `resolveEngineModule` in `engine.ts`.
 *
 * The child-process command resolver (`resolveEngineCommand`, `BIMAX_ENGINE_CMD`) and its tests went with the separate
 * engine process in record 64's M4 (2026-09-30): ~/Developer/bimax-archive, and the git tag `keep/engine-process-fallback`.
 */

test('a broken packaged app fails visibly: a refusing spawn is a bounded, reported failure, not a crash or a loop', () => {
  const phases: string[] = [];
  const notices: string[] = [];
  const timers: Array<() => void> = [];
  let stored: string | null = null;
  const supervisor = new EngineSupervisor({
    spawn: () => { throw new PackagedRuntimeError('packaged Bimax.app is missing its bundled engine at /x'); },
    now: () => 1,
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    random: () => 0,
    memory: () => ({ freeBytes: 8e9, totalBytes: 16e9 }),
    env: {},
    journal: new CrashJournal({ load: () => stored, save: (text: string) => { stored = text; } }),
    logTail: () => '',
    onStatus: (status: unknown) => phases.push((status as { phase: string }).phase),
    onMessage: () => undefined,
    onNotice: (_level: unknown, text: unknown) => notices.push(String(text)),
  } as never);
  expect(() => supervisor.openProject('/proj')).not.toThrow();
  for (let i = 0; i < 20 && timers.length; i++) timers.shift()!();
  expect(phases).toContain('restarting');
  expect(phases).toContain('failed');
  expect(notices.some((notice) => /automatic restarts paused/i.test(notice))).toBe(true);
  expect(JSON.stringify(supervisor.crashHistory())).toContain('missing its bundled engine');
  supervisor.dispose();
});

test('the module decides nothing at run time: it never launches anything or loads Electron', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'coding.runtime.paths.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(code).not.toMatch(/spawn|exec\(|child_process/);
  expect(code).not.toMatch(/from\s+'electron'/);
});
