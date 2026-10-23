/**
 * Splitting a document into retrievable pieces.
 *
 * ## Why a whole document is the wrong unit
 *
 * An embedding is an average of what a text is about. Embed a 2,000-word note whole and you get a
 * vector that is *slightly* about each of the eight things it covers and strongly about none of
 * them — so a query about one of those eight matches it weakly, and loses to a short document that
 * is entirely about something adjacent. The information was there; the representation buried it.
 * This is the single largest quality lever in a retrieval system after having real vectors at all.
 *
 * BM25 has the mirror problem from the other direction: its length normalization already discounts
 * long documents, so a genuinely relevant long note is penalised for being thorough. Chunking fixes
 * both, because both retrievers then see units of comparable size.
 *
 * ## Where the boundaries go
 *
 * Fixed-size splitting is the obvious implementation and it is the one that destroys meaning: it
 * cuts sentences in half, and — in this corpus specifically — it cuts *code blocks* in half, which
 * is worse. A fragment ending mid-identifier is not merely less useful, it embeds as something the
 * document does not say. So boundaries are chosen structurally, cheapest first:
 *
 *   1. Fenced code blocks are extracted whole and never split. A 300-line block becomes one
 *      oversized chunk, deliberately — an unsplittable unit is better than eight meaningless ones.
 *   2. The remaining prose splits on blank lines (paragraphs), then on sentence ends, then — only
 *      if a single sentence still exceeds the budget — on words.
 *
 * ## Why chunks overlap
 *
 * A fact that straddles a boundary is otherwise unfindable: half of it is in each of two chunks and
 * neither half matches. Overlap is the cheap insurance — the last sentence or so of each chunk is
 * repeated at the head of the next, so anything spanning a seam is intact in at least one of them.
 * It costs storage proportional to the overlap and nothing else.
 */

export interface Chunk {
  /** `${documentId}#${ordinal}` — stable, so re-chunking an unchanged document is a no-op. */
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
}

export interface ChunkOptions {
  /**
   * Target size in characters, not tokens.
   *
   * Tokenizing to plan a split would mean running a tokenizer over every document on every write,
   * and the budget only needs to be approximately right — the embedding model truncates at its own
   * limit regardless. ~4 characters per token is the usual English ratio, so 1,200 characters is
   * roughly 300 tokens: comfortably inside the range these retrieval models were trained on, and
   * small enough that a chunk is about one thing.
   */
  maxChars?: number;
  /** Characters of the previous chunk repeated at the head of the next. */
  overlapChars?: number;
  /**
   * Chunks shorter than this are folded into their neighbour instead of standing alone. A 20-character
   * fragment ("Fixed:") retrieves badly and pollutes the ranking — it has almost no content to match
   * against, so its similarity to anything is noise.
   */
  minChars?: number;
}

const DEFAULT_MAX = 1_200;
const DEFAULT_OVERLAP = 160;
const DEFAULT_MIN = 80;

interface Piece { text: string; isCode: boolean }

/** ```lang … ``` — captured whole, including the fences, so the block is never cut. */
const FENCE = /```[\s\S]*?(?:```|$)/g;

export function chunkDocument(
  documentId: string,
  text: string,
  options: ChunkOptions = {},
): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX;
  const overlapChars = Math.min(options.overlapChars ?? DEFAULT_OVERLAP, Math.floor(maxChars / 2));
  const minChars = options.minChars ?? DEFAULT_MIN;

  const trimmed = text.trim();
  if (!trimmed) return [];
  // Short documents are one chunk. Splitting a 400-character note into two 200-character halves
  // makes both worse and gains nothing.
  if (trimmed.length <= maxChars) {
    return [{ id: `${documentId}#0`, documentId, ordinal: 0, text: trimmed }];
  }

  const pieces: Piece[] = [];
  for (const segment of splitPreservingCode(trimmed)) {
    if (segment.isCode) {
      // Never split. An oversized code chunk is a deliberate choice — see the header.
      pieces.push({ text: segment.text, isCode: true });
    } else {
      for (const text of splitProse(segment.text, maxChars)) pieces.push({ text, isCode: false });
    }
  }

  return assemble(pieces, documentId, maxChars, overlapChars, minChars);
}

/** Split the text into alternating prose and fenced-code segments, in order. */
function splitPreservingCode(text: string): { text: string; isCode: boolean }[] {
  const out: { text: string; isCode: boolean }[] = [];
  let cursor = 0;
  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(text); match; match = FENCE.exec(text)) {
    if (match.index > cursor) out.push({ text: text.slice(cursor, match.index), isCode: false });
    out.push({ text: match[0], isCode: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), isCode: false });
  return out.filter((s) => s.text.trim().length > 0);
}

/** Paragraphs, then sentences, then words — descending order of how much meaning a cut costs. */
function splitProse(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (p.length <= maxChars) { out.push(p); continue; }

    // Sentence ends: `. ` / `? ` / `! ` / a newline. Kept with the sentence they end.
    for (const sentence of p.split(/(?<=[.!?])\s+|\n+/)) {
      const s = sentence.trim();
      if (!s) continue;
      if (s.length <= maxChars) { out.push(s); continue; }

      // A single sentence over budget — a wall of prose with no punctuation, or a long URL. Words
      // are the last boundary that does not cut inside a token.
      let buffer = '';
      for (const word of s.split(/\s+/)) {
        if (buffer && buffer.length + word.length + 1 > maxChars) { out.push(buffer); buffer = ''; }
        buffer = buffer ? `${buffer} ${word}` : word;
      }
      if (buffer) out.push(buffer);
    }
  }
  return out;
}

/**
 * Pack pieces up to the budget, overlapping each chunk with the tail of the previous one.
 *
 * Overlap is taken at a **word** boundary rather than a character offset: slicing the last 160
 * characters mid-word puts a fragment like `rimination` at the head of a chunk, which is a token
 * the document never contained and which BM25 will happily index.
 */
function assemble(
  pieces: Piece[],
  documentId: string,
  maxChars: number,
  overlapChars: number,
  minChars: number,
): Chunk[] {
  const texts: string[] = [];
  let buffer = '';
  let bufferHasCode = false;

  for (const piece of pieces) {
    if (!buffer) { buffer = piece.text; bufferHasCode = piece.isCode; continue; }
    if (!bufferHasCode && !piece.isCode && buffer.length + piece.text.length + 2 <= maxChars) {
      buffer = `${buffer}\n\n${piece.text}`;
      continue;
    }
    texts.push(buffer);
    // No overlap across a code boundary. Carrying the tail of a fenced block into the next chunk
    // duplicates the closing fence, which makes the block appear in two chunks — so a search for
    // its contents returns the same document twice and the "never split" guarantee reads as broken.
    // A code block is also self-contained by nature: there is no straddling sentence to protect.
    const carry = overlapChars > 0 && !bufferHasCode && !piece.isCode
      ? tailWords(buffer, overlapChars)
      : '';
    buffer = joinOverlap(carry, piece.text);
    bufferHasCode = piece.isCode;
  }
  if (buffer) texts.push(buffer);

  // Fold a runt tail into its predecessor. A trailing 30-character chunk is noise in the index.
  if (texts.length > 1 && texts[texts.length - 1].length < minChars) {
    const runt = texts.pop()!;
    texts[texts.length - 1] = `${texts[texts.length - 1]}\n\n${runt}`;
  }

  return texts.map((text, ordinal) => ({
    id: `${documentId}#${ordinal}`,
    documentId,
    ordinal,
    text: text.trim(),
  }));
}

function tailWords(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const slice = text.slice(-budget);
  const space = slice.search(/\s/);
  return space === -1 ? '' : slice.slice(space + 1);
}

function joinOverlap(overlap: string, piece: string): string {
  return overlap ? `${overlap}\n\n${piece}` : piece;
}
