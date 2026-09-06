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

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/** How much recognizable text a page must carry before it counts as having a real text layer. */
const TEXT_LAYER_MIN_CHARS = 40;

export interface RasterOptions {
  /** 1-indexed inclusive page range. Omitted means the whole document. */
  firstPage?: number;
  lastPage?: number;
  /**
   * Render resolution. 150 dpi is the floor at which Vision and Tesseract read 8-point drawing
   * annotations reliably; 300 doubles the file size for no measured gain on printed reports, and
   * is worth reaching for only on a dense P&ID.
   */
  dpi?: number;
  /** Where the page images go. A caller that does not supply one gets a fresh temp directory. */
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
async function has(binary: string): Promise<boolean> {
  try {
    await run(binary, ['-v'], { timeout: 5_000 });
    return true;
  } catch (error: unknown) {
    return (error as { code?: string }).code !== 'ENOENT';
  }
}

/** Is poppler available? Reported rather than assumed, so a caller can degrade with a real message. */
export async function pdfToolingAvailable(): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const binary of ['pdftotext', 'pdftoppm']) {
    if (!(await has(binary))) missing.push(binary);
  }
  return { ok: missing.length === 0, missing };
}

/** Page count, read from the document rather than inferred from what rendering produced. */
export async function pdfPageCount(file: string): Promise<number> {
  try {
    const { stdout } = await run('pdfinfo', [file], { maxBuffer: 1 << 20 });
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    if (match) return Number(match[1]);
  } catch { /* pdfinfo is optional; fall through to the text-layer probe */ }
  // pdftotext emits a form feed between pages, so the count is derivable without pdfinfo.
  try {
    const { stdout } = await run('pdftotext', [file, '-'], { maxBuffer: 1 << 26 });
    return stdout.split('\f').filter((_, i, a) => i < a.length - 1).length || 1;
  } catch {
    throw new PdfToolingMissing('pdftotext');
  }
}

/** Per-page text from the embedded layer. Index 0 is page 1. */
export async function extractTextLayer(file: string, options: RasterOptions = {}): Promise<string[]> {
  const args: string[] = [];
  if (options.firstPage) args.push('-f', String(options.firstPage));
  if (options.lastPage) args.push('-l', String(options.lastPage));
  // `-layout` preserves column structure, which is what makes a tabulated findings table readable
  // instead of collapsing into one stream of words.
  args.push('-layout', file, '-');
  try {
    const { stdout } = await run('pdftotext', args, { maxBuffer: 1 << 26 });
    return stdout.split('\f').slice(0, -1);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') throw new PdfToolingMissing('pdftotext');
    throw error;
  }
}

/** Render pages to PNG. Returns the produced paths in page order. */
export async function rasterizePages(file: string, options: RasterOptions = {}): Promise<{ outDir: string; images: string[] }> {
  const outDir = options.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-pdf-'));
  fs.mkdirSync(outDir, { recursive: true });
  const prefix = path.join(outDir, 'page');
  const args = ['-png', '-r', String(options.dpi ?? 150)];
  if (options.firstPage) args.push('-f', String(options.firstPage));
  if (options.lastPage) args.push('-l', String(options.lastPage));
  args.push(file, prefix);
  try {
    await run('pdftoppm', args, { maxBuffer: 1 << 20 });
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') throw new PdfToolingMissing('pdftoppm');
    throw error;
  }
  const images = fs.readdirSync(outDir)
    .filter(name => name.startsWith('page') && name.endsWith('.png'))
    .map(name => path.join(outDir, name))
    // pdftoppm zero-pads inconsistently by page count, so sort on the parsed number, never the name.
    .sort((a, b) => pageNumberOf(a) - pageNumberOf(b));
  return { outDir, images };
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
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  const totalPages = await pdfPageCount(file);
  const first = options.firstPage ?? 1;
  const layers = await extractTextLayer(file, options);

  const needRaster = layers.some(text => !hasTextLayer(text)) || layers.length === 0;
  let images: string[] = [];
  let outDir: string | undefined;
  if (needRaster) {
    const rendered = await rasterizePages(file, options);
    images = rendered.images;
    outDir = rendered.outDir;
  }
  const imageFor = (page: number): string | undefined =>
    images.find(image => pageNumberOf(image) === page);

  const count = Math.max(layers.length, images.length);
  const pages: PdfPage[] = [];
  for (let i = 0; i < count; i++) {
    const page = first + i;
    const text = layers[i];
    if (hasTextLayer(text)) pages.push({ page, text: text!.trim(), source: 'text-layer' });
    else pages.push({ page, imagePath: imageFor(page), source: 'raster' });
  }
  return { pages, totalPages, ...(outDir ? { outDir } : {}) };
}
