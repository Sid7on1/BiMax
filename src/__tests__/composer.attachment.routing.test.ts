import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandFileAtMentions } from '../cli/atMention';
import { ComposerCorpus, setComposerCorpus, createComposerStore } from '../memory/corpus';

/**
 * What happens when a user attaches a file.
 *
 * The Composer's front door is the `@path` an attach button or a drag-and-drop produces. Before
 * this routing existed, that path had two silent failures that both end with a confident answer
 * built on nothing:
 *
 *   • a file over 100 KB was skipped outright — no content, no error;
 *   • a binary document under the limit was read as UTF-8 and injected as mojibake.
 *
 * A refinery inspection report is routinely both a PDF and several megabytes, so this was not an
 * edge case for the intended user, it was the normal case. These tests grade the routing.
 */

let workdir: string;
let corpus: ComposerCorpus;

beforeEach(async () => {
  workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bimax-attach-'));
  corpus = new ComposerCorpus(
    createComposerStore(null, null, path.join(workdir, 'composer.index.sqlite')),
    { manifestPath: path.join(workdir, 'c.json') },
  );
  setComposerCorpus(corpus);
});

afterEach(async () => {
  setComposerCorpus(null);
  await fs.promises.rm(workdir, { recursive: true, force: true });
});

const write = async (name: string, body: string | Buffer): Promise<string> => {
  const file = path.join(workdir, name);
  await fs.promises.writeFile(file, body);
  return file;
};

describe('attachments route by kind and size, not by hope', () => {
  it('still inlines a small text file — RAG must not tax the ordinary case', async () => {
    const file = await write('config.yaml', 'threshold_mm: 6.4\nunit: CDU');
    const result = await expandFileAtMentions(`look at @${file}`, workdir);
    expect(result.text).toContain('threshold_mm: 6.4');
    expect(result.injected).toContain(`@${file}`);
  });

  it('ingests a large text file instead of silently skipping it', async () => {
    // The old behaviour: `if (stat.size > MAX) continue` — the user saw no error and no content.
    const big = `Corrosion observed at nozzle N2 on exchanger E-204.\n${'padding line\n'.repeat(20_000)}`;
    const file = await write('long-report.txt', big);
    expect((await fs.promises.stat(file)).size).toBeGreaterThan(100 * 1024);

    const result = await expandFileAtMentions(`review @${file}`, workdir);
    expect(result.text).toMatch(/Read into the Composer as \d+ searchable passage/);
    expect(result.text).toContain('ComposerSearchTool');
    // And it is genuinely retrievable, not merely announced.
    const hits = await corpus.search('nozzle N2 corrosion exchanger', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe('long-report.txt');
  });

  it('injects relevant passages but never the whole document', async () => {
    // The property is BOUNDED, not absent. Retrieved passages are the point — a pointer with no
    // content is what made a small model go poking at the file with shell commands. What must never
    // happen is the 200 KB arriving whole.
    const big = `UNIQUE-MARKER-9F2A\n${'filler sentence about nothing in particular.\n'.repeat(6_000)}`;
    const file = await write('bulk.txt', big);
    const result = await expandFileAtMentions(`what does this say @${file}`, workdir);
    expect(result.text).toMatch(/Most relevant passages/);
    // Orders of magnitude smaller than the source, and a hard ceiling either way.
    expect(result.text.length).toBeLessThan(big.length / 10);
    expect(result.text.length).toBeLessThan(20_000);
  });

  it('routes a document FORMAT to the corpus even when it is small', async () => {
    // A 4 KB spreadsheet would have passed the size check and been inlined as binary garbage.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Readings');
    sheet.addRow(['Equipment', 'Measured']);
    sheet.addRow(['E-204', 7.8]);
    const file = path.join(workdir, 'readings.xlsx');
    await workbook.xlsx.writeFile(file);

    const result = await expandFileAtMentions(`check @${file}`, workdir);
    expect(result.text).toContain('Read into the Composer');
    const hits = await corpus.search('E-204 measured', 5);
    expect(hits.some((hit) => hit.text.includes('7.8'))).toBe(true);
    expect(hits[0].locator).toContain('Readings');
  });

  it('reports an unreadable attachment rather than dropping it silently', async () => {
    // The user believes this file was read. If it was not, they must be told, or they will act on
    // an answer that had no access to the thing they attached.
    const file = await write('scan.tiff', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff]));
    const result = await expandFileAtMentions(`read @${file}`, workdir);
    expect(result.text).toMatch(/not ingested:/);
    expect(result.injected).toContain(`@${file}`);
  });

  it('says so when no Composer is available instead of pretending the file was read', async () => {
    setComposerCorpus(null);
    const file = await write('report.pdf', 'x'.repeat(150_000));
    const result = await expandFileAtMentions(`@${file}`, workdir);
    expect(result.text).toMatch(/not attached/);
  });

  it('tells the model NOT to inspect an already-parsed file with the shell', async () => {
    // Measured failure on a small local model: given only a pointer, it tried ReadDocumentTool
    // (PDFs and images only), then `ls -la`, then a python zipfile script — reinventing extraction
    // badly while a parsed copy sat in the corpus.
    // A document FORMAT, so it routes to the corpus. A small .txt is deliberately still inlined —
    // RAG must not tax the ordinary case.
    const file = await write('slides.csv', 'Slide,Topic\n1,Biological limitations of human flight\n');
    const result = await expandFileAtMentions(`what is this about @${file}`, workdir);
    expect(result.text).toMatch(/Do NOT inspect this file with shell commands/);
  });

  it('MUTANT — the old size check would have returned nothing at all', async () => {
    const file = await write('huge.txt', 'FINDING: wall loss 4.2 mm\n' + 'y'.repeat(150_000));
    const stat = await fs.promises.stat(file);
    const oldBehaviour = stat.size > 100 * 1024 ? null : 'inlined';
    expect(oldBehaviour).toBeNull();                       // the neutered path: silence

    const result = await expandFileAtMentions(`@${file}`, workdir);
    expect(result.injected).toHaveLength(1);               // ours: ingested and acknowledged
    expect(await corpus.search('wall loss', 3)).not.toHaveLength(0);
  });
});
