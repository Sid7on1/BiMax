import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The distinction this report exists to make: DOWNLOADED is not SERVABLE.
 *
 * A `models--org--name` directory means weights may be on disk; it never means something will
 * answer a chat request. Measured on the development machine: six such entries at 4 KB each — the
 * shells left by metadata-only fetches, with no weights at all. Presenting those as usable models
 * sends the user to a picker entry where every request 404s.
 */
describe('local model discovery', () => {
  let home: string;
  let realHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-local-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
    jest.resetModules();
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const hubEntry = (repo: string, bytes: number): void => {
    const dir = path.join(home, '.cache', 'huggingface', 'hub', `models--${repo.replace(/\//g, '--')}`, 'blobs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'weights.bin'), Buffer.alloc(bytes));
  };

  test('a weightless cache entry is reported as having nothing to serve', async () => {
    hubEntry('Org/Empty', 4096);
    const { discoverLocalModels } = require('../main/local.models');
    const report = await discoverLocalModels();
    const hf = report.runtimes.find((r: { id: string }) => r.id === 'huggingface');
    expect(hf.installed).toBe(true);
    expect(hf.models).toHaveLength(1);
    expect(hf.models[0].servable).toBe(false);
    expect(hf.models[0].detail).toMatch(/no weights/i);
    expect(hf.hint).toMatch(/none with weights/i);
  });

  test('a real cached model reports its size and still is not servable', async () => {
    hubEntry('Org/Real', 2_000_000);
    const { discoverLocalModels } = require('../main/local.models');
    const report = await discoverLocalModels();
    const hf = report.runtimes.find((r: { id: string }) => r.id === 'huggingface');
    expect(hf.models[0].sizeBytes).toBeGreaterThan(1_000_000);
    // Weights on disk are still not an endpoint.
    expect(hf.models[0].servable).toBe(false);
    expect(report.servable).toHaveLength(0);
  });

  test('every runtime that is absent says so instead of appearing empty-but-fine', async () => {
    const { discoverLocalModels } = require('../main/local.models');
    const report = await discoverLocalModels();
    for (const rt of report.runtimes) {
      if (!rt.installed) expect(rt.hint.length).toBeGreaterThan(3);
      expect(typeof rt.running).toBe('boolean');
    }
  });

  test('servable collects only models a running server will accept', async () => {
    hubEntry('Org/Real', 2_000_000);
    const { discoverLocalModels } = require('../main/local.models');
    const report = await discoverLocalModels();
    for (const m of report.servable) expect(m.servable).toBe(true);
  });
});
