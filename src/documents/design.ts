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

/** A serif for long prose, a grotesque for slides and data. Both ship with Office and macOS. */
export const FONT = {
  prose: 'Georgia',
  sans: 'Helvetica Neue',
  mono: 'Menlo',
} as const;

/** Points. 1in margins on a document; slides get their own generous gutter. */
export const PAGE = {
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

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'numbered'; items: string[] }
  | { kind: 'keyvalue'; pairs: { label: string; value: string }[] }
  | { kind: 'quote'; text: string; attribution?: string }
  | { kind: 'code'; text: string; language?: string }
  | TableBlock
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
