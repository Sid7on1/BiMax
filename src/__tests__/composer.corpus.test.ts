import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile, looksLikeText, describeLocator } from '../documents/extract';
import { ComposerCorpus, createComposerStore } from '../memory/corpus';

/**
 * The Composer: ingestion, provenance and retrieval.
 *
 * The property that matters is not "it can read a file" — it is that a retrieved passage can still
 * say WHERE IT CAME FROM. An inspection engineer cannot sign an assessment sourced from "a
 * document"; they need "E-204 Inspection Report.pdf, page 3". So most of these tests grade the
 * survival of the locator from extraction, through chunking, into the text the model receives.
 *
 * Runs with no embeddings backend (lexical-only retrieval), which is deliberate: it keeps the suite
 * offline and hermetic, and it also grades the degraded path an air-gapped site hits before a local
 * embedding model is pulled.
 */

let workdir: string;

beforeEach(async () => {
  workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bimax-composer-'));
});

afterEach(async () => {
  await fs.promises.rm(workdir, { recursive: true, force: true });
});

const write = async (name: string, body: string | Buffer): Promise<string> => {
  const file = path.join(workdir, name);
  await fs.promises.writeFile(file, body);
  return file;
};

const newCorpus = (): ComposerCorpus => new ComposerCorpus(
  createComposerStore(null, null, path.join(workdir, 'composer.index.sqlite')),
  { manifestPath: path.join(workdir, 'composer.json') },
);

describe('extraction reads what an engineer actually has', () => {
  it('reads plain text, markdown, code and JSON through one path', async () => {
    for (const [name, body] of [
      ['note.txt', 'Shell thickness measured 7.8 mm at nozzle N2.'],
      ['sop.md', '# Inspection SOP\n\nMinimum allowable thickness is 6.4 mm.'],
      ['calc.py', 'rate = (nominal - measured) / years'],
      ['limits.json', '{"minimum_mm": 6.4}'],
    ] as [string, string][]) {
      const result = await extractFile(await write(name, body));
      expect(result.ok).toBe(true);
      expect(result.segments[0].text).toContain(body.split('\n').pop()!.slice(0, 10));
    }
  });

  it('reads a file with an extension nobody has heard of, when its bytes are text', async () => {
    // The "any .xyz" requirement: an instrument vendor's export must not need a code change.
    const file = await write('reading.vendorx', 'TAG=E-204\nTHK=7.8\nUNIT=mm');
    const result = await extractFile(file);
    expect(result.ok).toBe(true);
    expect(result.segments[0].text).toContain('THK=7.8');
  });

  it('refuses a binary rather than indexing its garbage', async () => {
    // A binary that squeaks past a printable-ratio check pollutes retrieval: its rare byte
    // sequences match rare query tokens and outrank real content.
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00, 0x03, 0x00, 0x99]);
    const result = await extractFile(await write('blob.unknownext', binary));
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/binary/i);
  });

  it('refuses known-opaque formats without reading them', async () => {
    const result = await extractFile(await write('clip.mp4', 'not really a video'));
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/not a readable document/);
  });

  it('reports an empty file as a reason, not a crash', async () => {
    const result = await extractFile(await write('empty.txt', ''));
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/empty/);
  });

  it('returns a reason for a missing file instead of throwing', async () => {
    const result = await extractFile(path.join(workdir, 'absent.txt'));
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/cannot read/);
  });

  it('reads a spreadsheet as rows, one segment per sheet, with the sheet as the locator', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Thickness');
    sheet.addRow(['Equipment', 'Nominal', 'Measured']);
    sheet.addRow(['E-204', 12, 7.8]);
    const file = path.join(workdir, 'readings.xlsx');
    await workbook.xlsx.writeFile(file);

    const result = await extractFile(file);
    expect(result.ok).toBe(true);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].locator.sheet).toBe('Thickness');
    expect(result.segments[0].text).toContain('E-204');
    expect(result.segments[0].text).toContain('7.8');
  });

  it('detects UTF-16 text, which Windows-authored plant logs routinely are', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('E-204', 'utf16le')]);
    expect(looksLikeText(utf16)).toEqual({ text: true, encoding: 'utf16le' });
  });

  it('MUTANT — a NUL-only binary check would admit a mostly-control-byte file', () => {
    const noisy = Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 0x01 : 0x41)));
    expect(noisy.includes(0)).toBe(false);              // the neutered check sees no NUL and admits it
    expect(looksLikeText(noisy).text).toBe(false);      // the printable-ratio check refuses it
  });
});

describe('a retrieved passage can name its source', () => {
  it('prefixes every stored passage with a citation header', async () => {
    const corpus = newCorpus();
    const file = await write('E-204 Inspection Report.txt',
      'Shell thickness nominal 12 mm. Minimum measured thickness 7.8 mm. '
      + 'Local corrosion observed around nozzle N2. Engineering assessment required.');
    await corpus.ingest([file], 'session');

    const hits = await corpus.search('nozzle N2 corrosion', 5);
    expect(hits.length).toBeGreaterThan(0);
    // The header is IN the text, which is the only thing the model sees.
    expect(hits[0].text).toContain('[E-204 Inspection Report.txt]');
    expect(hits[0].name).toBe('E-204 Inspection Report.txt');
  });

  it('keeps page/sheet locators out of the wrong passage', () => {
    expect(describeLocator({ page: 3 })).toBe('page 3');
    expect(describeLocator({ sheet: 'Thickness' })).toBe('sheet Thickness');
    expect(describeLocator({ slide: 4 })).toBe('slide 4');
    expect(describeLocator({})).toBe('');
  });

  it('separates session from library, and searches both by default', async () => {
    const corpus = newCorpus();
    const report = await write('report.txt', 'Measured thickness 7.8 mm on exchanger E-204.');
    const sop = await write('SOP-Inspection.txt', 'Minimum allowable thickness for exchangers is 6.4 mm.');
    await corpus.ingest([report], 'session');
    await corpus.ingest([sop], 'library');

    const both = await corpus.search('thickness', 10);
    expect(new Set(both.map((hit) => hit.scope))).toEqual(new Set(['session', 'library']));

    const libraryOnly = await corpus.search('thickness', 10, ['library']);
    expect(libraryOnly.every((hit) => hit.scope === 'library')).toBe(true);
    expect(libraryOnly.some((hit) => hit.name === 'SOP-Inspection.txt')).toBe(true);
  });

  it('clearing the session leaves the library standing', async () => {
    const corpus = newCorpus();
    await corpus.ingest([await write('quote.txt', 'Vendor A offers a level gauge, 12 week delivery.')], 'session');
    await corpus.ingest([await write('manual.txt', 'Level gauge calibration procedure for the unit.')], 'library');

    await corpus.clear('session');
    const stats = await corpus.stats();
    expect(stats.session).toBe(0);
    expect(stats.library).toBe(1);
    const remaining = await corpus.search('level gauge', 10);
    expect(remaining.every((hit) => hit.scope === 'library')).toBe(true);
  });

  it('promotes a session document into the library without re-reading it as a new document', async () => {
    const corpus = newCorpus();
    const file = await write('SOP-Corrosion.txt', 'Corrosion rate is computed from successive thickness readings.');
    await corpus.ingest([file], 'session');

    const promoted = await corpus.promote('SOP-Corrosion.txt');
    expect(promoted?.scope).toBe('library');
    const stats = await corpus.stats();
    expect(stats.session).toBe(0);
    expect(stats.library).toBe(1);
  });
});

describe('a bad file never costs the good ones', () => {
  it('ingests what it can and reports what it could not, with reasons', async () => {
    const corpus = newCorpus();
    const good = await write('good.txt', 'Pump P-310A vibration measured at 9.1 mm/s, above the 4.5 mm/s limit.');
    const empty = await write('blank.txt', '');
    const opaque = await write('archive.zip', 'PK-not-really');
    const missing = path.join(workdir, 'never-existed.pdf');

    const report = await corpus.ingest([good, empty, opaque, missing], 'session');
    expect(report.ingested.map((entry) => entry.name)).toEqual(['good.txt']);
    expect(report.skipped).toHaveLength(3);
    for (const skip of report.skipped) expect(skip.reason).toBeTruthy();
    expect(report.chunks).toBeGreaterThan(0);
  });

  it('re-ingesting unchanged bytes is a no-op, not a duplicate', async () => {
    const corpus = newCorpus();
    const file = await write('history.txt', 'Bearing replaced on P-310A during the 2024 turnaround.');
    const first = await corpus.ingest([file], 'session');
    const second = await corpus.ingest([file], 'session');
    expect(first.ingested).toHaveLength(1);
    expect(second.ingested).toHaveLength(0);
    expect(second.unchanged).toBe(1);
    expect((await corpus.stats()).session).toBe(1);
  });

  it('an edited file is re-ingested, because its bytes changed', async () => {
    const corpus = newCorpus();
    const file = await write('log.txt', 'Reading 8.6 mm.');
    await corpus.ingest([file], 'session');
    await fs.promises.writeFile(file, 'Reading 7.8 mm after further wall loss.');
    const second = await corpus.ingest([file], 'session');
    expect(second.ingested).toHaveLength(1);
    const hits = await corpus.search('wall loss', 5);
    expect(hits.some((hit) => hit.text.includes('7.8'))).toBe(true);
  });

  it('survives a corrupt manifest instead of serving wrong citations from it', async () => {
    const manifestPath = path.join(workdir, 'composer.json');
    await fs.promises.writeFile(manifestPath, '{ this is not json');
    const corpus = new ComposerCorpus(
      createComposerStore(null, null, path.join(workdir, 'composer.index.sqlite')),
      { manifestPath },
    );
    // A half-read manifest would map chunk ids to the wrong pages. Starting empty is the honest
    // degradation; a wrong page number on an approval note is not.
    await expect(corpus.list()).resolves.toEqual([]);
    const file = await write('fresh.txt', 'Exchanger E-204 requires assessment.');
    await expect(corpus.ingest([file])).resolves.toMatchObject({ skipped: [] });
  });
});
