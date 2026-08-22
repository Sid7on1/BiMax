import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MAC_PROVIDER_SERVER_NAME } from '../shared/mac.provider';
import { DESKTOP_CU_DATA_ENV } from '../shared/cu.storage';

/**
 * Where a packaged Bimax.app is allowed to find its own executables.
 *
 * `05_TARGET_ARCHITECTURE.md` is explicit: "a release build cannot walk to `../src` or silently
 * compile whichever engine happens to be beside it", and `08_ACCEPTANCE_GATES.md` requires that
 * "compatibility/legacy backends cannot silently activate in a production build". Before this
 * module, both were violated by the same two habits:
 *
 *   1. every component honoured an environment override FIRST, unconditionally — so launching the
 *      packaged app with `BIMAX_CU_SERVICE_BINARY=/tmp/anything` pointed the shipped product at a
 *      foreign native service, and `BIMAX_ENGINE_CMD` replaced the engine outright;
 *   2. a missing bundled engine fell through to `dist/index.js` and then `npx tsx src/index.ts`
 *      resolved from a walked-up repo root — a packaged app quietly running source it did not ship.
 *
 * The rule is therefore: **packaged runs resolve from the bundle and nowhere else.** An override
 * presented to a packaged app is not obeyed and not silently dropped either — it is reported, so a
 * refusal is visible in the engine log rather than looking like the override "did nothing".
 *
 * Development keeps one explicit engine override for contributors. Its default is the same pinned,
 * staged engine artifact used by packaging — never an implicit dist/tsx source ladder.
 *
 * Electron-free by design: `app.isPackaged`, `process.resourcesPath` and filesystem probing are all
 * injected, so the whole policy is unit-testable without an Electron process.
 */

/** Executables a Desktop run can need. */
export type ComponentName = 'engine' | 'macCapability' | 'cuService' | 'cuBridge' | 'desktopHelper';

/** Environment overrides, by component. Development-only in effect. */
export const OVERRIDE_ENV: Record<ComponentName, string> = {
  engine: 'BIMAX_ENGINE_CMD',
  macCapability: 'BIMAX_MAC_CAPABILITY_PROVIDER',
  cuService: 'BIMAX_CU_SERVICE_BINARY',
  cuBridge: 'BIMAX_CU_BRIDGE_BINARY',
  desktopHelper: 'BIMAX_DESKTOP_HELPER',
};
export const LIVE_PIP_HELPER_ENV = 'BIMAX_LIVE_PIP_HELPER';

/**
 * The variables the engine child reads directly from its own environment. They are cleared before
 * the child is spawned and then re-set only from resolved values, so an inherited value can never
 * reach the engine on a path where this process declined to supply one.
 */
export const NATIVE_COMPONENT_ENV: readonly string[] = [
  OVERRIDE_ENV.cuService,
  OVERRIDE_ENV.cuBridge,
  OVERRIDE_ENV.desktopHelper,
  LIVE_PIP_HELPER_ENV,
];
export const HOST_CAPABILITIES_ENV = 'BIMAX_HOST_CAPABILITIES_JSON';
export const TRUSTED_PLAN_SECRET_ENV = 'BIMAX_CU_TRUSTED_PLAN_SECRET';
export const TRUSTED_PLAN_REQUIRED_ENV = 'BIMAX_CU_TRUSTED_PLAN_REQUIRED';

export interface RuntimeLayout {
  /** app.isPackaged — the only thing that distinguishes a shipped app from a dev shell. */
  packaged: boolean;
  /** process.resourcesPath, i.e. <Bimax.app>/Contents/Resources. */
  resourcesPath: string;
  /** Repo root, used only in development. */
  devRepoRoot: string;
  env: Record<string, string | undefined>;
  exists: (candidate: string) => boolean;
}

export interface Resolution {
  /** Absolute path, or undefined when the component is genuinely absent. */
  path?: string;
  /** Where the value came from. `bundle` is the only source a packaged run may use. */
  source: 'bundle' | 'artifact' | 'dev' | 'override' | 'missing';
  /**
   * Set when a packaged run was given an override and refused it. The caller reports this; a
   * silently ignored override is indistinguishable from a broken override.
   */
  refusedOverride?: { variable: string; value: string };
}

export class PackagedRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackagedRuntimeError';
  }
}

export class EngineArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineArtifactError';
  }
}

/** Bundle locations, relative to Contents/Resources. These mirror electron-builder.yml exactly. */
function bundlePath(layout: RuntimeLayout, component: Exclude<ComponentName, 'engine'>): string {
  const contents = path.resolve(layout.resourcesPath, '..');
  switch (component) {
    case 'cuService':
      return path.join(contents, 'XPCServices', 'BimaxCuService.xpc', 'Contents', 'MacOS', 'bimax-cu-service');
    case 'cuBridge':
      return path.join(contents, 'MacOS', 'bimax-cu-bridge');
    case 'desktopHelper':
      return path.join(contents, 'MacOS', 'bimax-desktop-helper');
    case 'macCapability':
      return path.join(contents, 'MacOS', 'bimax-mac-capability');
  }
}

function devPath(layout: RuntimeLayout, component: Exclude<ComponentName, 'engine'>): string {
  const staged = path.join(layout.devRepoRoot, 'app', 'native-service');
  switch (component) {
    case 'cuService':
      return path.join(staged, 'BimaxCuService.xpc', 'Contents', 'MacOS', 'bimax-cu-service');
    case 'cuBridge':
      return path.join(staged, 'bimax-cu-bridge');
    case 'desktopHelper':
      return path.join(staged, 'bimax-desktop-helper');
    case 'macCapability':
      return path.join(staged, 'bimax-mac-capability');
  }
}

export function packagedEnginePath(layout: RuntimeLayout): string {
  return path.join(layout.resourcesPath, 'engine', 'bimax-engine');
}

export function stagedEnginePath(layout: RuntimeLayout): string {
  return path.join(layout.devRepoRoot, 'app', 'engine', 'bimax-engine');
}

/**
 * Resolve one native component. In a packaged run this only ever returns a path inside the bundle;
 * a component that is missing from the bundle is `missing`, never substituted from elsewhere.
 */
export function resolveNativeComponent(
  layout: RuntimeLayout,
  component: Exclude<ComponentName, 'engine'>,
): Resolution {
  const variable = OVERRIDE_ENV[component];
  const override = layout.env[variable]?.trim();

  if (layout.packaged) {
    const bundled = bundlePath(layout, component);
    const resolution: Resolution = layout.exists(bundled)
      ? { path: bundled, source: 'bundle' }
      : { source: 'missing' };
    // The override is refused, not obeyed — and the refusal is reported.
    if (override) resolution.refusedOverride = { variable, value: override };
    return resolution;
  }

  if (override) return { path: override, source: 'override' };
  const candidate = devPath(layout, component);
  return layout.exists(candidate) ? { path: candidate, source: 'dev' } : { source: 'missing' };
}

export interface EngineCommand {
  cmd: string;
  args: string[];
  cwd: string;
  source: 'bundle' | 'artifact' | 'override';
  refusedOverride?: { variable: string; value: string };
}

/**
 * Resolve the engine command.
 *
 * A packaged app has exactly one legal answer: the binary electron-builder placed in
 * `Contents/Resources/engine/`. If that is absent the app is broken and must say so — falling back
 * to `dist/index.js` or `npx tsx` would mean a shipped product running whatever source tree happens
 * to sit next to it, which is precisely what the target architecture forbids.
 */
export function resolveEngineCommand(layout: RuntimeLayout, projectDir: string): EngineCommand {
  const variable = OVERRIDE_ENV.engine;
  const override = layout.env[variable]?.trim();

  if (layout.packaged) {
    const bundled = packagedEnginePath(layout);
    if (!layout.exists(bundled)) {
      throw new PackagedRuntimeError(
        `packaged Bimax.app is missing its bundled engine at ${bundled}; refusing to fall back to a development engine`,
      );
    }
    return {
      cmd: bundled,
      args: [],
      cwd: projectDir,
      source: 'bundle',
      ...(override ? { refusedOverride: { variable, value: override } } : {}),
    };
  }

  if (override) {
    const parts = override.split(/\s+/);
    return { cmd: parts[0], args: parts.slice(1), cwd: projectDir, source: 'override' };
  }
  const staged = stagedEnginePath(layout);
  if (!layout.exists(staged)) {
    throw new EngineArtifactError(
      `Desktop engine artifact is not staged at ${staged}; run npm --prefix app run prepare:engine or set BIMAX_ENGINE_CMD explicitly`,
    );
  }
  return { cmd: staged, args: [], cwd: projectDir, source: 'artifact' };
}

/**
 * One human-readable line per refused override, for the engine log. Kept here rather than at the
 * call site so the wording of a refusal is part of the policy and can be asserted.
 */
export function describeRefusal(refusal: { variable: string; value: string }): string {
  return `[desktop] ignored ${refusal.variable} in a packaged build (packaged runs resolve from the app bundle only); requested: ${refusal.value}`;
}

export interface ChildEnvInput {
  parentEnv: Record<string, string | undefined>;
  /** The supervisor's capability plan. */
  extraEnv: Record<string, string>;
  /** True only for an Electron app whose resources came from a packaged bundle. */
  packaged?: boolean;
  path: string;
  projectDir: string;
  /** Electron's private app-data directory. Passed only to the app-owned Mac provider. */
  desktopDataDirectory?: string;
  /** Electron's actual process architecture; binds the provider contract to the running chipset. */
  architecture?: 'arm64' | 'x64';
  /**
   * Loopback endpoint + token for the app-owned user takeover latch (main/takeover.ts). It goes in
   * the PROVIDER's own descriptor environment, never in the generic engine environment: the engine
   * has no business knowing that a macOS takeover control exists.
   */
  takeover?: { endpoint: string; token: string };
  resolved: {
    macCapability?: string;
    cuService?: string;
    cuBridge?: string;
    desktopHelper?: string;
  };
}

/**
 * Build the engine child's environment.
 *
 * The engine reads the native-component variables straight out of its own environment, so this
 * function clears all of them from the inherited copy and then sets back only the ones that
 * actually resolved. Without the clear, a component missing from the bundle would leave whatever
 * the parent process inherited in place — meaning a refused override would still reach the engine.
 * That is the same defect Phase 1 fixed on the Terminal side in `tui/engine.go`.
 */
export function buildEngineChildEnv(input: ChildEnvInput): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...input.parentEnv,
    ...input.extraEnv,
    PATH: input.path,
    BIMAX_HEADLESS: '1',
    BIMAX_CWD: input.projectDir,
  };
  // The generic engine never receives app routing flags. Only the provider learns package mode.
  delete env.BIMAX_DESKTOP_RELEASE_MODE;
  delete env[TRUSTED_PLAN_SECRET_ENV];
  delete env[TRUSTED_PLAN_REQUIRED_ENV];
  for (const variable of NATIVE_COMPONENT_ENV) delete env[variable];
  delete env[HOST_CAPABILITIES_ENV];
  if (input.resolved.macCapability) {
    // One launch-scoped authentication key is shared only with the bundled engine and the
    // app-owned provider. The model/renderer never sees it and therefore cannot forge task scope.
    const trustedPlanSecret = randomBytes(32).toString('base64url');
    env[TRUSTED_PLAN_SECRET_ENV] = trustedPlanSecret;
    env[TRUSTED_PLAN_REQUIRED_ENV] = '1';
    const providerEnv: Record<string, string> = {
      BIMAX_CWD: input.projectDir,
      BIMAX_HOST_ARCH: input.architecture || (process.arch === 'arm64' ? 'arm64' : 'x64'),
      BIMAX_MAC_PROVIDER_AUTHORITY: 'electron-main',
      BIMAX_MAC_CONSENT_CHANNEL: 'engine-governor',
      BIMAX_DESKTOP_RELEASE_MODE: input.packaged ? 'packaged' : 'development',
      [TRUSTED_PLAN_SECRET_ENV]: trustedPlanSecret,
      [TRUSTED_PLAN_REQUIRED_ENV]: '1',
      // The preview is staged beside the provider in development and in Bimax.app/Contents/MacOS
      // when packaged. Deriving it from the already-resolved provider keeps packaged runs inside
      // the bundle and prevents an inherited path from selecting a foreign helper.
      [LIVE_PIP_HELPER_ENV]: path.join(path.dirname(input.resolved.macCapability), 'bimax-live-pip'),
    };
    if (input.desktopDataDirectory) providerEnv[DESKTOP_CU_DATA_ENV] = input.desktopDataDirectory;
    // Desktop ALWAYS requires a takeover authority. Declaring it separately from supplying it is
    // what lets the provider tell "nobody owns takeover here" apart from "my host owed me an
    // authority and failed to start one" — the second must not act on the user's Mac.
    providerEnv.BIMAX_CU_TAKEOVER_REQUIRED = '1';
    if (input.takeover) {
      providerEnv.BIMAX_CU_TAKEOVER_ENDPOINT = input.takeover.endpoint;
      providerEnv.BIMAX_CU_TAKEOVER_TOKEN = input.takeover.token;
    }
    if (input.resolved.cuService) providerEnv[OVERRIDE_ENV.cuService] = input.resolved.cuService;
    if (input.resolved.cuBridge) providerEnv[OVERRIDE_ENV.cuBridge] = input.resolved.cuBridge;
    if (input.resolved.desktopHelper) providerEnv[OVERRIDE_ENV.desktopHelper] = input.resolved.desktopHelper;
    env[HOST_CAPABILITIES_ENV] = JSON.stringify({
      version: 1,
      transport: 'stdio',
      servers: [{
        // The engine registers each of this server's tools as `mcp__<name>__<tool>`, so this
        // constant is what the renderer's Mac-lane recognizer matches against. One source of truth.
        name: MAC_PROVIDER_SERVER_NAME,
        command: input.resolved.macCapability,
        args: [],
        env: providerEnv,
      }],
    });
  }
  return env;
}
