import * as fs from 'fs';
import { toSegments, doclingAvailable, helperScript, DoclingDocument } from '../documents/docling';
import { PythonVenv, vendorRoot } from '../sidecar/python.env';

/**
 * The converter itself needs a few hundred megabytes of Python and is not installed here, so what is
 * tested is the part that runs on its output: the mapping into `Segment`, where the citation is
 * either correct or fabricated. A page number invented from a document whose build could not report
 * one is the failure that matters — it puts a page reference into an approval note that nobody can
 * check against the source.
 */

const doc = (pages: DoclingDocument['pages'], paged = true): DoclingDocument => ({
  path: '/drop/E-204 Inspection Report.pdf',
  ok: true,
  paged,
  pages,
});

describe('converted pages become citable segments', () => {
  it('carries the page through as a locator', () => {
    const segments = toSegments(doc([
      { page: 1, text: 'Shell course 1 examined.', tables: [] },
      { page: 2, text: 'Minimum measured thickness 9.4 mm.', tables: [] },
    ]));
    expect(segments).toHaveLength(2);
    expect(segments[0].locator).toEqual({ page: 1 });
    expect(segments[1].locator).toEqual({ page: 2 });
    expect(segments[0].via).toBe('layout');
  });

  it('NEVER invents a page when the build could not report one', () => {
    // page 0 is the helper's "unplaced". Turning that into page 1 would be a fabricated citation.
    const segments = toSegments(doc([{ page: 0, text: 'Whole document markdown.', tables: [] }], false));
    expect(segments).toHaveLength(1);
    expect(segments[0].locator).toEqual({});
    expect(segments[0].locator.page).toBeUndefined();
  });

  it('keeps a table with the prose on its own page rather than splitting it out', () => {
    // A segment is a natural unit of the source. Giving the table its own locator would separate the
    // readings from the sentence that says what they were taken during.
    const segments = toSegments(doc([{
      page: 3,
      text: 'Readings taken during the 2026 shutdown.',
      tables: ['| Nozzle | mm |\n| --- | --- |\n| N2 | 7.8 |'],
    }]));
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toContain('2026 shutdown');
    expect(segments[0].text).toContain('N2');
    expect(segments[0].locator).toEqual({ page: 3 });
  });

  it('rides a context line on pages whose tables were recovered', () => {
    const segments = toSegments(doc([{ page: 3, text: 'x', tables: ['| a |', '| b |'] }]));
    // The deterministic half of contextual retrieval: every chunk cut from this page keeps saying
    // the numbers in it came out of a recovered table, not out of OCR noise.
    expect(segments[0].context).toContain('page 3');
    expect(segments[0].context).toContain('2 tables recovered');
  });

  it('adds no context line when there was no table to describe', () => {
    expect(toSegments(doc([{ page: 1, text: 'prose only', tables: [] }]))[0].context).toBeUndefined();
  });

  it('drops empty pages instead of emitting a citable segment with nothing in it', () => {
    const segments = toSegments(doc([
      { page: 1, text: '   ', tables: [] },
      { page: 2, text: 'real', tables: [] },
    ]));
    expect(segments).toHaveLength(1);
    expect(segments[0].locator).toEqual({ page: 2 });
  });
});

describe('availability is honest and never installs', () => {
  it('the helper script is committed beside the module', () => {
    expect(fs.existsSync(helperScript())).toBe(true);
  });

  it('reports unavailable when disabled, without touching Python', () => {
    process.env.BIMAX_DISABLE_DOCLING = '1';
    return doclingAvailable()
      .then((available) => expect(available).toBe(false))
      .finally(() => { delete process.env.BIMAX_DISABLE_DOCLING; });
  });

  it('a venv that was never provisioned reports false rather than throwing', async () => {
    const venv = new PythonVenv({ name: 'does-not-exist', packages: [], imports: ['nothing_here'] });
    expect(venv.dir.startsWith(vendorRoot())).toBe(true);
    await expect(venv.provisioned()).resolves.toBe(false);
  });
});
