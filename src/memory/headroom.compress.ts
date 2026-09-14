// Headroom context compression.
//
// The REAL engine is the Headroom Kompress proxy (see headroomProxy.ts): the
// chopratejas/kompress-v2-base ModernBERT token classifier, run torch-free via int8 ONNX, reached
// over HEADROOM_PROXY_URL → POST /v1/compress (proxyCompress below). It compresses tool outputs
// ~30-40% while protecting error/signal lines.
//
// The native compressText/compressBacklog below is only a dependency-light SAFETY NET used while the
// proxy is still provisioning (first-run venv + 261MB model download): it strips ANSI and collapses
// repetitive log/build line-runs, always preserving error/warning lines. Pure + synchronous so it
// never blocks the request path.

import { Logger } from '../utils/logger';

export interface BacklogStats {
  tokensBefore: number;   // whole message array
  tokensAfter: number;
  saved: number;
  compressedMessages: number;
  compressedBefore: number; // only the outputs that were compressed (for a true ratio)
  compressedAfter: number;
}

export interface HeadroomModelRow { model: string; saved: number; before: number; after: number; count: number }
export interface HeadroomReport {
  totalSaved: number;
  totalBefore: number;   // sum of compressed-output sizes before
  totalAfter: number;
  compressions: number;
  ratio: number;         // after/before over compressed content (0.14 ⇒ 86% saved)
  engine: 'native' | 'proxy';
  byModel: HeadroomModelRow[];
}

// Process-wide session stats, attributed per model — this is the data behind the TUI /headroom report.
const _byModel = new Map<string, { saved: number; before: number; after: number; count: number }>();
let _lastEngine: 'native' | 'proxy' = 'native';

/** Record one compaction's savings against the model that was active. */
export function recordCompression(model: string, before: number, after: number, engine: 'native' | 'proxy' = 'native'): void {
  const saved = Math.max(0, before - after);
  if (saved <= 0) return;
  _lastEngine = engine;
  const key = model || 'unknown';
  const a = _byModel.get(key) || { saved: 0, before: 0, after: 0, count: 0 };
  a.saved += saved; a.before += before; a.after += after; a.count += 1;
  _byModel.set(key, a);
}

export function getHeadroomSavedTokens(): number {
  let s = 0; for (const a of _byModel.values()) s += a.saved; return s;
}

export function getHeadroomReport(): HeadroomReport {
  let saved = 0, before = 0, after = 0, count = 0;
  const byModel: HeadroomModelRow[] = [];
  for (const [model, a] of _byModel) {
    saved += a.saved; before += a.before; after += a.after; count += a.count;
    byModel.push({ model, saved: a.saved, before: a.before, after: a.after, count: a.count });
  }
  byModel.sort((x, y) => y.saved - x.saved);
  return { totalSaved: saved, totalBefore: before, totalAfter: after, compressions: count, ratio: before > 0 ? after / before : 1, engine: _lastEngine, byModel };
}

// eslint-disable-next-line no-control-regex
const ANSI = /?\[[0-9;]*[A-Za-z]/g;
export const ERROR_LINE = /\b(error|err|fail(ed|ure)?|exception|traceback|panic|fatal|warn(ing)?|denied|refused|timeout|cannot|unable)\b/i;

/** Normalize a line so log lines that differ only by numbers/timestamps/hashes collapse together. */
function signature(line: string): string {
  return line
    .replace(/\b[0-9a-f]{7,40}\b/gi, '#')   // hashes/ids
    .replace(/\d+/g, '#')                     // numbers/timestamps
    .replace(/\s+/g, ' ')
    .trim();
}

/** A hash-like id: 7 to 40 hex digits with at least one letter. A plain seven-digit count is a number, not an id. */
const HASH_ID = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi;

/**
 * The numbers in a line, in order, signed where a minus sign starts the number (not a date's `2026-09-14`), skipping
 * hash-like ids. Dropping every 7-to-40-digit integer as an id and every sign lost a 9,000,000 outlier outright and
 * reported `-900` among `-100`s as "ranged 100–900" (audit 51, U10).
 */
function numbersIn(line: string): number[] {
  return (line.replace(HASH_ID, '#').match(/(?<![\w.])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|\d+(?:\.\d+)?/gi) ?? []).map(Number);
}

/**
 * The spread of every number that varies across a run of similar lines, as `min–max`, in the order
 * the numbers appear. Collapsing a run to one representative line used to drop every other value,
 * including the one worth seeing (a 900 ms spike among 100 ms lines, record 47 A08), so the elision
 * marker carries the ranges. Empty when nothing varies or the lines' numbers do not line up.
 */
function numberRanges(run: string[]): string[] {
  const rows = run.map(numbersIn);
  if (!rows.length) return [];
  const width = rows[0].length;
  if (!width || rows.some((row) => row.length !== width)) return [];
  const ranges: string[] = [];
  for (let k = 0; k < width; k++) {
    let min = Infinity;
    let max = -Infinity;
    for (const row of rows) {
      if (row[k] < min) min = row[k];
      if (row[k] > max) max = row[k];
    }
    if (min !== max) ranges.push(`${min}–${max}`);
  }
  return ranges;
}

/**
 * The rows holding each varying number's minimum and maximum, so the collapsed run keeps the actual extreme lines,
 * not only their values. At most `limit`, first columns first. Empty when the lines' numbers do not line up.
 */
function extremeRows(run: string[], limit = 4): number[] {
  const rows = run.map(numbersIn);
  const width = rows[0]?.length ?? 0;
  if (!width || rows.some((row) => row.length !== width)) return [];
  const picked = new Set<number>();
  for (let k = 0; k < width && picked.size < limit; k++) {
    let min = 0;
    let max = 0;
    rows.forEach((row, r) => {
      if (row[k] < rows[min][k]) min = r;
      if (row[k] > rows[max][k]) max = r;
    });
    if (rows[min][k] === rows[max][k]) continue;
    picked.add(min);
    if (picked.size < limit) picked.add(max);
  }
  return [...picked];
}

/**
 * Compress a single tool/output blob: strip ANSI, collapse runs of near-identical lines (the
 * classic log/build spam), and squeeze blank-line runs. Error/warning lines are kept verbatim and
 * never fold into a "similar lines" group. Returns the original if it can't beat it.
 */
export function compressText(text: string): string {
  if (!text) return text;
  const stripped = text.replace(ANSI, '');
  const lines = stripped.split('\n');
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Squeeze 2+ blank lines to one.
    if (line.trim() === '') {
      out.push('');
      while (i < lines.length && lines[i].trim() === '') i++;
      continue;
    }

    // Error/warning lines are signal — never collapse them.
    if (ERROR_LINE.test(line)) { out.push(line); i++; continue; }

    // Collapse a run of >=4 lines sharing a signature (repetitive logs).
    const sig = signature(line);
    let j = i + 1;
    while (j < lines.length && !ERROR_LINE.test(lines[j]) && signature(lines[j]) === sig) j++;
    const run = j - i;
    if (run >= 4) {
      const block = lines.slice(i, j);
      // Keep one representative and the lines holding each varying number's extremes, in their original order.
      const kept = [...new Set([0, ...extremeRows(block)])].sort((a, b) => a - b);
      for (const k of kept) out.push(block[k]);
      const ranges = numberRanges(block);
      out.push(`… (×${run - kept.length} more similar lines elided${ranges.length ? `; numbers ranged ${ranges.join(', ')}` : ''}) …`);
      i = j;
    } else {
      out.push(line);
      i++;
    }
  }

  const result = out.join('\n');
  return result.length < stripped.length ? result : stripped;
}

const cheapTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Does this tool output look like SOURCE CODE (vs. logs / build spam)? The generic Kompress
 * token-classifier shreds code into syntactically-invalid fragments — dropped closing braces,
 * stripped `export function` keywords, orphaned expressions (verified empirically against the
 * v0.27.0 proxy on /v1/compress). For a *coding* agent that's the worst kind of lossy: the model
 * can't tell a brace is missing and may reproduce broken code. So we detect code and keep it
 * verbatim. AST-aware compression (headroom-ai[code]) only engages on the transparent /v1/messages
 * path, not the /v1/compress call we make — so on this path code must be protected by us.
 */
export function looksLikeCode(text: string): boolean {
  if (!text || text.length < 40) return false;
  if (/^FILE\s.+:/m.test(text)) return true;                         // bimax file-read header
  const lines = text.split('\n');
  if (lines.length < 3) return false;
  const codeLines = lines.filter(l =>
    /[;{}]\s*$/.test(l) ||                                           // statement/block punctuation
    /=>/.test(l) ||
    /\b(function|const|let|var|class|def|import|export|return|interface|struct|impl|fn|func|public|private)\b/.test(l),
  ).length;
  return codeLines / lines.length > 0.4;                             // dense code, not a log dump
}

/**
 * Optional hook to the REAL Headroom engine: if HEADROOM_PROXY_URL is set (a running
 * `headroom proxy`, e.g. http://localhost:8787), POST the messages to /v1/compress and use its
 * ML-compressed result. Returns null on any miss so the caller falls back to the native compressor.
 * This is how the full Kompress model plugs in without bloating the repo with a Python+model runtime.
 */
export async function proxyCompress(
  messages: { role: string; content: any; [k: string]: any }[],
  model: string,
  tokenBudget?: number,
): Promise<{ messages: any[]; saved: number } | null> {
  const base = process.env.HEADROOM_PROXY_URL;
  if (!base) return null;
  // model is required by /v1/compress; config tunes the Kompress router (protect the last couple of
  // turns + the user's messages, let it compress the rest). target_ratio nudges it more aggressive
  // than its conservative default. The proxy's own ONNX Kompress backend does the real work.
  const body: any = {
    messages,
    model: model || 'claude-sonnet-4-5-20250929',
    config: { protect_recent: 2, compress_user_messages: false, target_ratio: 0.5 },
  };
  if (tokenBudget) body.token_budget = tokenBudget;
  // ONE timeout must cover BOTH the fetch AND the body read: the proxy returns 200 headers quickly but
  // streams the compressed body only after the (slow) Kompress inference finishes. Clearing the timer
  // after fetch() and then awaiting res.json() left the body read UNBOUNDED — a slow first inference
  // (e.g. CoreML graph compilation) would hang the whole compaction forever. Keep the timer live until
  // json() resolves. 45s headroom; only invoked under token pressure, where the latency is worth it.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/v1/compress`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!res.ok) { Logger.warn(`[Headroom] proxy /v1/compress returned ${res.status}; falling back to native.`); return null; }
    const data: any = await res.json();
    if (!Array.isArray(data?.messages)) { Logger.warn('[Headroom] proxy response had no messages array; falling back to native.'); return null; }

    // CODE GUARD — never let the generic token-classifier mangle source. The proxy preserves message
    // order/count, so we zip by index: any tool message that was code-shaped is restored to its
    // original verbatim, while logs/build-spam tool outputs keep the proxy's real compression. This is
    // the difference between "15% saved on logs" and "15% saved but the model now sees broken code".
    const out: any[] = data.messages;
    let restored = 0;
    if (out.length === messages.length) {
      for (let i = 0; i < out.length; i++) {
        const orig = messages[i];
        if (orig?.role === 'tool' && typeof orig.content === 'string' && looksLikeCode(orig.content)) {
          const oc = out[i]?.content;
          if (typeof oc !== 'string' || oc !== orig.content) { out[i] = { ...out[i], content: orig.content }; restored++; }
        }
      }
    }
    // Recompute savings from the (restored) array — the proxy's tokens_saved over-counts now that we
    // put code back. char/4 keeps it cheap; the caller re-measures precisely anyway.
    let saved = Math.max(0, Number(data.tokens_saved) || 0);
    if (restored > 0) {
      let before = 0, after = 0;
      for (let i = 0; i < messages.length; i++) {
        if (typeof messages[i].content === 'string') before += cheapTokens(messages[i].content as string);
        if (typeof out[i]?.content === 'string') after += cheapTokens(out[i].content as string);
      }
      saved = Math.max(0, before - after);
      Logger.info(`[Headroom] code guard restored ${restored} code-shaped tool output(s) to verbatim (logs still compressed).`);
    }
    return { messages: out, saved };
  } catch (e) {
    Logger.warn(`[Headroom] proxy /v1/compress failed (${(e as Error).name === 'AbortError' ? 'timeout >45s' : (e as Error).message}); falling back to native.`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Compress the OLD tool-result backlog of a message array, protecting the most recent turns and all
 * non-tool roles. Returns the (new) messages plus token stats. Char/4 token estimate keeps it cheap;
 * the caller can re-measure precisely if it wants.
 */
export function compressBacklog(
  messages: { role: string; content: any; [k: string]: any }[],
  opts: { protectRecent?: number; minChars?: number; skipCode?: boolean } = {},
): { messages: typeof messages; stats: BacklogStats } {
  const protectRecent = opts.protectRecent ?? 6;
  const minChars = opts.minChars ?? 400;
  const skipCode = opts.skipCode ?? false;
  const cutoff = Math.max(0, messages.length - protectRecent);

  let before = 0, after = 0, compressedMessages = 0, compressedBefore = 0, compressedAfter = 0;
  const out = messages.map((m, idx) => {
    // Never collapse code: even the lossless run-deduper folds near-identical lines (e.g. a block of
    // similar getters/exports) behind a "(×N elided)" marker. That's fine for log spam, lossy for
    // source. When stacking after the proxy code guard, skipCode keeps the guarantee absolute.
    const isOldTool = m.role === 'tool' && idx < cutoff && typeof m.content === 'string'
      && !(skipCode && looksLikeCode(m.content));
    if (!isOldTool || m.content.length < minChars) {
      if (typeof m.content === 'string') { before += cheapTokens(m.content); after += cheapTokens(m.content); }
      return m;
    }
    const compressed = compressText(m.content);
    const cb = cheapTokens(m.content), ca = cheapTokens(compressed);
    before += cb;
    after += ca;
    if (compressed.length < m.content.length) {
      compressedMessages++;
      compressedBefore += cb;
      compressedAfter += ca;
      return { ...m, content: compressed };
    }
    return m;
  });

  return {
    messages: out,
    stats: { tokensBefore: before, tokensAfter: after, saved: Math.max(0, before - after), compressedMessages, compressedBefore, compressedAfter },
  };
}
