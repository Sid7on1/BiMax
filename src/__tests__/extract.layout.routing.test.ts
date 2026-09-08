import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPdf } from '../documents/pdf.writer';
import { Segment } from '../documents/extract';

/**
 * PDFs are routed through the layout converter first, and fall back to the built-in reader PER PAGE.
 *
 * The all-or-nothing version of this shipped first and had a real hole: a 40-page report where the
 * converter silently produced nothing for six pages kept the 34 good pages and lost the other six,
 * because the fallback only fired when the WHOLE document came back empty. Six missing pages in an
 * otherwise healthy extraction is the kind of loss nobody notices until a citation cannot be found.
 *
 * So the floor is the text layer, which is nearly free to obtain, and the tests below are mostly
 * about pages the converter dropped or half-read. They assert the PROPERTY — a thin page falls back,
 * a healthy page does not — at margins far from the threshold, rather than pinning the ratio.
 */

jest.mock('../documents/docling', () => ({
  doclingAvailable: jest.fn(),
  doclingConvert: jest.fn(),
  toSegments: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const docling = require('../documents/docling') as {
  doclingAvailable: jest.Mock;
  doclingConvert: jest.Mock;
  toSegments: jest.Mock;
};

// Imported after the mock is registered so the lazy require inside `extract.ts` resolves to it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { extractFile } = require('../documents/extract') as typeof import('../documents/extract');

let dir: string;
let pdf: string;

/** Long enough that a one-character layout result is unambiguously below any sane floor. */
const PAGE_TEXT = [
  'Ultrasonic thickness survey recorded a minimum shell thickness of 8.2 mm against a design minimum of 9.0 mm at grid location C4 on the crude distillation vessel.',
  'The second course was examined over its full circumference and showed no measurable loss beyond the corrosion allowance stated in the original fabrication record.',
  'Recommendation is to replace the affected shell course within ninety days and to repeat the survey at the next scheduled shutdown of the unit.',
];

/** A layout segment that plainly read its page: comparable in length to the text layer. */
const fullLayout = (page: number): Segment => ({
  text: `${PAGE_TEXT[page - 1]}\n\n| Nozzle | mm |\n| --- | --- |\n| N2 | 7.8 |`,
  locator: { page },
  via: 'layout',
  context: `inspection.pdf · page ${page} · 1 table recovered`,
});

/** A layout segment for a page the converter effectively lost. */
const thinLayout = (page: number): Segment => ({ text: 'Figure 1.', locator: { page }, via: 'layout' });

const paged = (segments: Segment[]) => {
  docling.doclingAvailable.mockResolvedValue(true);
  docling.doclingConvert.mockResolvedValue([{ path: pdf, ok: true, paged: true, pages: [] }]);
  docling.toSegments.mockReturnValue(segments);
};

const viaByPage = (segments: Segment[]) =>
  Object.fromEntries(segments.map((s) => [s.locator.page, s.via]));

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-layout-route-'));
  pdf = path.join(dir, 'inspection.pdf');
  fs.writeFileSync(pdf, await buildPdf({
    title: 'Equipment Inspection Report',
    blocks: [
      { kind: 'paragraph', text: PAGE_TEXT[0] },
      { kind: 'pagebreak' },
      { kind: 'paragraph', text: PAGE_TEXT[1] },
      { kind: 'pagebreak' },
      { kind: 'paragraph', text: PAGE_TEXT[2] },
    ],
  }));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => jest.clearAllMocks());

describe('a healthy conversion is kept', () => {
  it('every page the converter read well stays layout-derived', async () => {
    paged([fullLayout(1), fullLayout(2), fullLayout(3)]);

    const result = await extractFile(pdf);

    expect(result.ok).toBe(true);
    expect(viaByPage(result.segments)).toEqual({ 1: 'layout', 2: 'layout', 3: 'layout' });
    // The recovered table survives the merge — the only reason to prefer layout at all.
    expect(result.segments[0].text).toContain('| Nozzle | mm |');
  });

  it('asks the converter exactly once, for exactly this file', async () => {
    paged([fullLayout(1), fullLayout(2), fullLayout(3)]);
    await extractFile(pdf);
    expect(docling.doclingConvert).toHaveBeenCalledTimes(1);
    expect(docling.doclingConvert).toHaveBeenCalledWith([pdf]);
  });
});

describe('THE FIX — a page the converter dropped is recovered from the text layer', () => {
  it('a missing page comes back rather than vanishing', async () => {
    paged([fullLayout(1), fullLayout(3)]);          // page 2 simply absent

    const result = await extractFile(pdf);

    expect(viaByPage(result.segments)).toEqual({ 1: 'layout', 2: 'text-layer', 3: 'layout' });
    // The page that would previously have been lost carries its real content.
    const page2 = result.segments.find((s) => s.locator.page === 2)!;
    expect(page2.text).toContain('second course');
  });

  it('a page read down to almost nothing falls back too', async () => {
    paged([fullLayout(1), thinLayout(2), fullLayout(3)]);

    const result = await extractFile(pdf);

    expect(viaByPage(result.segments)).toEqual({ 1: 'layout', 2: 'text-layer', 3: 'layout' });
    expect(result.segments.find((s) => s.locator.page === 2)!.text).toContain('corrosion allowance');
  });

  it('pages come back in page order whichever source won', async () => {
    paged([fullLayout(3), thinLayout(2), fullLayout(1)]);

    const result = await extractFile(pdf);

    expect(result.segments.map((s) => s.locator.page)).toEqual([1, 2, 3]);
  });

  it('a wholly failed conversion still yields every page', async () => {
    paged([thinLayout(1), thinLayout(2), thinLayout(3)]);

    const result = await extractFile(pdf);

    expect(viaByPage(result.segments)).toEqual({ 1: 'text-layer', 2: 'text-layer', 3: 'text-layer' });
  });
});

describe('an unpaged conversion stays all-or-nothing', () => {
  it('is used as-is, because there is no page to align a floor against', async () => {
    const unpaged: Segment = { text: 'Whole document markdown.', locator: {}, via: 'layout' };
    docling.doclingAvailable.mockResolvedValue(true);
    docling.doclingConvert.mockResolvedValue([{ path: pdf, ok: true, paged: false, pages: [] }]);
    docling.toSegments.mockReturnValue([unpaged]);

    const result = await extractFile(pdf);

    // Aligning it would attach one page's floor to another page's text.
    expect(result.segments).toEqual([unpaged]);
  });
});

describe('every way the optional path can fail lands on the built-in reader', () => {
  const usedFallback = (segments: Segment[]) => segments.every((s) => s.via !== 'layout');

  it('not installed — the converter is never even called', async () => {
    docling.doclingAvailable.mockResolvedValue(false);
    const result = await extractFile(pdf);
    expect(docling.doclingConvert).not.toHaveBeenCalled();
    expect(usedFallback(result.segments)).toBe(true);
    expect(result.segments).toHaveLength(3);
  });

  it('conversion reported failure', async () => {
    docling.doclingAvailable.mockResolvedValue(true);
    docling.doclingConvert.mockResolvedValue([{ path: pdf, ok: false, paged: false, pages: [], error: 'boom' }]);
    const result = await extractFile(pdf);
    expect(docling.toSegments).not.toHaveBeenCalled();
    expect(usedFallback(result.segments)).toBe(true);
  });

  it('conversion "succeeded" but produced nothing at all', async () => {
    paged([]);
    const result = await extractFile(pdf);
    expect(usedFallback(result.segments)).toBe(true);
  });

  it('the helper threw', async () => {
    docling.doclingAvailable.mockResolvedValue(true);
    docling.doclingConvert.mockRejectedValue(new Error('helper could not be started'));
    const result = await extractFile(pdf);
    expect(usedFallback(result.segments)).toBe(true);
  });

  it('the availability probe itself threw', async () => {
    docling.doclingAvailable.mockRejectedValue(new Error('venv exploded'));
    const result = await extractFile(pdf);
    expect(usedFallback(result.segments)).toBe(true);
  });

  it('returned no row for the file at all', async () => {
    docling.doclingAvailable.mockResolvedValue(true);
    docling.doclingConvert.mockResolvedValue([]);
    const result = await extractFile(pdf);
    expect(usedFallback(result.segments)).toBe(true);
  });
});

describe('only PDFs are routed through it', () => {
  it('a spreadsheet keeps its exact cells instead of being re-read off a rendering', async () => {
    docling.doclingAvailable.mockResolvedValue(true);
    const csv = path.join(dir, 'readings.csv');
    fs.writeFileSync(csv, 'Nozzle,mm\nN2,7.8\n');

    const result = await extractFile(csv);

    expect(docling.doclingConvert).not.toHaveBeenCalled();
    expect(result.segments[0].via).toBe('cells');
  });

  it('a text file is not routed either', async () => {
    docling.doclingAvailable.mockResolvedValue(true);
    const txt = path.join(dir, 'notes.txt');
    fs.writeFileSync(txt, 'Shell course 1 examined.');

    const result = await extractFile(txt);

    expect(docling.doclingConvert).not.toHaveBeenCalled();
    expect(result.segments[0].via).toBe('text');
  });
});
