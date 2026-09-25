import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';

/**
 * God's Land stage 2 (docs/product-reset/gods-land/03_PLAN.md): the shelf in the notch. Things dragged onto the notch
 * stay there, across Spaces and restarts, until dragged out.
 *
 * The rules, all here so they can be tested without the helper that draws them:
 * - Files are kept by REFERENCE. A file whose source is gone says so ("missing") instead of pretending.
 * - Except files in a temporary folder (a fresh screenshot's thumbnail, a browser's drag file): those vanish on their
 *   own, so the shelf keeps its own copy.
 * - Nothing is ever deleted (owner rule). A card untouched for a day turns amber and moves to the end; sweeping sends
 *   ambers to the archive, and anything archived can be put back. Past the active limit the oldest go to the archive.
 * - The same file, link or text dropped again is the same card, brought to the front.
 */

export type ShelfKind = 'file' | 'url' | 'text';
export interface ShelfItem {
  id: string;
  kind: ShelfKind;
  title: string;
  path?: string;
  url?: string;
  text?: string;
  /** The shelf made its own copy (the source was temporary); `path` points at the copy and `source` at the original. */
  copied?: boolean;
  source?: string;
  addedAt: number;
  touchedAt: number;
  archivedAt?: number;
}
export interface ShelfInput { kind: ShelfKind; path?: string; url?: string; text?: string }
/** What the helper draws. */
export interface ShelfCard { id: string; kind: ShelfKind; title: string; path?: string; url?: string; text?: string; missing: boolean; amber: boolean }
export interface ShelfView { t: 'shelf'; items: ShelfCard[]; archived: ShelfCard[] }

export const AMBER_AFTER_MS = 24 * 60 * 60 * 1000;
export const MAX_ACTIVE = 24;
export const MAX_ARCHIVED_SHOWN = 30;
/** A dropped text longer than this is cut; a shelf is for snippets, not documents (drop the file instead). */
export const MAX_TEXT = 100_000;

const TEMPORARY_ROOTS = (): string[] => [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map((p) => path.resolve(p));

/** Whether a path lives somewhere the system empties by itself. */
export function isTemporaryPath(file: string, roots: readonly string[] = TEMPORARY_ROOTS()): boolean {
  const resolved = path.resolve(file);
  return roots.some((root) => resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

function titleFor(input: ShelfInput): string {
  if (input.kind === 'file') return path.basename(input.path ?? '') || 'File';
  if (input.kind === 'url') {
    try { const u = new URL(input.url ?? ''); return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 80); } catch { return (input.url ?? 'Link').slice(0, 80); }
  }
  const firstLine = (input.text ?? '').trim().split('\n')[0] ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine || 'Text';
}

function sameThing(a: ShelfItem, b: ShelfInput): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'file') return (a.source ?? a.path) === b.path;
  if (a.kind === 'url') return a.url === b.url;
  return a.text === b.text;
}

function valid(input: ShelfInput): boolean {
  if (input.kind === 'file') return typeof input.path === 'string' && path.isAbsolute(input.path);
  if (input.kind === 'url') { try { const u = new URL(input.url ?? ''); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
  return input.kind === 'text' && typeof input.text === 'string' && input.text.trim().length > 0;
}

export class Shelf {
  private items: ShelfItem[] = [];

  /**
   * @param file where the shelf is saved (JSON, written atomically)
   * @param copies where copies of temporary files go
   */
  constructor(
    private readonly file: string,
    private readonly copies: string,
    private readonly now: () => number = Date.now,
    private readonly exists: (file: string) => boolean = existsSync,
    private readonly temporaryRoots: readonly string[] = TEMPORARY_ROOTS(),
  ) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { items?: ShelfItem[] };
      this.items = Array.isArray(parsed.items) ? parsed.items.filter((i) => i && typeof i.id === 'string' && typeof i.kind === 'string') : [];
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, items: this.items }, null, 1));
    renameSync(temp, this.file);
  }

  private active(): ShelfItem[] {
    return this.items.filter((i) => i.archivedAt === undefined);
  }

  /** Keep what was dropped. Returns the ids now at the front, in drop order. */
  add(inputs: readonly ShelfInput[]): string[] {
    const ids: string[] = [];
    const at = this.now();
    for (const raw of inputs) {
      if (!valid(raw)) continue;
      const input: ShelfInput = raw.kind === 'text' ? { kind: 'text', text: (raw.text ?? '').slice(0, MAX_TEXT) } : raw;
      const existing = this.items.find((i) => sameThing(i, input));
      if (existing) {
        existing.touchedAt = at;
        delete existing.archivedAt;
        ids.push(existing.id);
        continue;
      }
      const id = randomUUID();
      const item: ShelfItem = { id, kind: input.kind, title: titleFor(input), addedAt: at, touchedAt: at };
      if (input.kind === 'file') {
        item.path = input.path;
        if (isTemporaryPath(input.path!, this.temporaryRoots) && this.exists(input.path!)) {
          try {
            mkdirSync(this.copies, { recursive: true });
            const copy = path.join(this.copies, `${id.slice(0, 8)}-${path.basename(input.path!)}`);
            copyFileSync(input.path!, copy);
            item.path = copy;
            item.copied = true;
            item.source = input.path;
          } catch { /* keep the reference; it may still be there when it is dragged out */ }
        }
      }
      if (input.kind === 'url') item.url = input.url;
      if (input.kind === 'text') item.text = input.text;
      this.items.push(item);
      ids.push(id);
    }
    // Past the limit, the least recently touched go to the archive — never away.
    const active = this.active().sort((a, b) => b.touchedAt - a.touchedAt);
    for (const extra of active.slice(MAX_ACTIVE)) extra.archivedAt = at;
    if (ids.length) this.save();
    return ids;
  }

  /** Dragged out, previewed or copied: it is in use, so it is fresh again. */
  touch(id: string): boolean {
    const item = this.items.find((i) => i.id === id && i.archivedAt === undefined);
    if (!item) return false;
    item.touchedAt = this.now();
    this.save();
    return true;
  }

  /** To the archive drawer. `amber: true` sweeps every amber card. */
  archive(target: { ids?: readonly string[]; amber?: boolean }): number {
    const at = this.now();
    let moved = 0;
    for (const item of this.active()) {
      if (target.ids?.includes(item.id) || (target.amber && this.isAmber(item, at))) {
        item.archivedAt = at;
        moved++;
      }
    }
    if (moved) this.save();
    return moved;
  }

  /** Back from the archive, at the front. */
  restore(id: string): boolean {
    const item = this.items.find((i) => i.id === id && i.archivedAt !== undefined);
    if (!item) return false;
    delete item.archivedAt;
    item.touchedAt = this.now();
    const active = this.active().sort((a, b) => b.touchedAt - a.touchedAt);
    for (const extra of active.slice(MAX_ACTIVE)) extra.archivedAt = this.now();
    this.save();
    return true;
  }

  private isAmber(item: ShelfItem, at: number): boolean {
    return at - item.touchedAt > AMBER_AFTER_MS;
  }

  private card(item: ShelfItem, at: number): ShelfCard {
    return {
      id: item.id, kind: item.kind, title: item.title,
      ...(item.path ? { path: item.path } : {}), ...(item.url ? { url: item.url } : {}), ...(item.text ? { text: item.text } : {}),
      missing: item.kind === 'file' && !this.exists(item.path ?? ''),
      amber: this.isAmber(item, at),
    };
  }

  /** Fresh cards first (most recently touched), amber ones at the end; the archive newest first. */
  view(): ShelfView {
    const at = this.now();
    const active = this.active().sort((a, b) => Number(this.isAmber(a, at)) - Number(this.isAmber(b, at)) || b.touchedAt - a.touchedAt);
    const archived = this.items.filter((i) => i.archivedAt !== undefined).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)).slice(0, MAX_ARCHIVED_SHOWN);
    return { t: 'shelf', items: active.map((i) => this.card(i, at)), archived: archived.map((i) => this.card(i, at)) };
  }
}
