import * as fs from 'fs';

/**
 * BERT WordPiece (uncased), enough to feed the local reranker a query–passage pair.
 *
 * Written rather than imported: the tokenizer libraries that do this pull a native addon or a whole inference framework
 * into the engine bundle for eighty lines of logic. It is held to the reference implementation instead — the ids for
 * 301 query–passage pairs (SciFact abstracts, Hindi, CJK, accents, "≤", "→") match Hugging Face `tokenizers` exactly,
 * and `local.rerank.test.ts` pins a sample of them. Two details that cost a mismatch each when wrong: only Unicode
 * PUNCTUATION splits a word ("≤" and "→" are symbols and do not), and accents are stripped after NFD.
 */
export interface WordPiece {
  encode(text: string): number[];
  /** `[CLS] a [SEP] b [SEP]`, trimming the longer side first until it fits `maxLength` (Hugging Face's pair default). */
  encodePair(a: string, b: string, maxLength: number): { ids: number[]; types: number[] };
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const isPunctuation = (ch: string): boolean => /\p{P}/u.test(ch) || ASCII_PUNCTUATION.test(ch);
const isCJK = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0xf900 && cp <= 0xfaff);

export function loadWordPiece(tokenizerJsonPath: string): WordPiece {
  const spec = JSON.parse(fs.readFileSync(tokenizerJsonPath, 'utf8')) as {
    model: { vocab: Record<string, number>; unk_token?: string; max_input_chars_per_word?: number };
  };
  const vocab = new Map(Object.entries(spec.model.vocab));
  const id = (token: string): number => {
    const value = vocab.get(token);
    if (value === undefined) throw new Error(`tokenizer vocabulary has no ${token}`);
    return value;
  };
  const unk = id(spec.model.unk_token ?? '[UNK]');
  const cls = id('[CLS]');
  const sep = id('[SEP]');
  const maxChars = spec.model.max_input_chars_per_word ?? 100;

  const basic = (text: string): string[] => {
    let cleaned = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || (/[\p{Cc}\p{Cf}]/u.test(ch) && !/[\t\n\r]/.test(ch))) continue;
      cleaned += isCJK(cp) ? ` ${ch} ` : /\s/.test(ch) ? ' ' : ch;
    }
    cleaned = cleaned.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    const words: string[] = [];
    for (const word of cleaned.split(/\s+/)) {
      if (!word) continue;
      let current = '';
      for (const ch of word) {
        if (!isPunctuation(ch)) { current += ch; continue; }
        if (current) words.push(current);
        words.push(ch);
        current = '';
      }
      if (current) words.push(current);
    }
    return words;
  };

  const pieces = (word: string): number[] => {
    const chars = [...word];
    if (chars.length > maxChars) return [unk];
    const ids: number[] = [];
    for (let start = 0; start < chars.length;) {
      let end = chars.length;
      let found: number | undefined;
      for (; start < end; end--) {
        found = vocab.get((start > 0 ? '##' : '') + chars.slice(start, end).join(''));
        if (found !== undefined) break;
      }
      if (found === undefined) return [unk];
      ids.push(found);
      start = end;
    }
    return ids;
  };

  const encode = (text: string): number[] => basic(text).flatMap(pieces);
  return {
    encode,
    encodePair(a, b, maxLength) {
      const whole = [encode(a), encode(b)];
      let [kept, keptSecond] = [whole[0].length, whole[1].length];
      while (kept + keptSecond > maxLength - 3) {
        if (kept > keptSecond) kept--;
        else keptSecond--;
      }
      const first = whole[0].slice(0, kept);
      const second = whole[1].slice(0, keptSecond);
      return {
        ids: [cls, ...first, sep, ...second, sep],
        types: [...new Array(first.length + 2).fill(0), ...new Array(second.length + 1).fill(1)],
      };
    },
  };
}
