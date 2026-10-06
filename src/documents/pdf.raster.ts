/**
 * Reading a PDF: the text layer when there is one, rasterized pages when there is not.
 *
 * The product could write four document formats and read none of them. That is the gap under
 * PS 26117's headline demonstration — "reading a scanned inspection report, pulling out key
 * findings and drafting an approval note" — because nothing in the tree could open the report.
 *
 * ## Why the text layer is tried first
 *
 * "Scanned" and "PDF" are not the same thing. A PDF exported from Word carries an exact text layer;
 * a PDF produced by a flatbed scanner carries a picture of text. OCR on the first is strictly
 * worse than reading it: slower, lossy, and it will occasionally misread a digit in a measurement
 * that an engineer is going to act on. So the discriminator is per PAGE, not per document — a
 * report with a typed body and a photographed annexe gets the exact text for the body and OCR only
 * for the annexe, which is also the common shape of a real inspection report.
 *
 * ## Why poppler
 *
 * `pdftotext` and `pdftoppm` are one dependency, offline, no model, no service, present in every
 * Linux distribution and one `brew install poppler` on macOS. The alternative — a JavaScript PDF
 * renderer — would put a font rasterizer inside the agent process for no benefit an air-gapped
 * deployment can use.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../utils/logger';

/** Per-child execution deadline, not a whole-document/OCR budget or measured optimum. */
const PDF_PROCESS_TIMEOUT_MS = 30_000;
export interface PdfProcessOptions { timeoutMs?: number; signal?: AbortSignal }

function validateOptions(options: RasterOptions): void {
  for (const page of [options.firstPage, options.lastPage]) {
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 1)) throw new Error('PDF page numbers must be positive integers.');
  }
  if (options.firstPage !== undefined && options.lastPage !== undefined && options.lastPage < options.firstPage) throw new Error('PDF lastPage must not precede firstPage.');
  if (options.dpi !== undefined && (!Number.isFinite(options.dpi) || options.dpi <= 0 || options.dpi > 600)) throw new Error('PDF dpi must be positive and at most 600.');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000)) throw new Error('PDF child deadline must be 1–300000 ms.');
  options.signal?.throwIfAborted();
}

/** Close the caller's pipes and kill the inherited process group before settling a deadline/Stop. */
function run(binary: string, args: string[], options: PdfProcessOptions & { maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  validateOptions(options);
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const stop = (error: Error) => {
      if (settled) return;
      if (child?.pid) {
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* The process may already have exited. */ } }
      }
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
      finish(error);
    };
    const abort = () => {
      const error = new Error('PDF reading was interrupted.', { cause: options.signal?.reason }); error.name = 'AbortError'; stop(error);
    };
    try {
      child = spawn(binary, args, { cwd: process.cwd(), env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > (options.maxBuffer ?? 1 << 26)) {
          stop(Object.assign(new Error(`PDF ${binary} exceeded its captured-output byte limit.`), { code: 'ERR_PDF_OUTPUT_LIMIT' })); return;
        }
        chunks.push(chunk);
      };
      child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.stdout?.once('error', stop);
      child.stderr?.once('error', stop);
      child.once('error', error => finish(Object.assign(new Error(error.message, { cause: error }), { code: (error as NodeJS.ErrnoException).code })));
      child.once('close', (code, signal) => {
        if (settled) return;
        if (code === 0) finish();
        else finish(Object.assign(new Error(`PDF ${binary} failed (${signal ?? code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 2000)}`), { code, signal }));
      });
      const deadline = options.timeoutMs ?? PDF_PROCESS_TIMEOUT_MS;
      timer = setTimeout(() => stop(Object.assign(new Error(`PDF ${binary} timed out after ${deadline}ms.`), { code: 'ETIMEDOUT' })), deadline);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    } catch (error) { finish(error as Error); }
  });
}

function textPages(stdout: string): string[] {
  if (!stdout) return [];
  const pages = stdout.split('\f');
  if (stdout.endsWith('\f')) pages.pop();
  return pages;
}

/** How much recognizable text a page must carry before it counts as having a real text layer. */
const TEXT_LAYER_MIN_CHARS = 40;

export interface RasterOptions extends PdfProcessOptions {
  /** 1-indexed inclusive page range. Omitted means the whole document. */
  firstPage?: number;
  lastPage?: number;
  /**
   * Render resolution. 150 dpi is the floor at which Vision and Tesseract read 8-point drawing
   * annotations reliably; 300 doubles the file size for no measured gain on printed reports, and
   * is worth reaching for only on a dense P&ID.
   */
  dpi?: number;
  /** Parent for a fresh, owned image job directory; unrelated existing images are never reused. */
  outDir?: string;
}

export interface PdfPage {
  /** 1-indexed page number in the source document. */
  page: number;
  /** Text from the embedded layer, when the page had one. */
  text?: string;
  /** Rendered image path, present when the page needs to be looked at. */
  imagePath?: string;
  /** How this page's content was obtained. */
  source: 'text-layer' | 'raster';
}

export interface PdfReadResult {
  pages: PdfPage[];
  /** Total pages in the document, even when only a range was read. */
  totalPages: number;
  /** The directory holding rendered images, when any were rendered. */
  outDir?: string;
  /** Call after OCR has consumed the owned raster images; safe to call more than once. */
  dispose?: () => Promise<void>;
}

export class PdfToolingMissing extends Error {
  constructor(public readonly binary: string) {
    super(
      `${binary} is not installed, so this PDF cannot be read. It is part of poppler: ` +
      `"brew install poppler" on macOS, "apt install poppler-utils" on Debian/Ubuntu. ` +
      `Poppler runs entirely offline — installing it does not make this deployment less sovereign.`
    );
    this.name = 'PdfToolingMissing';
  }
}

/**
 * Is `binary` on PATH?
 *
 * By running it, not by asking the shell about it. `command -v` through `execFile` is unreliable
 * (it is a shell builtin, and the shell option changes how the argv is assembled), and it failed
 * silently here — reporting poppler as absent on a machine that had it, which skipped the whole
 * read path rather than exercising it. ENOENT is the only answer that means "not installed"; a
 * non-zero exit from a `-v` flag still proves the binary is there.
 */
async function has(binary: string, options: PdfProcessOptions): Promise<boolean> {
  try {
    await run(binary, ['-v'], { ...options, timeoutMs: options.timeoutMs ?? 5_000 });
    return true;
  } catch (error: unknown) {
    if (options.signal?.aborted) throw error;
    const code = (error as { code?: string | number } | null)?.code;
    if (code === 'ENOENT') return false;
    if (typeof code === 'number') return true;
    throw error;
  }
}

/** Is poppler available? Reported rather than assumed, so a caller can degrade with a real message. */
export async function pdfToolingAvailable(options: PdfProcessOptions = {}): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const binary of ['pdftotext', 'pdftoppm']) {
    if (!(await has(binary, options))) missing.push(binary);
  }
  return { ok: missing.length === 0, missing };
}

/** Page count, read from the document rather than inferred from what rendering produced. */
export async function pdfPageCount(file: string, options: PdfProcessOptions = {}): Promise<number> {
  try {
    const { stdout } = await run('pdfinfo', [file], { ...options, maxBuffer: 1 << 20 });
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    if (match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0) return Number(match[1]);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const code = (error as { code?: string | number } | null)?.code;
    if (code !== 'ENOENT' && typeof code !== 'number') throw error;
  }
  // pdftotext emits a form feed between pages, so the count is derivable without pdfinfo.
  try {
    const { stdout } = await run('pdftotext', [file, '-'], options);
    const count = textPages(stdout).length;
    if (!count) throw new Error('PDF page count is unavailable: the reader produced no pages.');
    return count;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if ((error as { code?: string } | null)?.code === 'ENOENT') throw new PdfToolingMissing('pdftotext');
    throw error;
  }
}

/** Per-page text from the embedded layer. Index 0 is page 1. */
export async function extractTextLayer(file: string, options: RasterOptions = {}): Promise<string[]> {
  validateOptions(options);
  const args: string[] = [];
  if (options.firstPage) args.push('-f', String(options.firstPage));
  if (options.lastPage) args.push('-l', String(options.lastPage));
  // `-layout` preserves column structure, which is what makes a tabulated findings table readable
  // instead of collapsing into one stream of words.
  args.push('-layout', file, '-');
  try {
    const { stdout } = await run('pdftotext', args, options);
    return textPages(stdout);
  } catch (error: unknown) {
    if (options.signal?.aborted) throw error;
    if ((error as { code?: string } | null)?.code === 'ENOENT') throw new PdfToolingMissing('pdftotext');
    throw error;
  }
}

/** Render pages to PNG. Returns the produced paths in page order. */
export async function rasterizePages(file: string, options: RasterOptions = {}): Promise<{ outDir: string; images: string[]; dispose: () => Promise<void> }> {
  validateOptions(options);
  const parent = options.outDir ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true });
  const outDir = fs.mkdtempSync(path.join(parent, 'bimax-pdf-'));
  const dispose = async () => { await fs.promises.rm(outDir, { recursive: true, force: true }).catch(error => Logger.warn(`[PDF] Could not remove owned raster images: ${(error as Error).message}`)); };
  const prefix = path.join(outDir, 'page');
  const args = ['-png', '-r', String(options.dpi ?? 150)];
  if (options.firstPage) args.push('-f', String(options.firstPage));
  if (options.lastPage) args.push('-l', String(options.lastPage));
  args.push(file, prefix);
  try {
    await run('pdftoppm', args, { ...options, maxBuffer: 1 << 20 });
    const images = fs.readdirSync(outDir).filter(name => /^page-\d+\.png$/.test(name)).map(name => path.join(outDir, name)).sort((a, b) => pageNumberOf(a) - pageNumberOf(b));
    if (!images.length || images.some(image => { const stat = fs.lstatSync(image); return !stat.isFile() || stat.size === 0; })) throw new Error('PDF rendering produced no usable regular page images.');
    return { outDir, images, dispose };
  } catch (error: unknown) {
    await dispose();
    if (options.signal?.aborted) throw error;
    if ((error as { code?: string } | null)?.code === 'ENOENT') throw new PdfToolingMissing('pdftoppm');
    throw error;
  }
}

/** The page number pdftoppm encoded in a rendered filename (`page-07.png` → 7). */
export function pageNumberOf(imagePath: string): number {
  const match = /(\d+)\.png$/.exec(path.basename(imagePath));
  return match ? Number(match[1]) : 0;
}

/** Does this page carry a real text layer, or a picture of text? */
export function hasTextLayer(pageText: string | undefined): boolean {
  if (!pageText) return false;
  // Count letters and digits only: a scanned page's "text layer" is frequently a handful of stray
  // punctuation and whitespace that a naive length check would accept.
  const meaningful = pageText.replace(/[^\p{L}\p{N}]/gu, '');
  return meaningful.length >= TEXT_LAYER_MIN_CHARS;
}

/**
 * Read a PDF the way the agent should: exact text where the document has it, a rendered image where
 * it does not. Pages needing OCR come back with `imagePath` and no `text`; the OCR layer fills them.
 */
export async function readPdf(file: string, options: RasterOptions = {}): Promise<PdfReadResult> {
  validateOptions(options);
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  const totalPages = await pdfPageCount(file, options);
  const first = options.firstPage ?? 1;
  const last = Math.min(options.lastPage ?? totalPages, totalPages);
  if (first > totalPages) throw new Error('PDF firstPage is outside the document.');
  const layers = await extractTextLayer(file, options);
  const count = last - first + 1;
  if (layers.length > count) throw new Error('PDF text page coverage disagrees with the requested range.');
  const needRaster: number[] = [];
  for (let i = 0; i < count; i++) if (!hasTextLayer(layers[i])) needRaster.push(first + i);
  const imageFor = new Map<number, string>();
  let outDir: string | undefined;
  let dispose: (() => Promise<void>) | undefined;
  if (needRaster.length) {
    const rendered = await rasterizePages(file, { ...options, firstPage: needRaster[0], lastPage: needRaster[needRaster.length - 1] });
    outDir = rendered.outDir;
    dispose = rendered.dispose;
    try {
      for (const image of rendered.images) {
        const page = pageNumberOf(image);
        if (page < first || page > last || imageFor.has(page)) throw new Error('PDF rendered page identities are invalid or duplicated.');
        imageFor.set(page, image);
      }
      if (needRaster.some(page => !imageFor.has(page))) throw new Error('PDF rendering did not cover every unreadable page.');
    } catch (error) { await dispose(); throw error; }
  }
  const pages: PdfPage[] = [];
  for (let i = 0; i < count; i++) {
    const page = first + i;
    const text = layers[i];
    if (hasTextLayer(text)) pages.push({ page, text: text!.trim(), source: 'text-layer' });
    else pages.push({ page, imagePath: imageFor.get(page), source: 'raster' });
  }
  return { pages, totalPages, ...(outDir ? { outDir, dispose } : {}) };
}
