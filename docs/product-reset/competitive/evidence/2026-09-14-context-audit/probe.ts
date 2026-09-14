/** Audit probes: assert present limitations, NOT desired acceptance behavior. No provider calls. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { CodeIndex } from '../../../../../src/memory/code.index';
import { VectorStore } from '../../../../../src/memory/vector.store';
import { recallForTurn, recallQuery, recallKey, RECALL_PREFIX } from '../../../../../src/memory/recall';
import { Bm25Index, tokenize } from '../../../../../src/memory/bm25';
import { ContextManager } from '../../../../../src/memory/context.manager';
import { fileStateCache } from '../../../../../src/memory/file-state-cache';
import { GraphStore } from '../../../../../src/graph/graph.store';
import { planContext } from '../../../../../src/graph/context.planner';
import { computePageRank } from '../../../../../src/graph/pagerank';
import { compressText } from '../../../../../src/memory/headroom.compress';

async function main() {
  const root = process.cwd();
  const output = path.join(root, 'docs/product-reset/competitive/evidence/2026-09-14-context-audit');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-context-audit-'));
  const results: any[] = [];
  const llm = { async *chat() { yield { type: 'token', text: '## Goal\nAudit fixture summary.' }; } };
  const run = async (id: string, fn: () => Promise<any>) => {
    try { results.push({ id, status: 'reproduced', evidence: await fn() }); }
    catch (e) { results.push({ id, status: 'not_reproduced_or_error', error: String(e) }); }
  };
  let staleFile = '';
  try {
    await run('A01_same_metadata_stale_index_and_restoration', async () => {
      const dir = path.join(temp, 'stale'); await fs.mkdir(dir);
      staleFile = path.join(dir, 'state.ts');
      const old = 'export const state = "oldsentinel";\n';
      const fresh = 'export const state = "newsentinel";\n';
      const timestamp = new Date('2026-01-01T00:00:00Z');
      await fs.writeFile(staleFile, old); await fs.utimes(staleFile, timestamp, timestamp);
      const before = await fs.stat(staleFile);
      const index = new CodeIndex(null, null, { root: dir, storePath: path.join(temp, 'stale.db') });
      assert.equal((await index.sync()).indexed, 1);
      fileStateCache.set(staleFile, before.mtimeMs, old);
      await fs.writeFile(staleFile, fresh); await fs.utimes(staleFile, timestamp, timestamp);
      const after = await fs.stat(staleFile);
      assert.equal(before.mtimeMs, after.mtimeMs); assert.equal(before.size, after.size);
      const sync = await index.sync();
      const hits = await index.search('oldsentinel', 3, undefined, 'lexical');
      assert.equal(sync.indexed, 0); assert.ok(hits.some(h => h.text.includes('oldsentinel')));
      const manager = new ContextManager(llm as any);
      const msgs: any[] = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `fixture ${i}` }));
      const compacted = await manager.compact(msgs);
      const restoration = compacted.find(m => typeof m.content === 'string' && m.content.startsWith('[Post-Compact Restoration'));
      assert.ok(String(restoration?.content).includes('oldsentinel'));
      assert.ok(String(restoration?.content).includes('verified unchanged on disk'));
      fileStateCache.invalidate(staleFile);
      return { sameMtimeAndSize: true, actualBytesChanged: old !== fresh, sync, staleSearch: true, staleRestorationLabelledVerified: true };
    });
    await run('A02_path_filter_candidate_starvation_and_prefix_boundary', async () => {
      const dir = path.join(temp, 'scoped');
      await fs.mkdir(path.join(dir, 'wanted'), { recursive: true });
      await fs.mkdir(path.join(dir, 'wantedExtra'), { recursive: true });
      for (let i = 0; i < 30; i++) await fs.writeFile(path.join(dir, `a${i}.ts`), 'export const needle = "needle";\n');
      await fs.writeFile(path.join(dir, 'wanted', 'target.ts'), `export const needle = "needle";\n/* ${'padding '.repeat(200)} */`);
      await fs.writeFile(path.join(dir, 'wantedExtra', 'leak.ts'), 'export const boundarysentinel = 1;');
      const index = new CodeIndex(null, null, { root: dir, storePath: path.join(temp, 'scoped.db') });
      await index.sync(100);
      const scoped = await index.search('needle', 1, 'wanted', 'lexical');
      const broad = await index.search('needle', 100, undefined, 'lexical');
      const prefix = await index.search('boundarysentinel', 1, 'wanted', 'lexical');
      assert.equal(scoped.length, 0); assert.ok(broad.some(h => h.path === 'wanted/target.ts'));
      assert.equal(prefix[0]?.path, 'wantedExtra/leak.ts');
      return { requestedTop1: scoped.length, intendedHitExistsInBroaderResults: true, siblingPrefixReturned: prefix[0].path };
    });
    await run('A03_matching_chunk_lost_when_whole_document_prefix_is_injected', async () => {
      const store = new VectorStore(null, null, { storePath: path.join(temp, 'notes.json'), dedup: false });
      const content = Array.from({ length: 100 }, (_, i) => `Background section ${i}: ordinary operational details unrelated to the question.\n`).join('\n')
        + '\nThe orchid launch passphrase is VIOLET-SENTINEL.\n';
      await store.storeDocument('long-note', content, ['note']);
      const recalled = await recallForTurn(store, 'What is the orchid launch passphrase?');
      assert.deepEqual(recalled?.ids, ['long-note']);
      assert.ok(!recalled?.text.includes('VIOLET-SENTINEL'));
      return { correctDocumentRetrieved: true, answerPresentInStoredDocument: true, answerAbsentFromInjectedContext: true, injectedChars: recalled?.text.length };
    });
    await run('A04_recall_survives_compaction_as_durable_system_text', async () => {
      const manager = new ContextManager(llm as any);
      const note = { role: 'system', content: `${RECALL_PREFIX} obsolete fixture assertion` };
      const history: any[] = [note, ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `fixture ${i}` }))];
      const out = await manager.compact(history);
      assert.ok(out.includes(note));
      const query = 'What is our current release procedure?';
      assert.equal(recallQuery('user', query, new Set([recallKey(query)])), null);
      return { recalledBlockRetainedUnchanged: true, repeatQuerySuppressedWithoutVersionOrResidencyCheck: true };
    });
    await run('A05_declared_context_pack_budget_exceeded', async () => {
      const dir = path.join(temp, 'pack'); await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'large.ts'), `export function target() {\n${'  const descriptiveVariable = "long body";\n'.repeat(150)}}\n`);
      const graph = new GraphStore(':memory:');
      graph.addNode({ id: 'budget-target', type: 'FUNCTION', name: 'target', filePath: 'large.ts', startLine: 1, endLine: 152 });
      const pack = await planContext(graph, 'budget-target', { cwd: dir, maxTokens: 100 });
      assert.ok(!('error' in pack)); if ('error' in pack) throw Error(pack.error);
      assert.ok(pack.tokenEstimate > 100); assert.equal(pack.truncated, false);
      return { requestedBudget: 100, reportedTokens: pack.tokenEstimate, truncated: pack.truncated };
    });
    await run('A06_graph_cache_reuses_changed_same_shape_graph', async () => {
      const graph = new GraphStore(':memory:');
      const nodes: any[] = ['audit-aa', 'audit-bb', 'audit-cc'].map(id => ({ id, type: 'FUNCTION', name: id }));
      graph.setGraph({ nodes: new Map(nodes.map(n => [n.id, n])), edges: [{ sourceId: nodes[0].id, targetId: nodes[1].id, type: 'CALLS' }] });
      const first = computePageRank(graph);
      graph.setGraph({ nodes: new Map(nodes.map(n => [n.id, n])), edges: [{ sourceId: nodes[0].id, targetId: nodes[2].id, type: 'CALLS' }] });
      const second = computePageRank(graph);
      assert.equal(first, second); assert.ok(second.get('audit-bb')! > second.get('audit-cc')!);
      return { sameCachedObject: true, oldTargetStillRanksAboveNewTarget: true, scoreMass: [...second.values()].reduce((a,b) => a+b,0) };
    });
    await run('A07_non_latin_lexical_query_disappears', async () => {
      const query = 'भुगतान विवरण';
      const terms = tokenize(query); const hits = new Bm25Index([{ id: 'hindi', text: query }]).search(query);
      assert.deepEqual(terms, []); assert.deepEqual(hits, []);
      return { exactMatchingDocument: true, tokens: terms, hits: hits.length };
    });
    await run('A08_numeric_log_compression_removes_distinct_observations', async () => {
      const input = 'latency 100 ms\nlatency 200 ms\nlatency 900 ms\nlatency 300 ms';
      const output = compressText(input);
      assert.ok(!output.includes('900')); assert.ok(output.includes('similar lines elided'));
      return { input, output, maximumObservationRemoved: true };
    });
  } finally { if (staleFile) fileStateCache.invalidate(staleFile); await fs.rm(temp, { recursive: true, force: true }); }
  const sourcePaths = ['src/memory/code.index.ts', 'src/memory/sqlite.code.store.ts', 'src/memory/vector.store.ts', 'src/memory/recall.ts', 'src/memory/context.manager.ts', 'src/memory/file-state-cache.ts', 'src/memory/bm25.ts', 'src/memory/headroom.compress.ts', 'src/graph/context.planner.ts', 'src/graph/pagerank.ts'];
  const hashes = Object.fromEntries(await Promise.all(sourcePaths.map(async p => [p, createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex')])));
  const report = { timestamp: new Date().toISOString(), runtime: process.version, statusMeaning: 'Reproduced current limitation; not an acceptance pass or performance measurement', providerCalls: 0, sourceHashes: hashes, results };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if (results.some(r => r.status !== 'reproduced')) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
