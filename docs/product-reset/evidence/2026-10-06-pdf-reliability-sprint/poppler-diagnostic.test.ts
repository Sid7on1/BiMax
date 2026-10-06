import * as childProcess from 'child_process';
import util from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPdf } from '../documents/pdf.writer';

it('diagnostic: trace real poppler settlement without replacing its custom promise', async () => {
  const original = util.promisify;
  const trace: object[] = [];
  jest.spyOn(util, 'promisify').mockImplementation(((fn: any) => {
    const invoke = original(fn);
    return (...args: any[]) => {
      const started = Date.now(); const promise = invoke(...args);
      trace.push({ event: 'start', command: args[0], pid: promise.child?.pid });
      promise.child?.on('exit', (code: number) => trace.push({ event: 'exit', command: args[0], code, ms: Date.now() - started }));
      promise.child?.on('close', (code: number) => trace.push({ event: 'close', command: args[0], code, ms: Date.now() - started }));
      promise.then(() => trace.push({ event: 'settled', command: args[0], ms: Date.now() - started }), () => trace.push({ event: 'rejected', command: args[0], ms: Date.now() - started }));
      return promise;
    };
  }) as any);
  const { extractTextLayer } = require('../documents/pdf.raster');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-pdf-diag-')); const file = path.join(dir, 'inspection.pdf');
  fs.writeFileSync(file, await buildPdf({ title: 'Inspection', blocks: [{ kind: 'paragraph', text: 'This is a real text layer. Thickness is 8.2 mm.' }] }));
  try {
    const layers = await extractTextLayer(file);
    expect(layers.join('\n')).toContain('8.2 mm');
  } finally {
    fs.writeFileSync(path.join(process.cwd(), 'docs/product-reset/evidence/2026-10-06-pdf-reliability-sprint/poppler-diagnostic.json'), JSON.stringify(trace, null, 2));
    jest.restoreAllMocks(); fs.rmSync(dir, { force: true, recursive: true });
  }
});
