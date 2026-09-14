import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ContextEvidence, UNKNOWN_VERSION, derivedEvidence, evidenceSpan, fileEvidence, fileVersion, versionOfBytes, versionOfText,
} from '../context/evidence';
import { MAX_ARCHIVED_BYTES, archiveDirectory, archiveOutput, readArchivedOutput } from '../context/output.archive';
import { createContextArchiveTool } from '../tools/implementations/context-archive.tool';
import { createReadFileTool } from '../tools/implementations/file.tool';
import { ContextManager } from '../memory/context.manager';
import { VectorStore } from '../memory/vector.store';
import { answeringExcerpt, recallForTurn } from '../memory/recall';
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

/** Rewrites a file with same-length text and puts the old modification time back. */
function rewriteKeepingSizeAndMtime(file: string, text: string): void {
  const before = fs.statSync(file);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, JAN_1, JAN_1);
  const after = fs.statSync(file);
  expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
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

  // Audit 51, U03: identity, eviction and late admission each let a dependant stay current after its input changed.
  test('the same words built from two different inputs are two spans, and each goes stale only with its own input', () => {
    const store = new ContextEvidence();
    const a = store.admit(source('file:/a', 'sha256:a1'));
    const b = store.admit(source('file:/b', 'sha256:b1'));
    const fromA = store.admit(derivedEvidence('summary', 'the same words', [a]));
    const fromB = store.admit(derivedEvidence('summary', 'the same words', [b]));
    expect(fromA.id).not.toBe(fromB.id);
    expect(store.sourceChanged('file:/b', 'sha256:b2').sort()).toEqual([b.id, fromB.id].sort());
    expect(store.isStale(fromA.id)).toBe(false);
  });

  test('evicting a span makes everything built from it stale, at the default bound too', () => {
    const small = new ContextEvidence(2);
    const a = small.admit(source('file:/a', 'sha256:a1'));
    const child = small.admit(derivedEvidence('child', 'built from a', [a]));
    small.admit(source('file:/b', 'sha256:b1'));
    expect(small.get(a.id)).toBeUndefined();
    expect(small.staleReason(child.id)).toContain('evicted');

    const store = new ContextEvidence();
    const parent = store.admit(source('file:/parent', 'sha256:p'));
    const kid = store.admit(derivedEvidence('kid', 'built from parent', [parent]));
    const grandkid = store.admit(derivedEvidence('grandkid', 'built from kid', [kid]));
    for (let i = 0; i < 1997; i++) store.admit(source(`file:/filler-${i}`, 'sha256:f'));
    // Control: at exactly the bound nothing is evicted and nothing is stale.
    expect([store.evictedCount, store.isStale(kid.id)]).toEqual([0, false]);
    store.admit(source('file:/one-more', 'sha256:f'));
    expect(store.evictedCount).toBe(1);
    expect([kid, grandkid].map((span) => store.isStale(span.id))).toEqual([true, true]);
  });

  test('a span built from a stale or unrecorded span is stale from the moment it is admitted', () => {
    const store = new ContextEvidence();
    const a = store.admit(source('file:/a', 'sha256:a1'));
    store.sourceChanged('file:/a', 'sha256:a2');
    const late = store.admit(derivedEvidence('late', 'built after a changed', [a]));
    expect(store.staleReason(late.id)).toContain(`span:${a.id}`);
    const orphan = store.admit(derivedEvidence('orphan', 'built from a span never admitted', [source('file:/never', 'sha256:n')]));
    expect(store.staleReason(orphan.id)).toContain('not in the record');
    // Control: built from a current span, a span is current.
    const b = store.admit(source('file:/b', 'sha256:b1'));
    expect(store.isStale(store.admit(derivedEvidence('fine', 'built from b', [b])).id)).toBe(false);
  });

  test('a file version is taken from its bytes, so two different invalid UTF-8 files never share one', async () => {
    const file = path.join(temp, 'bytes.bin');
    fs.writeFileSync(file, Buffer.from([0x61, 0xff]));
    const first = await fileVersion(file);
    fs.writeFileSync(file, Buffer.from([0x61, 0xfe]));
    expect(await fileVersion(file)).not.toBe(first);
    // Valid UTF-8: the byte version equals the text version, so versions taken either way still compare.
    fs.writeFileSync(file, 'plain text ✓\n');
    expect(await fileVersion(file)).toBe(versionOfText('plain text ✓\n'));
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

describe('archive safety and bounds (audit 51, U05, U06)', () => {
  test('a symlink in the archive is never followed, for a file or for the directory itself', () => {
    const outside = path.join(temp, 'outside.txt');
    const outsideText = 'text that lives outside the archive\n';
    fs.writeFileSync(outside, outsideText);
    const id = versionOfText(outsideText).slice('sha256:'.length, 'sha256:'.length + 32);
    archiveOutput('the archive directory exists');
    const link = path.join(archiveDirectory(), `${id}.txt`);
    fs.symlinkSync(outside, link);
    expect(readArchivedOutput(`archive:${id}`)).toEqual({ ok: false, reason: 'unsafe' });

    // Archiving that same text replaces the link with a real file, and the file outside is untouched.
    const archived = archiveOutput(outsideText)!;
    expect(archived.handle).toBe(`archive:${id}`);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readArchivedOutput(archived.handle)).toMatchObject({ ok: true, text: outsideText });
    expect(fs.readFileSync(outside, 'utf8')).toBe(outsideText);

    // The directory itself swapped for a link: nothing is written through it or read from it.
    const dir = archiveDirectory();
    const real = `${dir}-real`;
    const elsewhere = fs.mkdtempSync(path.join(temp, 'elsewhere-'));
    fs.renameSync(dir, real);
    fs.symlinkSync(elsewhere, dir);
    try {
      expect(archiveOutput('written through a link?')).toBeNull();
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(readArchivedOutput(archived.handle)).toEqual({ ok: false, reason: 'unsafe' });
    } finally {
      fs.unlinkSync(dir);
      fs.renameSync(real, dir);
    }
    // Control: with the real directory back, the handle reads again.
    expect(readArchivedOutput(archived.handle)).toMatchObject({ ok: true });
  });

  test('one result over the per-item cap is not archived, and a damaged copy is replaced rather than reused', () => {
    expect(archiveOutput('x'.repeat(MAX_ARCHIVED_BYTES + 1))).toBeNull();
    expect(archiveOutput('x'.repeat(1024))).not.toBeNull();
    const text = 'kept exactly as it was\n';
    const first = archiveOutput(text)!;
    fs.writeFileSync(path.join(archiveDirectory(), `${first.id}.txt`), 'damaged');
    expect(archiveOutput(text)!.handle).toBe(first.handle);
    expect(readArchivedOutput(first.handle)).toMatchObject({ ok: true, text });
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

  // Audit 51, U07: a cut passage was recorded whole, so the record claimed text the model never saw.
  test('recall records only the text it injects, and marks a cut chunk partial', async () => {
    const store = new VectorStore(null as any, null as any, { storePath: path.join(temp, 'recall-cut.json'), dedup: false });
    await store.storeDocument('orchid-cut', `${'orchid '.repeat(100)} HIDDEN-SENTINEL`, ['note']);
    const recalled = (await recallForTurn(store, 'orchid', { maxChars: 100 }))!;
    expect(recalled.text).not.toContain('HIDDEN-SENTINEL');
    expect(recalled.evidence.length).toBeGreaterThan(0);
    for (const span of recalled.evidence) {
      expect(span.text).not.toContain('HIDDEN-SENTINEL');
      expect(recalled.text).toContain(span.text);
    }
    expect(recalled.evidence.some((span) => span.locator.kind === 'memory' && span.locator.partial)).toBe(true);
  });

  // Record 50 step 6b: a chunk the budget could not hold was shown as its head, which cut an answer at its end (B5).
  test('a chunk the budget cannot hold is shown as the lines that answer, recorded as a partial span', async () => {
    const store = new VectorStore(null as any, null as any, { storePath: path.join(temp, 'recall-excerpt.json'), dedup: false });
    const note = Array.from({ length: 100 }, (_, i) => `Background section ${i}: ordinary operational details unrelated to the question.\n`).join('\n')
      + '\nThe orchid launch passphrase is VIOLET-SENTINEL.\n';
    await store.storeDocument('orchid-excerpt', note, ['note']);
    const recalled = (await recallForTurn(store, 'What is the orchid launch passphrase?', { maxChars: 600 }))!;
    expect(recalled.text).toContain('VIOLET-SENTINEL');
    expect(recalled.text.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(608);
    const span = recalled.evidence.find((s) => s.text.includes('VIOLET-SENTINEL'))!;
    expect(span.locator).toMatchObject({ kind: 'memory', documentId: 'orchid-excerpt', partial: true });
    expect(note).toContain(span.text);
    expect(recalled.text).toContain(span.text);
  });

  test('an excerpt centres on the rarest query terms, and without any it keeps the head', () => {
    const text = [
      ...Array.from({ length: 30 }, (_, i) => `The release notes for week ${i} list the usual fixes.`),
      'The deploy freeze starts on 2026-09-11 and lasts a week.',
      ...Array.from({ length: 30 }, (_, i) => `The release checklist item ${i} is routine.`),
    ].join('\n');
    // "release" is on 60 of the 61 lines and "freeze" on one, so the rarer term chooses the line.
    const excerpt = answeringExcerpt(text, 'When does the release freeze start?', 200);
    expect(excerpt).toContain('The deploy freeze starts on 2026-09-11');
    expect(excerpt.length).toBeLessThanOrEqual(200);
    // Widened by its neighbours while they fit, not the bare line.
    expect(excerpt.split('\n').length).toBeGreaterThan(1);
    expect(text).toContain(excerpt);
    // Control: a query sharing no term with the text keeps its head.
    expect(answeringExcerpt(text, 'zebra quokka', 120)).toBe(text.slice(0, 120).trimEnd());
  });

  // Audit 51, U11: compression ran before any archive, so the raw result was never saved.
  test('a tool result compaction compresses is archived raw first, and later clearing keeps that handle', async () => {
    const manager = new ContextManager(summarizer, 1000);
    const raw = Array.from({ length: 500 }, (_, i) => `sample ${i === 77 ? 900 : 100} ms`).join('\n');
    const messages = [
      { role: 'user', content: 'go' },
      ...toolExchange('c0', raw),
      ...Array.from({ length: 9 }).flatMap((_, i) => toolExchange(`c${i + 1}`, `filler result ${i}`)),
    ];
    const out = await manager.checkAndCompact(messages as any);
    const span = manager.evidence.all().find((s) => s.sourceVersion === versionOfText(raw));
    expect(span?.rawHandle).toMatch(/^archive:[0-9a-f]{32}$/);
    const back = readArchivedOutput(span!.rawHandle!);
    expect(back.ok && back.text.split('\n')[77]).toBe('sample 900 ms');
    // Whatever stands in the prompt for that result names the raw handle, not a handle of its compressed form.
    const first = out.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c0');
    if (first) expect(String(first.content)).toContain(span!.rawHandle!);
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

  const indexedMarker = async (name: string) => {
    const root = path.join(temp, name);
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'marker.ts');
    fs.writeFileSync(file, 'export const marker = "oldsentinel";\n');
    fs.utimesSync(file, JAN_1, JAN_1);
    const storePath = path.join(temp, `${name}.db`);
    expect((await new CodeIndex(null, null, { root, storePath }).sync()).indexed).toBe(1);
    const manifestPath = `${storePath}.manifest.json`;
    const editManifest = (edit: (entry: { m: number; s: number; c?: number; h?: string }) => void) => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      edit(manifest['marker.ts']);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    };
    return { root, file, storePath, editManifest };
  };
  const found = (hits: { text: string }[], word: string) => hits.some((hit) => hit.text.includes(word));

  // Audit 51, U01: an older manifest adopted the new file's hash, and old rows were then served at the new version.
  test('an index written before hashes existed re-indexes its files instead of adopting their new versions', async () => {
    const { root, file, storePath, editManifest } = await indexedMarker('legacy');
    editManifest((entry) => { delete entry.c; delete entry.h; });
    rewriteKeepingSizeAndMtime(file, 'export const marker = "newsentinel";\n');

    const index = new CodeIndex(null, null, { root, storePath });
    expect((await index.sync()).indexed).toBe(1);
    expect(found(await index.search('oldsentinel', 3, undefined, 'lexical'), 'oldsentinel')).toBe(false);
    const [hit] = await index.search('newsentinel', 3, undefined, 'lexical');
    expect(hit.evidence!.sourceVersion).toBe(versionOfBytes(fs.readFileSync(file)));
  });

  test('a manifest that already calls a file current while its rows are old heals at the next search', async () => {
    const { root, file, storePath, editManifest } = await indexedMarker('adopted');
    rewriteKeepingSizeAndMtime(file, 'export const marker = "newsentinel";\n');
    // What a build that adopted hashes left behind: the new file's hash and ctime over the old rows.
    editManifest((entry) => { entry.c = fs.statSync(file).ctimeMs; entry.h = versionOfBytes(fs.readFileSync(file)).slice('sha256:'.length); });

    const index = new CodeIndex(null, null, { root, storePath });
    // Control: sync alone believes the file is current, so only admission can find the old rows.
    expect((await index.sync()).indexed).toBe(0);
    expect(found(await index.search('oldsentinel', 3, undefined, 'lexical'), 'oldsentinel')).toBe(false);
    expect(found(await index.search('newsentinel', 3, undefined, 'lexical'), 'newsentinel')).toBe(true);
  });

  // Audit 51, U02: search took rows, a sync then moved the manifest, and the old rows were admitted at the new version.
  test('a sync between retrieval and admission cannot lend an old row the new version', async () => {
    const { root, file, storePath } = await indexedMarker('race');
    const index = new CodeIndex(null, null, { root, storePath });
    const store = (index as any).store;
    const retrieve = store.semanticSearch.bind(store);
    let raced = false;
    store.semanticSearch = async (...args: unknown[]) => {
      const docs = await retrieve(...args);
      if (!raced) {
        raced = true;
        fs.writeFileSync(file, 'export const marker = "newsentinel, rewritten during the search";\n');
        await index.sync();
      }
      return docs;
    };
    const hits = await index.search('oldsentinel', 3, undefined, 'lexical');
    expect(raced).toBe(true);
    expect(found(hits, 'oldsentinel')).toBe(false);
    const current = fs.readFileSync(file);
    for (const hit of hits) {
      expect(current.toString('utf8')).toContain(hit.evidence!.text);
      expect(hit.evidence!.sourceVersion).toBe(versionOfBytes(current));
    }
  });
});
