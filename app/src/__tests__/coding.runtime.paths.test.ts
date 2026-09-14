import fs from 'node:fs';
import path from 'node:path';
import {
  EngineArtifactError,
  PackagedRuntimeError,
  describeRefusal,
  resolveEngineCommand,
  type RuntimeLayout,
} from '../main/coding.runtime.paths';
import { EngineSupervisor } from '../main/supervisor/supervisor';
import { CrashJournal } from '../main/supervisor/journal';

/**
 * How the app finds its engine, tested against `coding.runtime.paths.ts`, the module `engine.ts` really loads.
 *
 * These tests were written for `runtime.paths.ts`, an older copy the app no longer loads (backlog Q3): they stayed green
 * while a fix shipped into that copy never reached an engine. The copy and its Computer Use–era component tests moved to
 * the archive; what still applies to the real module is here.
 */

const APP = '/Applications/Bimax.app';
const RESOURCES = `${APP}/Contents/Resources`;
const REPO = '/Users/dev/Bimax';
const BUNDLED = `${RESOURCES}/engine/bimax-engine`;
const STAGED = `${REPO}/app/engine/bimax-engine`;

/** A layout whose filesystem contains exactly `present`, and whose environment is exactly `env`. */
function layout(opts: { packaged: boolean; present?: string[]; env?: Record<string, string | undefined> }): RuntimeLayout {
  const present = new Set(opts.present ?? []);
  return { packaged: opts.packaged, resourcesPath: RESOURCES, devRepoRoot: REPO, env: opts.env ?? {}, exists: (candidate) => present.has(candidate) };
}

describe('a packaged app runs the engine from its bundle only', () => {
  test('the bundled engine is used, with the project as the working directory', () => {
    expect(resolveEngineCommand(layout({ packaged: true, present: [BUNDLED] }), '/proj')).toEqual({ cmd: BUNDLED, args: [], cwd: '/proj', source: 'bundle' });
  });

  test('BIMAX_ENGINE_CMD is refused in a packaged build, and the refusal is reported rather than swallowed', () => {
    const resolved = resolveEngineCommand(layout({ packaged: true, present: [BUNDLED], env: { BIMAX_ENGINE_CMD: '/tmp/other-engine --flag' } }), '/proj');
    expect(resolved).toMatchObject({ cmd: BUNDLED, args: [], source: 'bundle' });
    expect(resolved.refusedOverride).toEqual({ variable: 'BIMAX_ENGINE_CMD', value: '/tmp/other-engine --flag' });
    expect(describeRefusal(resolved.refusedOverride!)).toBe('[desktop] ignored BIMAX_ENGINE_CMD in a packaged build; requested: /tmp/other-engine --flag');
  });

  test('a packaged app missing its engine fails, even when an override could have "fixed" it', () => {
    for (const env of [{}, { BIMAX_ENGINE_CMD: '/tmp/other-engine' }]) {
      expect(() => resolveEngineCommand(layout({ packaged: true, present: [], env }), '/proj')).toThrow(PackagedRuntimeError);
    }
    expect(() => resolveEngineCommand(layout({ packaged: true }), '/proj')).toThrow(/missing its bundled engine at .*refusing a development fallback/);
  });
});

describe('development keeps its escape hatch and fails visibly without an engine', () => {
  test('BIMAX_ENGINE_CMD is honoured and split into a command and arguments', () => {
    expect(resolveEngineCommand(layout({ packaged: false, env: { BIMAX_ENGINE_CMD: 'bun run src/index.ts --headless' } }), '/proj'))
      .toEqual({ cmd: 'bun', args: ['run', 'src/index.ts', '--headless'], cwd: '/proj', source: 'override' });
  });

  test('without an override, development uses the staged engine artifact, the same one packaging uses', () => {
    expect(resolveEngineCommand(layout({ packaged: false, present: [STAGED] }), '/proj')).toEqual({ cmd: STAGED, args: [], cwd: '/proj', source: 'artifact' });
  });

  test('without a staged artifact, development fails and says how to stage one', () => {
    expect(() => resolveEngineCommand(layout({ packaged: false }), '/proj')).toThrow(EngineArtifactError);
    expect(() => resolveEngineCommand(layout({ packaged: false }), '/proj')).toThrow(/prepare:engine/);
  });
});

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

test('the resolver decides locations only: it never launches anything or loads Electron', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'coding.runtime.paths.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(code).not.toMatch(/spawn|exec\(|child_process/);
  expect(code).not.toMatch(/from\s+'electron'/);
});
