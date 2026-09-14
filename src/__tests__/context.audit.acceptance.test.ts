import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { strict as assert } from 'assert';
import { CodeIndex } from '../memory/code.index';
import { VectorStore } from '../memory/vector.store';
import { recallForTurn, RECALL_PREFIX } from '../memory/recall';
import { Bm25Index, tokenize } from '../memory/bm25';
import { ContextManager } from '../memory/context.manager';
import { fileStateCache } from '../memory/file-state-cache';
import { GraphStore } from '../graph/graph.store';
import { planContext } from '../graph/context.planner';
import { computePageRank } from '../graph/pagerank';
import { compressText } from '../memory/headroom.compress';
import { openSqlite } from '../core/sqlite';

/**
 * Acceptance tests for the eight context defects reproduced in record 47 (A01–A08). This is step 1 of
 * record 50's build plan.
 *
 * Every check asserts the behaviour we WANT. Today each one fails, so each runs inside `knownDefect`,
 * which passes only while its check fails with an assertion. The day a fix lands, `knownDefect` turns
 * the test red on purpose: replace it with the plain check, and the test guards the fix from then on.
 *
 * A broken fixture must never read as "still broken". Setup and controls run outside `knownDefect`,
 * and any error inside it that is not an assertion still fails the test.
 *
 * A01's index test and A02 need SQLite FTS5. Node 22's `node:sqlite` on the dev Mac has none, so Jest
 * skips them by name; `npm run test:context` runs this file under Bun, where all of them run.
 */

async function knownDefect(check: () => unknown): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (error instanceof assert.AssertionError) return;
    throw error;
  }
  throw new Error('This defect now looks fixed: replace knownDefect with the plain check (record 50, step 3).');
}

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

let temp: string;
beforeAll(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-context-acceptance-')); });
afterAll(() => { fs.rmSync(temp, { recursive: true, force: true }); });

describe('knownDefect', () => {
  test('passes only while its check fails with an assertion', async () => {
    await expect(knownDefect(() => assert.equal(1, 2))).resolves.toBeUndefined();
    await expect(knownDefect(() => undefined)).rejects.toThrow(/looks fixed/);
    await expect(knownDefect(() => { throw new Error('fixture broke'); })).rejects.toThrow('fixture broke');
  });
});

describe('A01: a rewrite that keeps the size and modification time', () => {
  test('is never restored after compaction as the old bytes', async () => {
    const file = path.join(temp, 'restored.ts');
    const old = 'export const state = "oldsentinel";\n';
    const stamp = new Date('2026-01-01T00:00:00Z');
    fs.writeFileSync(file, old);
    fs.utimesSync(file, stamp, stamp);
    const before = fs.statSync(file);
    const restorations = async () => (await new ContextManager(summarizer).compact(history(20) as any))
      .map(m => String(m.content))
      .filter(content => content.startsWith('[Post-Compact Restoration'));
    try {
      fileStateCache.set(file, before.mtimeMs, old);
      // Control: while the bytes really are unchanged, restoring them as verified is correct.
      expect((await restorations()).some(c => c.includes('oldsentinel') && c.includes('verified unchanged'))).toBe(true);

      fs.writeFileSync(file, 'export const state = "newsentinel";\n');
      fs.utimesSync(file, stamp, stamp);
      const after = fs.statSync(file);
      expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);

      const afterRewrite = await restorations();
      await knownDefect(() => {
        assert.ok(!afterRewrite.some(c => c.includes('oldsentinel')), 'compaction restored bytes the file no longer has');
      });
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
    const stamp = new Date('2026-01-01T00:00:00Z');
    fs.writeFileSync(file, 'export const state = "oldsentinel";\n');
    fs.utimesSync(file, stamp, stamp);
    const before = fs.statSync(file);
    const index = new CodeIndex(null, null, { root: dir, storePath: path.join(temp, 'stale.db') });
    expect((await index.sync()).indexed).toBe(1);
    // Control: the index works, so an empty result later cannot pass for a fix.
    expect((await index.search('oldsentinel', 3, undefined, 'lexical')).some(h => h.text.includes('oldsentinel'))).toBe(true);

    fs.writeFileSync(file, 'export const state = "newsentinel";\n');
    fs.utimesSync(file, stamp, stamp);
    const after = fs.statSync(file);
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);

    await index.sync();
    const stale = await index.search('oldsentinel', 3, undefined, 'lexical');
    const current = await index.search('newsentinel', 3, undefined, 'lexical');
    await knownDefect(() => {
      assert.ok(!stale.some(h => h.text.includes('oldsentinel')), 'search returned text the file no longer has');
      assert.ok(current.some(h => h.text.includes('newsentinel')), 'the file\'s current text is not searchable');
    });
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
      const scoped = await index.search('needle', 1, 'wanted', 'lexical');
      await knownDefect(() => {
        assert.deepEqual(scoped.map(h => h.path), ['wanted/target.ts']);
      });
    });

    test('matches whole path segments, so `wanted` does not include `wantedExtra/`', async () => {
      // Control: the sibling file is in the index.
      expect((await index.search('boundarysentinel', 5, undefined, 'lexical')).some(h => h.path === 'wantedExtra/leak.ts')).toBe(true);
      const scoped = await index.search('boundarysentinel', 5, 'wanted', 'lexical');
      await knownDefect(() => {
        assert.ok(!scoped.some(h => h.path.startsWith('wantedExtra/')), `scope "wanted" returned ${scoped.map(h => h.path).join(', ')}`);
      });
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
    // Control: retrieval finds the right document; the loss happens after it.
    expect(recalled?.ids).toEqual(['long-note']);
    await knownDefect(() => {
      assert.ok(recalled!.text.includes('VIOLET-SENTINEL'), 'the answering passage was not injected');
    });
  });
});

describe('A04: recalled memory and compaction', () => {
  test('compaction does not keep a recall block as durable system text', async () => {
    const recall = { role: 'system', content: `${RECALL_PREFIX} — an obsolete fixture fact` };
    const out = await new ContextManager(summarizer).compact([recall, ...history(20)] as any);
    // Control: this history is long enough to compact.
    expect(out.some(m => String(m.content).startsWith('[Previous Context Summary]'))).toBe(true);
    await knownDefect(() => {
      assert.ok(!out.some(m => String(m.content).startsWith(RECALL_PREFIX)), 'a recall block survived compaction unchanged');
    });
  });

  // The other half of A04 lives in AgentLoop: `this.recalled` (src/core/agent.loop.ts) is never cleared, so once
  // compaction removes a recall block, asking the same question again is still suppressed. A test here could only
  // exercise a copy of that logic, not the loop. Step 3 of record 50 exposes the seam; this becomes real then.
  test.todo('A04: after compaction removes a recall block, the same question recalls again');
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

    const tight = await planContext(graph, 'budget-target', { cwd: dir, maxTokens: 100 });
    await knownDefect(() => {
      if ('error' in tight) {
        assert.match(tight.error, /budget|token/i);
        return;
      }
      assert.ok(tight.tokenEstimate <= 100, `a 100-token pack came back at ${tight.tokenEstimate} tokens`);
      assert.equal(tight.truncated, true);
    });
  });
});

describe('A06: graph ranking', () => {
  const setEdges = (store: GraphStore, ids: string[], edges: Array<[string, string]>) =>
    store.setGraph({
      nodes: new Map(ids.map(id => [id, { id, type: 'FUNCTION', name: id }])),
      edges: edges.map(([sourceId, targetId]) => ({ sourceId, targetId, type: 'CALLS' })),
    } as any);

  test('reflects rewired edges even when the node and edge counts stay the same', async () => {
    const ids = ['rank-aa', 'rank-bb', 'rank-cc'];
    const store = new GraphStore(':memory:');
    setEdges(store, ids, [['rank-aa', 'rank-bb']]);
    const first = computePageRank(store);
    // Control: the edge's target outranks the node nothing points at.
    expect(first.get('rank-bb')!).toBeGreaterThan(first.get('rank-cc')!);

    setEdges(store, ids, [['rank-aa', 'rank-cc']]);
    const second = computePageRank(store);
    await knownDefect(() => {
      assert.ok(second.get('rank-cc')! > second.get('rank-bb')!, 'the ranking still reflects the old edge');
    });
  });

  test('keeps the total score at 1 when some nodes have no outgoing edges', async () => {
    const ids = ['mass-aa', 'mass-bb', 'mass-cc'];
    const store = new GraphStore(':memory:');
    setEdges(store, ids, [['mass-aa', 'mass-bb']]);
    const scores = computePageRank(store);
    expect(scores.size).toBe(3);
    const total = [...scores.values()].reduce((sum, score) => sum + score, 0);
    await knownDefect(() => {
      assert.ok(Math.abs(total - 1) < 1e-6, `scores sum to ${total}`);
    });
  });
});

describe('A07: lexical search', () => {
  test('keeps non-Latin words', async () => {
    // Controls: Latin-script tokens must come out unchanged, and the index ranks a matching document first.
    expect(tokenize('Error 0x8832 in Render-Loop failed, exit 25208'))
      .toEqual(['error', '0x8832', 'render', 'loop', 'failed', 'exit', '25208']);
    const other = { id: 'other', text: 'rendering pipeline frame budget' };
    expect(new Bm25Index([{ id: 'english', text: 'payment details summary' }, other]).search('payment details')[0]?.id).toBe('english');

    const query = 'भुगतान विवरण';
    const tokens = tokenize(query);
    const hits = new Bm25Index([{ id: 'hindi', text: `${query} का सारांश` }, other]).search(query);
    await knownDefect(() => {
      assert.deepEqual(tokens, ['भुगतान', 'विवरण']);
      assert.equal(hits[0]?.id, 'hindi');
    });
  });
});

describe('A08: log compression', () => {
  test('keeps the outlier when it collapses similar numeric lines', async () => {
    // Control: identical lines still collapse.
    expect(compressText(Array.from({ length: 40 }, () => 'GET /health 200').join('\n'))).toContain('similar lines elided');

    const latencies = Array.from({ length: 40 }, (_, i) => `latency ${i === 23 ? 900 : 100 + (i % 7) * 10} ms`).join('\n');
    const out = compressText(latencies);
    await knownDefect(() => {
      assert.ok(out.includes('900'), 'the maximum observation was dropped');
      assert.ok(out.length < latencies.length, 'the log was not compressed at all');
    });
  });
});
