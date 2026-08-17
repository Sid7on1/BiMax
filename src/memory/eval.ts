/**
 * Retrieval evaluation — the difference between "we added stages" and "it got better".
 *
 * ## Why this exists
 *
 * Every other test in this layer asserts a *behaviour*: the query embeds with the right role, the
 * fusion prefers agreement, a paraphrase is findable. All necessary, none of them answers the only
 * question that matters — **is retrieval better than it was, and by how much?** Without a number,
 * "advanced" is a claim, the next change to the ranking is a coin flip, and a regression is
 * invisible because every behavioural test still passes while the results quietly get worse.
 *
 * So this measures the two things retrieval is actually judged on:
 *
 *   - **recall@k** — was the right document in the top k at all? This is the ceiling: nothing later
 *     in the pipeline can recover a document that was never retrieved.
 *   - **MRR** (mean reciprocal rank) — *where* in the list was it? Recall treats "first" and "tenth"
 *     as equally good; MRR does not, and the difference is the whole point of reranking.
 *
 * Reporting only recall would make reranking look like it does nothing. Reporting only MRR would
 * hide a retriever that dropped the answer entirely. They are both required — and note that
 * reranking reorders a fixed candidate SET, but only the top k of it is returned, so reranking CAN
 * cost a place at the tail of the top k while it moves everything else up. The eval allows at most
 * one such demotion; more means the reranker's signal disagrees with retrieval often enough to be
 * a net negative, which is the failure the margin in /retrieval exists to catch on the live side.
 */

import type { VectorStore } from './vector.store';

export interface EvalCase {
  query: string;
  /** Document ids that genuinely answer this query. */
  relevant: string[];
}

export interface EvalCorpusEntry {
  id: string;
  text: string;
}

export interface EvalResult {
  cases: number;
  /** Fraction of cases where a relevant document appeared in the top k. */
  recallAtK: number;
  /** Mean of 1/rank of the first relevant document; 0 when none was found. */
  mrr: number;
  k: number;
  /** Per-case detail, so a regression names the query it broke rather than a moved average. */
  detail: { query: string; foundAt: number | null }[];
}

/**
 * Run a labelled set against a store.
 *
 * The store is passed in already populated and configured, so the same corpus can be run against
 * lexical-only, hybrid, and hybrid+rerank and the numbers compared directly. That comparison is the
 * output worth having: an absolute recall figure means little without the baseline it improved on.
 */
export async function evaluateRetrieval(
  store: VectorStore,
  cases: EvalCase[],
  k: number = 5,
): Promise<EvalResult> {
  const detail: { query: string; foundAt: number | null }[] = [];
  let found = 0;
  let reciprocalSum = 0;

  for (const testCase of cases) {
    // minScore 0: a lexical floor would silently filter the dense-only hits this is measuring.
    const results = await store.semanticSearch(testCase.query, k, 0);
    const relevant = new Set(testCase.relevant);
    const position = results.findIndex((doc) => relevant.has(doc.id));

    if (position >= 0) {
      found++;
      reciprocalSum += 1 / (position + 1);
      detail.push({ query: testCase.query, foundAt: position + 1 });
    } else {
      detail.push({ query: testCase.query, foundAt: null });
    }
  }

  return {
    cases: cases.length,
    recallAtK: cases.length ? found / cases.length : 0,
    mrr: cases.length ? reciprocalSum / cases.length : 0,
    k,
    detail,
  };
}

/**
 * The labelled set.
 *
 * Drawn from this project's own history rather than a public benchmark, because a public benchmark
 * measures a general-purpose retriever and this store holds engineering memory: error codes,
 * decisions, and the reasons behind them. What it must be good at is the way *this* user asks
 * questions later — rarely in the words the note was written in.
 *
 * The queries are deliberately split between two kinds, because a retriever that only handles one
 * is exactly the thing being fixed:
 *
 *   - **lexical** — an identifier or code that appears verbatim. BM25 must carry these, and a
 *     regression here means the dense stage has started drowning exact matches.
 *   - **semantic** — phrased so that BM25 cannot rank the target first: mostly paraphrase, sharing
 *     at most a word or two of vocabulary with a note written in different terms. Impossible to
 *     answer before embeddings; these are the cases that measure whether the upgrade is real. (The
 *     earlier blanket claim of "no content word in common" was measured false — real questions
 *     incidentally reuse words — so the property asserted is the one that matters: lexical search
 *     alone does not find them.)
 */
export const EVAL_CORPUS: EvalCorpusEntry[] = [
  {
    id: 'ax-refusal',
    text: 'Background press delivery returned AXError -25208 on a Notes row. Measured 214 of 214 rows cannot take a background press, while WhatsApp accepts none of 31. The capability is per-control and must be read from the tree, never assumed from the role.',
  },
  {
    id: 'tcc-stale',
    text: 'macOS decides a process Accessibility trust once, at launch. A process that started before the grant can never see it, so the Trust Center rendered a dead value forever and the grant watch sat out its full five minute timeout. The fix asks a freshly spawned child, which gets a new trust evaluation.',
  },
  {
    id: 'jest-workers',
    text: 'Random cross-suite timeouts were seven workers each allowed a one gigabyte idle heap on an eight gigabyte machine. Setting maxWorkers to fifty percent fixed ten failures and was faster overall. Raising the per-test timeout made it worse.',
  },
  {
    id: 'radix-portal',
    text: 'The portal renders null on its first commit, so a layout effect reading the ref sees nothing and never runs again because its dependencies have not changed. The animation is simply never started, with no error. Put the node in state via a callback ref so its arrival becomes a render.',
  },
  {
    id: 'morph-clip',
    text: 'The sidebar animation writes a clip-path over a column whose width never changes. Neighbours cannot respond to a clip, so the middle pane does not move until the collapse finishes and the panel unmounts, at which point it jumps to full width in one frame.',
  },
  {
    id: 'session-cwd',
    text: 'Session metadata is written to a path built from the current working directory, so history landed in whichever folder the process happened to start in and the project actually in use has none. The snapshot builder swallows the failure, so the list renders empty with no error anywhere.',
  },
  {
    id: 'signing-identity',
    text: 'An ad-hoc signature produces a designated requirement bound only to the code hash, so every rebuild voids the permission grants while System Settings still shows them enabled. A self-signed certificate makes the requirement stable across rebuilds.',
  },
  {
    id: 'glass-contrast',
    text: 'Primary text over a bright backdrop measured 2.0 to 1 against a floor of 4.5, less than half the accessibility minimum, and secondary text was effectively invisible at 1.1. The veil had been reasoned about as a tint over the desktop rather than over the application own bright surfaces.',
  },
  {
    id: 'xpc-location',
    text: 'An XPC service registers from its bundle placement, not from the binary that spawns it. Hosted anywhere but Bimax.app/Contents/XPCServices/ the service never becomes reachable, and the error surfaces as a launch timeout rather than a placement complaint.',
  },
  {
    id: 'engine-pin',
    text: 'The Mac app bundles one pinned engine artifact and its protocol schema, verified by hash. The terminal publishes versioned artifacts instead, so updating one product can never silently change the behaviour of the other — an unpinned reference drifts and the first symptom is a protocol mismatch weeks later.',
  },
  {
    id: 'recall-wiring',
    text: 'A feature can pass every unit test and yet be dead in production: the tests constructed the dependency the production callsite never passed. Automatic recall ran zero times outside tests for exactly this reason — the loop was built without the store, and each test built it with one.',
  },
  {
    id: 'vector-space-stamp',
    text: 'A stored vector is only comparable to vectors from the same model at the same size. Every record carries a space stamp; a mismatch means re-embed, never compare — mixing spaces produces plausible-looking similarity scores that mean nothing, which is worse than an error.',
  },
  {
    id: 'backfill-pending',
    text: 'Memories written while no embedding key existed carry no vectors and stay invisible to semantic search after a key is added, because nothing re-embeds old records on its own. A bounded backfill pass closes the hole; without it, the dense stage quietly sees only what was stored after the key arrived.',
  },
  {
    id: 'safe-storage-keys',
    text: 'API keys are sealed with Electron safeStorage, so only a process the app itself spawned can decrypt them. Unit tests therefore stop at the HTTP boundary by necessity, and the one link no test can close — the live call — must be probed from inside the running process instead.',
  },
  {
    id: 'nv-embed-model',
    text: 'The retrieval space is nvidia/llama-3.2-nv-embedqa-1b-v2 at 768 Matryoshka dimensions, served on the same OpenAI-compatible base URL and key rotation as chat, with truncate END because the provider default NONE rejects long documents rather than truncating them.',
  },
];

export const EVAL_CASES: EvalCase[] = [
  // --- lexical: the exact token appears verbatim ------------------------------------------------
  { query: 'AXError -25208', relevant: ['ax-refusal'] },
  { query: 'maxWorkers 50%', relevant: ['jest-workers'] },
  { query: 'llama-3.2-nv-embedqa-1b-v2', relevant: ['nv-embed-model'] },
  { query: 'safeStorage decrypt', relevant: ['safe-storage-keys'] },

  // --- semantic: no content word shared with the target ----------------------------------------
  // "why does it still say off after I turned it on" ↔ a note about stale trust evaluation.
  { query: 'I enabled the permission but it still shows as disabled', relevant: ['tcc-stale'] },
  // "the panel appears instantly with no animation" ↔ a note about an effect that never runs.
  { query: 'the dialog just appears instead of animating in', relevant: ['radix-portal'] },
  // "the layout jumps at the end" ↔ a note about clip-path not reflowing neighbours.
  { query: 'why does the middle area snap wider only after the panel is gone', relevant: ['morph-clip'] },
  // "my past conversations vanished" ↔ a note about metadata keyed to the working directory.
  { query: 'my previous chats are missing from the list', relevant: ['session-cwd'] },
  // "I have to re-approve every time I install a new build" ↔ a note about designated requirements.
  { query: 'why do I need to grant access again after every update', relevant: ['signing-identity'] },
  // "the writing is hard to read on the frosted background" ↔ a note about contrast ratios.
  { query: 'text is difficult to read over the translucent material', relevant: ['glass-contrast'] },
  // "the helper never starts when I run it from the shell" ↔ a note about XPC bundle placement.
  { query: 'the native helper does not become reachable when launched from the shell', relevant: ['xpc-location'] },
  // "the two products drifted apart after an update" ↔ a note about the pinned engine artifact.
  { query: 'the desktop app broke because the terminal changed underneath it', relevant: ['engine-pin'] },
  // "all green in CI, nothing in the real app" ↔ a note about tests constructing what production omits.
  { query: 'every test passes but the feature does nothing when I actually use it', relevant: ['recall-wiring'] },
  // "similarity scores look fine but are nonsense after resizing" ↔ a note about space stamps.
  { query: 'search behaved oddly after I changed the embedding size, the similarity scores look wrong', relevant: ['vector-space-stamp'] },
  // "old notes still only match keywords after adding the key" ↔ a note about unbackfilled records.
  { query: 'older entries only match by keyword even though the key now works', relevant: ['backfill-pending'] },
];
