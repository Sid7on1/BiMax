import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractTextLayer, pdfPageCount, pdfToolingAvailable, rasterizePages, readPdf, PdfToolingMissing, type RasterOptions } from '../documents/pdf.raster';

// Jest virtualizes process.env; explicitly pass that fixture environment to real child processes.
// No outputs are mocked: private executables produce every result and failure on disk.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process') as typeof import('child_process');
  const execFile = (file: string, args: string[], options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) =>
    actual.execFile(file, args, { ...options, env: process.env }, callback);
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (file: string, args: string[], options: object) => new Promise((resolve, reject) => {
      execFile(file, args, options, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
    }),
  });
  return { ...actual, execFile };
});

describe('PDF reader sprint — real child processes and exact page ownership', () => {
  let dir: string; let bin: string; let file: string; let oldPath: string | undefined;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-pdf-sprint-')));
    bin = path.join(dir, 'bin'); fs.mkdirSync(bin); file = path.join(dir, 'input.pdf'); fs.writeFileSync(file, '%PDF-fixture');
    oldPath = process.env.PATH; process.env.PATH = bin; jest.spyOn(os, 'tmpdir').mockReturnValue(dir);
  });
  afterEach(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const binary = (name: string, body: string, mode = 0o755) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}\n`, { mode });
  const info = (pages = 3) => binary('pdfinfo', `process.stdout.write('Pages: ${pages}\\n');`);
  const text = (value: string) => binary('pdftotext', `process.stdout.write(${JSON.stringify(value)});`);
  const render = (numbers: number[]) => binary('pdftoppm', `const fs = require('fs'); const prefix = process.argv.at(-1); for (const n of ${JSON.stringify(numbers)}) fs.writeFileSync(prefix + '-' + n + '.png', 'image-' + n);`);

  it('preserves the final text page when the output has no trailing form feed', async () => {
    text('first page\fsecond page');
    expect(await extractTextLayer(file)).toEqual(['first page', 'second page']);
  });

  it('does not invent page one for an empty page-count fallback', async () => {
    binary('pdfinfo', "process.exit(1);"); text('');
    expect(await pdfPageCount(file).catch(error => error)).toBeInstanceOf(Error);
  });

  it('retains malformed-PDF failures instead of diagnosing an installed reader as missing', async () => {
    binary('pdfinfo', "process.exit(1);"); binary('pdftotext', "process.stderr.write('malformed PDF'); process.exit(1);");
    const result = await pdfPageCount(file).catch(error => error);
    expect(result).toBeInstanceOf(Error); expect(result).not.toBeInstanceOf(PdfToolingMissing);
    expect((result as Error).message).toContain('malformed PDF');
  });

  it('refuses inaccessible tooling rather than reporting it ready', async () => {
    binary('pdftotext', '', 0o644); binary('pdftoppm', '', 0o644);
    expect(await pdfToolingAvailable().catch(error => error)).toBeInstanceOf(Error);
  });

  it('enforces a requested short deadline', async () => {
    binary('pdftotext', "process.on('SIGTERM', () => {}); setTimeout(() => process.stdout.write('late\\f'), 700);");
    const started = Date.now(); const result = await extractTextLayer(file, { timeoutMs: 150 }).catch(error => error);
    expect(result).toHaveProperty('code', 'ETIMEDOUT'); expect(Date.now() - started).toBeLessThan(650);
  });

  it('honors an already-aborted read before launching any child', async () => {
    const launched = path.join(dir, 'launched');
    binary('pdftotext', `require('fs').writeFileSync(${JSON.stringify(launched)}, 'launched'); process.stdout.write('text\\f');`);
    const controller = new AbortController(); controller.abort();
    const options: RasterOptions & { signal: AbortSignal } = { signal: controller.signal };
    expect(await extractTextLayer(file, options).catch(error => error)).toHaveProperty('name', 'AbortError');
    expect(fs.existsSync(launched)).toBe(false);
  });

  it('preserves pre-abort reasons without probing tooling or falling back', async () => {
    const launched = path.join(dir, 'launched');
    for (const name of ['pdfinfo', 'pdftotext', 'pdftoppm']) binary(name, `require('fs').writeFileSync(${JSON.stringify(launched)}, 'launched');`);
    for (const reason of [null, Object.assign(new Error('Stop'), { code: 'ENOENT' })]) {
      const controller = new AbortController(); controller.abort(reason);
      expect(await pdfToolingAvailable({ signal: controller.signal }).catch(error => error)).toBe(reason);
      expect(await pdfPageCount(file, { signal: controller.signal }).catch(error => error)).toBe(reason);
    }
    expect(fs.existsSync(launched)).toBe(false);
  });

  it('validates page ranges before spawning readers', async () => {
    const launched = path.join(dir, 'launched');
    binary('pdftotext', `require('fs').writeFileSync(${JSON.stringify(launched)}, 'launched'); process.stdout.write('text\\f');`);
    for (const options of [{ firstPage: 0 }, { firstPage: 1.5 }, { firstPage: 3, lastPage: 2 }, { dpi: -1 }]) {
      expect(await extractTextLayer(file, options).catch(error => error)).toBeInstanceOf(Error);
    }
    expect(fs.existsSync(launched)).toBe(false);
  });

  it('cannot reuse stale images from a caller-owned output directory', async () => {
    const parent = path.join(dir, 'output'); fs.mkdirSync(parent); const stale = path.join(parent, 'page-99.png'); fs.writeFileSync(stale, 'old');
    render([1]); const result = await rasterizePages(file, { outDir: parent });
    expect(result.images.map(p => path.basename(p))).toEqual(['page-1.png']); expect(fs.readFileSync(stale, 'utf8')).toBe('old');
  });

  it('refuses incomplete rendered page coverage instead of silently dropping scanned pages', async () => {
    info(3); text('\f\f\f'); render([1, 3]);
    expect(await readPdf(file).catch(error => error)).toBeInstanceOf(Error);
  });

  it('rasterizes only the envelope of pages without readable text', async () => {
    const sentence = 'This is enough meaningful readable text to qualify as the exact text layer.';
    info(3); text(`${sentence}\f\f${sentence}\f`);
    const argv = path.join(dir, 'render-argv');
    binary('pdftoppm', `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2))); fs.writeFileSync(process.argv.at(-1) + '-2.png', 'image-2');`);
    const result = await readPdf(file);
    expect(result.pages.map(p => [p.page, p.source])).toEqual([[1, 'text-layer'], [2, 'raster'], [3, 'text-layer']]);
    const args: string[] = JSON.parse(fs.readFileSync(argv, 'utf8'));
    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2)).toEqual(['-f', '2']);
    expect(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2)).toEqual(['-l', '2']);
  });
  it('stops an in-flight read and its inherited worker process group', async () => {
    const launched = path.join(dir, 'launched'); const late = path.join(dir, 'descendant-late');
    const descendantReady = path.join(dir, 'descendant-ready');
    const descendantCode = `require('fs').writeFileSync(${JSON.stringify(descendantReady)}, 'ready'); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(late)}, 'late'), 700);`;
    binary('pdftotext', `const fs = require('fs'); const cp = require('child_process');
      cp.spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'inherit' });
      const watch = setInterval(() => { if (fs.existsSync(${JSON.stringify(descendantReady)})) { clearInterval(watch); fs.writeFileSync(${JSON.stringify(launched)}, 'ready'); } }, 10);
      process.on('SIGTERM', () => {});`);
    const controller = new AbortController(); const pending = extractTextLayer(file, { signal: controller.signal, timeoutMs: 4500 }).catch(error => error);
    for (let i = 0; i < 150 && !fs.existsSync(launched); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const ready = fs.existsSync(launched); controller.abort();
    expect(await pending).toHaveProperty('name', 'AbortError'); expect(ready).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(fs.existsSync(late)).toBe(false);
  });

  it('keeps split UTF-8 text intact across stdout chunks', async () => {
    binary('pdftotext', "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82,0xac,0x0c])), 40);");
    expect(await extractTextLayer(file)).toEqual(['€']);
  });

  it('bounds combined captured output and does not retry after overflow', async () => {
    const fallback = path.join(dir, 'fallback');
    binary('pdfinfo', "process.stdout.write(Buffer.alloc(700000, 65)); process.stderr.write(Buffer.alloc(700000, 66));");
    binary('pdftotext', `require('fs').writeFileSync(${JSON.stringify(fallback)}, 'bad retry'); process.stdout.write('text\\f');`);
    expect(await pdfPageCount(file).catch(error => error)).toHaveProperty('code', 'ERR_PDF_OUTPUT_LIMIT');
    expect(fs.existsSync(fallback)).toBe(false);
  });

  it('does not start a fallback after a metadata deadline', async () => {
    const fallback = path.join(dir, 'fallback');
    binary('pdfinfo', "setTimeout(() => process.stdout.write('Pages: 1\\n'), 1700);");
    binary('pdftotext', `require('fs').writeFileSync(${JSON.stringify(fallback)}, 'bad retry'); process.stdout.write('text\\f');`);
    expect(await pdfPageCount(file, { timeoutMs: 1000 }).catch(error => error)).toHaveProperty('code', 'ETIMEDOUT');
    expect(fs.existsSync(fallback)).toBe(false);
  });

  it('distinguishes missing executables from installed nonzero version flags', async () => {
    expect(await pdfToolingAvailable()).toEqual({ ok: false, missing: ['pdftotext', 'pdftoppm'] });
    binary('pdftotext', 'process.exit(1);'); binary('pdftoppm', 'process.exit(2);');
    expect(await pdfToolingAvailable()).toEqual({ ok: true, missing: [] });
  });

  it('disposes successful renders idempotently while preserving caller-owned files', async () => {
    const parent = path.join(dir, 'output'); fs.mkdirSync(parent); const owned = path.join(parent, 'keep'); fs.writeFileSync(owned, 'caller');
    render([1]); const result = await rasterizePages(file, { outDir: parent });
    expect(fs.existsSync(result.images[0])).toBe(true);
    await result.dispose(); await result.dispose();
    expect(fs.existsSync(result.outDir)).toBe(false); expect(fs.readFileSync(owned, 'utf8')).toBe('caller');
  });

  it('cleans incomplete coverage before rejecting it', async () => {
    info(3); text('\f\f\f'); render([1,3]);
    const parent = path.join(dir, 'output');
    expect(await readPdf(file, { outDir: parent }).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('rejects duplicate page identities and removes their job', async () => {
    info(1); text('\f');
    binary('pdftoppm', "const fs=require('fs'); const p=process.argv.at(-1); fs.writeFileSync(p+'-1.png','one'); fs.writeFileSync(p+'-01.png','another');");
    const parent = path.join(dir, 'output');
    expect(await readPdf(file, { outDir: parent }).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('rejects linked images without touching their targets', async () => {
    const target = path.join(dir, 'keep'); fs.writeFileSync(target, 'caller');
    binary('pdftoppm', `require('fs').symlinkSync(${JSON.stringify(target)}, process.argv.at(-1)+'-1.png');`);
    const parent = path.join(dir, 'output');
    expect(await rasterizePages(file, { outDir: parent }).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readdirSync(parent)).toEqual([]); expect(fs.readFileSync(target,'utf8')).toBe('caller');
  });

  it('cleans a partially rendered job on cancellation', async () => {
    const parent = path.join(dir, 'output'); const ready = path.join(dir, 'ready');
    binary('pdftoppm', `const fs=require('fs'); fs.writeFileSync(process.argv.at(-1)+'-1.png','partial'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>{},900);`);
    const controller = new AbortController(); const pending = rasterizePages(file,{ outDir: parent, signal: controller.signal }).catch(error=>error);
    for(let i=0;i<150&&!fs.existsSync(ready);i++) await new Promise(resolve=>setTimeout(resolve,20));
    const launched = fs.existsSync(ready); controller.abort();
    expect(await pending).toHaveProperty('name','AbortError'); expect(launched).toBe(true); expect(fs.readdirSync(parent)).toEqual([]);
  });

});
