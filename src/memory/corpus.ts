import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { VectorDocument } from './vector.store';
import { SqliteCodeVectorStore } from './sqlite.code.store';
import type { EmbeddingBackend } from './embeddings';
import type { RemoteReranker } from './rerank';
import { chunkDocument } from './chunking';
import { extractFile, describeLocator, ExtractionResult, Segment } from '../documents/extract';
import { FactStore, factsFromSegment } from './facts';

/**
 * The Composer corpus — ingested documents, retrievable with citations.
 *
 * This is the layer between "a user dropped 40 files" and "the model answered with a page number".
 * The retrieval machinery underneath (BM25 + dense + RRF fusion + rerank) already existed and is
 * reused wholesale; what did not exist was a way to put a *document* into it and get a *citation*
 * back out. That gap is the whole reason an inspection engineer could not use this: an assessment
 * that cannot name its source is not evidence, it is a rumour with good grammar.
 *
 * ## Two corpora, deliberately
 *
 * - **session** — what was dropped for the task at hand. Evicted when the task ends. A vendor quote
 *   read once must not outrank the SOP library for the next six months.
 * - **library** — the standing knowledge base: SOPs, equipment history, manuals, past inspections.
 *   Explicitly promoted, never accumulated by accident.
 *
 * Both live in the same `VectorStore` and are separated by tag, so a single query ranks across both
 * and the caller can still say "SOPs only". Retrieval must reach both: the E-204 question is
 * *"compare this new report against the SOP and the equipment's history"*, which is one query
 * spanning a freshly dropped file and a two-year-old one.
 *
 * ## Why the citation lives inside the chunk text
 *
 * Each stored chunk is prefixed with a provenance header:
 *
 *     [E-204 Inspection Report.pdf · page 3]
 *     Shell thickness nominal 12 mm. Minimum measured 7.8 mm...
 *
 * Structured metadata alone does not work, because the model only ever sees the text. Putting the
 * source *in* the text is what makes "according to E-204 Inspection Report.pdf page 3" appear in the
 * answer without a prompt instruction begging for it. The structured record is kept alongside for
 * the UI and for `sources()`, but the header is what produces cited output.
 *
 * ## Sovereignty
 *
 * Ingestion is local: extraction is in-process, embeddings go to whatever provider is configured
 * (under `--sovereign` that is a local Ollama/vLLM). Nothing here opens a socket of its own.
 */

export type CorpusScope = 'session' | 'library';

/** Tag namespace. `composer:` prefixes everything so a corpus query can never collide with project memory. */
const TAG_ROOT = 'composer';
export const SESSION_TAG = `${TAG_ROOT}:session`;
export const LIBRARY_TAG = `${TAG_ROOT}:library`;

export function scopeTag(scope: CorpusScope): string {
  return scope === 'library' ? LIBRARY_TAG : SESSION_TAG;
}

/**
 * Equipment / instrument tags — the primary key of a plant.
 *
 * `E-204`, `P-310A`, `PT-101`, `TIC-3021`. Dense embeddings cannot rank these: an out-of-vocabulary
 * identifier is an opaque character sequence to an embedding model, which is why retrieval systems
 * miss `SKU-B4920`-shaped queries entirely. BM25 partially covers it, but a tag in a query is not a
 * hint — it is the subject. So we index tags exactly and use them as a FILTER.
 *
 * Deliberately conservative: two-to-five digits after a short alphabetic prefix. It will also match
 * things like `ISO-9001`, which is why the filter is only applied when the identifier is actually
 * present in the corpus (see `search`) — a standard number typed in passing must not silence a query.
 */
const IDENTIFIER = /\b[A-Z]{1,4}-\d{2,5}[A-Z]?\b/g;
const IDENTIFIER_TAG = 'id';

export function extractIdentifiers(text: string): string[] {
  const found = String(text || '').toUpperCase().match(IDENTIFIER);
  return found ? [...new Set(found)] : [];
}

function identifierTag(identifier: string): string {
  return `${IDENTIFIER_TAG}:${identifier}`;
}

/** One ingested source file. */
export interface CorpusEntry {
  /** Stable id derived from the absolute path + content hash. Re-ingesting an unchanged file is a no-op. */
  id: string;
  file: string;
  name: string;
  kind: string;
  scope: CorpusScope;
  bytes: number;
  chunks: number;
  /** Segment-level provenance, indexed by the chunk ids stored in the vector store. */
  ingestedAt: number;
  /** Set when extraction produced nothing usable, or produced it with a caveat. */
  note?: string;
  /** True when any part of this document was read by OCR, so the text may contain recognition errors. */
  ocr: boolean;
}

export interface IngestReport {
  ingested: CorpusEntry[];
  skipped: { file: string; reason: string }[];
  /** Chunks written across all ingested files. */
  chunks: number;
  /** Files that were already present at the same content hash. */
  unchanged: number;
}

export interface CorpusHit {
  text: string;
  file: string;
  name: string;
  locator: string;
  scope: CorpusScope;
  ocr: boolean;
}

interface ChunkProvenance {
  entryId: string;
  file: string;
  name: string;
  locator: string;
  scope: CorpusScope;
  ocr: boolean;
}

/** Manifest persisted next to the store so a restart does not lose provenance. */
interface Manifest {
  version: 1;
  entries: Record<string, CorpusEntry>;
  chunks: Record<string, ChunkProvenance>;
  /** Identifiers known to exist in the corpus, so a filter is never applied for an absent one. */
  identifiers: Record<string, true>;
}

function emptyManifest(): Manifest {
  return { version: 1, entries: {}, chunks: {}, identifiers: {} };
}

async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (part) => hash.update(part));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex').slice(0, 16);
}

export interface CorpusOptions {
  /** Where the manifest lives. Defaults to `<cwd>/.breakglass/composer.json`. */
  manifestPath?: string;
  /** Characters per chunk. The default matches the retrieval models' comfortable range. */
  maxChars?: number;
  /**
   * Numeric facts extracted alongside the prose. Optional: without it the Composer still retrieves
   * passages, it just cannot answer a question that requires comparing numbers.
   */
  facts?: FactStore | null;
}

/**
 * The store operations the corpus needs. Narrow on purpose: it is satisfied by both the JSON
 * `VectorStore` and the SQLite one, so a test can run against either.
 */
export interface CorpusStore {
  storeDocuments(inputs: { id: string; text: string; tags: string[] }[]): Promise<unknown>;
  semanticSearch(
    query: string, limit?: number, minScore?: number, options?: { tags?: string[] },
  ): Promise<VectorDocument[]>;
  deleteWhere(predicate: (doc: { id: string }) => boolean): Promise<number>;
}

/**
 * Build the store the Composer requires — SQLite, not the JSON one.
 *
 * ## Why this is SQLite and not `VectorStore`
 *
 * The JSON store holds every document, chunk text and float vector RESIDENT IN RAM and rewrites the
 * whole file, pretty-printed, on every save. `sqlite.code.store.ts` was written because that design
 * "dies with the laptop somewhere around 10k chunks", and a document corpus is squarely in that
 * territory. MEASURED, per 1.2 KB chunk at 768 dimensions:
 *
 *     JSON, as written to disk   25.7 KB   (17.1 KB of it the pretty-printed float vector)
 *     int8 BLOB in SQLite         0.75 KB
 *
 * A 34x difference, and the JSON copy is also resident. One 200-report shutdown drop (~36k chunks)
 * is ~900 MB of JSON held in memory and rewritten on every ingest; the same corpus is ~27 MB of
 * SQLite that streams from disk. On an 8 GB machine the first one is not slow, it is impossible.
 *
 * The SQLite store additionally self-limits: `maxIndexBytes` means a runaway ingest stops growing
 * rather than filling the disk — which matters when the corpus is fed by dropping folders.
 *
 * `dedup` does not appear here because this store has no near-duplicate merge at all. That is the
 * right default for documents: page 4 of a repetitive inspection form is a near-duplicate of page 3,
 * and merging them files one page's text under the other's id, putting the WRONG PAGE NUMBER on a
 * citation. See `composer.retrieval.traps.test.ts`, which reproduces exactly that against the JSON
 * store's merge.
 */
export const COMPOSER_STORE_OPTIONS = {
  /** Room for a real document library; the store streams, so this costs disk and not memory. */
  maxVectors: 150_000,
  /** Hard disk ceiling. Past it the index stops accepting new content instead of growing forever. */
  maxIndexBytes: 2 * 1024 * 1024 * 1024,
} as const;

export function composerStorePath(root: string = process.cwd()): string {
  return path.join(stateDir('.breakglass', root), 'memory', 'composer.index.sqlite');
}

export function createComposerStore(
  embeddings: EmbeddingBackend | null,
  reranker: RemoteReranker | null,
  storePath: string = composerStorePath(),
): CorpusStore {
  return new SqliteCodeVectorStore(embeddings, reranker, { storePath, ...COMPOSER_STORE_OPTIONS });
}

export class ComposerCorpus {
  private manifest: Manifest = emptyManifest();
  private loaded = false;
  /**
   * The most recent ingest's outcome, kept in memory for the UI.
   *
   * Specifically so a front-end can show what did NOT go in. A user who drops 200 reports and is
   * shown only "191 ingested" will act as though all 200 were read; the nine that were unreadable
   * scans are the ones that change an assessment.
   */
  private lastIngest: { at: number; ingested: number; chunks: number; skipped: { name: string; reason: string }[] } | null = null;

  constructor(
    private readonly store: CorpusStore,
    private readonly options: CorpusOptions = {},
  ) {}

  private manifestPath(): string {
    return this.options.manifestPath
      ?? path.join(stateDir('.breakglass'), 'composer.json');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.promises.readFile(this.manifestPath(), 'utf8');
      const parsed = JSON.parse(raw) as Manifest;
      // A manifest from a future/older shape is discarded rather than half-adopted: a corpus that
      // half-remembers its provenance produces citations that point at the wrong page, which is
      // worse than no citation at all.
      if (parsed && parsed.version === 1 && parsed.entries && parsed.chunks) {
        this.manifest = { ...parsed, identifiers: parsed.identifiers ?? {} };
      }
    } catch {
      this.manifest = emptyManifest();
    }
  }

  private async persist(): Promise<void> {
    const file = this.manifestPath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(this.manifest), 'utf8');
    // Atomic replace: a half-written manifest read on next boot loses every citation.
    await fs.promises.rename(temporary, file);
  }

  /**
   * Ingest files into a corpus.
   *
   * Never throws for one bad file — the report lists what went in and what did not, and why. A
   * shutdown drop of 200 reports where 9 are corrupt must still deliver the 191.
   */
  async ingest(files: string[], scope: CorpusScope = 'session'): Promise<IngestReport> {
    await this.load();
    const report: IngestReport = { ingested: [], skipped: [], chunks: 0, unchanged: 0 };
    const documents: { id: string; text: string; tags: string[] }[] = [];

    for (const raw of files) {
      const file = path.resolve(raw);
      let digest: string;
      try {
        digest = await hashFile(file);
      } catch (error) {
        report.skipped.push({ file, reason: (error as Error).message });
        continue;
      }
      const id = `${TAG_ROOT}:${digest}`;
      const existing = this.manifest.entries[id];
      if (existing && existing.scope === scope) {
        // Same bytes, same corpus — already indexed. Re-embedding it would spend the whole ingest
        // budget re-learning what is already known.
        report.unchanged++;
        continue;
      }

      const extraction = await extractFile(file);
      if (!extraction.ok || extraction.segments.length === 0) {
        report.skipped.push({ file, reason: extraction.note || 'no readable text' });
        continue;
      }

      const entry = this.indexExtraction(id, file, scope, extraction, documents);
      report.ingested.push(entry);
      report.chunks += entry.chunks;
    }

    if (documents.length) await this.store.storeDocuments(documents);
    await this.persist();
    this.lastIngest = {
      at: Date.now(),
      ingested: report.ingested.length,
      chunks: report.chunks,
      skipped: report.skipped.map((skip) => ({ name: path.basename(skip.file), reason: skip.reason })),
    };
    // Best-effort: the corpus is usable without a front-end attached.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('../engine/events') as typeof import('../engine/events')).engineEvents.emit('composer_changed');
    } catch { /* no event bus in this context */ }
    return report;
  }

  /** Chunk one extraction and stage its documents. Returns the manifest entry. */
  private indexExtraction(
    id: string,
    file: string,
    scope: CorpusScope,
    extraction: ExtractionResult,
    staged: { id: string; text: string; tags: string[] }[],
  ): CorpusEntry {
    const name = path.basename(file);
    const tag = scopeTag(scope);
    let chunkCount = 0;
    let usedOcr = false;

    const facts = this.options.facts;
    extraction.segments.forEach((segment: Segment, index: number) => {
      if (segment.via === 'ocr') usedOcr = true;
      if (facts) {
        // Facts are pulled per segment, so a value keeps the sheet/page it was read from and stays
        // citable. A computed answer must be traceable to a row, not merely to a document.
        try {
          facts.add(factsFromSegment(segment, { file, name, entryId: id }));
        } catch { /* fact extraction must never fail an ingest */ }
      }
      const where = describeLocator(segment.locator);
      // Chunking happens per SEGMENT so a chunk never straddles two pages — the locator on the
      // header stays true for every character under it.
      const chunks = chunkDocument(`${id}:${index}`, segment.text, { maxChars: this.options.maxChars });
      for (const chunk of chunks) {
        const citation = where ? `${name} · ${where}` : name;
        const header = segment.via === 'ocr'
          // Marked, because a number read by a recognizer is not a number read from a text layer,
          // and an engineer deciding repair-or-replace is entitled to know which one they have.
          ? `[${citation} · OCR]`
          : `[${citation}]`;

        // Contextual Retrieval, deterministic tier. The context line rides on every chunk cut from
        // this segment — not just the first — and it goes in BEFORE embedding and before the BM25
        // index, which is what the measured 5.7% -> 2.9% failure reduction requires (contextual
        // embeddings alone only reach 3.7%; the lexical half is half the win).
        //
        // Skipped on the chunk that already opens with it, so the first chunk of a page is not
        // made to say its own title twice.
        const needsContext = segment.context
          && !chunk.text.slice(0, segment.context.length + 8).includes(segment.context.slice(0, 40));
        const body = needsContext ? `${segment.context}\n${chunk.text}` : chunk.text;

        staged.push({
          id: chunk.id,
          text: `${header}\n${body}`,
          // The context line is included when looking for identifiers, so a measurement chunk
          // inherits the equipment named in its carried heading.
          tags: [tag, TAG_ROOT, ...extractIdentifiers(`${header}\n${body}`).map(identifierTag)],
        });
        for (const identifier of extractIdentifiers(`${header}\n${body}`)) {
          this.manifest.identifiers[identifier] = true;
        }
        this.manifest.chunks[chunk.id] = {
          entryId: id, file, name, locator: where, scope, ocr: segment.via === 'ocr',
        };
        chunkCount++;
      }
    });

    const entry: CorpusEntry = {
      id, file, name, kind: extraction.kind, scope,
      bytes: extraction.bytes, chunks: chunkCount,
      ingestedAt: Date.now(), note: extraction.note, ocr: usedOcr,
    };
    this.manifest.entries[id] = entry;
    return entry;
  }

  /**
   * Retrieve chunks relevant to a query, with their provenance.
   *
   * `scopes` defaults to both corpora, which is the shape of a real question: the E-204 assessment
   * needs the report the engineer just dropped AND the SOP that was promoted months ago.
   */
  async search(
    query: string,
    limit = 8,
    scopes: CorpusScope[] = ['session', 'library'],
    /**
     * Zero on purpose. `VectorStore` applies this floor with `lexicalRelevance`, which is the
     * ratio of query terms found to the length of the CHUNK — so a good hit in a document is
     * scored low simply because documents are long. Measured on a real inspection paragraph:
     * the query "nozzle N2 corrosion", which the passage answers exactly, scores 0.136, and
     * "thickness" scores 0.091. The memory store's 0.25 default would reject both.
     *
     * Ranking is already the job of BM25 + dense fusion + rerank. A length-biased overlap floor
     * on top of that does not filter noise, it deletes the long passages — which in a refinery
     * corpus are the procedures and the assessments, the two things most worth retrieving.
     */
    minScore = 0,
  ): Promise<CorpusHit[]> {
    await this.load();
    const scopeTags = scopes.map(scopeTag);

    // Identifier lane. When the query names a tag the corpus actually holds, that tag is not one
    // signal among many — it is the subject, and a passage about a different vessel is wrong however
    // well it scores. Embeddings cannot express this: an out-of-vocabulary identifier is an opaque
    // sequence to them, so `E-204` and `P-310A` are near-neighbours in vector space.
    //
    // Only identifiers PRESENT in the corpus filter. A query mentioning `ISO-9001` in passing, or a
    // tag from a document nobody ingested, must not silently return nothing — an empty result would
    // read as "your documents do not discuss this", which is a different and false claim.
    const named = extractIdentifiers(query).filter((identifier) => this.manifest.identifiers[identifier]);

    let documents: VectorDocument[];
    if (named.length) {
      // The store's tag filter is a disjunction, so scope cannot be ANDed in the query. Retrieve
      // deeper against the identifier and narrow to the requested corpora here.
      const idTags = named.map(identifierTag);
      const deep = await this.store.semanticSearch(query, limit * 4, minScore, { tags: idTags });
      const scoped = deep.filter((document) => {
        const provenance = this.manifest.chunks[document.id];
        return !provenance || scopes.includes(provenance.scope);
      });
      documents = scoped.slice(0, limit);
      // If the identifier exists but not within the requested scopes, fall back rather than return
      // nothing: the user asked a question, not for a scope audit.
      if (!documents.length) {
        documents = await this.store.semanticSearch(query, limit, minScore, { tags: scopeTags });
      }
    } else {
      documents = await this.store.semanticSearch(query, limit, minScore, { tags: scopeTags });
    }

    return documents.map((document) => {
      const provenance = this.manifest.chunks[document.id];
      const text = document.metadata.content;
      if (!provenance) {
        // A chunk with no manifest record still carries its header in the text, so it is returned
        // rather than dropped — degraded, but honest about what it is.
        return { text, file: '', name: 'unknown source', locator: '', scope: 'session' as CorpusScope, ocr: false };
      }
      return {
        text,
        file: provenance.file,
        name: provenance.name,
        locator: provenance.locator,
        scope: provenance.scope,
        ocr: provenance.ocr,
      };
    });
  }

  /** Everything currently ingested, newest first. */
  async list(scope?: CorpusScope): Promise<CorpusEntry[]> {
    await this.load();
    return Object.values(this.manifest.entries)
      .filter((entry) => !scope || entry.scope === scope)
      .sort((a, b) => b.ingestedAt - a.ingestedAt);
  }

  /** Move an already-ingested file from the session corpus into the standing library. */
  async promote(match: string): Promise<CorpusEntry | null> {
    await this.load();
    const entry = Object.values(this.manifest.entries).find(
      (candidate) => candidate.scope === 'session'
        && (candidate.file === match || candidate.name === match || candidate.id === match),
    );
    if (!entry) return null;
    // Retag rather than re-extract: the bytes have not changed, and re-running OCR over a 60-page
    // scan to change one label would be minutes of work for no new information.
    await this.store.deleteWhere((document) => this.manifest.chunks[document.id]?.entryId === entry.id);
    this.options.facts?.removeEntry(entry.id);
    const staged: { id: string; text: string; tags: string[] }[] = [];
    const extraction = await extractFile(entry.file);
    if (!extraction.ok) return null;
    delete this.manifest.entries[entry.id];
    const promoted = this.indexExtraction(entry.id, entry.file, 'library', extraction, staged);
    await this.store.storeDocuments(staged);
    await this.persist();
    return promoted;
  }

  /** Drop a corpus. Session eviction at task end runs through here. */
  async clear(scope: CorpusScope): Promise<number> {
    await this.load();
    const removed = await this.store.deleteWhere((document) => {
      const provenance = this.manifest.chunks[document.id];
      return provenance?.scope === scope;
    });
    for (const [id, entry] of Object.entries(this.manifest.entries)) {
      if (entry.scope === scope) this.options.facts?.removeEntry(id);
    }
    for (const [id, provenance] of Object.entries(this.manifest.chunks)) {
      if (provenance.scope === scope) delete this.manifest.chunks[id];
    }
    for (const [id, entry] of Object.entries(this.manifest.entries)) {
      if (entry.scope === scope) delete this.manifest.entries[id];
    }
    await this.persist();
    return removed;
  }

  async stats(): Promise<{ session: number; library: number; chunks: number }> {
    await this.load();
    const entries = Object.values(this.manifest.entries);
    return {
      session: entries.filter((entry) => entry.scope === 'session').length,
      library: entries.filter((entry) => entry.scope === 'library').length,
      chunks: Object.keys(this.manifest.chunks).length,
    };
  }

  /** Synchronous snapshot for the UI. Returns nulls before the manifest has been read. */
  snapshot(): {
    session: number; library: number; chunks: number;
    lastIngest: { ingested: number; chunks: number; skipped: { name: string; reason: string }[] } | null;
  } {
    const entries = Object.values(this.manifest.entries);
    return {
      session: entries.filter((entry) => entry.scope === 'session').length,
      library: entries.filter((entry) => entry.scope === 'library').length,
      chunks: Object.keys(this.manifest.chunks).length,
      lastIngest: this.lastIngest
        ? { ingested: this.lastIngest.ingested, chunks: this.lastIngest.chunks, skipped: this.lastIngest.skipped }
        : null,
    };
  }
}

let globalCorpus: ComposerCorpus | null = null;

export function setComposerCorpus(corpus: ComposerCorpus | null): void {
  globalCorpus = corpus;
}

export function getComposerCorpus(): ComposerCorpus | null {
  return globalCorpus;
}
