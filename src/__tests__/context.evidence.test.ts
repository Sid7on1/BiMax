import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ContextEvidence, UNKNOWN_VERSION, derivedEvidence, evidenceSpan, fileEvidence, fileVersion, versionOfText,
} from '../context/evidence';
import { archiveDirectory, archiveOutput, readArchivedOutput } from '../context/output.archive';
import { createContextArchiveTool } from '../tools/implementations/context-archive.tool';
import { createReadFileTool } from '../tools/implementations/file.tool';
import { ContextManager } from '../memory/context.manager';
import { VectorStore } from '../memory/vector.store';
import { recallForTurn } from '../memory/recall';
import { fileStateCache, hashFileText } from '../memory/file-state-cache';
import { CodeIndex } from '../memory/code.index';
import { openSqlite } from '../core/sqlite';
import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';

/**
 * Record 50 step 5: the evidence foundation. Exit conditions, as tests: every admitted item carries its source,
 * version and scope, and changing one of two inputs invalidates only what was built from it.
 */

const SHA256_VERSION = /^sha256:[0-9a-f]{64}$/;
const governor = { approveTaskExecution: async () => {} } as any;
const summarizer = { async *chat() { yield { type: 'token', text: '## Goal\nFixture summary.' }; } } as any;
const JAN_1 = new Date('2026-01-01T00:00:00Z');

const textOf = (result: unknown): string => (typeof result === 'string' ? result : JSON.stringify(result));

function source(sourceId: string, version: string) {
  return evidenceSpan({
    sourceId, sourceVersion: version, locator: { kind: 'file', path: sourceId.slice(5) },
    text: sourceId, scope: {}, derivedFrom: [], kind: 'source',
  });
}

function toolExchange(id: string, content: string): any[] {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content },
  ];
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

let temp: string;
let previousStateDir: string | undefined;
beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-context-evidence-'));
  previousStateDir = process.env.BIMAX_STATE_DIR;
  process.env.BIMAX_STATE_DIR = path.join(temp, 'state');
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.BIMAX_STATE_DIR;
  else process.env.BIMAX_STATE_DIR = previousStateDir;
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('dependency invalidation', () => {
  test('changing one of two inputs invalidates only what was built from it', () => {
    const store = new ContextEvidence();
    const a = store.admit(source('file:/a', 'sha256:a1'));
    const b = store.admit(source('file:/b', 'sha256:b1'));
    const fromA = store.admit(derivedEvidence('from-a', 'built from a', [a]));
    const fromB = store.admit(derivedEvidence('from-b', 'built from b', [b]));
    const fromBoth = store.admit(derivedEvidence('from-both', 'built from a and b', [a, b]));
    const fromDerived = store.admit(derivedEvidence('from-derived', 'built from both', [fromBoth]));

    // Control: reporting the version a span already has changes nothing.
    expect(store.sourceChanged('file:/b', 'sha256:b1')).toEqual([]);

    expect(store.sourceChanged('file:/a', 'sha256:a2').sort()).toEqual([a.id, fromA.id, fromBoth.id, fromDerived.id].sort());
    expect([b, fromB].map((span) => store.isStale(span.id))).toEqual([false, false]);
    expect(store.staleReason(fromDerived.id)).toContain(`span:${fromBoth.id}`);
  });

  test('an unknown version is never taken as current, not even when the current version is unknown too', () => {
    const store = new ContextEvidence();
    const unknown = store.admit(source('file:/legacy', UNKNOWN_VERSION));
    expect(store.sourceChanged('file:/legacy', 'sha256:whatever')).toEqual([unknown.id]);
    const unverifiable = store.admit(source('file:/unverifiable', UNKNOWN_VERSION));
    expect(store.sourceChanged('file:/unverifiable', UNKNOWN_VERSION)).toEqual([unverifiable.id]);
  });

  test('a gone source makes its spans stale', () => {
    const store = new ContextEvidence();
    const span = store.admit(source('file:/gone', 'sha256:x'));
    expect(store.sourceChanged('file:/gone', null)).toEqual([span.id]);
    expect(store.staleReason(span.id)).toContain('gone or unreadable');
  });

  test('file sources are re-checked from their bytes, even when size and mtime are put back', async () => {
    const changed = path.join(temp, 'changed.ts');
    const steady = path.join(temp, 'steady.ts');
    fs.writeFileSync(changed, 'export const value = "before";\n');
    fs.writeFileSync(steady, 'export const steady = true;\n');
    fs.utimesSync(changed, JAN_1, JAN_1);
    const store = new ContextEvidence();
    const changedSpan = store.admit(fileEvidence(changed, 'value', (await fileVersion(changed))!));
    const steadySpan = store.admit(fileEvidence(steady, 'steady', (await fileVersion(steady))!));
    expect(changedSpan.sourceVersion).toMatch(SHA256_VERSION);

    fs.writeFileSync(changed, 'export const value = "after!";\n');
    fs.utimesSync(changed, JAN_1, JAN_1);
    expect(await store.refreshFileSources()).toEqual([changedSpan.id]);
    expect(store.isStale(steadySpan.id)).toBe(false);
  });

  test('the store is bounded and counts what it evicts', () => {
    const store = new ContextEvidence(2);
    ['file:/1', 'file:/2', 'file:/3'].forEach((id) => store.admit(source(id, 'sha256:v')));
    expect(store.all()).toHaveLength(2);
    expect(store.evictedCount).toBe(1);
  });
});

describe('the context archive', () => {
  test('returns exactly what was archived, checks the hash, and says why when it cannot', () => {
    const text = 'line one\nline two\nline three\n';
    const first = archiveOutput(text)!;
    expect(first.handle).toMatch(/^archive:[0-9a-f]{32}$/);
    expect(archiveOutput(text)!.handle).toBe(first.handle);
    expect(readArchivedOutput(first.handle)).toEqual({ ok: true, text, sha256: first.sha256 });

    expect(readArchivedOutput('archive:not-a-handle')).toEqual({ ok: false, reason: 'malformed' });
    expect(readArchivedOutput(`archive:${'0'.repeat(32)}`)).toEqual({ ok: false, reason: 'missing' });
    fs.writeFileSync(path.join(archiveDirectory(), `${first.id}.txt`), 'tampered');
    expect(readArchivedOutput(first.handle)).toEqual({ ok: false, reason: 'corrupt' });
  });

  test('ContextArchiveTool reads a handle back inside a folder-scoped thread, where a path read is refused', async () => {
    const thread = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'thread-')));
    const archived = archiveOutput('first\nsecond\nthird')!;
    const previousRoot = process.env.BIMAX_THREAD_ROOT;
    process.env.BIMAX_THREAD_ROOT = thread;
    try {
      // Control: the archive lives outside the thread's folder, so reading it by path is refused.
      const byPath = await createReadFileTool(governor)
        .execute({ path: path.join(archiveDirectory(), `${archived.id}.txt`) }, { cwd: thread })
        .then(textOf, (error: Error) => error.message);
      expect(byPath).toMatch(/scoped to/);

      const tool = createContextArchiveTool(governor);
      expect(textOf(await tool.execute({ handle: archived.handle }, { cwd: thread }))).toBe('first\nsecond\nthird');
      expect(textOf(await tool.execute({ handle: archived.handle, startLine: 2, endLine: 2 }, { cwd: thread }))).toContain('second');
    } finally {
      if (previousRoot === undefined) delete process.env.BIMAX_THREAD_ROOT;
      else process.env.BIMAX_THREAD_ROOT = previousRoot;
    }
  });
});

describe('admitted evidence from the pipeline', () => {
  test('micro-compaction archives what it clears, and the stub carries a handle that reads it back', () => {
    const manager = new ContextManager(summarizer);
    const long = (i: number) => `result number ${i}\n${'log line '.repeat(80)}`;
    const messages = [
      { role: 'user', content: 'go' },
      ...Array.from({ length: 10 }).flatMap((_, i) => toolExchange(`c${i}`, i === 1 ? 'short' : long(i))),
    ];
    const { messages: out } = manager.reactiveDrain(messages as any);
    const tools = out.filter((m) => m.role === 'tool').map((m) => String(m.content));
    const stub = tools[0];
    expect(stub.startsWith('[tool result cleared to save context')).toBe(true);
    // The stub is shorter than what it replaces: clearing never grows the context.
    expect(stub.length).toBeLessThan(long(0).length);
    const handle = stub.match(/archive:[0-9a-f]{32}/)?.[0];
    expect(handle).toBeDefined();
    expect(readArchivedOutput(handle!)).toMatchObject({ ok: true, text: long(0) });
    // A result shorter than a stub with a handle keeps the short stub, and is not archived.
    expect(tools[1]).toBe('[tool result cleared to save context]');

    const span = manager.evidence.all().find((s) => s.rawHandle === handle)!;
    expect(span).toMatchObject({ sourceId: expect.stringMatching(/^tool-output:/), kind: 'observation', scope: {} });
    expect(span.sourceVersion).toMatch(SHA256_VERSION);
  });

  test('recall records each injected chunk with its memory and version, and the loop admits it', async () => {
    const store = new VectorStore(null as any, null as any, { storePath: path.join(temp, 'recall.json'), dedup: false });
    const content = Array.from({ length: 60 }, (_, i) => `Section ${i}: routine detail.\n`).join('\n')
      + '\nThe orchid launch passphrase is VIOLET-SENTINEL.\n';
    await store.storeDocument('orchid', content, ['note']);
    const question = 'What is the orchid launch passphrase?';

    const recalled = (await recallForTurn(store, question))!;
    expect(recalled.evidence.length).toBeGreaterThan(0);
    for (const span of recalled.evidence) {
      expect(span).toMatchObject({ sourceId: 'memory:orchid', sourceVersion: versionOfText(content), scope: { tags: ['note'] } });
      expect(span.locator).toMatchObject({ kind: 'memory', documentId: 'orchid' });
      expect(span.validFrom).toBeUndefined();
    }
    expect(recalled.evidence.some((span) => span.text.includes('VIOLET-SENTINEL'))).toBe(true);

    const manager = new ContextManager(summarizer);
    const loop = new AgentLoop(summarizer, new ToolRegistry(), undefined, undefined, manager, store, new Set<string>());
    (loop as any).messages = [{ role: 'user', content: question }];
    await (loop as any).injectRecall();
    const admitted = manager.evidence.all();
    const block = admitted.find((span) => span.sourceId === 'derived:recall-block')!;
    expect(block).toBeDefined();
    expect(block.derivedFrom.length).toBe(admitted.filter((span) => span.sourceId === 'memory:orchid').length);
  });

  test('a restored file is admitted at its verified version, and goes stale when its bytes change', async () => {
    const file = path.join(temp, 'restore.ts');
    const text = 'export const restored = "yes";\n';
    fs.writeFileSync(file, text);
    fs.utimesSync(file, JAN_1, JAN_1);
    const manager = new ContextManager(summarizer);
    const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
    try {
      fileStateCache.set(file, fs.statSync(file).mtimeMs, text, undefined, undefined, { fileHash: hashFileText(text) });
      await manager.compact(history as any);
      const span = manager.evidence.all().find((s) => s.sourceId === `file:${file}`)!;
      expect(span).toMatchObject({ sourceVersion: `sha256:${hashFileText(text)}`, kind: 'source' });

      const rewritten = 'export const restored = "no!";\n';
      expect(rewritten.length).toBe(text.length);
      fs.writeFileSync(file, rewritten);
      fs.utimesSync(file, JAN_1, JAN_1);
      const out = await manager.compact(history as any);
      expect(out.some((m) => String(m.content).includes('restored = "yes"'))).toBe(false);
      expect(manager.evidence.isStale(span.id)).toBe(true);
    } finally {
      fileStateCache.invalidate(file);
    }
  });
});

(sqliteHasFts5() ? describe : describe.skip)('code search admission (needs SQLite FTS5: npm run test:context)', () => {
  test('a hit is admitted only while its file still holds the bytes it was indexed from', async () => {
    const root = path.join(temp, 'admission');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/steady.ts'), 'export const steadysentinel = 1;\n');
    fs.writeFileSync(path.join(root, 'src/moving.ts'), 'export const marker = "beforesentinel";\n');
    const index = new CodeIndex(null, null, { root, storePath: path.join(temp, 'admission.db') });
    await index.sync();

    // Control: an unchanged file's hit carries its file, verified version, lines and scope.
    const [steady] = await index.search('steadysentinel', 3, undefined, 'lexical');
    const steadyText = fs.readFileSync(path.join(root, 'src/steady.ts'), 'utf8');
    expect(steady.evidence).toMatchObject({
      sourceId: `file:${path.join(root, 'src/steady.ts')}`,
      sourceVersion: versionOfText(steadyText),
      scope: { root },
      locator: { kind: 'file', startLine: steady.startLine, endLine: steady.endLine, partial: true },
    });

    // Changed on disk, not synced: the old text is not served as current, and the new text is found.
    fs.writeFileSync(path.join(root, 'src/moving.ts'), 'export const marker = "aftersentinel, changed while idle";\n');
    expect((await index.search('beforesentinel', 3, undefined, 'lexical')).some((h) => h.text.includes('beforesentinel'))).toBe(false);
    const [after] = await index.search('aftersentinel', 3, undefined, 'lexical');
    expect(after.evidence!.sourceVersion).toBe(versionOfText(fs.readFileSync(path.join(root, 'src/moving.ts'), 'utf8')));
  });
});
