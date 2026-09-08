import { Segment } from '../documents/extract';

/**
 * The scanned half of the per-page merge.
 *
 * A page with no text layer has no floor to be measured against, so the decision is different and
 * worth its own suite: the converter runs its own recognizer, so a scanned page it DID read is
 * better than re-recognising it ourselves — but a scanned page it dropped has nothing behind it
 * except OCR, and that page must still be rasterised and read rather than silently omitted.
 *
 * `pdf.raster` and `ocr` are both mocked here so the branch is exercised without poppler, without a
 * recognizer, and without a genuinely scanned fixture. That is the point: the thing under test is
 * the ROUTING DECISION, and the two suites that cover the real readers already exist.
 */

jest.mock('../documents/docling', () => ({
  doclingAvailable: jest.fn(),
  doclingConvert: jest.fn(),
  toSegments: jest.fn(),
}));

jest.mock('../documents/pdf.raster', () => ({
  extractTextLayer: jest.fn(),
  hasTextLayer: jest.fn((text?: string) => !!text && text.replace(/[^\p{L}\p{N}]/gu, '').length >= 20),
  readPdf: jest.fn(),
}));

jest.mock('../documents/ocr', () => ({ ocrPages: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const docling = require('../documents/docling') as Record<string, jest.Mock>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const raster = require('../documents/pdf.raster') as Record<string, jest.Mock>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ocr = require('../documents/ocr') as Record<string, jest.Mock>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { extractFile } = require('../documents/extract') as typeof import('../documents/extract');

const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');

let pdf: string;

const layoutSegment = (page: number, text: string): Segment => ({ text, locator: { page }, via: 'layout' });

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-layout-ocr-'));
  pdf = path.join(dir, 'scan.pdf');
  // Content is irrelevant — every reader is mocked. It only has to exist and be non-empty.
  fs.writeFileSync(pdf, '%PDF-1.4 stub');
});

beforeEach(() => {
  jest.clearAllMocks();
  docling.doclingAvailable.mockResolvedValue(true);
  docling.doclingConvert.mockResolvedValue([{ path: pdf, ok: true, paged: true, pages: [] }]);
  // Three scanned pages: no text layer anywhere.
  raster.extractTextLayer.mockResolvedValue(['', '', '']);
  raster.readPdf.mockResolvedValue({
    totalPages: 3,
    pages: [
      { page: 1, imagePath: '/tmp/page-1.png', source: 'raster' },
      { page: 2, imagePath: '/tmp/page-2.png', source: 'raster' },
      { page: 3, imagePath: '/tmp/page-3.png', source: 'raster' },
    ],
  });
});

describe('a scanned page the converter read is kept without re-recognising it', () => {
  it('does not rasterise at all when the converter covered every page', async () => {
    docling.toSegments.mockReturnValue([
      layoutSegment(1, 'Scanned findings for course one, recovered by the layout model.'),
      layoutSegment(2, 'Scanned findings for course two, recovered by the layout model.'),
      layoutSegment(3, 'Scanned findings for course three, recovered by the layout model.'),
    ]);

    const result = await extractFile(pdf);

    // The saving that makes this worth doing: no raster pass, no OCR pass.
    expect(raster.readPdf).not.toHaveBeenCalled();
    expect(ocr.ocrPages).not.toHaveBeenCalled();
    expect(result.segments.map((s) => s.via)).toEqual(['layout', 'layout', 'layout']);
  });
});

describe('a scanned page the converter dropped is still read', () => {
  beforeEach(() => {
    ocr.ocrPages.mockResolvedValue({
      backend: 'vision',
      pages: [{ imagePath: '/tmp/page-2.png', text: 'Recovered by OCR: minimum thickness 7.8 mm.', lines: 1, confidence: 0.91 }],
    });
  });

  it('OCRs ONLY the dropped page, not the whole document', async () => {
    docling.toSegments.mockReturnValue([
      layoutSegment(1, 'Scanned findings for course one, recovered by the layout model.'),
      layoutSegment(3, 'Scanned findings for course three, recovered by the layout model.'),
    ]);

    const result = await extractFile(pdf);

    expect(ocr.ocrPages).toHaveBeenCalledTimes(1);
    // Page 2 alone — rasterising all three is unavoidable, recognising all three is not.
    expect(ocr.ocrPages).toHaveBeenCalledWith(['/tmp/page-2.png']);

    expect(result.segments.map((s) => s.locator.page)).toEqual([1, 2, 3]);
    expect(result.segments.map((s) => s.via)).toEqual(['layout', 'ocr', 'layout']);
  });

  it('carries the recognizer confidence through, so a weak read can be flagged later', async () => {
    docling.toSegments.mockReturnValue([layoutSegment(1, 'Course one, recovered by the layout model.'), layoutSegment(3, 'Course three, recovered by the layout model.')]);

    const result = await extractFile(pdf);
    const page2 = result.segments.find((s) => s.locator.page === 2)!;

    expect(page2.confidence).toBeCloseTo(0.91);
    expect(page2.text).toContain('7.8 mm');
  });

  it('a page nobody could read is omitted rather than emitted empty', async () => {
    docling.toSegments.mockReturnValue([layoutSegment(1, 'Course one, recovered by the layout model.'), layoutSegment(3, 'Course three, recovered by the layout model.')]);
    ocr.ocrPages.mockResolvedValue({
      backend: 'vision',
      pages: [{ imagePath: '/tmp/page-2.png', text: '   ', lines: 0 }],
    });

    const result = await extractFile(pdf);

    // A citable segment with nothing in it is worse than an acknowledged gap.
    expect(result.segments.map((s) => s.locator.page)).toEqual([1, 3]);
  });

  it('an empty layout string counts as dropped, not as read', async () => {
    docling.toSegments.mockReturnValue([
      layoutSegment(1, 'Course one, recovered by the layout model.'),
      layoutSegment(2, '   '),
      layoutSegment(3, 'Course three, recovered by the layout model.'),
    ]);

    const result = await extractFile(pdf);

    expect(ocr.ocrPages).toHaveBeenCalledWith(['/tmp/page-2.png']);
    expect(result.segments.map((s) => s.via)).toEqual(['layout', 'ocr', 'layout']);
  });
});

describe('when there is no text layer to compare against at all', () => {
  it('a converter result stands on its own when pdftotext is missing', async () => {
    raster.extractTextLayer.mockRejectedValue(new Error('pdftotext is not installed'));
    docling.toSegments.mockReturnValue([layoutSegment(2, 'Only page two was converted.')]);

    const result = await extractFile(pdf);

    // No floor exists, so the layout result is not discarded over a missing comparison — and no
    // raster pass is attempted either, because nothing can be said about the pages it did not cover.
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].via).toBe('layout');
    expect(ocr.ocrPages).not.toHaveBeenCalled();
  });
});
