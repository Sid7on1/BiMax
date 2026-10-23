import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ComposerCorpus, createComposerStore, extractIdentifiers } from '../memory/corpus';

/**
 * The identifier lane.
 *
 * Equipment tags are the primary key of a plant, and they are precisely what embeddings cannot rank:
 * an out-of-vocabulary identifier is an opaque character sequence to an embedding model, so `E-204`
 * and `P-310A` sit near each other in vector space while meaning entirely different vessels. An
 * assessment that quotes the wrong equipment's wall thickness is not a ranking imperfection, it is a
 * safety-relevant error.
 *
 * The design constraint these tests exist to hold: a filter that matches nothing must FALL BACK, not
 * return silence. "No passages found" reads to a user as "your documents do not discuss this", which
 * is a different and false claim.
 */

let workdir: string;

beforeEach(async () => {
  workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bimax-id-'));
});
afterEach(async () => {
  await fs.promises.rm(workdir, { recursive: true, force: true });
});

const newCorpus = (): ComposerCorpus => new ComposerCorpus(
  createComposerStore(null, null, path.join(workdir, 'c.sqlite')),
  { manifestPath: path.join(workdir, 'c.json') },
);

const write = async (name: string, body: string): Promise<string> => {
  const file = path.join(workdir, name);
  await fs.promises.writeFile(file, body);
  return file;
};

describe('what counts as an identifier', () => {
  it('recognises the shapes a plant actually uses', () => {
    expect(extractIdentifiers('Exchanger E-204 and pump P-310A feed PT-101 via TIC-3021.'))
      .toEqual(['E-204', 'P-310A', 'PT-101', 'TIC-3021']);
  });

  it('is case-insensitive, because nobody types tags consistently', () => {
    expect(extractIdentifiers('check e-204 please')).toEqual(['E-204']);
  });

  it('does not treat ordinary hyphenated words as tags', () => {
    expect(extractIdentifiers('the well-known follow-up on high-pressure piping')).toEqual([]);
  });

  it('deduplicates repeated mentions', () => {
    expect(extractIdentifiers('E-204 again E-204 and E-204')).toEqual(['E-204']);
  });
});

describe('a named tag restricts the answer to that equipment', () => {
  async function twoVessels(corpus: ComposerCorpus): Promise<void> {
    await corpus.ingest([
      await write('E-204 report.txt',
        'INSPECTION RECORD — Equipment E-204. Measured minimum thickness 7.8 mm. '
        + 'Local corrosion around nozzle N2. Engineering assessment required.'),
      await write('P-310A report.txt',
        'INSPECTION RECORD — Equipment P-310A. Measured minimum thickness 9.4 mm. '
        + 'Local corrosion around nozzle N2. Engineering assessment required.'),
    ], 'session');
  }

  it('never returns the other vessel above the one that was asked for', async () => {
    const corpus = newCorpus();
    await twoVessels(corpus);
    // The two documents are near-identical apart from the tag and the number — exactly the case
    // where semantic similarity cannot separate them.
    const hits = await corpus.search('E-204 minimum thickness corrosion', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.text.includes('E-204'))).toBe(true);
    expect(hits.some((hit) => hit.text.includes('P-310A'))).toBe(false);
  });

  it('MUTANT — without the filter, the wrong vessel is a legitimate top hit', async () => {
    const corpus = newCorpus();
    await twoVessels(corpus);
    // Same corpus, a query with no tag in it: both documents are equally good answers, which is the
    // whole problem the lane solves. This is what every query looked like before.
    const untagged = await corpus.search('minimum thickness corrosion nozzle', 5);
    const names = new Set(untagged.map((hit) => hit.name));
    expect(names.size).toBeGreaterThan(1);
  });

  it('finds the tag through a carried context line, not only where it is written', async () => {
    const corpus = newCorpus();
    // The measurement is far from the heading; only the carried context puts the tag on its chunk.
    const body = Array.from({ length: 300 }, (_, i) => `Grid point ${i}: reading 11.2 mm.`).join('\n');
    await corpus.ingest([
      await write('survey.txt', `INSPECTION RECORD — Equipment E-204 — Unit CDU\n${body}\nFinal: 7.8 mm minimum.`),
    ], 'session');

    const hits = await corpus.search('E-204 final minimum reading', 8);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.text.includes('E-204'))).toBe(true);
  });
});

describe('a filter that matches nothing must fall back, never go silent', () => {
  it('ignores an identifier the corpus does not contain', async () => {
    const corpus = newCorpus();
    await corpus.ingest([
      await write('report.txt', 'INSPECTION RECORD — Equipment E-204. Measured minimum thickness 7.8 mm.'),
    ], 'session');

    // V-999 was never ingested. The question is still about thickness and must be answered.
    const hits = await corpus.search('V-999 measured minimum thickness', 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('ignores a standards number mentioned in passing', async () => {
    const corpus = newCorpus();
    await corpus.ingest([
      await write('sop.txt', 'Thickness surveys follow the corrosion assessment procedure for all exchangers.'),
    ], 'session');

    // `ISO-9001` matches the identifier shape but is not equipment and is not in the corpus.
    const hits = await corpus.search('per ISO-9001 what is the thickness survey procedure', 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('falls back when the tag exists but only outside the requested corpus', async () => {
    const corpus = newCorpus();
    await corpus.ingest([
      await write('E-204 library.txt', 'INSPECTION RECORD — Equipment E-204. Historical minimum 8.6 mm.'),
    ], 'library');
    await corpus.ingest([
      await write('session note.txt', 'General thickness survey guidance for exchangers.'),
    ], 'session');

    // Asking session-only for a tag that lives in the library: answer the question rather than
    // reporting an empty scope.
    const hits = await corpus.search('E-204 thickness', 5, ['session']);
    expect(hits.length).toBeGreaterThan(0);
  });
});
