import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractFile } from '../documents/extract';
import { createReadDocumentTool } from '../tools/implementations/readdoc.tool';
import * as docling from '../documents/docling';
import * as raster from '../documents/pdf.raster';
import * as ocr from '../documents/ocr';
import type { IGovernor } from '../core/interfaces';

jest.mock('../documents/docling', () => ({ doclingAvailable: jest.fn(), doclingConvert: jest.fn(), toSegments: jest.fn() }));
jest.mock('../documents/pdf.raster', () => ({
  extractTextLayer: jest.fn(), hasTextLayer: jest.fn(() => false), readPdf: jest.fn(), pdfToolingAvailable: jest.fn(),
  PdfToolingMissing: class extends Error {},
}));
jest.mock('../documents/ocr', () => ({ ocrPages: jest.fn(), NoOcrBackend: class extends Error {} }));
// The tool's resource lifetime is exercised independently of the governor/transport wrapper.
jest.mock('../tools/tool.factory', () => ({ buildTool: (config: object) => config }));

let dir: string; let file: string; let image: string; let job: string;
let dispose: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-pdf-cleanup-'));
  file = path.join(dir, 'scan.pdf'); fs.writeFileSync(file, '%PDF-stub');
  job = path.join(dir, 'owned'); fs.mkdirSync(job); image = path.join(job, 'page-1.png'); fs.writeFileSync(image, 'image');
  dispose = jest.fn(async () => { await fs.promises.rm(job, { recursive: true, force: true }); });
  jest.mocked(raster.readPdf).mockResolvedValue({ pages: [{ page: 1, source: 'raster', imagePath: image }], totalPages: 1, dispose });
  jest.mocked(raster.extractTextLayer).mockResolvedValue(['']);
  jest.mocked(raster.pdfToolingAvailable).mockResolvedValue({ ok: true, missing: [] });
  jest.mocked(docling.doclingAvailable).mockResolvedValue(false);
  jest.mocked(docling.doclingConvert).mockResolvedValue([{ path: file, ok: true, paged: true, pages: [] }]);
  jest.mocked(docling.toSegments).mockReturnValue([]);
  jest.mocked(ocr.ocrPages).mockImplementation(async () => {
    expect(fs.existsSync(image)).toBe(true);
    return { backend: 'vision', pages: [{ imagePath: image, text: 'Inspected shell thickness is 8.2 mm.', lines: 1, confidence: 0.9 }] };
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

for (const layout of [false, true]) {
  for (const fails of [false, true]) {
    it(`cleans ${layout ? 'layout merge' : 'fallback extraction'} after OCR ${fails ? 'failure' : 'success'}`, async () => {
      jest.mocked(docling.doclingAvailable).mockResolvedValue(layout);
      if (layout) {
        jest.mocked(docling.toSegments).mockReturnValue([{ text: 'Layout retained page two.', locator: { page: 2 }, via: 'layout' }]);
        jest.mocked(raster.extractTextLayer).mockResolvedValue(['', '']);
      }
      if (fails) jest.mocked(ocr.ocrPages).mockImplementation(async () => { expect(fs.existsSync(image)).toBe(true); throw new Error('recognizer failed'); });
      const result = await extractFile(file);
      expect(dispose).toHaveBeenCalledTimes(1); expect(fs.existsSync(job)).toBe(false);
      expect(raster.extractTextLayer).toHaveBeenCalledTimes(layout ? 1 : 0);
      if (fails) expect(result.note).toContain('recognizer failed');
      else expect(result.segments[0].text).toContain('8.2 mm');
    });
  }
}

it('keeps tool images until OCR completes, then removes the job', async () => {
  const config = createReadDocumentTool({} as IGovernor) as unknown as { execute: (args: object, context: object) => Promise<unknown> };
  await config.execute({ path: file }, { cwd: dir });
  expect(dispose).toHaveBeenCalledTimes(1); expect(fs.existsSync(job)).toBe(false);
});

it('propagates a Stop received during OCR and cleans instead of returning success', async () => {
  const controller = new AbortController();
  jest.mocked(ocr.ocrPages).mockImplementation(async () => {
    expect(fs.existsSync(image)).toBe(true); controller.abort();
    return { backend: 'vision', pages: [] };
  });
  const config = createReadDocumentTool({} as IGovernor) as unknown as { execute: (args: object, context: object) => Promise<unknown> };
  expect(await config.execute({ path: file }, { cwd: dir, signal: controller.signal }).catch(error => error)).toHaveProperty('name', 'AbortError');
  expect(dispose).toHaveBeenCalledTimes(1); expect(fs.existsSync(job)).toBe(false);
});
