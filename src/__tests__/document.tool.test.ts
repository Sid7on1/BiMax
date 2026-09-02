import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDocumentTool } from '../tools/implementations/document.tool';

/**
 * The originating failure: asked for a PDF the agent had no tool for it, wrote prose with
 * WriteFileTool and named the file `.pdf`. `file` reported "Unicode text" and nothing could open
 * it. So these tests assert the FORMAT SIGNATURE on disk, not that a function returned.
 */
const governor: any = { approveTaskExecution: async () => true, mode: 'bypass' };

const PDF_MAGIC = Buffer.from('%PDF-');
/** docx / pptx / xlsx are ZIP containers; the local file header is 50 4b 03 04. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe('DocumentTool produces real, openable files', () => {
  let dir: string;
  const tool = createDocumentTool(governor);
  const run = (args: Record<string, unknown>): Promise<string> =>
    tool.execute(args, { cwd: dir }) as Promise<string>;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-doc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const prose = {
    title: 'Approval Note',
    blocks: [
      { kind: 'heading', level: 1, text: 'Recommendation' },
      { kind: 'paragraph', text: 'Replace the spool during the current window.' },
      { kind: 'table', columns: ['Point', 'Measured'], rows: [['TP-02', '5.98'], ['TP-04', '5.61']] },
    ],
  };

  test('pdf carries the PDF signature, not prose in a renamed file', async () => {
    const out = await run({ format: 'pdf', path: 'note.pdf', spec: prose });
    expect(out).toContain('note.pdf');
    const bytes = fs.readFileSync(path.join(dir, 'note.pdf'));
    expect(bytes.subarray(0, 5)).toEqual(PDF_MAGIC);
  });

  test('docx and xlsx are real OOXML containers', async () => {
    await run({ format: 'docx', path: 'a.docx', spec: prose });
    await run({ format: 'xlsx', path: 'a.xlsx', spec: { title: 'Book', sheets: [{ name: 'S', columns: ['A'], rows: [[1]] }] } });
    for (const f of ['a.docx', 'a.xlsx']) {
      expect(fs.readFileSync(path.join(dir, f)).subarray(0, 4)).toEqual(ZIP_MAGIC);
    }
  });

  /**
   * pptxgenjs uses a dynamic `import()` internally, which jest's CJS sandbox cannot execute
   * ("A dynamic import callback was invoked without --experimental-vm-modules"). That is a test-
   * runner limit, not a product one — the engine is bundled by bun and runs under real node. So
   * this builds the deck in a real node process and asserts the bytes it wrote, rather than
   * skipping the only format jest happens to be unable to load.
   */
  test('pptx is a real OOXML container with a slide per entry', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = path.join(dir, 'a.pptx');
    const script = `
      const { buildPptx } = require('${path.resolve(__dirname, '..', 'documents', 'pptx.writer')}');
      const fs = require('fs');
      buildPptx({ title: 'Deck', slides: [{ title: 'One', bullets: ['x'] }, { title: 'Two', statement: '11 months' }] })
        .then(b => { fs.writeFileSync('${out}', b); })
        .catch(e => { console.error(e); process.exit(1); });
    `;
    execFileSync('npx', ['tsx', '-e', script], { cwd: path.resolve(__dirname, '..', '..'), stdio: 'pipe', timeout: 120_000 });

    const bytes = fs.readFileSync(out);
    expect(bytes.subarray(0, 4)).toEqual(ZIP_MAGIC);
    // A cover plus the two content slides.
    const text = bytes.toString('latin1');
    expect(text).toContain('ppt/slides/slide3.xml');
  }, 150_000);

  test('the xlsx total is a live SUM formula, not a typed-in number', async () => {
    await run({
      format: 'xlsx', path: 'n.xlsx',
      spec: { title: 'N', sheets: [{ name: 'S', columns: ['Item', 'Qty'], rows: [['a', 2], ['b', 3]], totals: [1] }] },
    });
    const buf = fs.readFileSync(path.join(dir, 'n.xlsx'));
    const zlib = require('node:zlib') as typeof import('node:zlib');
    let found = false;
    for (let i = 0; i + 30 < buf.length && !found; i++) {
      if (!(buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04)) continue;
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      try {
        const body = buf.subarray(i + 30 + nameLen + extraLen);
        const text = zlib.inflateRawSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString();
        if (text.includes('SUM(')) found = true;
      } catch { /* not a deflated member we can read from here */ }
    }
    expect(found).toBe(true);
  });

  test('a mismatched extension is refused rather than written', async () => {
    const out = await run({ format: 'pdf', path: 'note.txt', spec: prose });
    expect(out).toMatch(/must match/i);
    expect(fs.existsSync(path.join(dir, 'note.txt'))).toBe(false);
  });

  test('a malformed table is refused with the offending row named', async () => {
    const out = await run({
      format: 'docx', path: 'b.docx',
      spec: { title: 'T', blocks: [{ kind: 'table', columns: ['A', 'B'], rows: [['only-one']] }] },
    });
    expect(out).toMatch(/rows\[0\]/);
    expect(fs.existsSync(path.join(dir, 'b.docx'))).toBe(false);
  });
});
