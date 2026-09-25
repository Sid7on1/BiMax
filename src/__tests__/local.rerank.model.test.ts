import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalReranker } from '../memory/local.rerank';
import { loadWordPiece } from '../memory/wordpiece';

/**
 * Record 61: the on-device reranker with its real model, under bun (see local.rerank.test.ts for why not jest).
 * The model is the one prepare-engine.sh caches at its pinned revision.
 */
const cached = path.join(process.env.BIMAX_MODEL_CACHE || path.join(os.homedir(), '.cache', 'bimax', 'models'), 'ms-marco-MiniLM-L6-v2@233902d');
const haveModel = fs.existsSync(path.join(cached, 'model_qint8_arm64.onnx')) && fs.existsSync(path.join(cached, 'tokenizer.json'));
// Bun only: under jest, onnxruntime-web's dynamic import of its WebAssembly glue needs --experimental-vm-modules.
const underBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const withModel = haveModel && underBun ? test : test.skip;
if (underBun && !haveModel) console.warn(`local.rerank.model.test: real-model cases skipped — no model at ${cached} (build once with BIMAX_LOCAL_RERANK=1 npm run build:engine)`);

withModel('the real model puts the passage that answers first, among passages that share its words', async () => {
  const reranker = new LocalReranker({ dir: cached });
  const hits = await reranker.rerank('why do I need to grant access again after every update', [
    { id: 'distractor-words', text: 'Grant access to the update server again after every update window closes; the access list is rebuilt nightly.' },
    { id: 'answer', text: 'An ad-hoc signature produces a designated requirement bound only to the code hash, so every rebuild voids the permission grants while System Settings still shows them enabled.' },
    { id: 'unrelated', text: 'Preheat the oven to 200 degrees and bake for 25 minutes.' },
  ]);
  expect(hits?.map((h) => h.id).slice(0, 2)).toContain('answer');
  expect(hits?.[hits.length - 1].id).toBe('unrelated');
  expect(reranker.unavailableReason()).toBeNull();
}, 60_000);

withModel('the tokenizer matches Hugging Face on the real vocabulary', () => {
  const tok = loadWordPiece(path.join(cached, 'tokenizer.json'));
  // Reference ids from `tokenizers` 0.22 (record 61; 301 of 301 pairs matched).
  expect(tok.encodePair('What is E-204?', 'naïve café ≤20 wk → src 中文', 64).ids).toEqual(REFERENCE_IDS);
});

const REFERENCE_IDS = [101, 2054, 2003, 1041, 1011, 19627, 1029, 102, 15743, 7668, 1608, 11387, 1059, 2243, 1585, 5034, 2278, 1746, 1861, 102];
