/**
 * Phase 2, slice 2 — a packaged Bimax.app resolves its engine, XPC service, bridge and helper from
 * its own bundle and nowhere else.
 *
 * `05_TARGET_ARCHITECTURE.md`: "a release build cannot walk to `../src` or silently compile
 * whichever engine happens to be beside it."
 * `08_ACCEPTANCE_GATES.md`, Desktop computer-use gate: "compatibility/legacy backends cannot
 * silently activate in a production build."
 * `competitive/07_BUILD_SEQUENCE.md`, Workstream A.4: "Make packaged Bimax.app the only production
 * Computer Use host."
 *
 * The policy module is Electron-free and every input is injected, so the packaged case is tested
 * directly rather than inferred from a dev shell.
 */
import path from 'node:path';

import {
  resolveEngineCommand, resolveNativeComponent, buildEngineChildEnv, describeRefusal,
  packagedEnginePath, PackagedRuntimeError, OVERRIDE_ENV, NATIVE_COMPONENT_ENV,
  EngineArtifactError, stagedEnginePath, type RuntimeLayout,
} from '../main/runtime.paths';
import { EngineSupervisor } from '../main/supervisor/supervisor';
import { CrashJournal } from '../main/supervisor/journal';

const APP = '/Applications/Bimax.app';
const RESOURCES = `${APP}/Contents/Resources`;
const REPO = '/Users/dev/Bimax';

const BUNDLE = {
  engine: `${RESOURCES}/engine/bimax-engine`,
  macCapability: `${APP}/Contents/MacOS/bimax-mac-capability`,
  cuService: `${APP}/Contents/XPCServices/BimaxCuService.xpc/Contents/MacOS/bimax-cu-service`,
  cuBridge: `${APP}/Contents/MacOS/bimax-cu-bridge`,
  desktopHelper: `${APP}/Contents/MacOS/bimax-desktop-helper`,
};

const DEV = {
  engine: `${REPO}/app/engine/bimax-engine`,
  macCapability: `${REPO}/app/native-service/bimax-mac-capability`,
  cuService: `${REPO}/app/native-service/BimaxCuService.xpc/Contents/MacOS/bimax-cu-service`,
  cuBridge: `${REPO}/app/native-service/bimax-cu-bridge`,
  desktopHelper: `${REPO}/app/native-service/bimax-desktop-helper`,
};

/** A layout whose filesystem contains exactly `present`, and whose env is exactly `env`. */
function layout(opts: {
  packaged: boolean;
  present?: string[];
  env?: Record<string, string | undefined>;
}): RuntimeLayout {
  const present = new Set(opts.present ?? []);
  return {
    packaged: opts.packaged,
    resourcesPath: RESOURCES,
    devRepoRoot: REPO,
    env: opts.env ?? {},
    exists: (candidate) => present.has(candidate),
  };
}

const ALL_BUNDLE = Object.values(BUNDLE);
const ALL_DEV = Object.values(DEV);

describe('packaged runs resolve the engine from the bundle only', () => {
  test('the bundled engine is used, with the project as cwd', () => {
    const resolved = resolveEngineCommand(layout({ packaged: true, present: ALL_BUNDLE }), '/proj');
    expect(resolved).toMatchObject({
      cmd: packagedEnginePath(layout({ packaged: true })),
      args: [],
      cwd: '/proj',
      source: 'bundle',
    });
    expect(resolved.cmd).toBe(BUNDLE.engine);
  });

  test('BIMAX_ENGINE_CMD is refused in a packaged build and the refusal is reported', () => {
    const resolved = resolveEngineCommand(
      layout({ packaged: true, present: ALL_BUNDLE, env: { BIMAX_ENGINE_CMD: '/tmp/evil-engine --pwn' } }),
      '/proj',
    );
    // Refused, not obeyed.
    expect(resolved.cmd).toBe(BUNDLE.engine);
    expect(resolved.args).toEqual([]);
    expect(resolved.source).toBe('bundle');
    // ...and not silently swallowed either.
    expect(resolved.refusedOverride).toEqual({ variable: 'BIMAX_ENGINE_CMD', value: '/tmp/evil-engine --pwn' });
  });

  test('a packaged app missing its engine FAILS instead of falling back to a dev engine', () => {
    // The whole point: no dist/index.js, no `npx tsx`, no walking to ../src.
    const broken = layout({ packaged: true, present: [] });
    expect(() => resolveEngineCommand(broken, '/proj')).toThrow(PackagedRuntimeError);
    try {
      resolveEngineCommand(broken, '/proj');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(BUNDLE.engine);
      expect(message).toMatch(/refusing to fall back/i);
      expect(message).not.toMatch(/npx|tsx|dist/);
    }
  });

  test('a packaged app missing its engine fails even when an override could have "fixed" it', () => {
    expect(() => resolveEngineCommand(
      layout({ packaged: true, present: [], env: { BIMAX_ENGINE_CMD: '/tmp/evil-engine' } }),
      '/proj',
    )).toThrow(PackagedRuntimeError);
  });
});

describe('packaged runs resolve native components from the bundle only', () => {
  const components = ['macCapability', 'cuService', 'cuBridge', 'desktopHelper'] as const;

  test.each(components)('%s comes from the app bundle', (component) => {
    const resolved = resolveNativeComponent(layout({ packaged: true, present: ALL_BUNDLE }), component);
    expect(resolved).toEqual({ path: BUNDLE[component], source: 'bundle' });
  });

  test.each(components)('%s ignores its environment override when packaged', (component) => {
    const variable = OVERRIDE_ENV[component];
    const resolved = resolveNativeComponent(
      layout({ packaged: true, present: ALL_BUNDLE, env: { [variable]: '/tmp/foreign-binary' } }),
      component,
    );
    expect(resolved.path).toBe(BUNDLE[component]);
    expect(resolved.source).toBe('bundle');
    expect(resolved.refusedOverride).toEqual({ variable, value: '/tmp/foreign-binary' });
  });

  test.each(components)(
    '%s missing from the bundle reports missing — it never substitutes the override or a dev path',
    (component) => {
      const variable = OVERRIDE_ENV[component];
      const resolved = resolveNativeComponent(
        // Nothing on disk at all, but both an override and a dev tree "available" in env terms.
        layout({ packaged: true, present: ALL_DEV, env: { [variable]: '/tmp/foreign-binary' } }),
        component,
      );
      expect(resolved.path).toBeUndefined();
      expect(resolved.source).toBe('missing');
      expect(resolved.refusedOverride).toEqual({ variable, value: '/tmp/foreign-binary' });
    },
  );

  test('a refusal names the variable, says it was ignored, and shows what was requested', () => {
    const line = describeRefusal({ variable: 'BIMAX_CU_SERVICE_BINARY', value: '/tmp/foreign' });
    expect(line).toContain('BIMAX_CU_SERVICE_BINARY');
    expect(line).toMatch(/ignored/i);
    expect(line).toContain('/tmp/foreign');
    expect(line).toMatch(/packaged/i);
  });
});

describe('development keeps every escape hatch', () => {
  test('BIMAX_ENGINE_CMD is honoured and split into command and arguments', () => {
    const resolved = resolveEngineCommand(
      layout({ packaged: false, env: { BIMAX_ENGINE_CMD: 'node ./dist/index.js --flag' } }),
      '/proj',
    );
    expect(resolved).toMatchObject({
      cmd: 'node',
      args: ['./dist/index.js', '--flag'],
      cwd: '/proj',
      source: 'override',
    });
    expect(resolved.refusedOverride).toBeUndefined();
  });

  test('without an override, development uses the same staged release artifact as packaging', () => {
    const resolved = resolveEngineCommand(layout({ packaged: false, present: ALL_DEV }), '/proj');
    expect(resolved.source).toBe('artifact');
    expect(resolved.cmd).toBe(stagedEnginePath(layout({ packaged: false })));
    expect(resolved.cwd).toBe('/proj');
  });

  test('without a staged artifact, development fails visibly instead of compiling Terminal source', () => {
    expect(() => resolveEngineCommand(layout({ packaged: false }), '/proj')).toThrow(EngineArtifactError);
  });

  test('native overrides still work outside a packaged build', () => {
    const resolved = resolveNativeComponent(
      layout({ packaged: false, env: { BIMAX_CU_SERVICE_BINARY: '/tmp/local-service' } }),
      'cuService',
    );
    expect(resolved).toEqual({ path: '/tmp/local-service', source: 'override' });
  });

  test('the staged dev tree is used when no override is set', () => {
    const resolved = resolveNativeComponent(layout({ packaged: false, present: ALL_DEV }), 'cuBridge');
    expect(resolved).toEqual({ path: DEV.cuBridge, source: 'dev' });
  });

  test('a dev checkout without staged native binaries reports missing, not a bundle path', () => {
    const resolved = resolveNativeComponent(layout({ packaged: false }), 'desktopHelper');
    expect(resolved).toEqual({ source: 'missing' });
    expect(resolved.path).toBeUndefined();
  });
});

describe('the engine child receives one generic local-provider contract', () => {
  const hostile = {
    BIMAX_CU_SERVICE_BINARY: '/tmp/evil-service',
    BIMAX_CU_BRIDGE_BINARY: '/tmp/evil-bridge',
    BIMAX_DESKTOP_HELPER: '/tmp/evil-helper',
    UNRELATED: 'keep-me',
  };

  test('native paths are scoped to the Desktop provider and never exposed directly to the engine', () => {
    const env = buildEngineChildEnv({
      parentEnv: { ...hostile },
      extraEnv: {},
      path: '/usr/bin',
      projectDir: '/proj',
      resolved: {
        macCapability: BUNDLE.macCapability,
        cuService: BUNDLE.cuService,
        cuBridge: BUNDLE.cuBridge,
        desktopHelper: BUNDLE.desktopHelper,
      },
    });
    for (const variable of NATIVE_COMPONENT_ENV) expect(env[variable]).toBeUndefined();
    const contract = JSON.parse(String(env.BIMAX_HOST_CAPABILITIES_JSON));
    expect(contract).toMatchObject({
      version: 1,
      transport: 'stdio',
      servers: [{ name: 'bimax-mac', command: BUNDLE.macCapability, args: [] }],
    });
    expect(contract.servers[0].env).toMatchObject({
      BIMAX_CU_SERVICE_BINARY: BUNDLE.cuService,
      BIMAX_CU_BRIDGE_BINARY: BUNDLE.cuBridge,
      BIMAX_DESKTOP_HELPER: BUNDLE.desktopHelper,
      BIMAX_LIVE_PIP_HELPER: `${APP}/Contents/MacOS/bimax-live-pip`,
      BIMAX_MAC_PROVIDER_AUTHORITY: 'electron-main',
      BIMAX_MAC_CONSENT_CHANNEL: 'engine-governor',
      BIMAX_HOST_ARCH: expect.stringMatching(/^(arm64|x64)$/),
    });
  });

  test('only the provider receives release mode derived from Electron package identity', () => {
    const providerMode = (packaged: boolean) => {
      const env = buildEngineChildEnv({
        parentEnv: { BIMAX_DESKTOP_RELEASE_MODE: packaged ? 'development' : 'packaged' },
        extraEnv: {},
        packaged,
        path: '/usr/bin',
        projectDir: '/proj',
        resolved: { macCapability: BUNDLE.macCapability },
      });
      expect(env.BIMAX_DESKTOP_RELEASE_MODE).toBeUndefined();
      const contract = JSON.parse(String(env.BIMAX_HOST_CAPABILITIES_JSON));
      return contract.servers[0].env.BIMAX_DESKTOP_RELEASE_MODE;
    };

    expect(providerMode(false)).toBe('development');
    expect(providerMode(true)).toBe('packaged');
  });

  test('an UNRESOLVED component is stripped, not left as the inherited hostile value', () => {
    // This is the hole the refusal alone did not close: the engine reads these variables from its
    // own environment, so a component missing from the bundle must leave NOTHING behind.
    const env = buildEngineChildEnv({
      parentEnv: { ...hostile },
      extraEnv: {},
      path: '/usr/bin',
      projectDir: '/proj',
      resolved: {},
    });
    for (const variable of NATIVE_COMPONENT_ENV) {
      expect(env[variable]).toBeUndefined();
    }
  });

  test('without a resolved provider, no native component reaches the engine', () => {
    const env = buildEngineChildEnv({
      parentEnv: { ...hostile },
      extraEnv: {},
      path: '/usr/bin',
      projectDir: '/proj',
      resolved: { cuService: BUNDLE.cuService },
    });
    for (const variable of NATIVE_COMPONENT_ENV) expect(env[variable]).toBeUndefined();
    expect(env.BIMAX_HOST_CAPABILITIES_JSON).toBeUndefined();
  });

  test('unrelated environment and the hardware capability plan survive without a product profile', () => {
    const env = buildEngineChildEnv({
      parentEnv: { ...hostile },
      extraEnv: { BIMAX_CODEMEM: '1' },
      path: '/opt/homebrew/bin:/usr/bin',
      projectDir: '/proj',
      resolved: {},
    });
    expect(env.UNRELATED).toBe('keep-me');
    expect(env.BIMAX_CODEMEM).toBe('1');
    expect(env.BIMAX_HOST_PROFILE).toBeUndefined();
    expect(env.BIMAX_HEADLESS).toBe('1');
    expect(env.BIMAX_CWD).toBe('/proj');
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
  });

  test('app package identity never leaks as an engine routing flag', () => {
    const development = buildEngineChildEnv({
      parentEnv: { BIMAX_DESKTOP_RELEASE_MODE: 'packaged' },
      extraEnv: {},
      path: '/usr/bin',
      projectDir: '/proj',
      resolved: {},
    });
    expect(development.BIMAX_DESKTOP_RELEASE_MODE).toBeUndefined();

    const packaged = buildEngineChildEnv({
      parentEnv: {},
      extraEnv: {},
      packaged: true,
      path: '/usr/bin',
      projectDir: '/proj',
      resolved: {},
    });
    expect(packaged.BIMAX_DESKTOP_RELEASE_MODE).toBeUndefined();
  });

  test('every legacy native variable is covered by the strip list', () => {
    expect([...NATIVE_COMPONENT_ENV].sort()).toEqual(
      ['BIMAX_CU_BRIDGE_BINARY', 'BIMAX_CU_SERVICE_BINARY', 'BIMAX_DESKTOP_HELPER', 'BIMAX_LIVE_PIP_HELPER'].sort(),
    );
  });
});

describe('a broken packaged app fails visibly rather than crashing the shell', () => {
  test('a refusing spawn becomes a bounded, reported failure — not a crash and not a silent loop', () => {
    const phases: string[] = [];
    const notices: string[] = [];
    const timers: Array<() => void> = [];
    let stored: string | null = null;

    const supervisor = new EngineSupervisor({
      // Exactly what engine.ts now does when a packaged bundle has no engine.
      spawn: () => { throw new PackagedRuntimeError('packaged Bimax.app is missing its bundled engine at /x'); },
      now: () => 1,
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
      clearTimeout: () => undefined,
      setInterval: () => 1,
      clearInterval: () => undefined,
      random: () => 0,
      memory: () => ({ freeBytes: 8e9, totalBytes: 16e9 }),
      env: {},
      // The real journal over in-memory storage — a stub would not prove the failure is recorded.
      journal: new CrashJournal({ load: () => stored, save: (text: string) => { stored = text; } }),
      logTail: () => '',
      onStatus: (s: unknown) => phases.push((s as { phase: string }).phase),
      onMessage: () => undefined,
      onNotice: (_level: unknown, text: unknown) => notices.push(String(text)),
    } as never);

    // Must not throw out of openProject — a broken bundle cannot take the shell down with it.
    expect(() => supervisor.openProject('/proj')).not.toThrow();

    // Drive the backoff timers the supervisor scheduled.
    for (let i = 0; i < 20 && timers.length; i++) timers.shift()!();

    // It stops. An unbounded restart loop against a permanently missing binary would be the real
    // failure mode here, so the terminal state matters more than the first transition.
    expect(phases).toContain('restarting');
    expect(phases[phases.length - 1] ?? phases.filter(Boolean).pop()).toBeDefined();
    expect(phases).toContain('failed');
    expect(notices.some((n) => /automatic restarts paused/i.test(n))).toBe(true);

    // The underlying cause is retained as evidence, not flattened to "engine died".
    const history = JSON.stringify(supervisor.crashHistory());
    expect(history).toContain('missing its bundled engine');
    supervisor.dispose();
  });
});

describe('this slice changed no Computer Use behaviour', () => {
  test('the resolver decides locations only — it never launches or routes anything', () => {
    const source = require('node:fs').readFileSync(
      path.join(__dirname, '..', 'main', 'runtime.paths.ts'), 'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/spawn|exec|child_process|XPCConnection|AXIsProcessTrusted/i);
    expect(code).not.toMatch(/from\s+'electron'/);
  });
});
