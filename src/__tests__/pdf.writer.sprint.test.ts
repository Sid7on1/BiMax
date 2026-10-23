import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildPdf } from '../documents/pdf.writer';
import { extractTextLayer, pdfPageCount, readPdf } from '../documents/pdf.raster';

const BODY = 'Ultrasonic inspection confirms a minimum shell thickness of 8.2 mm at grid location C4. This page must remain exact text without OCR.';

describe('PDF writer sprint — real final pagination and page numbers', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-pdf-pages-'))); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps a short digital report on one page without a footer-only OCR page', async () => {
    const file = path.join(dir, 'single.pdf'); fs.writeFileSync(file, await buildPdf({ title: 'Inspection', blocks: [{ kind: 'paragraph', text: BODY }] }));
    expect(await pdfPageCount(file)).toBe(1);
    const result = await readPdf(file);
    expect(result.pages.map(page => page.source)).toEqual(['text-layer']);
    expect(result.pages[0]?.text).toContain('8.2 mm');
  });

  it('numbers every finished page sequentially without creating extra pages', async () => {
    const file = path.join(dir, 'three.pdf'); fs.writeFileSync(file, await buildPdf({ title: 'Inspection', blocks: [
      { kind: 'paragraph', text: `Course one. ${BODY}` }, { kind: 'pagebreak' },
      { kind: 'paragraph', text: `Course two. ${BODY}` }, { kind: 'pagebreak' },
      { kind: 'paragraph', text: `Course three. ${BODY}` },
    ] }));
    expect(await pdfPageCount(file)).toBe(3);
    const layers = await extractTextLayer(file);
    expect(layers).toHaveLength(3);
    for (let i = 0; i < layers.length; i++) expect(layers[i].trim()).toMatch(new RegExp(`(?:^|\\n)\\s*${i + 1}\\s*$`));
    expect(layers.map(text => text.includes('8.2 mm'))).toEqual([true, true, true]);
  });
});
