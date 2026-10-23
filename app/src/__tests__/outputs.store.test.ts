import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OutputsStore, outputInput } from '../main/outputs.store';
import { outputBinding, combineBindings } from '../main/outputs.service';
let root: string, store: OutputsStore;
const input = {
  key: 'report',
  title: 'Report',
  format: 'markdown' as const,
  content: '# Report\n\nUnicode α 👋\n',
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-output-test-'));
  store = new OutputsStore(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
test('retains exact bytes after engine/store restart, including original version', async () => {
  const first = await store.publish('A', 'run', input);
  const second = await store.publish('A', 'next', {
    ...input,
    content: 'Changed',
    outputId: first.record.id,
    baseVersion: first.version.id,
  });
  const restarted = new OutputsStore(root);
  expect((await restarted.read(first.record.id, first.version.id)).content).toBe(input.content);
  expect((await restarted.read(first.record.id)).version.id).toBe(second.version.id);
  expect((await restarted.list())[0].versions).toHaveLength(2);
});
test('duplicate publication is idempotent; conflicting replay and stale save are refused', async () => {
  const first = await store.publish('A', 'run', input);
  expect((await store.publish('A', 'run', input)).version.id).toBe(first.version.id);
  await expect(store.publish('A', 'run', { ...input, content: 'different' })).rejects.toThrow(
    'already published',
  );
  const edit = { ...input, outputId: first.record.id, baseVersion: first.version.id, content: 'changed' };
  await store.publish('A', 'run', edit);
  await expect(store.publish('A', 'run', { ...edit, content: 'stale' })).rejects.toThrow('Reload');
  expect((await store.list())[0].versions).toHaveLength(2);
});
test('ownership cannot be forged or moved to another conversation', async () => {
  const first = await store.publish('A', 'run', input);
  await expect(
    store.publish('B', 'run', { ...input, outputId: first.record.id, baseVersion: first.version.id }),
  ).rejects.toThrow('ownership');
  expect(await store.list('B')).toEqual([]);
  const binding = outputBinding(
    store,
    'B',
    () => 'run',
    () => {},
  );
  await expect(
    binding.execute(
      'OutputTool',
      { action: 'read', outputId: first.record.id },
      new AbortController().signal,
    ),
  ).rejects.toThrow('another conversation');
});
test('missing and altered bytes remain distinct and are never silently replaced', async () => {
  const first = await store.publish('A', 'run', input),
    file = path.join(root, first.record.id, `${first.version.id}.content`);
  await fs.writeFile(file, 'tampered');
  expect((await store.read(first.record.id)).state).toBe('changed');
  await fs.rm(file);
  expect((await store.read(first.record.id)).state).toBe('missing');
});
test('simultaneous stale writers cannot both commit; queue recovers after refusal', async () => {
  const first = await store.publish('A', 'run', input);
  const results = await Promise.allSettled(
    ['one', 'two'].map((content) =>
      store.publish('A', 'run', {
        ...input,
        content,
        outputId: first.record.id,
        baseVersion: first.version.id,
      }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await store.read(first.record.id)).record.versions).toHaveLength(2);
  expect((await store.publish('A', 'run2', input)).state).toBe('available');
});
test('reverting retains distinct immutable versions and exact history', async () => {
  let doc = await store.publish('A', 'run', input);
  for (const content of ['second', input.content])
    doc = await store.publish('A', 'run', {
      ...input,
      content,
      outputId: doc.record.id,
      baseVersion: doc.version.id,
    });
  expect(new Set(doc.record.versions.map((v) => v.id)).size).toBe(3);
});
test('rejects traversal, oversized bytes, malformed JSON and symlink content', async () => {
  expect(() => outputInput({ ...input, key: '../outside' })).toThrow();
  expect(() => outputInput({ ...input, content: 'α'.repeat(100_000) })).toThrow();
  expect(() => outputInput({ ...input, format: 'table', content: 'invalid' })).toThrow();
  const doc = await store.publish('A', 'run', input),
    file = path.join(root, doc.record.id, `${doc.version.id}.content`);
  await fs.rm(file);
  await fs.symlink('/etc/hosts', file);
  await expect(store.read(doc.record.id)).rejects.toThrow();
});
test('closed generation cannot publish; combined bindings keep distinct ownership', async () => {
  const binding = outputBinding(
    store,
    'A',
    () => 'run',
    () => {},
  );
  binding.close();
  await expect(
    binding.execute('OutputTool', { ...input, action: 'publish' }, new AbortController().signal),
  ).rejects.toThrow('stopped');
  expect(await store.list()).toEqual([]);
  expect(() => combineBindings(binding, binding)).toThrow('Duplicate');
});
test('publication admission is rechecked at the serialized commit boundary', async () => {
  let admitted = true;
  const pending = store.publish('A', 'run', input, () => admitted);
  admitted = false;
  await expect(pending).rejects.toThrow('stopped');
  expect(await store.list()).toEqual([]);
});
