import path from 'node:path';

export interface RuntimeLayout {
  packaged: boolean;
  resourcesPath: string;
  devRepoRoot: string;
  env: Record<string, string | undefined>;
  exists: (candidate: string) => boolean;
}

export interface EngineCommand {
  cmd: string;
  args: string[];
  cwd: string;
  source: 'bundle' | 'artifact' | 'override';
  refusedOverride?: { variable: string; value: string };
}

export interface Resolution {
  path?: string;
  source: 'bundle' | 'artifact' | 'override' | 'missing';
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

export function resolveEngineCommand(layout: RuntimeLayout, projectDir: string): EngineCommand {
  const variable = 'BIMAX_ENGINE_CMD';
  const override = layout.env[variable]?.trim();
  if (layout.packaged) {
    const bundled = path.join(layout.resourcesPath, 'engine', 'bimax-engine');
    if (!layout.exists(bundled)) {
      throw new PackagedRuntimeError(
        `packaged Bimax.app is missing its bundled engine at ${bundled}; refusing a development fallback`,
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
  const staged = path.join(layout.devRepoRoot, 'app', 'engine', 'bimax-engine');
  if (!layout.exists(staged)) {
    throw new EngineArtifactError(
      `Desktop engine artifact is not staged at ${staged}; run npm --prefix app run prepare:engine or set BIMAX_ENGINE_CMD explicitly`,
    );
  }
  return { cmd: staged, args: [], cwd: projectDir, source: 'artifact' };
}

export function describeRefusal(refusal: { variable: string; value: string }): string {
  return `[desktop] ignored ${refusal.variable} in a packaged build; requested: ${refusal.value}`;
}

export function buildEngineChildEnv(input: {
  parentEnv: Record<string, string | undefined>;
  extraEnv: Record<string, string>;
  path: string;
  projectDir: string;
  /**
   * Where V8 may keep compiled code for the engine bundle (NODE_COMPILE_CACHE).
   *
   * MEASURED 2026-09-19 on this Mac, Electron 43 / Node 24: an engine reaches `ready` in ~424 ms,
   * and ~394 ms of that is spent BEFORE the first boot phase reports — V8 parsing the 22 MB bundle,
   * of which only 2.1 MB is our own source. With the cache the same boot is ~330 ms (parse ~300 ms),
   * a 22% cut for one environment variable. Threads pays this PER TASK, because every task gets its
   * own engine, so it is 94 ms × every ⌘2 run, not once.
   *
   * The first boot after a new bundle is ~60 ms slower while the cache is written, and Node keys
   * entries by file, so an engine update simply misses and repopulates rather than running stale
   * code. Omitted (no directory) means no cache: never guess a path inside a shared env builder.
   */
  compileCacheDir?: string;
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...input.parentEnv,
    ...input.extraEnv,
    PATH: input.path,
    BIMAX_HEADLESS: '1',
    BIMAX_CWD: input.projectDir,
    BGW_FIRST_CHUNK_TIMEOUT_MS: '45000',
    ...(input.compileCacheDir ? { NODE_COMPILE_CACHE: input.compileCacheDir } : {}),
  };
  for (const variable of [
    'BIMAX_MAC_CAPABILITY_PROVIDER',
    'BIMAX_CU_SERVICE_BINARY',
    'BIMAX_CU_BRIDGE_BINARY',
    'BIMAX_DESKTOP_HELPER',
    'BIMAX_LIVE_PIP_HELPER',
    'BIMAX_HOST_CAPABILITIES_JSON',
    'BIMAX_CU_TRUSTED_PLAN_SECRET',
    'BIMAX_CU_TRUSTED_PLAN_REQUIRED',
    'BIMAX_CU_NATIVE_ROUTING_ENABLED',
    'BIMAX_CU_NATIVE_SEMANTIC_ROUTING_ENABLED',
    'BIMAX_DESKTOP_RELEASE_MODE',
    'BIMAX_DESKTOP_STRICT_MODEL',
    'BGW_MODEL',
    'BGW_LITE_MODEL',
    'BGW_VISION_MODEL',
    'BIMAX_FALLBACK_MODEL',
  ]) delete env[variable];
  // One task may answer with a different model than Bimax's saved slots (the ⌘2 model menu, "Retry with…", talk mode).
  // It arrives as BIMAX_THREAD_MODEL and becomes the engine's volatile overrides, applied after the clearing above and
  // never written back to the user's configuration.
  const threadModel = String(input.extraEnv?.BIMAX_THREAD_MODEL ?? '').trim();
  delete env.BIMAX_THREAD_MODEL;
  if (threadModel) { env.BGW_MODEL = threadModel; env.BGW_LITE_MODEL = threadModel; }
  // Talk mode (BIMAX_THREAD_VOICE) makes every reply short and markdown-free, so only a talk-mode engine gets it, never one
  // that merely inherited it from the shell that started Bimax.
  const spoken = input.extraEnv?.BIMAX_THREAD_VOICE === '1';
  delete env.BIMAX_THREAD_VOICE;
  if (spoken) env.BIMAX_THREAD_VOICE = '1';
  // Folder rules and protected items belong to the folder the app started this engine for (backlog Q2). Left in the
  // shell that started Bimax, they reached every engine, the same leak BIMAX_THREAD_VOICE had.
  for (const variable of ['BIMAX_THREAD_RULES', 'BIMAX_THREAD_PROTECTED']) {
    const own = input.extraEnv?.[variable];
    delete env[variable];
    if (own !== undefined) env[variable] = own;
  }
  return env;
}
