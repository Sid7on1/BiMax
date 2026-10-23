/**
 * One house style for every document Bimax produces.
 *
 * A generated deliverable reads as generated for reasons that are almost entirely typographic, not
 * lexical: a heading one point larger than its body, six different greys, tables ruled on all four
 * sides, centre-aligned paragraphs, and a colour used because it was available rather than because
 * it means something. Each writer below (docx / pdf / pptx / xlsx) is a different library with a
 * different unit system, so without a shared source of truth the four drift into four house styles
 * and a set of documents from one task stops looking like a set.
 *
 * These tokens are that source of truth. They are deliberately few — one accent, four greys, a
 * modular type scale, and a single spacing unit everything is a multiple of.
 */

/** Points. A 1.25 modular scale from an 11pt body — large enough steps to read as hierarchy. */
export const TYPE = {
  title: 26,
  h1: 18,
  h2: 14,
  h3: 11.5,
  body: 11,
  small: 9.5,
  micro: 8,
} as const;

/** Points. Everything vertical is a multiple of 4 so the page keeps one rhythm. */
export const SPACE = {
  unit: 4,
  tight: 4,
  paragraph: 8,
  section: 20,
  block: 12,
} as const;

/**
 * Ink, not colour. Text is near-black rather than pure black (pure black on white is harsh in
 * print), the greys are one family, and ACCENT is the only chromatic value — used for rules and
 * headers, never for body text.
 */
export const COLOR = {
  ink: '1A1A1A',
  body: '2E2E2E',
  muted: '6B6B6B',
  faint: '9A9A9A',
  rule: 'D8D8D8',
  wash: 'F4F4F4',
  accent: '1F4E79',
  accentWash: 'EAF0F6',
} as const;

/**
 * Series colours. The accent leads, then hues chosen to stay distinguishable in greyscale print
 * and for the common red-green colour deficiencies — a chart that only works in colour is a chart
 * half the readers cannot read.
 */
export const CHART = ['1F4E79', 'C1663A', '4E7A52', '7A5C8E', '8A7B2F', '3E7C8C'] as const;

/** A serif for long prose, a grotesque for slides and data. Both ship with Office and macOS. */
export const FONT = {
  prose: 'Georgia',
  sans: 'Helvetica Neue',
  mono: 'Menlo',
} as const;

/** Points. 1in margins on a document; slides get their own generous gutter. */
export const PAGE = {
  /** US Letter, in points — the size both writers already assumed implicitly. */
  width: 612,
  height: 792,
  marginTop: 72,
  marginBottom: 72,
  marginLeft: 72,
  marginRight: 72,
  /** Measured line length. Prose past ~90 characters is measurably harder to scan. */
  maxCharsPerLine: 90,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The content model every writer consumes.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TableBlock {
  kind: 'table';
  /** First row is the header. Every row must have the same length as `columns`. */
  columns: string[];
  rows: string[][];
  caption?: string;
}

export interface ImageBlock {
  kind: 'image';
  /** Project-relative path to a PNG or JPEG already on disk. Never a URL or base64. */
  path: string;
  caption?: string;
  /** Fraction of the content width, 0.1–1. The aspect ratio is always preserved. */
  width?: number;
}

/**
 * Data, not pixels. The writer draws it — natively in PowerPoint (where the reader can click the
 * chart and see the numbers) and as vector graphics in PDF. Both stay crisp at any zoom, which a
 * rendered PNG would not, and neither needs a charting dependency compiled into the engine.
 */
export interface ChartBlock {
  kind: 'chart';
  chart: 'bar' | 'line' | 'pie';
  /** Category labels — one per value in every series. */
  labels: string[];
  /** One entry per series; `values` must line up with `labels`. Pie charts use the first series. */
  series: { name: string; values: number[] }[];
  caption?: string;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'numbered'; items: string[] }
  | { kind: 'keyvalue'; pairs: { label: string; value: string }[] }
  | { kind: 'quote'; text: string; attribution?: string }
  | { kind: 'code'; text: string; language?: string }
  | TableBlock
  | ImageBlock
  | ChartBlock
  | { kind: 'divider' }
  | { kind: 'pagebreak' };

export interface Slide {
  title: string;
  /** A slide is one claim. Keep bullets few and short; the writer will not shrink text to fit. */
  bullets?: string[];
  notes?: string;
  table?: { columns: string[]; rows: string[][] };
  /** A single large statement instead of bullets — for section dividers and headline numbers. */
  statement?: string;
  /** A picture as the slide's body. Mutually exclusive with the other body kinds. */
  image?: { path: string; caption?: string };
  /** A native, editable PowerPoint chart as the slide's body. */
  chart?: Omit<ChartBlock, 'kind'>;
}

export interface Sheet {
  name: string;
  columns: string[];
  rows: (string | number | null)[][];
  /** Column index → a number format, e.g. `{ 2: '#,##0.00' }`. */
  formats?: Record<number, string>;
  /** Append a SUM row for these column indexes. */
  totals?: number[];
}

export interface DocumentSpec {
  title: string;
  subtitle?: string;
  author?: string;
  /** ISO date or free text; defaults to today when omitted. */
  date?: string;
  blocks?: Block[];
  slides?: Slide[];
  sheets?: Sheet[];
}

/** A document with no date reads as undated rather than timeless. Default to today. */
export function resolveDate(spec: DocumentSpec): string {
  if (spec.date) return spec.date;
  return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Every writer validates the same way, so a bad spec fails identically in all four formats. */
/** Shape checks only. Existence, format and size are the loader's job at build time. */
function imageProblem(b: { path?: unknown; width?: unknown }): string | null {
  if (typeof b.path !== 'string' || !b.path.trim()) return 'path is required';
  if (b.width !== undefined && (typeof b.width !== 'number' || !(b.width > 0) || b.width > 1)) {
    return 'width must be a number in (0, 1] — a fraction of the content width';
  }
  return null;
}

function chartProblem(c: { chart?: unknown; labels?: unknown; series?: unknown }): string | null {
  if (c.chart !== 'bar' && c.chart !== 'line' && c.chart !== 'pie') return 'chart must be bar, line or pie';
  if (!Array.isArray(c.labels) || c.labels.length === 0) return 'labels must be a non-empty array';
  if (!Array.isArray(c.series) || c.series.length === 0) return 'series must be a non-empty array';
  for (const [i, ser] of c.series.entries()) {
    if (!ser || typeof ser.name !== 'string' || !ser.name) return `series[${i}].name is required`;
    if (!Array.isArray(ser.values)) return `series[${i}].values must be an array`;
    if (ser.values.length !== c.labels.length) {
      return `series[${i}].values has ${ser.values.length} values but there are ${c.labels.length} labels`;
    }
    const bad = (ser.values as unknown[]).findIndex(v => typeof v !== 'number' || !Number.isFinite(v));
    // A NaN reaches the file as a blank bar with no error, which reads as a real zero.
    if (bad >= 0) return `series[${i}].values[${bad}] is not a finite number`;
  }
  return null;
}

export function validateSpec(spec: DocumentSpec, need: 'blocks' | 'slides' | 'sheets'): string | null {
  if (!spec || typeof spec !== 'object') return 'spec must be an object';
  if (!spec.title || typeof spec.title !== 'string') return 'spec.title is required';
  const value = spec[need];
  if (!Array.isArray(value) || value.length === 0) return `spec.${need} must be a non-empty array`;
  if (need === 'blocks') {
    for (const [i, b] of (spec.blocks ?? []).entries()) {
      if (!b || typeof (b as { kind?: unknown }).kind !== 'string') return `blocks[${i}] has no kind`;
      if (b.kind === 'table') {
        const bad = b.rows.findIndex(r => r.length !== b.columns.length);
        if (bad >= 0) return `blocks[${i}].rows[${bad}] has ${b.rows[bad].length} cells but there are ${b.columns.length} columns`;
      }
      if (b.kind === 'image') {
        const bad = imageProblem(b);
        if (bad) return `blocks[${i}].${bad}`;
      }
      if (b.kind === 'chart') {
        const bad = chartProblem(b);
        if (bad) return `blocks[${i}].${bad}`;
      }
    }
  }
  if (need === 'slides') {
    for (const [i, sl] of (spec.slides ?? []).entries()) {
      const bodies = ['statement', 'table', 'bullets', 'image', 'chart'].filter(k => (sl as unknown as Record<string, unknown>)[k]);
      if (bodies.length > 1) return `slides[${i}] has ${bodies.join(' + ')}; a slide carries one body`;
      if (sl.image) {
        const bad = imageProblem(sl.image);
        if (bad) return `slides[${i}].image.${bad}`;
      }
      if (sl.chart) {
        const bad = chartProblem(sl.chart);
        if (bad) return `slides[${i}].chart.${bad}`;
      }
    }
  }
  if (need === 'sheets') {
    for (const [i, s] of (spec.sheets ?? []).entries()) {
      if (!s.name) return `sheets[${i}].name is required`;
      const bad = s.rows.findIndex(r => r.length !== s.columns.length);
      if (bad >= 0) return `sheets[${i}].rows[${bad}] has ${s.rows[bad].length} cells but there are ${s.columns.length} columns`;
    }
  }
  return null;
}
