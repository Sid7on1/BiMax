/**
 * On-device OCR. No network, no model download, no service.
 *
 * ## Why two backends and not one
 *
 * macOS ships Vision, which is already on the machine, needs no weights, and reads handwriting
 * materially better than the alternatives — which matters when the input is a hand-annotated
 * inspection note. Linux does not have it, and a refinery's GPU server is a Linux box, so Tesseract
 * is the second backend. Both run entirely offline; the choice is availability, not preference.
 *
 * ## Why the macOS helper is compiled here rather than shipped
 *
 * Vision is only reachable from a native process. Compiling a ~90-line Swift file on first use and
 * caching the binary keeps the repository free of a checked-in Mach-O, keeps the helper's source
 * reviewable beside the code that calls it, and costs about two seconds once per installation. The
 * compile is local: `swiftc` is part of the Command Line Tools, and nothing is fetched.
 *
 * If neither backend is available the failure is REPORTED, never silently degraded. An OCR layer
 * that quietly returns empty text would make a scanned report look like a blank one, and the model
 * would then confidently summarise a document it never read.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export interface OcrPage {
  imagePath: string;
  text: string;
  /** Mean recognizer confidence, 0..1, when the backend reports one. */
  confidence?: number;
  lines: number;
  error?: string;
}

export interface OcrBackend {
  readonly name: 'vision' | 'tesseract';
  /** Is this backend usable on this machine right now? */
  available(): Promise<boolean>;
  recognize(imagePaths: string[]): Promise<OcrPage[]>;
}

/** Where the compiled Vision helper is cached between runs. */
function helperPath(sourceHash: string): string {
  return path.join(os.tmpdir(), `bimax-ocr-${sourceHash.slice(0, 12)}`);
}

/** The Swift source that calls Vision, kept beside this file so the two stay reviewable together. */
function helperSource(): string {
  return path.join(__dirname, 'native', 'ocr.swift');
}

/**
 * Apple Vision, via a locally compiled helper.
 *
 * The binary is keyed by a hash of its source, so editing the Swift file produces a new binary
 * rather than silently reusing a stale one — the failure that would otherwise be invisible, because
 * a cached helper runs perfectly well and simply does the old thing.
 */
export class VisionOcrBackend implements OcrBackend {
  readonly name = 'vision' as const;
  private binary: string | null = null;

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    if (!fs.existsSync(helperSource())) return false;
    // Run it rather than asking the shell: `command -v` through execFile is a shell builtin and
    // reports absent on machines that have the binary. ENOENT is the only true "not installed".
    try {
      await run('swiftc', ['--version'], { timeout: 15_000 });
      return true;
    } catch (error: unknown) {
      return (error as { code?: string }).code !== 'ENOENT';
    }
  }

  /** Compile once per source revision; reuse thereafter. */
  private async ensureBinary(): Promise<string> {
    if (this.binary && fs.existsSync(this.binary)) return this.binary;
    const source = helperSource();
    const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const target = helperPath(hash);
    if (!fs.existsSync(target)) {
      // -O because recognition is the cost, but the compile itself should not be gratuitously slow.
      await run('swiftc', ['-O', '-o', target, source], { timeout: 120_000 });
    }
    this.binary = target;
    return target;
  }

  async recognize(imagePaths: string[]): Promise<OcrPage[]> {
    if (imagePaths.length === 0) return [];
    const binary = await this.ensureBinary();
    // A non-zero exit means at least one page failed; the per-page JSON still carries the rest, so
    // the output is parsed either way rather than discarding good pages over one bad one.
    let stdout = '';
    try {
      ({ stdout } = await run(binary, imagePaths, { maxBuffer: 1 << 26, timeout: 300_000 }));
    } catch (error: unknown) {
      stdout = (error as { stdout?: string }).stdout ?? '';
      if (!stdout) throw error;
    }
    return stdout.split('\n').filter(Boolean).map(line => {
      const parsed = JSON.parse(line) as { path: string; text: string; confidence: number | null; lines: number; error: string | null };
      return {
        imagePath: parsed.path,
        text: parsed.text,
        lines: parsed.lines,
        ...(parsed.confidence !== null ? { confidence: parsed.confidence } : {}),
        ...(parsed.error ? { error: parsed.error } : {}),
      };
    });
  }
}

/** Tesseract, the portable backend. Present on Linux servers and installable everywhere. */
export class TesseractOcrBackend implements OcrBackend {
  readonly name = 'tesseract' as const;

  async available(): Promise<boolean> {
    try {
      await run('tesseract', ['--version'], { timeout: 10_000 });
      return true;
    } catch (error: unknown) {
      return (error as { code?: string }).code !== 'ENOENT';
    }
  }

  async recognize(imagePaths: string[]): Promise<OcrPage[]> {
    const pages: OcrPage[] = [];
    for (const imagePath of imagePaths) {
      try {
        // `stdout` as the output target keeps this from writing temp files beside the input.
        const { stdout } = await run('tesseract', [imagePath, 'stdout'], { maxBuffer: 1 << 24, timeout: 120_000 });
        const text = stdout.trim();
        pages.push({ imagePath, text, lines: text ? text.split('\n').length : 0 });
      } catch (error: unknown) {
        pages.push({ imagePath, text: '', lines: 0, error: (error as Error).message });
      }
    }
    return pages;
  }
}

export class NoOcrBackend extends Error {
  constructor() {
    super(
      'No on-device OCR backend is available, so a scanned page cannot be read. ' +
      'On macOS this needs the Xcode Command Line Tools ("xcode-select --install") for swiftc, ' +
      'which lets Bimax use the built-in Vision recognizer. On Linux, install tesseract-ocr. ' +
      'Both run entirely offline. Nothing was read — rather than return empty text and let a ' +
      'scanned report look like a blank one.'
    );
    this.name = 'NoOcrBackend';
  }
}

/** The first usable backend, Vision preferred on macOS. Null when none is installed. */
export async function selectOcrBackend(candidates?: OcrBackend[]): Promise<OcrBackend | null> {
  for (const backend of candidates ?? [new VisionOcrBackend(), new TesseractOcrBackend()]) {
    if (await backend.available()) return backend;
  }
  return null;
}

/** Recognize a set of page images, or throw {@link NoOcrBackend} naming what to install. */
export async function ocrPages(imagePaths: string[], candidates?: OcrBackend[]): Promise<{ backend: string; pages: OcrPage[] }> {
  const backend = await selectOcrBackend(candidates);
  if (!backend) throw new NoOcrBackend();
  return { backend: backend.name, pages: await backend.recognize(imagePaths) };
}
