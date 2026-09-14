import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeIndex } from '../memory/code.index';
import { VectorStore } from '../memory/vector.store';
import { recallForTurn, RECALL_PREFIX } from '../memory/recall';
import { Bm25Index, tokenize } from '../memory/bm25';
import { ContextManager } from '../memory/context.manager';
import { fileStateCache } from '../memory/file-state-cache';
import { GraphStore } from '../graph/graph.store';
import { planContext } from '../graph/context.planner';
import { computePageRank, formatRepoMapOutline } from '../graph/pagerank';
import { compressText } from '../memory/headroom.compress';
import { openSqlite } from '../core/sqlite';
import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { createReadFileTool } from '../tools/implementations/file.tool';

/**
 * Acceptance tests for the eight context defects reproduced in record 47 (A01–A08), written in step 1 of
 * record 50's build plan and turned into plain assertions as each fix landed: A02, A05, A06, A07 and A08 in
 * step 2, A01, A03 and A04 in step 3. Every test states the behaviour we want, with a control that proves
 * its fixture works, so an empty result can never pass for a fix.
 *
 * The code-index tests need SQLite FTS5. Node 22's `node:sqlite` on the dev Mac has none, so Jest skips
 * them by name; `npm run test:context` runs this file under Bun, where all of them run.
 */

function sqliteHasFts5(): boolean {
  const db = openSqlite(':memory:');
  if (!db) return false;
  try {
    db.exec('CREATE VIRTUAL TABLE fts5_probe USING fts5(x)');
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Stands in for the summarizer, so compaction runs without a provider. */
const summarizer = { async *chat() { yield { type: 'token', text: '## Goal\nFixture summary.' }; } } as any;
const history = (turns: number) =>
  Array.from({ length: turns }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `fixture turn ${i}` }));
const JAN_1 = new Date('2026-01-01T00:00:00Z');

/** Rewrites a file with same-length text and puts the old modification time back. */
function rewriteKeepingSizeAndMtime(file: string, text: string): void {
  const before = fs.statSync(file);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, JAN_1, JAN_1);
  const after = fs.statSync(file);
  expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
}

let temp: string;
beforeAll(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-context-acceptance-')); });
afterAll(() => { fs.rmSync(temp, { recursive: true, force: true }); });

describe('A01: a rewrite that keeps the size and modification time', () => {
  test('is never restored after compaction as the old bytes', async () => {
    const file = path.join(temp, 'restored.ts');
    const old = 'export const state = "oldsentinel";\n';
    fs.writeFileSync(file, old);
    fs.utimesSync(file, JAN_1, JAN_1);
    const restorations = async () => (await new ContextManager(summarizer).compact(history(20) as any))
      .map(m => String(m.content))
      .filter(content => content.startsWith('[Post-Compact Restoration'));
    try {
      fileStateCache.set(file, fs.statSync(file).mtimeMs, old);
      // Control: while the bytes really are unchanged, restoring them as verified is correct.
      expect((await restorations()).some(c => c.includes('oldsentinel') && c.includes('verified unchanged'))).toBe(true);

      rewriteKeepingSizeAndMtime(file, 'export const state = "newsentinel";\n');
      expect((await restorations()).some(c => c.includes('oldsentinel'))).toBe(false);
    } finally {
      fileStateCache.invalidate(file);
    }
  });

  test('is not served from the read cache as the old bytes', async () => {
    const dir = path.join(temp, 'read-cache');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'read.ts');
    fs.writeFileSync(file, 'export const state = "oldsentinel";\n');
    fs.utimesSync(file, JAN_1, JAN_1);
    const tool = createReadFileTool({ approveTaskExecution: async () => {} } as any);
    const read = async (): Promise<string> => {
      const result: any = await tool.execute({ path: 'read.ts' }, { cwd: dir });
      return typeof result === 'string' ? result : JSON.stringify(result);
    };
    try {
      expect(await read()).toContain('oldsentinel');
      rewriteKeepingSizeAndMtime(file, 'export const state = "newsentinel";\n');
      const second = await read();
      expect(second).toContain('newsentinel');
      expect(second).not.toContain('oldsentinel');
    } finally {
      fileStateCache.invalidate(file);
    }
  });
});

(sqliteHasFts5() ? describe : describe.skip)('A01 and A02 in the code index (need SQLite FTS5: npm run test:context)', () => {
  test('A01: the index serves the current bytes after a same-size, same-mtime rewrite', async () => {
    const dir = path.join(temp, 'stale');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'state.ts');
    fs.writeFileSync(file, 'export const state = "oldsentinel";\n');
    fs.utimesSync(file, JAN_1, JAN_1);
    const index = new CodeIndex(null, null, { root: dir, storePath: path.join(temp, 'stale.db') });
    expect((await index.sync()).indexed).toBe(1);
    // Control: the index works, so an empty result later cannot pass for a fix.
    expect((await index.search('oldsentinel', 3, undefined, 'lexical')).some(h => h.text.includes('oldsentinel'))).toBe(true);
    // A moved ctime with the same bytes re-checks the file but does not re-index it.
    fs.utimesSync(file, JAN_1, JAN_1);
    expect((await index.sync()).indexed).toBe(0);

    rewriteKeepingSizeAndMtime(file, 'export const state = "newsentinel";\n');
    expect((await index.sync()).indexed).toBe(1);
    expect((await index.search('oldsentinel', 3, undefined, 'lexical')).some(h => h.text.includes('oldsentinel'))).toBe(false);
    expect((await index.search('newsentinel', 3, undefined, 'lexical')).some(h => h.text.includes('newsentinel'))).toBe(true);
  });

  describe('A02: a scoped search', () => {
    let index: CodeIndex;
    beforeAll(async () => {
      const dir = path.join(temp, 'scoped');
      fs.mkdirSync(path.join(dir, 'wanted'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'wantedExtra'), { recursive: true });
      for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `a${i}.ts`), 'export const needle = "needle";\n');
      fs.writeFileSync(path.join(dir, 'wanted', 'target.ts'), `export const needle = "needle";\n/* ${'padding '.repeat(200)} */\n`);
      fs.writeFileSync(path.join(dir, 'wantedExtra', 'leak.ts'), 'export const boundarysentinel = 1;\n');
      index = new CodeIndex(null, null, { root: dir, storePath: path.join(temp, 'scoped.db') });
      await index.sync(100);
    });

    test('finds the in-scope hit even when out-of-scope hits outrank it', async () => {
      // Control: the intended hit is in the index.
      expect((await index.search('needle', 100, undefined, 'lexical')).some(h => h.path === 'wanted/target.ts')).toBe(true);
      expect((await index.search('needle', 1, 'wanted', 'lexical')).map(h => h.path)).toEqual(['wanted/target.ts']);
      // A single file is a scope too.
      expect((await index.search('needle', 5, 'wanted/target.ts', 'lexical')).map(h => h.path)).toEqual(['wanted/target.ts']);
    });

    test('matches whole path segments, so `wanted` does not include `wantedExtra/`', async () => {
      // Control: the sibling file is in the index.
      expect((await index.search('boundarysentinel', 5, undefined, 'lexical')).some(h => h.path === 'wantedExtra/leak.ts')).toBe(true);
      expect((await index.search('boundarysentinel', 5, 'wanted', 'lexical')).map(h => h.path)).toEqual([]);
    });
  });
});

describe('A03: automatic recall', () => {
  test('injects the passage that answers the question, not the start of the document', async () => {
    const store = new VectorStore(null as any, null as any, { storePath: path.join(temp, 'notes.json'), dedup: false });
    const content = Array.from({ length: 100 }, (_, i) =>
      `Background section ${i}: ordinary operational details unrelated to the question.\n`).join('\n')
      + '\nThe orchid launch passphrase is VIOLET-SENTINEL.\n';
    await store.storeDocument('long-note', content, ['note']);
    const recalled = await recallForTurn(store, 'What is the orchid launch passphrase?');
    // Control: retrieval finds the right document.
    expect(recalled?.ids).toEqual(['long-note']);
    expect(recalled!.text).toContain('VIOLET-SENTINEL');
  });
});

describe('A04: recalled memory and compaction', () => {
  test('compaction does not keep a recall block as durable system text', async () => {
    const recall = { role: 'system', content: `${RECALL_PREFIX} — an obsolete fixture fact` };
    const out = await new ContextManager(summarizer).compact([recall, ...history(20)] as any);
    // Control: this history is long enough to compact.
    expect(out.some(m => String(m.content).startsWith('[Previous Context Summary]'))).toBe(true);
    expect(out.some(m => String(m.content).startsWith(RECALL_PREFIX))).toBe(false);
  });

  test('after compaction removes a recall block, the same question recalls again', async () => {
    const store = new VectorStore(null as any, null as any, { storePath: path.join(temp, 'recall-again.json'), dedup: false });
    await store.storeDocument('coach', 'The permission coach polls once a second and blocks the main process', ['note']);
    let searches = 0;
    const search = store.semanticSearch.bind(store);
    store.semanticSearch = (async (...args: Parameters<VectorStore['semanticSearch']>) => {
      searches++;
      return search(...args);
    }) as VectorStore['semanticSearch'];

    const question = 'why does the permission flow feel slow and blocked';
    const twoRounds = async (manager: ContextManager): Promise<number> => {
      searches = 0;
      const loop = new AgentLoop(summarizer, new ToolRegistry(), undefined, undefined, manager, store, new Set<string>());
      (loop as any).messages = [...history(20), { role: 'user', content: question }];
      await (loop as any).prepareContext('smart');
      await (loop as any).prepareContext('smart');
      return searches;
    };
    const keepsEverything = new (class extends ContextManager {
      async checkAndCompact(messages: any[]) { return messages; }
    })(summarizer);
    const compactsEveryRound = new (class extends ContextManager {
      async checkAndCompact(messages: any[]) { return this.compact(messages); }
    })(summarizer);

    // Control: while the recall block stays in the prompt, the same question is not searched twice.
    expect(await twoRounds(keepsEverything)).toBe(1);
    // Compaction drops the block, so the next round recalls the evidence again.
    expect(await twoRounds(compactsEveryRound)).toBe(2);
  });
});

describe('A05: a graph context pack', () => {
  test('stays within its token budget, or says it cannot', async () => {
    const dir = path.join(temp, 'pack');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'large.ts'), `export function target() {\n${'  const descriptiveVariable = "long body";\n'.repeat(150)}}\n`);
    const graph = new GraphStore(':memory:');
    graph.addNode({ id: 'budget-target', type: 'FUNCTION', name: 'target', filePath: 'large.ts', startLine: 1, endLine: 152 });

    // Control: with room to spare, the pack holds the whole body and is not truncated.
    const roomy = await planContext(graph, 'budget-target', { cwd: dir, maxTokens: 5000 });
    if ('error' in roomy) throw new Error(roomy.error);
    expect(roomy.truncated).toBe(false);
    expect(roomy.text.split('descriptiveVariable').length - 1).toBe(150);

    // A tight budget keeps the leading lines, stays under the cap, and says what it left out.
    const tight = await planContext(graph, 'budget-target', { cwd: dir, maxTokens: 100 });
    if ('error' in tight) throw new Error(tight.error);
    expect(tight.tokenEstimate).toBeLessThanOrEqual(100);
    expect(tight.truncated).toBe(true);
    expect(tight.text).toContain('omitted to fit the 100-token budget');

    // A budget too small for the headers is an explicit error, never an oversized pack.
    const impossible = await planContext(graph, 'budget-target', { cwd: dir, maxTokens: 10 });
    expect('error' in impossible && impossible.error).toMatch(/cannot fit in 10 tokens/);
  });
});

describe('A06: graph ranking', () => {
  const setEdges = (store: GraphStore, ids: string[], edges: Array<[string, string]>) =>
    store.setGraph({
      nodes: new Map(ids.map(id => [id, { id, type: 'FUNCTION', name: id, filePath: `${id}.ts`, startLine: 1, signature: `function ${id}()` }])),
      edges: edges.map(([sourceId, targetId]) => ({ sourceId, targetId, type: 'CALLS' })),
    } as any);

  test('reflects rewired edges even when the node and edge counts stay the same', () => {
    const ids = ['rank-aa', 'rank-bb', 'rank-cc'];
    const store = new GraphStore(':memory:');
    setEdges(store, ids, [['rank-aa', 'rank-bb']]);
    const first = computePageRank(store);
    // Control: the edge's target outranks the node nothing points at.
    expect(first.get('rank-bb')!).toBeGreaterThan(first.get('rank-cc')!);

    setEdges(store, ids, [['rank-aa', 'rank-cc']]);
    const second = computePageRank(store);
    expect(second.get('rank-cc')!).toBeGreaterThan(second.get('rank-bb')!);
  });

  test('the repo map outline also reflects rewired edges', () => {
    const ids = ['map-aa', 'map-bb', 'map-cc'];
    const store = new GraphStore(':memory:');
    setEdges(store, ids, [['map-aa', 'map-bb']]);
    const before = formatRepoMapOutline(store, 5000);
    // Control: the ranked file comes first.
    expect(before.indexOf('map-bb.ts')).toBeLessThan(before.indexOf('map-cc.ts'));

    setEdges(store, ids, [['map-aa', 'map-cc']]);
    const after = formatRepoMapOutline(store, 5000);
    expect(after.indexOf('map-cc.ts')).toBeLessThan(after.indexOf('map-bb.ts'));
  });

  test('keeps the total score at 1 when some nodes have no outgoing edges', () => {
    const ids = ['mass-aa', 'mass-bb', 'mass-cc'];
    const store = new GraphStore(':memory:');
    setEdges(store, ids, [['mass-aa', 'mass-bb']]);
    const scores = computePageRank(store);
    expect(scores.size).toBe(3);
    const total = [...scores.values()].reduce((sum, score) => sum + score, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('A07: lexical search', () => {
  test('keeps non-Latin words', () => {
    // Controls: Latin-script tokens come out unchanged, and the index ranks a matching document first.
    expect(tokenize('Error 0x8832 in Render-Loop failed, exit 25208'))
      .toEqual(['error', '0x8832', 'render', 'loop', 'failed', 'exit', '25208']);
    const other = { id: 'other', text: 'rendering pipeline frame budget' };
    expect(new Bm25Index([{ id: 'english', text: 'payment details summary' }, other]).search('payment details')[0]?.id).toBe('english');

    const query = 'भुगतान विवरण';
    expect(tokenize(query)).toEqual(['भुगतान', 'विवरण']);
    expect(new Bm25Index([{ id: 'hindi', text: `${query} का सारांश` }, other]).search(query)[0]?.id).toBe('hindi');
  });
});

describe('A08: log compression', () => {
  test('keeps the outlier when it collapses similar numeric lines', () => {
    // Control: identical lines still collapse.
    expect(compressText(Array.from({ length: 40 }, () => 'GET /health 200').join('\n'))).toContain('similar lines elided');

    const latencies = Array.from({ length: 40 }, (_, i) => `latency ${i === 23 ? 900 : 100 + (i % 7) * 10} ms`).join('\n');
    const out = compressText(latencies);
    expect(out).toContain('numbers ranged 100–900');
    expect(out.length).toBeLessThan(latencies.length);
  });
});
