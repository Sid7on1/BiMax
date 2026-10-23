import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ComposerCorpus, createComposerStore } from '../memory/corpus';
import { extractFile, leadingContext } from '../documents/extract';

/**
 * Contextual Retrieval, deterministic tier.
 *
 * The measured technique prepends chunk-specific context before embedding AND before BM25 indexing,
 * taking top-20 retrieval failures from 5.7% to 2.9% (and 1.9% once reranked). We implement the
 * half that needs no model, because the failure it removes is the one this domain actually has:
 *
 *   a chunk that reads "Measured minimum thickness 7.8 mm" and never says which vessel,
 *   because the heading was three chunks earlier.
 *
 * Error analysis of text-and-table retrieval puts 73% of residual failures in that class, so these
 * tests are weighted towards tables and repetitive forms rather than prose.
 */

let workdir: string;

beforeEach(async () => {
  workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bimax-ctx-'));
});
afterEach(async () => {
  await fs.promises.rm(workdir, { recursive: true, force: true });
});

const newCorpus = (): ComposerCorpus => new ComposerCorpus(
  createComposerStore(null, null, path.join(workdir, 'c.sqlite')),
  { manifestPath: path.join(workdir, 'c.json') },
);

describe('a spreadsheet keeps its column names on every chunk', () => {
  /** A readings sheet long enough that chunking splits it well past the header row. */
  async function readingsWorkbook(rows: number): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Thickness Survey');
    sheet.addRow(['Equipment', 'Nominal mm', 'Measured mm', 'Inspector']);
    for (let i = 0; i < rows; i++) {
      sheet.addRow([`E-${200 + i}`, 12.0, 12 - (i % 40) / 10, 'R. Rao']);
    }
    const file = path.join(workdir, 'thickness.xlsx');
    await workbook.xlsx.writeFile(file);
    return file;
  }

  it('extracts the header row as the segment context', async () => {
    const result = await extractFile(await readingsWorkbook(5));
    expect(result.ok).toBe(true);
    expect(result.segments[0].context).toContain('columns:');
    expect(result.segments[0].context).toContain('Measured mm');
  });

  it('carries the column names into chunks far below the header', async () => {
    const corpus = newCorpus();
    await corpus.ingest([await readingsWorkbook(600)], 'session');

    // A row deep in the sheet. Without the carried context its chunk is a grid of bare numbers.
    const hits = await corpus.search('E-540 measured mm', 8);
    expect(hits.length).toBeGreaterThan(0);
    const deep = hits.find((hit) => hit.text.includes('E-540'));
    expect(deep).toBeDefined();
    expect(deep!.text).toContain('columns:');
    expect(deep!.text).toContain('Measured mm');
  });

  it('MUTANT — without carried context, a later chunk names no columns at all', async () => {
    // The neutered behaviour: only chunk 0 of the sheet holds the header row, so a chunk drawn from
    // the middle is uninterpretable — "7.8" with no statement of what was measured.
    const result = await extractFile(await readingsWorkbook(600));
    const wholeSheet = result.segments[0].text;
    const middle = wholeSheet.slice(Math.floor(wholeSheet.length / 2), Math.floor(wholeSheet.length / 2) + 400);
    expect(middle).not.toContain('Measured mm');       // the raw segment loses it
    expect(result.segments[0].context).toContain('Measured mm');  // the carried context restores it
  });
});

describe('a repetitive form keeps its subject on every chunk', () => {
  const FORM_HEADER = 'INSPECTION RECORD SHEET — Equipment E-204 — Unit CDU';

  it('takes the opening line as context when it reads like a heading', () => {
    expect(leadingContext(`${FORM_HEADER}\nNominal 12.0 mm.`)).toBe(FORM_HEADER);
  });

  it('does not repeat a whole paragraph of prose on every chunk', () => {
    const prose = 'The corrosion assessment procedure requires successive wall thickness measurements '
      + 'taken at the same location, and where the computed rate projects the wall below the minimum '
      + 'allowable thickness before the next scheduled inspection an engineering assessment is required.';
    // Truncated rather than carried whole: a 300-character "context" on every chunk is index bloat
    // with no identifying signal.
    expect(leadingContext(prose)!.length).toBeLessThanOrEqual(160);
  });

  it('retrieves a measurement by the equipment named only in the heading', async () => {
    const corpus = newCorpus();
    // The measurement sits far below the heading, so chunking separates them.
    const body = Array.from({ length: 400 }, (_, i) =>
      `Point ${i}: reading ${(11.9 - (i % 30) / 10).toFixed(1)} mm at grid location ${i}.`).join('\n');
    const file = path.join(workdir, 'E-204 survey.txt');
    await fs.promises.writeFile(file, `${FORM_HEADER}\n${body}\nPoint 999: reading 7.8 mm, minimum recorded.`);
    await corpus.ingest([file], 'session');

    // The query names the vessel, which appears ONLY in the heading — not beside the reading.
    const hits = await corpus.search('E-204 minimum recorded reading', 8);
    expect(hits.length).toBeGreaterThan(0);
    // Every returned chunk can state its subject, wherever in the document it was cut from.
    expect(hits.every((hit) => hit.text.includes('E-204'))).toBe(true);
  });

  it('does not make the first chunk say its own title twice', async () => {
    const corpus = newCorpus();
    const file = path.join(workdir, 'short.txt');
    await fs.promises.writeFile(file, `${FORM_HEADER}\nMeasured minimum thickness 7.8 mm.`);
    await corpus.ingest([file], 'session');

    const hits = await corpus.search('measured minimum thickness', 5);
    const occurrences = hits[0].text.split('INSPECTION RECORD SHEET').length - 1;
    expect(occurrences).toBe(1);
  });
});
