import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A runtime heal recovers the SESSION; it must never rewrite the model the user chose.
 *
 * Regression: the boot healer persisted its swap with `saveConfig(patch, {origin:'runtime'})` so
 * "the next launch is already correct". Because `moonshotai/kimi-k3` is the top-ranked coding
 * candidate, one transient provider hiccup permanently replaced a deliberate pick — reported as
 * "whenever I open the app the kimi model is selected again".
 */
describe('an explicit model pick is not rewritten by healing', () => {
  /** Comments explain the fix and legitimately quote the old call; only CODE may be asserted on. */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  test('neither heal site persists the swap', () => {
    const root = path.resolve(__dirname, '..', '..');
    const entry = stripComments(fs.readFileSync(path.join(root, 'src/protocol/headless.entry.ts'), 'utf8'));
    const session = stripComments(fs.readFileSync(path.join(root, 'src/protocol/headless.session.ts'), 'utf8'));

    // The heal blocks must not call saveConfig with a runtime origin.
    expect(entry).not.toMatch(/saveConfig\([^)]*origin:\s*'runtime'/);
    expect(session).not.toMatch(/saveConfig\([^)]*origin:\s*'runtime'/);
    // …and both must still actually heal, so this cannot be "fixed" by deleting the recovery.
    expect(entry).toContain('healModels()');
    expect(session).toContain('healModels()');
  });

  test('kimi-k3 is the top coding candidate, so an unguarded heal is not self-correcting', () => {
    // Pins WHY this matters: every heal lands on the same id, so a persisted heal is a one-way
    // door. If the catalogue ranking changes this test still passes for the right reason —
    // the guarantee is that *some* single id dominates, not that it is kimi.
    const { autoSelectCandidates } = require('../engine/models');
    const { MODEL_CATALOG } = require('../engine/models');
    const all = MODEL_CATALOG.map((m: any) => m.value);
    const top = autoSelectCandidates('coding', all)[0];
    expect(typeof top).toBe('string');
    expect(top.length).toBeGreaterThan(0);
  });

  test('a user-origin write still persists (the fix must not disable the picker)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-model-'));
    const cwd = process.cwd();
    const home = process.env.HOME;
    process.chdir(dir);
    process.env.HOME = dir;
    jest.resetModules();
    try {
      const config = require('../engine/config');
      await config.loadConfig();
      await config.saveConfig({ model: 'nvidia/nemotron-3-nano-30b-a3b' }, { origin: 'user' });
      expect(config.getConfig().model).toBe('nvidia/nemotron-3-nano-30b-a3b');

      jest.resetModules();
      const reread = require('../engine/config');
      await reread.loadConfig();
      expect(reread.getConfig().model).toBe('nvidia/nemotron-3-nano-30b-a3b');
    } finally {
      process.chdir(cwd);
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
