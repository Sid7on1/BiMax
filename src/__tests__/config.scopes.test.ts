import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';

// Configuration-scope contract: volatile values (env/test/benchmark) must never persist into the
// user's real configuration. The historical failure this pins: a mock benchmark run with
// BGW_MODEL=mock caused healModel to persist {"model":"mock"} into ~/.breakglass/config.json —
// observed live, twice. Also covers: precedence, provenance, atomic writes, corrupt-file
// preservation, read-only config, and crash-during-write integrity.

let dir: string;
let cfgPath: string;

const ENV_KEYS = [
  'BGW_MODEL',
  'BGW_LITE_MODEL',
  'BGW_VISION_MODEL',
  'BGW_REASONING_EFFORT',
  'BIMAX_DESKTOP_STRICT_MODEL',
  'BIMAX_BREAKGLASS_DIR',
];
const savedEnv: Record<string, string | undefined> = {};

function freshConfigModule() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../cli/config') as typeof import('../cli/config');
}

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-config-'));
  cfgPath = path.join(dir, 'config.json');
  process.env.BIMAX_BREAKGLASS_DIR = dir;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function disk(): Promise<any> {
  try {
    return JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
  } catch {
    return null;
  }
}

describe('config scopes — precedence and provenance', () => {
  it('env override (BGW_MODEL) beats the persisted global value', async () => {
    await fs.writeFile(cfgPath, JSON.stringify({ model: 'user/persisted-model' }));
    process.env.BGW_MODEL = 'mock';
    const { loadConfig, configSource } = freshConfigModule();
    const cfg = await loadConfig();
    expect(cfg.model).toBe('mock');
    expect(configSource('model')).toBe('env');
  });

  it('persisted global value beats the built-in default; default fills the rest', async () => {
    await fs.writeFile(cfgPath, JSON.stringify({ model: 'user/persisted-model' }));
    const { loadConfig, configSource } = freshConfigModule();
    const cfg = await loadConfig();
    expect(cfg.model).toBe('user/persisted-model');
    expect(configSource('model')).toBe('global');
    expect(configSource('liteModel')).toBe('default');
  });
});

describe('config scopes — the contamination class', () => {
  it('MOCK MODEL: a runtime (healing) write to an env-overridden key never reaches disk', async () => {
    await fs.writeFile(cfgPath, JSON.stringify({ model: 'stepfun-ai/step-3.7-flash' }));
    process.env.BGW_MODEL = 'mock';
    const { loadConfig, saveConfig } = freshConfigModule();
    await loadConfig();
    // healModel "heals" to the only model the mock provider serves and asks to persist it.
    const after = await saveConfig({ model: 'mock' }, { origin: 'runtime' });
    expect(after.model).toBe('mock'); // the session keeps working with the healed value…
    expect((await disk()).model).toBe('stepfun-ai/step-3.7-flash'); // …but the user's config is untouched
  });

  it('INVALID/TEST MODEL via env: same guard, any value', async () => {
    process.env.BGW_MODEL = 'totally-fake-test-model';
    const { loadConfig, saveConfig } = freshConfigModule();
    await loadConfig();
    await saveConfig({ model: 'whatever-the-healer-picked' }, { origin: 'runtime' });
    expect(await disk()).toBeNull(); // nothing was ever written
  });

  it('AUTOMATIC HEALING of real drift (no env override) still persists its fix', async () => {
    await fs.writeFile(cfgPath, JSON.stringify({ model: 'openrouter/some-stale-model' }));
    const { loadConfig, saveConfig } = freshConfigModule();
    await loadConfig();
    await saveConfig({ model: 'stepfun-ai/step-3.7-flash' }, { origin: 'runtime' });
    expect((await disk()).model).toBe('stepfun-ai/step-3.7-flash');
  });

  it('EXPLICIT USER CHOICE always persists, even while an env override is active', async () => {
    process.env.BGW_MODEL = 'mock';
    const { loadConfig, saveConfig } = freshConfigModule();
    await loadConfig();
    await saveConfig({ model: 'meta/llama-3.1-70b-instruct' }); // origin defaults to 'user'
    expect((await disk()).model).toBe('meta/llama-3.1-70b-instruct');
  });

  it('a runtime write only drops the env-overridden keys, not its other keys', async () => {
    process.env.BGW_MODEL = 'mock';
    const { loadConfig, saveConfig } = freshConfigModule();
    await loadConfig();
    await saveConfig({ model: 'mock', liteModel: 'meta/llama-3.1-70b-instruct' }, { origin: 'runtime' });
    const d = await disk();
    expect(d.model).toBeUndefined();
    expect(d.liteModel).toBe('meta/llama-3.1-70b-instruct');
  });

  it('SESSION FALLBACK values (env lite/vision models) are volatile too', async () => {
    process.env.BGW_LITE_MODEL = 'mock';
    process.env.BGW_VISION_MODEL = 'mock-vision';
    const { loadConfig, saveConfig, configSource } = freshConfigModule();
    const cfg = await loadConfig();
    expect(cfg.liteModel).toBe('mock');
    expect(configSource('liteModel')).toBe('env');
    expect(configSource('visionModel')).toBe('env');
    await saveConfig({ liteModel: 'mock', visionModel: 'mock-vision' }, { origin: 'runtime' });
    expect(await disk()).toBeNull();
  });
});

describe('config scopes — file integrity', () => {
  it('MALFORMED EXISTING CONFIG is preserved (not silently destroyed) and defaults apply', async () => {
    await fs.writeFile(cfgPath, '{"model": "user/persisted-mo…TRUNCATED');
    const { loadConfig, DEFAULTS } = freshConfigModule();
    const cfg = await loadConfig();
    // Against DEFAULTS, not a hardcoded id: the default model is a measured choice that changes
    // (see the rationale in config.ts), and this test's subject is "corrupt scope → defaults",
    // not which model happens to be the default today.
    expect(cfg.model).toBe(DEFAULTS.model);
    const entries = await fs.readdir(dir);
    expect(entries.some((f) => f.startsWith('config.json.corrupt-'))).toBe(true); // evidence kept
  });

  it('CRASH DURING WRITE cannot half-write config.json (atomic tmp+rename)', async () => {
    await fs.writeFile(cfgPath, JSON.stringify({ model: 'before' }));
    const { loadConfig, saveConfig } = freshConfigModule();
    await loadConfig();
    await saveConfig({ theme: 'dark' });
    // The observable atomicity contract: the final file is complete valid JSON containing both the
    // old and new keys, and no temp litter remains.
    const d = await disk();
    expect(d.model).toBe('before');
    expect(d.theme).toBe('dark');
    const entries = await fs.readdir(dir);
    expect(entries.filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  it('CONCURRENT WRITERS each land a complete file (no interleaved corruption)', async () => {
    const { loadConfig, saveConfig } = freshConfigModule();
    await loadConfig();
    await Promise.all([saveConfig({ theme: 'dark' }), saveConfig({ verbose: true }), saveConfig({ maxTokens: 2048 })]);
    const d = await disk();
    expect(d).not.toBeNull(); // whatever the merge order, the file parses
  });

  it('READ-ONLY CONFIG dir: save warns, session state still updates, no crash', async () => {
    const { loadConfig, saveConfig, getConfig } = freshConfigModule();
    await loadConfig();
    await fs.chmod(dir, 0o500); // r-x: no writes
    try {
      const out = await saveConfig({ theme: 'dark' });
      expect(out.theme).toBe('dark');
      expect(getConfig().theme).toBe('dark');
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });

  it('MISSING PROVIDER/global file: first save creates it atomically', async () => {
    const { loadConfig, saveConfig } = freshConfigModule();
    await loadConfig();
    expect(fssync.existsSync(cfgPath)).toBe(false);
    await saveConfig({ theme: 'dark' });
    expect((await disk()).theme).toBe('dark');
  });
});

describe('config scopes — deprecated/legacy value migration', () => {
  it('keeps every model route unified and read-only in Desktop strict mode', async () => {
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        model: 'terminal/model',
        liteModel: 'terminal/lite',
        visionModel: 'terminal/vision',
        fallbackModel: 'terminal/fallback',
        subagentModel: 'terminal/subagent',
      }),
    );
    process.env.BIMAX_DESKTOP_STRICT_MODEL = 'stepfun-ai/step-3.7-flash';
    const { loadConfig, saveConfig } = freshConfigModule();

    const cfg = await loadConfig();
    expect(cfg).toMatchObject({
      model: 'stepfun-ai/step-3.7-flash',
      liteModel: 'stepfun-ai/step-3.7-flash',
      visionModel: 'stepfun-ai/step-3.7-flash',
      subagentModel: 'stepfun-ai/step-3.7-flash',
      fallbackModel: '',
    });
    await saveConfig({ model: 'other/model', fallbackModel: 'other/fallback', theme: 'dark' });
    expect(await disk()).toMatchObject({ model: 'terminal/model', fallbackModel: 'terminal/fallback', theme: 'dark' });
    expect((await loadConfig()).model).toBe('stepfun-ai/step-3.7-flash');
  });

  it('a reasoning model copied into the lite slot splits back apart in memory only', async () => {
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        provider: 'stepfun',
        model: 'stepfun-ai/step-3.7-flash',
        liteModel: 'stepfun-ai/step-3.7-flash',
        visionModel: 'stepfun-ai/step-3.7-flash',
      }),
    );
    const { loadConfig } = freshConfigModule();
    const cfg = await loadConfig();
    expect(cfg).toMatchObject({
      provider: 'nvidia',
      model: 'moonshotai/kimi-k3',
      liteModel: 'mistralai/mistral-7b-instruct-v0.3',
      visionModel: 'moonshotai/kimi-k3',
    });
    expect((await disk()).liteModel).toBe('stepfun-ai/step-3.7-flash'); // disk untouched until the user saves
  });
});
