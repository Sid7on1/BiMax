import * as fs from 'fs';
import * as path from 'path';
import { openSqlite, type SqliteDB } from '../core/sqlite';
import { Logger } from '../utils';
import { Segment, describeLocator } from '../documents/extract';

/**
 * Measured facts, extracted from documents and queryable as data.
 *
 * ## Why this exists at all
 *
 * Error analysis of retrieval over text-and-table documents puts **73% of residual failures in
 * "table structure mismatch" and a further 20% in numerical reasoning** — 93% of what still breaks
 * after hybrid retrieval and reranking are working. The cause is not a weak model, it is a category
 * error: in a vector index **numbers are tokens, not quantities.** Nothing in an embedding makes
 * 7.8 rank as *less than* 8.0.
 *
 * So a question an inspection engineer actually asks —
 *
 *     "which exchangers are below minimum allowable thickness?"
 *
 * is not a retrieval question, and no amount of retrieval tuning will answer it. It is a `SELECT`.
 * This module extracts the numbers out of the documents at ingest and puts them somewhere they can
 * be compared, sorted and filtered, while keeping every value chained to the file, sheet and row it
 * was read from so a computed answer stays as citable as a quoted one.
 *
 * ## What is deliberately NOT done
 *
 * - **No inference.** A unit the document does not state is not guessed. A corrosion rate the source
 *   does not give is not derived here — the agent may compute one, in the open, from facts that
 *   carry their provenance.
 * - **No prose mining beyond one line.** A regex that pairs an identifier in one paragraph with a
 *   number in another manufactures facts that were never asserted. Facts come from table rows, where
 *   the association between subject, property and value is structural, plus the narrow case of a
 *   single line that contains all three.
 *
 * A fact we did not read is not a fact.
 */

export interface Fact {
  /** The equipment or instrument the fact is about, e.g. `E-204`. */
  subject: string;
  /** What was measured, from the column header or the line's own wording. */
  property: string;
  value: number;
  /** Only when the document states it. Never inferred. */
  unit: string | null;
  /** ISO date when the document states one. */
  measuredOn: string | null;
  sourceFile: string;
  sourceName: string;
  locator: string;
  entryId: string;
}

export interface FactQuery {
  subject?: string;
  property?: string;
  /** Numeric comparison — the thing retrieval fundamentally cannot do. */
  op?: 'lt' | 'lte' | 'gt' | 'gte' | 'eq';
  value?: number;
  limit?: number;
}

const IDENTIFIER = /^[A-Z]{1,4}-\d{2,5}[A-Z]?$/;
const MAX_ROWS = 500;

/** `Measured mm`, `Thickness (mm)`, `Nominal, mm` → `mm`. Absent when the header states no unit. */
export function unitFromHeader(header: string): string | null {
  const parenthesised = /\(([^)]{1,12})\)\s*$/.exec(header);
  if (parenthesised) return parenthesised[1].trim();
  const trailing = /[\s,]([A-Za-zµ°%/]{1,8})\s*$/.exec(header.trim());
  if (trailing && !/^(no|id|name|type|date|ref)$/i.test(trailing[1])) return trailing[1];
  return null;
}

/** The column header minus its unit, so `Measured mm` and `Measured (mm)` are one property. */
export function propertyFromHeader(header: string): string {
  return header
    .replace(/\([^)]*\)\s*$/, '')
    .replace(/[\s,]+[A-Za-zµ°%/]{1,8}$/, (match) => (unitFromHeader(header) ? '' : match))
    .trim() || header.trim();
}

function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function parseDate(raw: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  return iso ? iso[0] : null;
}

/**
 * Pull facts out of one extracted segment.
 *
 * Tabular segments (`via: 'cells'`) are the reliable source: the header row names the properties and
 * each row's identifier column names the subject, so the subject/property/value association is
 * structural rather than guessed.
 */
export function factsFromSegment(
  segment: Segment,
  source: { file: string; name: string; entryId: string },
): Fact[] {
  const locator = describeLocator(segment.locator);
  const facts: Fact[] = [];
  const lines = segment.text.split('\n').filter((line) => line.trim());
  if (!lines.length) return facts;

  if (segment.via === 'cells') {
    const headers = lines[0].split('\t').map((cell) => cell.trim());
    // A header row must actually name things; a sheet that opens with data has no property names
    // and would otherwise produce facts called "7.8".
    if (!headers.some((header) => /[A-Za-z]{2,}/.test(header))) return facts;

    for (const line of lines.slice(1)) {
      const cells = line.split('\t').map((cell) => cell.trim());
      const subjectIndex = cells.findIndex((cell) => IDENTIFIER.test(cell.toUpperCase()));
      if (subjectIndex === -1) continue;                 // no subject → no assertion to record
      const subject = cells[subjectIndex].toUpperCase();
      const rowDate = cells.map(parseDate).find(Boolean) ?? null;

      cells.forEach((cell, index) => {
        if (index === subjectIndex) return;
        const value = parseNumber(cell);
        if (value === null) return;
        const header = headers[index] || `column ${index + 1}`;
        facts.push({
          subject,
          property: propertyFromHeader(header).toLowerCase(),
          value,
          unit: unitFromHeader(header),
          measuredOn: rowDate,
          sourceFile: source.file,
          sourceName: source.name,
          locator,
          entryId: source.entryId,
        });
      });
    }
    return facts;
  }

  // Prose, narrowly: subject, property and value must appear on ONE line. Pairing across lines is
  // how a fact gets manufactured that the document never asserted.
  for (const line of lines) {
    const subjectMatch = /\b([A-Z]{1,4}-\d{2,5}[A-Z]?)\b/.exec(line.toUpperCase());
    if (!subjectMatch) continue;
    const measurement = /([A-Za-z][A-Za-z \-]{2,40}?)\s+(-?\d+(?:\.\d+)?)\s*([A-Za-zµ°%/]{1,8})\b/.exec(line);
    if (!measurement) continue;
    const value = parseNumber(measurement[2]);
    if (value === null) continue;
    facts.push({
      subject: subjectMatch[1],
      property: measurement[1].trim().toLowerCase(),
      value,
      unit: measurement[3],
      measuredOn: parseDate(line),
      sourceFile: source.file,
      sourceName: source.name,
      locator,
      entryId: source.entryId,
    });
  }
  return facts;
}

export class FactStore {
  private db: SqliteDB | null = null;

  constructor(private readonly storePath: string) {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      this.db = openSqlite(storePath);
      if (!this.db) {
        // Visible, not silent: with no SQLite backend the numeric lane simply does not exist, and a
        // user must be told that rather than shown an empty result set.
        Logger.warn('[facts] no SQLite backend on this runtime — numeric fact queries are unavailable');
        return;
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS facts (
        subject TEXT NOT NULL,
        property TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT,
        measured_on TEXT,
        source_file TEXT NOT NULL,
        source_name TEXT NOT NULL,
        locator TEXT,
        entry_id TEXT NOT NULL
      )`);
      this.db.exec('CREATE INDEX IF NOT EXISTS facts_subject ON facts(subject)');
      this.db.exec('CREATE INDEX IF NOT EXISTS facts_property ON facts(property)');
      this.db.exec('CREATE INDEX IF NOT EXISTS facts_entry ON facts(entry_id)');
    } catch (error) {
      Logger.warn(`[facts] store unavailable: ${(error as Error).message}`);
      this.db = null;
    }
  }

  available(): boolean { return this.db !== null; }

  add(facts: Fact[]): number {
    if (!this.db || !facts.length) return 0;
    const insert = this.db.prepare(
      `INSERT INTO facts (subject, property, value, unit, measured_on, source_file, source_name, locator, entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const fact of facts) {
      insert.run(fact.subject, fact.property, fact.value, fact.unit, fact.measuredOn,
        fact.sourceFile, fact.sourceName, fact.locator, fact.entryId);
    }
    return facts.length;
  }

  removeEntry(entryId: string): number {
    if (!this.db) return 0;
    const before = this.count();
    this.db.prepare('DELETE FROM facts WHERE entry_id = ?').run(entryId);
    return before - this.count();
  }

  clear(): void {
    if (this.db) this.db.exec('DELETE FROM facts');
  }

  count(): number {
    if (!this.db) return 0;
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM facts').get()?.n ?? 0);
  }

  /**
   * Query facts. The comparison operators are the entire point — this is what the vector index
   * cannot express, and the parameters are bound, never concatenated.
   */
  query(request: FactQuery): Fact[] {
    if (!this.db) return [];
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (request.subject) { clauses.push('subject = ?'); params.push(request.subject.toUpperCase()); }
    if (request.property) { clauses.push('property LIKE ?'); params.push(`%${request.property.toLowerCase()}%`); }
    if (request.op && typeof request.value === 'number') {
      const operator = { lt: '<', lte: '<=', gt: '>', gte: '>=', eq: '=' }[request.op];
      clauses.push(`value ${operator} ?`);
      params.push(request.value);
    }
    const limit = Math.max(1, Math.min(request.limit ?? 100, MAX_ROWS));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT subject, property, value, unit, measured_on, source_file, source_name, locator, entry_id
       FROM facts ${where} ORDER BY subject, property, measured_on LIMIT ${limit}`,
    ).all(...params);

    return rows.map((row: any) => ({
      subject: row.subject, property: row.property, value: row.value, unit: row.unit,
      measuredOn: row.measured_on, sourceFile: row.source_file, sourceName: row.source_name,
      locator: row.locator, entryId: row.entry_id,
    }));
  }

  /** What the corpus can actually be asked about — so the model discovers rather than guesses. */
  schema(): { subjects: string[]; properties: { property: string; unit: string | null; count: number }[] } {
    if (!this.db) return { subjects: [], properties: [] };
    const subjects = this.db.prepare('SELECT DISTINCT subject FROM facts ORDER BY subject LIMIT 200')
      .all().map((row: any) => row.subject);
    const properties = this.db.prepare(
      `SELECT property, unit, COUNT(*) AS n FROM facts GROUP BY property, unit ORDER BY n DESC LIMIT 60`,
    ).all().map((row: any) => ({ property: row.property, unit: row.unit, count: Number(row.n) }));
    return { subjects, properties };
  }
}

let globalFactStore: FactStore | null = null;
export function setFactStore(store: FactStore | null): void { globalFactStore = store; }
export function getFactStore(): FactStore | null { return globalFactStore; }
