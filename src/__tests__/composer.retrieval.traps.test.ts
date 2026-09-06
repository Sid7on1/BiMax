import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ComposerCorpus, createComposerStore, COMPOSER_STORE_OPTIONS } from '../memory/corpus';
import { VectorStore, lexicalRelevance } from '../memory/vector.store';

/**
 * Two traps that made the Composer silently wrong, pinned so they cannot return.
 *
 * Both were found by measurement rather than reasoning, and both share a shape: the retrieval store
 * was built for the AGENT'S MEMORY, and two of its defaults are actively harmful when the payload
 * is a document. Neither failure announces itself — one returns nothing, the other returns the right
 * text under the wrong page number — so a test is the only thing standing between a fix and its
 * quiet reversal.
 *
 * These grade the PROPERTY (a citation stays true; a real passage is retrievable), never a
 * constant, because pinning the number is how the constant becomes the spec instead of the
 * behaviour it was chosen to produce.
 */

let workdir: string;

beforeEach(async () => {
  workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bimax-traps-'));
});
afterEach(async () => {
  await fs.promises.rm(workdir, { recursive: true, force: true });
});

const write = async (name: string, body: string): Promise<string> => {
  const file = path.join(workdir, name);
  await fs.promises.writeFile(file, body);
  return file;
};

/**
 * Two pages of ONE repetitive inspection form — identical boilerplate, one differing measurement.
 *
 * The near-identity is the point, and it is what a real record sheet looks like: the same printed
 * form filled in per shell course. Measured against this store, these two score above the 0.8
 * Jaccard merge threshold, whereas two pages with differing prose do not — which is why an earlier
 * version of this test failed to reproduce the bug it was written to pin.
 */
const PAGE_ONE = 'INSPECTION RECORD SHEET. Equipment E-204. Nominal thickness 12.0 mm. '
  + 'Measured minimum thickness 9.4 mm. Inspector R. Rao. Method ultrasonic thickness survey. '
  + 'Condition acceptable.';
const PAGE_TWO = 'INSPECTION RECORD SHEET. Equipment E-204. Nominal thickness 12.0 mm. '
  + 'Measured minimum thickness 7.8 mm. Inspector R. Rao. Method ultrasonic thickness survey. '
  + 'Condition acceptable.';

describe('trap 1 — near-duplicate merging would file a passage under the wrong source', () => {
  it('the Composer store is configured so two near-identical pages stay two documents', async () => {
    const corpus = new ComposerCorpus(
      createComposerStore(null, null, path.join(workdir, 'v.json')),
      { manifestPath: path.join(workdir, 'c.json') },
    );
    await corpus.ingest([
      await write('E-204 course 1.txt', PAGE_ONE),
      await write('E-204 course 2.txt', PAGE_TWO),
    ], 'session');

    // Both survive as separate documents...
    expect((await corpus.stats()).session).toBe(2);

    // ...and each measurement is still attached to the file it came from. This is the assertion
    // that matters: 7.8 mm is the reading that triggers an engineering assessment, and citing it
    // against course 1 would send an engineer to inspect the wrong part of the vessel.
    const hits = await corpus.search('measured minimum thickness', 10);
    const byName = new Map(hits.map((hit) => [hit.name, hit.text]));
    expect(byName.get('E-204 course 1.txt')).toContain('9.4 mm');
    expect(byName.get('E-204 course 2.txt')).toContain('7.8 mm');
    expect(byName.get('E-204 course 1.txt')).not.toContain('7.8 mm');
  });

  it('MUTANT — with the memory store’s dedup ON, the second page is swallowed by the first', async () => {
    // The neutered configuration: exactly what `new VectorStore(...)` gives you by default.
    const merged = new VectorStore(null, null, { storePath: path.join(workdir, 'dedup.json') });
    await merged.storeDocuments([
      { id: 'doc:course-1', text: `[E-204 course 1.txt]\n${PAGE_ONE}`, tags: ['composer:session'] },
      { id: 'doc:course-2', text: `[E-204 course 2.txt]\n${PAGE_TWO}`, tags: ['composer:session'] },
    ]);
    const found = await merged.semanticSearch('measured minimum thickness', 10, 0, { tags: ['composer:session'] });

    // MEASURED: one document survives, and it is the WORST possible outcome — course 1's id
    // carrying course 2's text. The Composer's manifest maps ids to provenance, so a passage
    // reading 7.8 mm would be cited as course 1, which is a different part of the vessel.
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('doc:course-1');
    expect(found[0].metadata.content).toContain('7.8 mm');
    expect(found[0].metadata.content).toContain('E-204 course 2.txt');
    // Course 1's own reading is gone entirely.
    expect(found[0].metadata.content).not.toContain('9.4 mm');

    // And the store the Composer actually uses keeps both pages, because it has no merge step at
    // all. Asserted as the OUTCOME rather than as a `dedup: false` flag — the flag was an artefact
    // of the JSON store, and pinning it would have made this test fail for the right change.
    const corpus = new ComposerCorpus(
      createComposerStore(null, null, path.join(workdir, 'ok.sqlite')),
      { manifestPath: path.join(workdir, 'ok.json') },
    );
    await corpus.ingest([
      await write('course 1.txt', PAGE_ONE),
      await write('course 2.txt', PAGE_TWO),
    ], 'session');
    expect((await corpus.stats()).session).toBe(2);
  });

  it('the Composer store is sized for documents, not for hand-written notes', () => {
    // The JSON memory store caps at 500 documents and holds every float vector resident. MEASURED
    // at 768 dimensions: 25.7 KB per chunk on disk against 0.75 KB as an int8 BLOB — so a corpus
    // that is 27 MB of SQLite would be ~900 MB of resident JSON. The cap can be large precisely
    // because this store streams.
    expect(COMPOSER_STORE_OPTIONS.maxVectors).toBeGreaterThanOrEqual(150_000);
    expect(COMPOSER_STORE_OPTIONS.maxIndexBytes).toBeGreaterThan(0);
  });
});

describe('trap 2 — a length-biased relevance floor rejects the passages worth retrieving', () => {
  it('scores a passage that exactly answers the query far below the memory default', () => {
    // The measurement the fix rests on. `lexicalRelevance` divides matched query terms by the
    // length of the chunk, so a long, precise, on-topic paragraph scores LOW — the opposite of what
    // a relevance floor is supposed to do.
    const passage = `[E-204 Inspection Report.pdf · page 3]\n${PAGE_TWO}`;
    expect(lexicalRelevance('nozzle N2 corrosion', passage)).toBeLessThan(0.25);
    expect(lexicalRelevance('measured minimum thickness', passage)).toBeLessThan(0.25);
  });

  it('retrieves a real passage that the memory default would have dropped', async () => {
    const corpus = new ComposerCorpus(
      createComposerStore(null, null, path.join(workdir, 'v.json')),
      { manifestPath: path.join(workdir, 'c.json') },
    );
    const file = await write('E-204 Inspection Report.txt', PAGE_TWO);
    await corpus.ingest([file], 'session');

    // The corpus default must find it.
    const hits = await corpus.search('measured minimum thickness', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain('7.8 mm');
  });

  it('MUTANT — the JSON store applies the floor and returns nothing; the Composer store does not', async () => {
    // The trap in its original habitat. `VectorStore` filters any non-dense candidate whose
    // lexicalRelevance is below minScore, so the memory default of 0.25 removes a passage that
    // answers the query outright.
    const json = new VectorStore(null, null, { storePath: path.join(workdir, 'json.json') });
    await json.storeDocuments([
      { id: 'd1', text: `[report.txt]\n${PAGE_TWO}`, tags: ['composer:session'] },
    ]);
    const floored = await json.semanticSearch('measured minimum thickness', 5, 0.25, { tags: ['composer:session'] });
    const unfloored = await json.semanticSearch('measured minimum thickness', 5, 0, { tags: ['composer:session'] });
    expect(floored).toHaveLength(0);          // the trap
    expect(unfloored).toHaveLength(1);        // the same corpus, same query, floor removed

    // The SQLite store the Composer actually uses has no length-biased floor at all — FTS and the
    // dense stage each own their own confidence — so the passage is returned whatever minScore says.
    // Switching stores did not tune this trap away, it deleted the mechanism.
    const corpus = new ComposerCorpus(
      createComposerStore(null, null, path.join(workdir, 'sq.sqlite')),
      { manifestPath: path.join(workdir, 'sq.json') },
    );
    await corpus.ingest([await write('report.txt', PAGE_TWO)], 'session');
    expect(await corpus.search('measured minimum thickness', 5, ['session', 'library'], 0.25))
      .not.toHaveLength(0);
    expect(await corpus.search('measured minimum thickness', 5)).not.toHaveLength(0);
  });

  it('longer passages are not penalised relative to short ones', async () => {
    const corpus = new ComposerCorpus(
      createComposerStore(null, null, path.join(workdir, 'v.json')),
      { manifestPath: path.join(workdir, 'c.json') },
    );
    // A one-line note and a full procedure both mention the term. The procedure is the useful one,
    // and a length-biased floor is exactly what would have removed it.
    await corpus.ingest([
      await write('note.txt', 'Check corrosion.'),
      await write('SOP-Corrosion-Assessment.txt',
        'CORROSION ASSESSMENT PROCEDURE. '.repeat(2)
        + 'Corrosion rate is derived from successive wall thickness measurements taken at the same '
        + 'location. Where the computed rate projects the wall below minimum allowable thickness '
        + 'before the next scheduled inspection, an engineering assessment is mandatory and the '
        + 'equipment shall be referred for repair, replacement or fitness-for-service evaluation.'),
    ], 'session');

    const hits = await corpus.search('corrosion rate wall thickness engineering assessment', 5);
    expect(hits.some((hit) => hit.name === 'SOP-Corrosion-Assessment.txt')).toBe(true);
  });
});
