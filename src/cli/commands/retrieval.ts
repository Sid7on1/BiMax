import { globalCommandRegistry } from './registry';
import { buildKeyPool, getCurrentProvider } from '../provider';
import { ApiKeyManager } from '../../credits/api.key.manager';
import { RemoteEmbeddingBackend, dot } from '../../memory/embeddings';
import { RemoteReranker } from '../../memory/rerank';

/**
 * `/retrieval` — is semantic search actually on, or silently degraded?
 *
 * ## Why this is a command and not a test
 *
 * The retrieval layer is graded by 48 unit tests, and every one of them stops at the HTTP boundary
 * because the API key is sealed with Electron's `safeStorage` — only a process the app itself
 * spawned can decrypt it. So the one link no test can close is the one that runs in production.
 * This command runs *inside that process*, which makes it the only place the question is
 * answerable.
 *
 * ## Why it earns a permanent place rather than being scaffolding
 *
 * Hybrid retrieval degrades silently by design: with no key, no network, or a provider that serves
 * no embeddings, `embed()` returns null and the store falls back to BM25 alone. That is the correct
 * behaviour — worse results beat wrong ones — but it is invisible from the outside. Search keeps
 * working, keeps returning documents, and quietly stops finding anything it does not share words
 * with. Every serious defect in this project has had that shape: code that runs, reports nothing,
 * and does nothing. A degradation with no readout is the same bug waiting to happen again.
 *
 * The probe is a real embedding call, not a ping, because the failure modes worth catching are all
 * downstream of "the endpoint responded": a model that returns the wrong dimensionality, vectors
 * that are not unit length, or a space that does not actually separate a paraphrase from unrelated
 * text. A 200 OK proves none of those.
 */

/**
 * The probe corpus.
 *
 * Deliberately a pair that shares NO content words with the query, plus a control drawn from this
 * project's own domain. If the margin between them is small the vector space is not doing the one
 * thing it was added for, and a green tick would be worse than no check at all.
 */
const QUERY = 'the build is failing';
const PARAPHRASE = 'CI is red on main after the last merge';
const UNRELATED = 'the sidebar corner radius interpolates from 22px to 14px';

/** Below this the space is not separating meaning; report it rather than calling it healthy. */
const MIN_MARGIN = 0.05;

function line(status: 'ok' | 'warn' | 'fail', label: string, detail: string): string {
  const glyph = status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✗';
  return `- ${glyph} ${label}: ${detail}`;
}

globalCommandRegistry.register({
  name: '/retrieval',
  aliases: ['/embeddings'],
  category: 'Session & Context',
  description: 'Prove semantic search is live — one real embedding call, with the margin it produced',
  execute: async () => {
    const out: string[] = ['**Retrieval**', ''];

    const keys = buildKeyPool();
    if (!keys.length) {
      out.push(line('fail', 'Embeddings', 'no API key — search is BM25 only'));
      out.push('');
      out.push('Keyword search still works. Paraphrases (no shared words) will not be found.');
      return { type: 'message', level: 'error', content: out.join('\n') };
    }

    const manager = new ApiKeyManager(keys);
    const backend = new RemoteEmbeddingBackend({
      resolve: async () => {
        const key = await manager.getNextKey();
        if (!key.keyStr) return null;
        return { apiKey: key.keyStr, baseURL: key.baseURL || 'https://integrate.api.nvidia.com/v1' };
      },
    });

    out.push(line('ok', 'Provider', `${getCurrentProvider()} · ${keys.length} key(s)`));
    out.push(line('ok', 'Space', backend.id));
    out.push('');

    const started = Date.now();
    // Passages and query embed in separate calls on purpose: these models are asymmetric, and
    // sending both sides through one role is the exact mistake this probe should be able to catch.
    const passages = await backend.embed([PARAPHRASE, UNRELATED], 'passage');
    const queries = await backend.embed([QUERY], 'query');
    const elapsed = Date.now() - started;

    if (!passages || !queries) {
      const why = backend.unavailableReason() ?? 'transient failure (network, timeout or rate limit)';
      out.push(line('fail', 'Live call', why));
      out.push('');
      out.push('Search has fallen back to BM25. That is keyword matching: exact terms still rank');
      out.push('correctly, and anything phrased differently from the stored text will be missed.');
      return { type: 'message', level: 'error', content: out.join('\n') };
    }

    const dims = passages[0].length;
    const norm = Math.sqrt(dot(passages[0], passages[0]));
    const near = dot(queries[0], passages[0]);
    const far = dot(queries[0], passages[1]);
    const margin = near - far;

    out.push(line('ok', 'Live call', `${elapsed}ms · ${dims} dimensions`));
    // A non-unit vector means cosine is not the dot product, and every score downstream is wrong by
    // an unknown factor. Cheap to check, silent if it ever regresses.
    out.push(line(
      Math.abs(norm - 1) < 1e-3 ? 'ok' : 'fail',
      'Unit length',
      norm.toFixed(6),
    ));
    out.push('');
    out.push('**Does the space separate meaning?**');
    out.push('');
    out.push(`  query      "${QUERY}"`);
    out.push(`  paraphrase "${PARAPHRASE}"`);
    out.push(`             → ${near.toFixed(4)}`);
    out.push(`  unrelated  "${UNRELATED}"`);
    out.push(`             → ${far.toFixed(4)}`);
    out.push('');

    const healthy = margin >= MIN_MARGIN;
    out.push(line(
      healthy ? 'ok' : 'fail',
      'Margin',
      healthy
        ? `${margin.toFixed(4)} — the space is separating meaning`
        : `${margin.toFixed(4)} — below ${MIN_MARGIN}; the model is responding but not discriminating`,
    ));

    // The fourth stage degrades exactly as silently as the third, and for the same reasons: a
    // reranker that cannot answer leaves the fused order in place, which is correct and invisible.
    out.push('');
    const reranker = new RemoteReranker({
      resolve: async () => {
        const key = await manager.getNextKey();
        if (!key.keyStr) return null;
        return { apiKey: key.keyStr, baseURL: key.baseURL || 'https://integrate.api.nvidia.com/v1' };
      },
    });
    const ranked = await reranker.rerank(QUERY, [
      { id: 'paraphrase', text: PARAPHRASE },
      { id: 'unrelated', text: UNRELATED },
    ]);
    if (!ranked) {
      out.push(line('fail', 'Rerank', reranker.unavailableReason() ?? 'transient failure'));
      out.push('  Results keep the fused order. Recall is unaffected; the best match may not be first.');
    } else {
      // The cross-encoder must agree with the retriever about which passage answers the query. If
      // it does not, it is reordering results on a signal that disagrees with the one that found
      // them, which is worse than not reranking at all.
      const first = ranked[0]?.id;
      out.push(line(
        first === 'paraphrase' ? 'ok' : 'fail',
        'Rerank',
        first === 'paraphrase'
          ? `${reranker.model} ranked the paraphrase first`
          : `${reranker.model} ranked "${first}" first — it disagrees with retrieval`,
      ));
    }

    out.push('');
    out.push(`Pipeline: chunk → BM25 ∥ dense → rank fusion${ranked ? ' → rerank' : ''}`);

    return {
      type: 'message',
      level: healthy ? 'info' : 'error',
      content: out.join('\n'),
    };
  },
});
