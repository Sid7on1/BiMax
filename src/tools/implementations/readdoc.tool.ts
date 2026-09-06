import * as fs from 'fs';
import * as path from 'path';
import { buildTool } from '../tool.factory';
import { IGovernor } from '../../core/interfaces';
import { resolvePath } from '../path.util';
import { readPdf, pdfToolingAvailable, PdfToolingMissing } from '../../documents/pdf.raster';
import { ocrPages, NoOcrBackend } from '../../documents/ocr';
import { outcomeOk, outcomeError } from '../outcome';

/**
 * ReadDocumentTool — read a PDF or a scanned page, on this machine.
 *
 * The product could WRITE four document formats and read none of them, which is why PS 26117's
 * headline demonstration had no input path: nothing could open the inspection report the approval
 * note was supposed to be drafted from.
 *
 * The tool reports HOW each page was read, and that is not a detail. A page taken from an embedded
 * text layer is exact; a page recovered by OCR is a recognizer's best reading, and an engineer
 * acting on a wall thickness needs to know which one they are looking at. Every page is labelled,
 * and low-confidence OCR is called out rather than presented as if it were certain.
 */

/** Below this mean confidence, an OCR page is flagged for human confirmation before it is acted on. */
const LOW_CONFIDENCE = 0.6;

export const createReadDocumentTool = (governor: IGovernor) => buildTool({
  name: 'ReadDocumentTool',
  description: `Reads a PDF or scanned image on this machine and returns its text.

Use this for inspection reports, SOPs, manuals, drawings, and any scanned correspondence. Everything runs locally — the PDF is rasterized with poppler and read with the on-device OCR engine (Apple Vision on macOS, Tesseract elsewhere). Nothing is uploaded.

# How it reads
- A page with a real embedded text layer is read EXACTLY. No OCR runs on it.
- A page that is a picture of text is rasterized and OCR'd, and reported as such with a confidence.
- Each page in the result says which of the two it was, so you never present a recognizer's guess as if it were the document.

# Instructions
- **Large documents:** pass \`firstPage\`/\`lastPage\`. A 200-page manual read whole will bury the answer.
- **Drawings and dense P&IDs:** raise \`dpi\` to 300. The default 150 is right for printed reports.
- **Low confidence:** if a page reports \`lowConfidence\`, say so in your answer rather than asserting the value. Quote the number AND that it was OCR'd.
- Images (.png/.jpg/.tif) are OCR'd directly; no rasterizing step applies.`,
  isDestructive: false,
  isConcurrencySafe: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF or image (absolute, or relative to the working directory).' },
      firstPage: { type: 'number', description: 'Optional. First page to read, 1-indexed.' },
      lastPage: { type: 'number', description: 'Optional. Last page to read, inclusive.' },
      dpi: { type: 'number', description: 'Optional. Rasterization resolution for scanned pages (default 150; use 300 for dense drawings).' },
    },
    required: ['path'],
  },
  execute: async (args: { path: string; firstPage?: number; lastPage?: number; dpi?: number }, context?: any) => {
    const file = resolvePath(args.path, context?.cwd || process.cwd());
    if (!fs.existsSync(file)) return outcomeError('not_found', `No such file: ${args.path}`);

    const extension = path.extname(file).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'].includes(extension);
    if (!isImage && extension !== '.pdf') {
      return outcomeError('invalid_args',
        `ReadDocumentTool reads PDFs and images. "${extension || 'a file with no extension'}" is neither — `
        + `use ReadFileTool for text files.`);
    }

    try {
      // An image is already a page: no text layer to try, nothing to rasterize.
      if (isImage) {
        const { backend, pages } = await ocrPages([file]);
        const page = pages[0];
        return outcomeOk(JSON.stringify({
          file: args.path, kind: 'image', ocrBackend: backend,
          pages: [{
            page: 1, source: 'ocr', text: page.text, lines: page.lines,
            ...(page.confidence !== undefined ? { confidence: Number(page.confidence.toFixed(3)) } : {}),
            ...(page.confidence !== undefined && page.confidence < LOW_CONFIDENCE ? { lowConfidence: true } : {}),
            ...(page.error ? { error: page.error } : {}),
          }],
        }, null, 2));
      }

      const tooling = await pdfToolingAvailable();
      if (!tooling.ok) return outcomeError('external', new PdfToolingMissing(tooling.missing[0]).message);

      const result = await readPdf(file, {
        firstPage: args.firstPage, lastPage: args.lastPage, dpi: args.dpi,
      });

      // Only pages that genuinely need looking at reach the recognizer. On a digital PDF that is
      // none of them, which is the whole point of trying the text layer first.
      const needOcr = result.pages.filter(p => p.source === 'raster' && p.imagePath);
      let backend: string | undefined;
      const recognized = new Map<string, { text: string; confidence?: number; lines: number; error?: string }>();
      if (needOcr.length > 0) {
        const ocr = await ocrPages(needOcr.map(p => p.imagePath!));
        backend = ocr.backend;
        for (const page of ocr.pages) recognized.set(page.imagePath, page);
      }

      const pages = result.pages.map(page => {
        if (page.source === 'text-layer') {
          return { page: page.page, source: 'text-layer', text: page.text ?? '' };
        }
        const hit = page.imagePath ? recognized.get(page.imagePath) : undefined;
        // A page with no text layer that the recognizer also found nothing on is BLANK, not a scan
        // we read. Labelling it 'ocr' would imply a recognizer read something, and a trailing page
        // carrying only a footer would look like a page whose contents we failed to recover.
        const source = hit && hit.lines === 0 && !hit.error ? 'blank' : 'ocr';
        return {
          page: page.page,
          source,
          text: hit?.text ?? '',
          lines: hit?.lines ?? 0,
          ...(hit?.confidence !== undefined ? { confidence: Number(hit.confidence.toFixed(3)) } : {}),
          ...(hit?.confidence !== undefined && hit.confidence < LOW_CONFIDENCE ? { lowConfidence: true } : {}),
          ...(hit?.error ? { error: hit.error } : {}),
        };
      });

      return outcomeOk(JSON.stringify({
        file: args.path,
        kind: 'pdf',
        totalPages: result.totalPages,
        pagesRead: pages.length,
        ...(backend ? { ocrBackend: backend } : {}),
        readExactly: pages.filter(p => p.source === 'text-layer').length,
        readByOcr: pages.filter(p => p.source === 'ocr').length,
        blank: pages.filter(p => p.source === 'blank').length,
        pages,
      }, null, 2));
    } catch (error: unknown) {
      if (error instanceof NoOcrBackend || error instanceof PdfToolingMissing) {
        return outcomeError('external', error.message);
      }
      return outcomeError('io', `Could not read ${args.path}: ${(error as Error).message}`);
    }
  },
}, governor);
