import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChainedReranker, type Reranker } from '../memory/rerank';
import { LocalReranker } from '../memory/local.rerank';
import { loadWordPiece } from '../memory/wordpiece';
import { capabilitySnapshot, reportCapability, resetCapabilityStatus } from '../core/capability.status';

/**
 * Record 61: the on-device reranker. Three layers, tested separately:
 * - the tokenizer, on a synthetic vocabulary, for the rules that each cost a mismatch against Hugging Face;
 * - the chain, with stub rerankers, for which one answers and what is reported;
 * - the real model, when `prepare-engine.sh` has cached it (it names what it skipped otherwise).
 */

let temp: string;
beforeAll(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-local-rerank-')); });
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeEach(() => resetCapabilityStatus());

function syntheticTokenizer(): string {
  const tokens = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'cafe', 'naive', 'run', '##ning', 'x', '≤', '20', ',', '.', '中', '文', 'e', '-', '204'];
  const file = path.join(temp, 'tokenizer.json');
  fs.writeFileSync(file, JSON.stringify({ model: { vocab: Object.fromEntries(tokens.map((t, i) => [t, i])), unk_token: '[UNK]' } }));
  return file;
}

describe('WordPiece', () => {
  test('splits punctuation, strips accents, spaces CJK, and matches the longest piece first', () => {
    const tok = loadWordPiece(syntheticTokenizer());
    const id = (t: string) => ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'cafe', 'naive', 'run', '##ning', 'x', '≤', '20', ',', '.', '中', '文', 'e', '-', '204'].indexOf(t);
    expect(tok.encode('Café, naïve.')).toEqual([id('cafe'), id(','), id('naive'), id('.')]);
    expect(tok.encode('running')).toEqual([id('run'), id('##ning')]);
    expect(tok.encode('中文')).toEqual([id('中'), id('文')]);
    expect(tok.encode('E-204')).toEqual([id('e'), id('-'), id('204')]);
    // "≤" is a SYMBOL, not punctuation: it stays glued to its word, which here makes the word unknown.
    expect(tok.encode('x≤20')).toEqual([id('[UNK]')]);
    expect(tok.encode('zzz')).toEqual([id('[UNK]')]);
  });

  test('a pair is [CLS] a [SEP] b [SEP] with segment ids, trimmed longest side first', () => {
    const tok = loadWordPiece(syntheticTokenizer());
    const pair = tok.encodePair('cafe cafe', 'run run run run run run', 8);
    expect(pair.ids).toEqual([2, 4, 4, 3, 6, 6, 6, 3]);
    expect(pair.types).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
});

const stub = (model: string, answer: (candidates: { id: string }[]) => { id: string; logit: number }[] | null): Reranker & { calls: number } => {
  const reranker = {
    model, calls: 0,
    unavailableReason: () => (answer([]) === null ? `${model} is down` : null),
    rerank: async (_q: string, candidates: { id: string; text: string }[]) => { reranker.calls++; return answer(candidates); },
  };
  return reranker;
};
const reversed = (candidates: { id: string }[]) => [...candidates].reverse().map((c, i) => ({ id: c.id, logit: -i }));
const candidates = [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }];

describe('ChainedReranker', () => {
  test('the remote reranker answers first, and the local one is not run', async () => {
    const remote = stub('remote', reversed);
    const local = stub('local', reversed);
    const chain = new ChainedReranker(remote, local);
    expect((await chain.rerank('q', candidates))?.map((h) => h.id)).toEqual(['b', 'a']);
    expect([remote.calls, local.calls]).toEqual([1, 0]);
    expect(chain.model).toBe('remote');
  });

  test('when the remote one cannot answer the local one does, and the remote failure is reported as covered', async () => {
    // What RemoteReranker.fail() reports on a 404, before the chain covers it.
    reportCapability({ id: 'reranking', label: 'Search reranking', state: 'degraded', reason: 'HTTP 404', impact: 'x', action: 'y' });
    const chain = new ChainedReranker(stub('remote', () => null), stub('local', reversed));
    expect((await chain.rerank('q', candidates))?.map((h) => h.id)).toEqual(['b', 'a']);
    expect(chain.model).toBe('local');
    const status = capabilitySnapshot().find((s) => s.id === 'reranking');
    expect(status?.state).toBe('ready');
    expect(status?.reason).toContain('Reranked on this Mac (local)');
  });

  test('neither answering is null, never an invented order', async () => {
    const chain = new ChainedReranker(stub('remote', () => null), stub('local', () => null));
    expect(await chain.rerank('q', candidates)).toBeNull();
    expect(chain.unavailableReason()).toContain('remote is down');
    expect(chain.unavailableReason()).toContain('local is down');
    expect(await new ChainedReranker(null, null).rerank('q', candidates)).toBeNull();
  });
});

describe('LocalReranker', () => {
  test('without its files it returns null, says why, and reports it', async () => {
    const reranker = new LocalReranker({ dir: path.join(temp, 'absent') });
    expect(reranker.installed()).toBe(false);
    expect(await reranker.rerank('q', candidates)).toBeNull();
    expect(reranker.unavailableReason()).toContain('not installed');
    expect(capabilitySnapshot().find((s) => s.id === 'reranking-local')?.state).toBe('degraded');
  });
});

// The real model runs under bun: onnxruntime-web loads its WebAssembly glue with a dynamic import, which jest's VM
// refuses without --experimental-vm-modules. See local.rerank.model.test.ts (npm run test:bun).
