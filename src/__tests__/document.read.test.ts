import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildPdf } from '../documents/pdf.writer';
import {
  readPdf, extractTextLayer, rasterizePages, hasTextLayer, pageNumberOf,
  pdfToolingAvailable, pdfPageCount,
} from '../documents/pdf.raster';
import { selectOcrBackend, ocrPages, NoOcrBackend, VisionOcrBackend, OcrBackend } from '../documents/ocr';

/**
 * These run against a REAL PDF produced by the product's own writer and a real rasterizer, because
 * the defect this closes was never a logic error — it was that the whole path did not exist. A
 * mocked poppler would prove that the mock works.
 */
let dir: string;
let digitalPdf: string;
let scannedPdf: string;

/**
 * Resolved at MODULE LOAD, not in `beforeAll`.
 *
 * `describe` callbacks run during collection, before any hook fires, so a flag set in `beforeAll`
 * is still false when the gate is evaluated and every gated block silently skips. That is how this
 * suite first reported 8 passed / 5 skipped on a machine with poppler installed — a green run that
 * had exercised none of the path it exists to cover.
 */
function binaryPresent(binary: string): boolean {
  try {
    execFileSync(binary, ['-v'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch (error: unknown) {
    return (error as { code?: string }).code !== 'ENOENT';
  }
}
const haveTooling = binaryPresent('pdftotext') && binaryPresent('pdftoppm');

const SAMPLE = {
  title: 'Equipment Inspection Report',
  subtitle: 'Crude Distillation Unit - Vessel PV-4021-A',
  date: '12 August 2026',
  blocks: [
    { kind: 'heading' as const, level: 2 as const, text: 'Findings' },
    { kind: 'paragraph' as const, text: 'Ultrasonic thickness survey recorded a minimum shell thickness of 8.2 mm against a design minimum of 9.0 mm at grid location C4.' },
    { kind: 'heading' as const, level: 2 as const, text: 'Recommendation' },
    { kind: 'paragraph' as const, text: 'Replace the affected shell course within 90 days.' },
  ],
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-doc-test-'));
  digitalPdf = path.join(dir, 'inspection.pdf');
  fs.writeFileSync(digitalPdf, await buildPdf(SAMPLE));

  // Cross-check the synchronous gate against the module's own probe: if these ever disagree, the
  // suite is testing something other than what it reports.
  expect((await pdfToolingAvailable()).ok).toBe(haveTooling);
  if (haveTooling) {
    // A "scanned" PDF: render the digital one to an image and wrap the image back into a PDF, so it
    // carries a picture of text and no text layer. That is exactly what a flatbed scanner produces.
    const { images } = await rasterizePages(digitalPdf, { outDir: path.join(dir, 'raster'), dpi: 150, lastPage: 1 });
    scannedPdf = path.join(dir, 'scanned.pdf');
    try {
      execFileSync('/usr/bin/sips', ['-s', 'format', 'pdf', images[0], '--out', scannedPdf], { stdio: 'ignore' });
    } catch { scannedPdf = ''; }
  }
}, 120_000);

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });

describe('hasTextLayer — the scanned-versus-digital discriminator', () => {
  it('accepts a page with real prose', () => {
    expect(hasTextLayer('Ultrasonic thickness survey recorded a minimum shell thickness of 8.2 mm')).toBe(true);
  });

  it('rejects the stray punctuation a scanned page carries instead of text', () => {
    // A naive length check accepts this; counting only letters and digits does not.
    expect(hasTextLayer('   .  \n\n  -   \f  ,,,   ')).toBe(false);
    expect(hasTextLayer('')).toBe(false);
    expect(hasTextLayer(undefined)).toBe(false);
  });

  it('rejects a page with a few stray characters', () => {
    expect(hasTextLayer('Page 1')).toBe(false);
  });
});

describe('pageNumberOf — ordering rendered pages', () => {
  it('reads the number, not the filename, so inconsistent zero-padding cannot reorder pages', () => {
    const names = ['/t/page-9.png', '/t/page-10.png', '/t/page-1.png'];
    expect(names.sort((a, b) => pageNumberOf(a) - pageNumberOf(b)))
      .toEqual(['/t/page-1.png', '/t/page-9.png', '/t/page-10.png']);
  });
});

const withTooling = () => (haveTooling ? describe : describe.skip);

withTooling()('reading a digital PDF', () => {
  it('counts its pages', async () => {
    expect(await pdfPageCount(digitalPdf)).toBeGreaterThanOrEqual(1);
  });

  it('reads every page that has content EXACTLY, never through OCR', async () => {
    const result = await readPdf(digitalPdf);
    expect(result.pages.length).toBeGreaterThan(0);

    // The property that matters: the content came from the text layer, not from a recognizer. OCR
    // on a digital PDF is slower and lossy, and it is exactly where a misread digit in a wall
    // thickness would come from.
    const contentPages = result.pages.filter(p => p.source === 'text-layer');
    expect(contentPages.length).toBeGreaterThan(0);
    const all = contentPages.map(p => p.text).join('\n');
    expect(all).toContain('PV-4021-A');
    expect(all).toContain('8.2 mm');

    // The writer emits a trailing page carrying only a footer page number. It has no meaningful
    // text layer, so it is rasterized — correctly, because per-page classification is what lets a
    // typed report with a photographed annexe get exact text for the body and OCR for the annexe.
    for (const page of result.pages) {
      if (page.source === 'raster') expect(page.text).toBeUndefined();
    }
  }, 60_000);

  it('honours a page range', async () => {
    const layers = await extractTextLayer(digitalPdf, { firstPage: 1, lastPage: 1 });
    expect(layers).toHaveLength(1);
  }, 60_000);

  it('rasterizes on demand and names pages in order', async () => {
    const { images } = await rasterizePages(digitalPdf, { outDir: path.join(dir, 'r2'), dpi: 72 });
    expect(images.length).toBeGreaterThan(0);
    expect(images.map(pageNumberOf)).toEqual([...images.map(pageNumberOf)].sort((a, b) => a - b));
    for (const image of images) expect(fs.statSync(image).size).toBeGreaterThan(0);
  }, 60_000);

  it('refuses a file that is not there', async () => {
    await expect(readPdf(path.join(dir, 'nope.pdf'))).rejects.toThrow('No such file');
  });
});

describe('OCR backend selection', () => {
  it('picks nothing, and says what to install, when no backend exists', async () => {
    const none: OcrBackend[] = [{ name: 'tesseract', available: async () => false, recognize: async () => [] }];
    expect(await selectOcrBackend(none)).toBeNull();
    // Silence would be the dangerous failure: an empty result makes a scanned report look blank,
    // and the model would then summarise a document it never read.
    await expect(ocrPages(['/x.png'], none)).rejects.toThrow(NoOcrBackend);
    await expect(ocrPages(['/x.png'], none)).rejects.toThrow(/entirely offline/);
  });

  it('prefers the first available backend', async () => {
    const second: OcrBackend = { name: 'tesseract', available: async () => true, recognize: async () => [] };
    const first: OcrBackend = { name: 'vision', available: async () => true, recognize: async () => [] };
    expect((await selectOcrBackend([first, second]))!.name).toBe('vision');
  });

  it('never selects Vision off macOS', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      expect(await new VisionOcrBackend().available()).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }
  });
});

const ocrAvailable = process.platform === 'darwin';
(ocrAvailable ? describe : describe.skip)('end-to-end: a scanned page becomes text', () => {
  it('recovers the tag number and the measurement from a picture of the report', async () => {
    if (!haveTooling || !scannedPdf) return;                 // no poppler/sips on this machine
    const result = await readPdf(scannedPdf, { dpi: 150 });
    const raster = result.pages.filter(p => p.source === 'raster' && p.imagePath);
    expect(raster.length).toBeGreaterThan(0);                 // it really has no text layer

    const { backend, pages } = await ocrPages(raster.map(p => p.imagePath!));
    expect(backend).toBe('vision');
    const text = pages.map(p => p.text).join('\n');
    // The two facts an engineer would act on.
    expect(text).toContain('PV-4021-A');
    expect(text).toMatch(/8\.2\s*mm/);
    expect(pages[0].confidence).toBeGreaterThan(0.5);
  }, 180_000);
});
