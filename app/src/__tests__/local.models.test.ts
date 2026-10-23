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
    // HOME fences the disk; this fences the network. Ollama and LM Studio are detected by asking
    // localhost, so without a stub every assertion about `servable` depends on whether the machine
    // running the suite has a local server up — the development machine serves two Ollama models.
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no local server in this test'));
    jest.resetModules();
  });
  afterEach(() => {
    jest.restoreAllMocks();
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
    // With the network fenced, `servable` is always empty and a loop over it asserts nothing. So a
    // server is stood up for this one: Ollama answers, LM Studio does not, and a weightless cache
    // entry sits beside them — only the listed Ollama model may come back.
    hubEntry('Org/Real', 2_000_000);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) !== 'http://localhost:11434/api/tags') throw new Error('connection refused');
      return {
        ok: true,
        json: async () => ({ models: [{ name: 'qwen2.5:0.5b', size: 397_821_319 }, { size: 1 }] }),
      } as unknown as Response;
    });
    const { discoverLocalModels } = require('../main/local.models');
    const report = await discoverLocalModels();
    const ollama = report.runtimes.find((r: { id: string }) => r.id === 'ollama');
    expect(ollama.running).toBe(true);
    expect(ollama.baseURL).toBe('http://localhost:11434/v1');
    expect(report.servable.map((m: { id: string }) => m.id)).toEqual(['qwen2.5:0.5b']);
  });
});
