/** Read-only production-source audit. All persisted memories are synthetic temporary fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VectorStore } from '../../../../src/memory/vector.store';
import { answeringExcerpt, recallForTurn } from '../../../../src/memory/recall';
import type { EmbeddingBackend } from '../../../../src/memory/embeddings';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-memory-audit-'));
  const observations: Record<string, unknown> = {};
  try {
    // Delay one writer at its existing async publication boundary. No production source is edited.
    const file = path.join(root, 'shared.json');
    const a = new VectorStore(null, null, { storePath: file, dedup: false });
    const b = new VectorStore(null, null, { storePath: file, dedup: false });
    await Promise.all([a.semanticSearch('initialize'), b.semanticSearch('initialize')]);
    const arrived = deferred<void>();
    const release = deferred<void>();
    const internal = a as unknown as { saveStore(): Promise<void> };
    const save = internal.saveStore.bind(a);
    internal.saveStore = async () => { arrived.resolve(); await release.promise; await save(); };
    const pending = a.storeDocument('writer-a', 'Apricot orchard harvest instructions.', ['note']);
    await arrived.promise;
    await b.storeDocument('writer-b', 'Zeppelin museum admission schedule.', ['note']);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).map((d: any) => d.id), ['writer-b']);
    release.resolve();
    await pending;
    const ids = JSON.parse(await fs.readFile(file, 'utf8')).map((d: any) => d.id);
    assert.deepEqual(ids, ['writer-a']);
    observations.sharedWriterLoss = { reproduced: true, acknowledgedWrites: 2, retainedIds: ids,
      expectedRetainedIds: ['writer-a', 'writer-b'], scheduling: 'writer A paused before save; writer B completes; A completes' };

    // Backfill must compare the selected text/version when its network result returns.
    const selected = deferred<void>();
    const oldVector = deferred<number[][] | null>();
    let phase = 'initial';
    const backend: EmbeddingBackend = { id: 'audit-space@2', dimensions: 2,
      embed: async texts => {
        if (phase === 'initial') return null;
        if (texts[0] === 'Old amber launch destination.') { selected.resolve(); return oldVector.promise; }
        return texts.map(() => [0, 1]);
      } };
    const backfillFile = path.join(root, 'backfill.json');
    const store = new VectorStore(backend, null, { storePath: backfillFile, dedup: false });
    await store.storeDocument('mutable', 'Old amber launch destination.', ['note']);
    phase = 'backfill';
    const filling = store.backfillEmbeddings();
    await selected.promise;
    await store.storeDocument('mutable', 'New violet launch destination.', ['note']);
    assert.deepEqual(JSON.parse(await fs.readFile(backfillFile, 'utf8'))[0].chunks[0].embedding, [0, 1]);
    oldVector.resolve([[1, 0]]);
    await filling;
    const changed = JSON.parse(await fs.readFile(backfillFile, 'utf8'))[0].chunks[0];
    assert.equal(changed.text, 'New violet launch destination.');
    assert.deepEqual(changed.embedding, [1, 0]);
    observations.staleBackfill = { reproduced: true, currentText: changed.text,
      expectedCurrentVector: [0, 1], persistedVector: changed.embedding };

    const orthogonal: EmbeddingBackend = { id: 'audit-orthogonal@2', dimensions: 2,
      embed: async (texts, role) => texts.map(() => role === 'query' ? [0, 1] : [1, 0]) };
    const dense = new VectorStore(orthogonal, null, { storePath: path.join(root, 'dense.json'), dedup: false });
    await dense.storeDocument('irrelevant', 'Apricot orchards require seasonal pruning.', ['note']);
    const query = 'Explain quantum neutrino oscillation parameters';
    const lexical = await dense.semanticSearch(query, 3, 0, { mode: 'lexical' });
    assert.equal(lexical.length, 0);
    const recalled = await recallForTurn(dense, query);
    assert.deepEqual(recalled?.ids, ['irrelevant']);
    observations.denseAbstentionGap = { reproduced: true, cosine: 0, lexicalMatches: 0,
      query, injected: recalled?.text, mode: dense.lastSearchMode(),
      limitation: 'Controlled orthogonal vectors; no claim about prevalence with a real embedding model.' };

    const line = 'Background context '.repeat(40) + 'Orion launch authorization code is VIOLET-73';
    const excerpt = answeringExcerpt(line, 'Orion launch authorization code', 120);
    assert.equal(answeringExcerpt('Orion code is VIOLET-73', 'Orion code', 120), 'Orion code is VIOLET-73');
    assert.equal(excerpt.includes('VIOLET-73'), false);
    observations.longLineEvidenceLoss = { reproduced: true, sourceHasFact: line.includes('VIOLET-73'),
      sourceChars: line.length, budgetChars: 120, excerpt, expectedFact: 'VIOLET-73' };

    // Exercise the exact resolver body with synthetic credentials, without booting a worker or HTTP.
    const workerSource = await fs.readFile(path.resolve('src/engine/worker.entry.ts'), 'utf8');
    const resolverBody = /const resolveKey = async \(\) => \{([\s\S]*?)\n      \};/.exec(workerSource)?.[1];
    assert.ok(resolverBody, 'Current worker resolver extraction must match');
    let chatKeyReads = 0;
    const localURL = 'http://127.0.0.1:11434/v1';
    const resolver = new Function('apiKeyManager', 'rerankURLFor', 'memorySettings',
      `return async () => {${resolverBody}}`)(
        { getNextKey: async () => { chatKeyReads++; return { keyStr: 'synthetic', baseURL: 'https://audit-chat.invalid/v1' }; } },
        (url: string) => `${url}/rerank`, { embeddingBaseURL: localURL },
      );
    const resolved = await resolver();
    assert.equal(resolved.baseURL, 'https://audit-chat.invalid/v1');
    assert.equal(chatKeyReads, 1);
    observations.workerEndpointMismatch = { reproduced: true, configuredEmbeddingBaseURL: localURL,
      resolvedEmbeddingBaseURL: resolved.baseURL, chatKeyReads,
      limitation: 'Extracted current resolver with fake credentials; no complete worker or HTTP request executed.' };

    console.log(JSON.stringify({ generatedAt: new Date().toISOString(),
      scope: 'Current source; synthetic local probes; no provider/model calls or source mutations', observations }, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
