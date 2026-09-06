import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ComposerCorpus, createComposerStore } from '../memory/corpus';
import { FactStore, factsFromSegment, unitFromHeader, propertyFromHeader } from '../memory/facts';

/**
 * Numeric facts — the lane retrieval cannot provide.
 *
 * Error analysis of text-and-table retrieval puts 73% of residual failures in table structure and a
 * further 20% in numerical reasoning: 93% of what still breaks once hybrid retrieval and reranking
 * are working. The cause is structural — in a vector index numbers are tokens, not quantities, so
 * "below 8 mm" is not a comparison the index can make at all.
 *
 * The end-to-end test at the bottom is the one that matters: a question flat retrieval cannot answer,
 * answered correctly from a spreadsheet, with citations.
 */

let workdir: string;

beforeEach(async () => {
  workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bimax-facts-'));
});
afterEach(async () => {
  await fs.promises.rm(workdir, { recursive: true, force: true });
});

const newFacts = (): FactStore => new FactStore(path.join(workdir, 'facts.sqlite'));

const source = { file: '/plant/readings.xlsx', name: 'readings.xlsx', entryId: 'entry-1' };

describe('reading a table header', () => {
  it('takes the unit only when the header states one', () => {
    expect(unitFromHeader('Measured mm')).toBe('mm');
    expect(unitFromHeader('Thickness (mm)')).toBe('mm');
    expect(unitFromHeader('Pressure, bar')).toBe('bar');
    // No unit stated → null, never a guess. An assumed unit in an assessment is a fabricated fact.
    expect(unitFromHeader('Equipment')).toBeNull();
    expect(unitFromHeader('Inspector')).toBeNull();
  });

  it('normalises a property so the same column is one property however it was written', () => {
    expect(propertyFromHeader('Measured mm')).toBe('Measured');
    expect(propertyFromHeader('Thickness (mm)')).toBe('Thickness');
  });
});

describe('facts come from structure, not from proximity', () => {
  it('extracts one fact per numeric cell, keyed to the row’s identifier', () => {
    const facts = factsFromSegment({
      via: 'cells',
      locator: { sheet: 'Thickness Survey' },
      text: 'Equipment\tNominal mm\tMeasured mm\tInspector\nE-204\t12.0\t7.8\tR. Rao\nP-310A\t10.0\t9.4\tR. Rao',
    }, source);

    expect(facts).toHaveLength(4);
    const e204 = facts.filter((fact) => fact.subject === 'E-204');
    expect(e204.map((fact) => [fact.property, fact.value, fact.unit]))
      .toEqual([['nominal', 12.0, 'mm'], ['measured', 7.8, 'mm']]);
    // Provenance rides on every value: a computed answer must be traceable to a row.
    expect(e204[0].locator).toBe('sheet Thickness Survey');
    expect(e204[0].sourceName).toBe('readings.xlsx');
  });

  it('records the row’s date when the row states one', () => {
    const facts = factsFromSegment({
      via: 'cells',
      locator: { sheet: 'Survey' },
      text: 'Equipment\tMeasured mm\tDate\nE-204\t7.8\t2026-03-14',
    }, source);
    expect(facts[0].measuredOn).toBe('2026-03-14');
  });

  it('ignores a row with no identifier — there is no subject to assert about', () => {
    const facts = factsFromSegment({
      via: 'cells', locator: {},
      text: 'Equipment\tMeasured mm\nTOTAL\t42.0',
    }, source);
    expect(facts).toHaveLength(0);
  });

  it('ignores a sheet whose first row is data, because it has no property names', () => {
    const facts = factsFromSegment({
      via: 'cells', locator: {},
      text: 'E-204\t12.0\t7.8\nP-310A\t10.0\t9.4',
    }, source);
    expect(facts).toHaveLength(0);
  });

  it('reads a single prose line that states subject, property and value together', () => {
    const facts = factsFromSegment({
      via: 'text', locator: { page: 3 },
      text: 'Exchanger E-204 recorded minimum thickness 7.8 mm during the survey.',
    }, source);
    expect(facts[0]).toMatchObject({ subject: 'E-204', value: 7.8, unit: 'mm' });
  });

  it('MUTANT — does NOT pair an identifier with a number from a different line', async () => {
    // The manufactured-fact failure: E-204 is named in one sentence and 9.4 appears in another about
    // a different vessel. Associating them would invent a measurement nobody recorded.
    const facts = factsFromSegment({
      via: 'text', locator: {},
      text: 'Equipment E-204 was inspected this quarter.\nSeparately, P-310A measured 9.4 mm.',
    }, source);
    const wrong = facts.filter((fact) => fact.subject === 'E-204' && fact.value === 9.4);
    expect(wrong).toHaveLength(0);
  });
});

describe('numeric comparison — what retrieval cannot do', () => {
  it('filters by threshold, which no text index can express', () => {
    const store = newFacts();
    if (!store.available()) return;                 // no SQLite backend on this runtime
    store.add(factsFromSegment({
      via: 'cells', locator: { sheet: 'Survey' },
      text: 'Equipment\tMeasured mm\nE-204\t7.8\nP-310A\t9.4\nV-101\t6.2\nT-220\t11.5',
    }, source));

    const below8 = store.query({ property: 'measured', op: 'lt', value: 8 });
    expect(below8.map((fact) => fact.subject).sort()).toEqual(['E-204', 'V-101']);
    // "7.8" and "6.2" are not lexically similar to "below 8" in any way an embedding could exploit.
    expect(below8.every((fact) => fact.value < 8)).toBe(true);
  });

  it('narrows to one equipment tag', () => {
    const store = newFacts();
    if (!store.available()) return;
    store.add(factsFromSegment({
      via: 'cells', locator: {},
      text: 'Equipment\tNominal mm\tMeasured mm\nE-204\t12.0\t7.8\nP-310A\t10.0\t9.4',
    }, source));
    expect(store.query({ subject: 'e-204' }).every((fact) => fact.subject === 'E-204')).toBe(true);
  });

  it('reports the subjects and properties it actually holds, so the model discovers rather than guesses', () => {
    const store = newFacts();
    if (!store.available()) return;
    store.add(factsFromSegment({
      via: 'cells', locator: {},
      text: 'Equipment\tMeasured mm\nE-204\t7.8',
    }, source));
    const schema = store.schema();
    expect(schema.subjects).toContain('E-204');
    expect(schema.properties.map((p) => p.property)).toContain('measured');
    expect(schema.properties[0].unit).toBe('mm');
  });

  it('removing a document removes its facts, so a cleared corpus cannot answer from it', () => {
    const store = newFacts();
    if (!store.available()) return;
    store.add(factsFromSegment({
      via: 'cells', locator: {}, text: 'Equipment\tMeasured mm\nE-204\t7.8',
    }, source));
    expect(store.count()).toBe(1);
    store.removeEntry('entry-1');
    expect(store.count()).toBe(0);
  });
});

describe('end to end: a question flat retrieval cannot answer', () => {
  it('answers a threshold question from an ingested spreadsheet, with citations', async () => {
    const facts = newFacts();
    if (!facts.available()) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Thickness Survey');
    sheet.addRow(['Equipment', 'Nominal mm', 'Measured mm', 'Minimum Allowable mm']);
    sheet.addRow(['E-204', 12.0, 7.8, 8.0]);
    sheet.addRow(['P-310A', 10.0, 9.4, 6.4]);
    sheet.addRow(['V-101', 14.0, 6.2, 8.0]);
    const file = path.join(workdir, 'Q1 thickness survey.xlsx');
    await workbook.xlsx.writeFile(file);

    const corpus = new ComposerCorpus(
      createComposerStore(null, null, path.join(workdir, 'c.sqlite')),
      { manifestPath: path.join(workdir, 'c.json'), facts },
    );
    await corpus.ingest([file], 'library');

    // "Which vessels measured below 8 mm?" — a comparison, not a similarity.
    const below = facts.query({ property: 'measured', op: 'lt', value: 8 });
    expect(below.map((fact) => fact.subject).sort()).toEqual(['E-204', 'V-101']);

    // And every number can name the file and sheet it was read from.
    for (const fact of below) {
      expect(fact.sourceName).toBe('Q1 thickness survey.xlsx');
      expect(fact.locator).toContain('Thickness Survey');
    }

    // The prose lane still works alongside it — facts do not replace passages.
    const passages = await corpus.search('thickness survey', 5);
    expect(passages.length).toBeGreaterThan(0);
  });
});
