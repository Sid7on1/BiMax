/**
 * Layout-aware conversion, as an optional upgrade to the existing extractors.
 *
 * ## Why add a second reader when `extract.ts` already reads everything
 *
 * `extract.ts` is deliberately dependency-free: a PDF text layer when there is one, Apple Vision or
 * Tesseract when there is not, ZIP-parsed XML for the Office formats. That covers the common case
 * and it runs on an air-gapped box with nothing installed. What it cannot do is recover *structure*.
 * A recognizer reads a thickness table as a run of numbers whose column headers are three lines away
 * and unlinked; the segment is honest about the page it came from and useless about which reading
 * belongs to which nozzle. Retrieval over that produces confident, wrong answers — the failure class
 * `Segment.context` exists to blunt and cannot fix, because the structure was destroyed at read
 * time.
 *
 * Docling is a layout model (RT-DETR + TableFormer) that recovers rows, columns and reading order.
 * It is MIT, runs on CPU, and is Python — which is why it is optional and why nothing in the default
 * path depends on it.
 *
 * ## Why it is opt-in and never provisions itself
 *
 * The venv is hundreds of megabytes and the models are downloaded on first conversion. Doing that
 * silently because someone dropped a PDF would be a surprise on a metered link and an outage on a
 * full disk. So `available()` reports what is installed and never installs, `ensure()` is the only
 * thing that provisions, and everything degrades to the built-in extractors — which still work.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils';
import { PythonVenv, runProcess } from '../sidecar/python.env';
// Type-only: `extract.ts` routes INTO this module, so a runtime edge back would be a cycle.
import type { Segment } from './extract';

/** One page of a converted document, in the source's own page numbering. */
export interface DoclingPage {
  /** 1-indexed. `0` means the build could not place this text on a page — never cite it as one. */
  page: number;
  text: string;
  /** Tables recovered on this page, as markdown so the row/column structure survives. */
  tables: string[];
}

export interface DoclingDocument {
  path: string;
  ok: boolean;
  /** False when this Docling build could not report page provenance; every page is then `0`. */
  paged: boolean;
  pages: DoclingPage[];
  error?: string;
}

const VENV = new PythonVenv({
  name: 'docling',
  // Pinned major so a breaking API change is an explicit upgrade rather than a silent one: the
  // helper script codes against `DocumentConverter -> result.document`, and Docling has moved that
  // surface before.
  packages: ['docling>=2,<3'],
  imports: ['docling'],
});

export function doclingVenv(): PythonVenv {
  return VENV;
}

/** The committed helper. Source lives beside this file so the two stay reviewable together. */
export function helperScript(): string {
  return path.join(__dirname, 'native', 'docling_convert.py');
}

export class DoclingUnavailable extends Error {
  constructor(reason: string) {
    super(
      `Layout-aware conversion is not available (${reason}). Nothing was converted — rather than `
      + 'return a document whose tables have been flattened into loose numbers and let it look like '
      + 'a clean read. Install it once with "/sidecars install docling" (a few hundred MB of '
      + 'Python wheels, downloaded once and cached under vendor/docling). The built-in extractors '
      + 'continue to work without it; they simply cannot recover table structure.',
    );
    this.name = 'DoclingUnavailable';
  }
}

/**
 * Is the converter usable right now?
 *
 * Never provisions. A probe that installs is a probe nobody can call from a hot path.
 */
export async function doclingAvailable(): Promise<boolean> {
  if (process.env.BIMAX_DISABLE_DOCLING === '1') return false;
  if (!fs.existsSync(helperScript())) return false;
  return VENV.provisioned();
}

/**
 * Provision the venv AND pull the models. Slow, loud, and only because a human asked.
 *
 * The prefetch is not an optimisation. Docling downloads its weights on first conversion, and
 * `extract.ts` promises that extraction reaches no network and is safe under `--sovereign`. Leaving
 * the download to conversion time would make that promise false the first time anyone ingested a
 * PDF on an air-gapped box — and it would fail as a hung convert rather than an honest refusal.
 * Downloading here puts it where a human and a network are both present.
 */
export async function installDocling(): Promise<boolean> {
  if (!fs.existsSync(helperScript())) {
    Logger.warn(`[docling] helper script missing at ${helperScript()}`);
    return false;
  }
  if (!(await VENV.ensure())) return false;

  Logger.info('[docling] downloading layout and table models (one-time)…');
  const prefetch = await runProcess(VENV.python, [helperScript(), '--prefetch'], { timeoutMs: 1_800_000 });
  if (prefetch.status !== 0) {
    // The wheels are installed and conversion will still work with a network, so this is a warning
    // rather than a failed install — but it is named, because the consequence lands later and
    // somewhere else: a sovereign run whose first PDF stalls waiting for weights.
    Logger.warn(
      `[docling] model prefetch failed (${prefetch.stderr.trim().slice(0, 200) || 'unknown'}). `
      + 'Conversion will try to download on first use, which an air-gapped host will not allow.',
    );
  }
  return true;
}

/**
 * Convert documents, one NDJSON line out per file in.
 *
 * A non-zero exit means at least one file failed; the per-file JSON still carries the rest, so the
 * output is parsed either way rather than discarding good documents over one bad one. That is the
 * same decision `ocr.ts` makes for the same reason.
 */
export async function doclingConvert(paths: string[], timeoutMs = 600_000): Promise<DoclingDocument[]> {
  if (paths.length === 0) return [];
  if (!(await doclingAvailable())) throw new DoclingUnavailable('the Python environment is not provisioned');

  const result = await runProcess(VENV.python, [helperScript(), ...paths], {
    timeoutMs,
    env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1' },
  });
  if (result.status === -1 && !result.stdout) {
    throw new DoclingUnavailable(result.stderr || 'the helper could not be started');
  }
  if (result.stderr.trim()) {
    Logger.warn(`[docling] ${result.stderr.trim().slice(0, 400)}`);
  }

  const documents: DoclingDocument[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      documents.push(JSON.parse(line) as DoclingDocument);
    } catch {
      // A malformed line is one document's worth of loss, not the batch's.
      Logger.warn('[docling] skipped an unparseable output line');
    }
  }
  return documents;
}

/**
 * Turn a converted document into the segments the rest of the pipeline already speaks.
 *
 * Two things are load-bearing here:
 *
 * 1. **A table becomes part of its page's segment, not a segment of its own.** Splitting it out
 *    would give the numbers their own locator and separate them from the prose that says what the
 *    reading was taken during — and a segment is defined as a natural unit of the source.
 * 2. **`page: 0` produces no page locator at all.** The helper uses 0 for "this build could not
 *    tell me", and inventing page 1 from it would put a fabricated citation into an approval note.
 */
export function toSegments(document: DoclingDocument): Segment[] {
  const segments: Segment[] = [];
  for (const page of document.pages) {
    const parts = [page.text.trim(), ...page.tables.map((t) => t.trim())].filter(Boolean);
    if (parts.length === 0) continue;
    segments.push({
      text: parts.join('\n\n'),
      locator: page.page > 0 ? { page: page.page } : {},
      via: 'layout',
      ...(page.tables.length
        // The deterministic half of contextual retrieval: every chunk cut from a page whose tables
        // were recovered must keep saying so, because a chunk of bare numbers is otherwise
        // indistinguishable from a chunk of OCR noise.
        ? { context: `${path.basename(document.path)}${page.page > 0 ? ` · page ${page.page}` : ''} · `
            + `${page.tables.length} table${page.tables.length === 1 ? '' : 's'} recovered` }
        : {}),
    });
  }
  return segments;
}
