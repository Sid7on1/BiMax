import * as path from 'path';
import { createHash } from 'crypto';
import { readEvidenceFile } from '../core/workflow.evidence';

/**
 * Context evidence: the text that reaches the model's prompt, with where it came from, which version of that source it
 * was taken from, and what it was built from (record 47 §3.1, record 50 step 5).
 *
 * This is not `src/evidence`, the causal security ledger of operations, decisions and approvals, and not
 * `OutcomeEvidence`, the receipts that satisfy acceptance criteria. Those record what the agent DID. This records what
 * the model was SHOWN, so that a stale piece of it can be found.
 *
 * Two rules hold everywhere:
 * - **A version is never invented.** It is a hash of the source as read — a file's raw bytes, a memory's stored text —
 *   or UNKNOWN_VERSION. An unknown version can never be shown current, so its span goes stale as soon as its source is
 *   checked.
 * - **Invalidation follows dependencies.** When a source changes, the spans taken from its old version go stale, and so
 *   does everything built from them. A span built from one that is stale, evicted or was never recorded cannot be
 *   checked, so it is stale too. Nothing else goes stale.
 */

export const UNKNOWN_VERSION = 'unknown';

/** The largest file whose version is read from its bytes: record 42's whole-read budget. */
const MAX_VERSION_READ_BYTES = 16 * 1024 * 1024;

/** A text's version: sha256 over its UTF-8 form, the same basis the read cache and the code index record. */
export function versionOfText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * A file's version: sha256 over its raw bytes. Decoding first made two different invalid UTF-8 files share a version,
 * because both decode to the same replacement character (audit 51, U04). For valid UTF-8 it equals
 * {@link versionOfText} of the decoded text, so versions taken either way still compare.
 */
export function versionOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A file's current version, from its actual bytes through record 42's bounded reader; null when gone or unreadable. */
export async function fileVersion(file: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return versionOfBytes(await readEvidenceFile(file, signal, MAX_VERSION_READ_BYTES));
  } catch {
    return null;
  }
}

export type SourceLocator =
  | { kind: 'file'; path: string; startLine?: number; endLine?: number; partial?: boolean }
  | { kind: 'memory'; documentId: string; part?: number; parts?: number; partial?: boolean }
  | { kind: 'tool-output'; handle: string }
  | { kind: 'derived'; label: string };

export interface EvidenceDependency {
  /** A source id, or `span:<id>` for another span. */
  sourceId: string;
  sourceVersion: string;
}

export type EvidenceKind = 'source' | 'observation' | 'derived' | 'hypothesis';

export interface EvidenceSpan {
  id: string;
  /** `file:<absolute path>`, `memory:<document id>`, `tool-output:<archive id>` or `derived:<label>`. */
  sourceId: string;
  /** The version of the source the text was taken from, or UNKNOWN_VERSION. */
  sourceVersion: string;
  locator: SourceLocator;
  /** Where the whole original can be read back when it lives outside the prompt. */
  rawHandle?: string;
  /** The text taken from the source; for archived tool output, its opening, with the whole at `rawHandle`. */
  text: string;
  scope: { root?: string; tags?: string[] };
  observedAt: string;
  /** When the fact became true, if the source says so. Unset when it does not; never guessed. */
  validFrom?: string;
  validUntil?: string;
  supersedes?: string[];
  derivedFrom: EvidenceDependency[];
  kind: EvidenceKind;
}

export type EvidenceDraft = Omit<EvidenceSpan, 'id' | 'observedAt'> & { observedAt?: string };

/**
 * Seal a span. Its id is the content address of everything that defines it — source, version, locator, text, scope,
 * kind, validity and what it was built from — never of when it was seen. The id once left out dependencies and scope,
 * so the same words built from two different inputs shared an id, and the store kept only the first one's inputs
 * (audit 51, U03).
 */
export function evidenceSpan(draft: EvidenceDraft): EvidenceSpan {
  const identity = [
    draft.sourceId, draft.sourceVersion, draft.locator, draft.text, draft.scope, draft.kind, draft.derivedFrom,
    draft.rawHandle ?? null, draft.validFrom ?? null, draft.validUntil ?? null, draft.supersedes ?? null,
  ];
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
  return { ...draft, id: `ev_${id}`, observedAt: draft.observedAt ?? new Date().toISOString() };
}

/** Text taken from a file at `version`: a hash checked against the file's bytes, or UNKNOWN_VERSION. */
export function fileEvidence(
  file: string,
  text: string,
  version: string,
  options: { root?: string; startLine?: number; endLine?: number; partial?: boolean } = {},
): EvidenceSpan {
  const absolute = path.resolve(file);
  return evidenceSpan({
    sourceId: `file:${absolute}`,
    sourceVersion: version,
    locator: {
      kind: 'file',
      path: absolute,
      ...(options.startLine !== undefined ? { startLine: options.startLine } : {}),
      ...(options.endLine !== undefined ? { endLine: options.endLine } : {}),
      ...(options.partial ? { partial: true } : {}),
    },
    text,
    scope: options.root ? { root: options.root } : {},
    derivedFrom: [],
    kind: 'source',
  });
}

/** A span built from other spans (a recall block, a summary, a pack). It goes stale when any of them does. */
export function derivedEvidence(label: string, text: string, from: readonly EvidenceSpan[]): EvidenceSpan {
  return evidenceSpan({
    sourceId: `derived:${label}`,
    sourceVersion: versionOfText(text),
    locator: { kind: 'derived', label },
    text,
    scope: {},
    derivedFrom: from.map((span) => ({ sourceId: `span:${span.id}`, sourceVersion: span.id })),
    kind: 'derived',
  });
}

/**
 * The evidence one session has admitted, and which of it is stale.
 *
 * Bounded: past `maxSpans` the oldest spans are evicted, and the eviction is counted, so a consumer can tell a trimmed
 * record from a complete one. What was built from an evicted span can no longer be checked through it, so it goes
 * stale rather than staying current by default.
 */
export class ContextEvidence {
  private readonly spans = new Map<string, EvidenceSpan>();
  private readonly stale = new Map<string, string>();
  /** Span id → ids of the spans built from it, so invalidation walks dependants instead of rescanning the store. */
  private readonly dependants = new Map<string, Set<string>>();
  private evicted = 0;

  constructor(private readonly maxSpans = 2000) {}

  /**
   * Record a span. Admitting the same span again is a no-op: the id covers everything that defines it. A span built from
   * a span that is already stale, or that is not in the record, is stale from the moment it is admitted — nothing
   * could ever mark it later.
   */
  admit(span: EvidenceSpan): EvidenceSpan {
    const existing = this.spans.get(span.id);
    if (existing) return existing;
    this.spans.set(span.id, span);
    const marked: string[] = [];
    for (const dep of span.derivedFrom) {
      if (!dep.sourceId.startsWith('span:')) continue;
      const parent = dep.sourceId.slice('span:'.length);
      let children = this.dependants.get(parent);
      if (!children) this.dependants.set(parent, children = new Set());
      children.add(span.id);
      if (this.stale.has(parent)) this.markStale(span.id, `built from stale span:${parent}`, marked);
      else if (!this.spans.has(parent)) this.markStale(span.id, `built from span:${parent}, which is not in the record`, marked);
    }
    while (this.spans.size > this.maxSpans) this.evict(this.spans.keys().next().value as string);
    return span;
  }

  admitAll(spans: readonly EvidenceSpan[]): void {
    for (const span of spans) this.admit(span);
  }

  get(id: string): EvidenceSpan | undefined {
    return this.spans.get(id);
  }

  all(): EvidenceSpan[] {
    return [...this.spans.values()];
  }

  isStale(id: string): boolean {
    return this.stale.has(id);
  }

  staleReason(id: string): string | undefined {
    return this.stale.get(id);
  }

  get evictedCount(): number {
    return this.evicted;
  }

  /**
   * `sourceId` now has `currentVersion` (null when it is gone or unreadable). Every span taken from any other version of
   * it goes stale, then everything built from a stale span, transitively. Returns the ids newly marked.
   */
  sourceChanged(sourceId: string, currentVersion: string | null): string[] {
    const marked: string[] = [];
    const outdated = (version: string): boolean =>
      currentVersion === null || version === UNKNOWN_VERSION || version !== currentVersion;
    const reason = currentVersion === null ? `${sourceId} is gone or unreadable` : `${sourceId} changed`;

    for (const span of this.spans.values()) {
      const direct = span.sourceId === sourceId && outdated(span.sourceVersion);
      const dependency = span.derivedFrom.some((dep) => dep.sourceId === sourceId && outdated(dep.sourceVersion));
      if (direct || dependency) this.markStale(span.id, reason, marked);
    }
    return marked;
  }

  /** Re-read every file behind a live span from its bytes and apply `sourceChanged` to each. Returns the ids marked. */
  async refreshFileSources(signal?: AbortSignal): Promise<string[]> {
    const files = new Set<string>();
    for (const span of this.spans.values()) {
      if (this.stale.has(span.id)) continue;
      if (span.sourceId.startsWith('file:')) files.add(span.sourceId);
      for (const dep of span.derivedFrom) if (dep.sourceId.startsWith('file:')) files.add(dep.sourceId);
    }
    const marked: string[] = [];
    for (const sourceId of files) {
      marked.push(...this.sourceChanged(sourceId, await fileVersion(sourceId.slice('file:'.length), signal)));
    }
    return marked;
  }

  /** Mark `id` stale for `reason`, then everything built from it, breadth first. Appends each newly marked id. */
  private markStale(id: string, reason: string, marked: string[]): void {
    if (this.stale.has(id) || !this.spans.has(id)) return;
    this.stale.set(id, reason);
    marked.push(id);
    const queue = [id];
    while (queue.length) {
      const parent = queue.shift()!;
      for (const child of this.dependants.get(parent) ?? []) {
        if (this.stale.has(child) || !this.spans.has(child)) continue;
        this.stale.set(child, `built from stale span:${parent}`);
        marked.push(child);
        queue.push(child);
      }
    }
  }

  /** Remove a span. What was built from it can no longer be checked through it, so it goes stale (audit 51, U03). */
  private evict(id: string): void {
    const span = this.spans.get(id);
    if (!span) return;
    const marked: string[] = [];
    for (const child of this.dependants.get(id) ?? []) {
      this.markStale(child, `built from span:${id}, which was evicted from the record`, marked);
    }
    this.spans.delete(id);
    this.stale.delete(id);
    this.dependants.delete(id);
    for (const dep of span.derivedFrom) {
      if (!dep.sourceId.startsWith('span:')) continue;
      const siblings = this.dependants.get(dep.sourceId.slice('span:'.length));
      siblings?.delete(id);
      if (siblings?.size === 0) this.dependants.delete(dep.sourceId.slice('span:'.length));
    }
    this.evicted++;
  }
}
