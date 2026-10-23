import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Module from 'module';
import * as ts from 'typescript';
import { boundSummaryInput } from '../memory/context.manager';
import { ContinuationState } from '../context/continuation';
import type { Message } from '../core/llm.provider';

// Frozen working-tree sources, not HEAD. Relative dependencies resolve from their real source
// directory; only the tested classes/functions differ. No provider, real config or external I/O.
const BASE = path.resolve(__dirname, '../../docs/product-reset/evidence/2026-10-13-context-work/baseline');
function frozen<T>(relative: string): T {
  const filename = path.resolve(__dirname, '..', relative);
  const source = fs.readFileSync(path.join(BASE, 'src', relative), 'utf8');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (id: string) => require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id);
  (mod as any).paths = (Module as any)._nodeModulePaths(path.dirname(filename));
  (mod as any)._compile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
  return mod.exports as T;
}
const beforeSummary = frozen<{ boundSummaryInput: typeof boundSummaryInput }>('memory/context.manager.ts').boundSummaryInput;
const BeforeContinuation = frozen<{ ContinuationState: typeof ContinuationState }>('context/continuation.ts').ContinuationState;
const handle = (text: string): string => `archive:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
afterEach(() => jest.restoreAllMocks());

describe('summary serialization work', () => {
  test('does not serialize a plain message whose own text cannot fit the input budget', () => {
    const huge = { role: 'tool', tool_call_id: 'read', content: 'source line\n'.repeat(100_000) };
    const history = [{ role: 'user', content: 'original goal' }, huge, { role: 'assistant', content: 'latest exact state' }];
    const expected = beforeSummary(history, 96_000);
    const stringify = jest.spyOn(JSON, 'stringify');
    const actual = boundSummaryInput(history, 96_000);
    expect(actual).toBe(expected);
    expect(stringify.mock.calls.filter(([value]) => value === huge)).toHaveLength(0);
    expect(actual).toContain('original goal'); expect(actual).toContain('latest exact state');
  });

  test.each([2, 120, 500, 24_000, 96_000])('mixed-sized history keeps identical JSON at budget %i', (budget) => {
    const messages = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: ${'🦊"\n'.repeat(i % 9 ? 50 : 30_000)}` }));
    expect(boundSummaryInput(messages, budget)).toBe(beforeSummary(messages, budget));
  });

  test('toJSON may shrink a huge object and must still run exactly once', () => {
    let calls = 0;
    const message = { role: 'user', content: 'large'.repeat(1000), toJSON() { calls++; return { role: 'user', content: 'small transformed text' }; } };
    expect(boundSummaryInput([message], 500)).toBe('[{"role":"user","content":"small transformed text"}]');
    expect(calls).toBe(1);
  });

  test('an inherited toJSON hook can shrink an otherwise plain large message', () => {
    const message = { role: 'user', content: 'large'.repeat(1000) };
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value: function (this: unknown) {
      return this === message ? { role: 'user', content: 'prototype hook output' } : this;
    } });
    try { expect(boundSummaryInput([message], 500)).toBe('[{"role":"user","content":"prototype hook output"}]'); }
    finally {
      if (original) Object.defineProperty(Object.prototype, 'toJSON', original);
      else delete (Object.prototype as any).toJSON;
    }
  });

  test('proxy keys can hide oversized content, so native JSON behavior is retained', () => {
    const message = new Proxy({ role: 'user', content: 'large'.repeat(1000) }, { ownKeys: () => ['role'] });
    expect(boundSummaryInput([message], 500)).toBe(JSON.stringify([message]));
  });

  test('non-enumerable oversized content is not treated as serialized text', () => {
    const message = Object.defineProperty({ role: 'user' }, 'content', { value: 'large'.repeat(1000) });
    expect(boundSummaryInput([message as any], 500)).toBe('[{"role":"user"}]');
  });

  test('accessors are not read an extra time to decide whether to serialize', () => {
    let reads = 0;
    const message = { role: 'user', get content() { reads++; return reads === 1 ? 'small first value' : 'large'.repeat(1000); } };
    expect(boundSummaryInput([message], 500)).toBe('[{"role":"user","content":"small first value"}]');
    expect(reads).toBe(1);
  });

  test('other getters and serialization errors are not skipped behind a huge content field', () => {
    let reads = 0;
    const message = { role: 'user', content: 'large'.repeat(1000), get metadata() { reads++; return 1n; } };
    expect(() => boundSummaryInput([message], 500)).toThrow();
    expect(reads).toBe(1);
  });

  test('plain null-prototype messages and unusual Unicode keep exact end selection', () => {
    const message = Object.assign(Object.create(null), { role: 'tool', content: '\ud800\u0000'.repeat(1000) });
    const messages = [message, { role: 'user', content: 'keep this' }];
    expect(boundSummaryInput(messages, 500)).toBe(beforeSummary(messages, 500));
  });
});

function history(count = 500): Message[] {
  return [
    ...Array.from({ length: count }, (_, i): Message => ({ role: 'user', content: `Instruction ${i}: ${'specific constraint '.repeat(12)}` })),
    ...Array.from({ length: 8 }, (_, i): Message => ({ role: 'assistant', content: `Tests passed for revision ${i}.` })),
    ...Array.from({ length: 6 }, (_, i): Message[] => [
      { role: 'assistant', tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'BashTool', arguments: JSON.stringify({ command: `npm run test-${i}` }) } }] },
      { role: 'tool', tool_call_id: `call-${i}`, content: 'Exit code: 0\nAll tests passed.' },
    ]).flat(),
  ];
}

describe('continuation work and exact output', () => {
  test.each([Infinity, 700, 1200, 2000, 5000])('render at %s retains identical text and archive bytes', (budget) => {
    const before = new BeforeContinuation(), after = new ContinuationState();
    before.absorb(history(), handle); after.absorb(history(), handle);
    const expectedArchive: string[] = [], actualArchive: string[] = [];
    const expected = before.render((text) => { expectedArchive.push(text); return handle(text); }, budget);
    const actual = after.render((text) => { actualArchive.push(text); return handle(text); }, budget);
    expect(actual).toBe(expected); expect(actualArchive).toEqual(expectedArchive);
    expect(actual).toContain('Instruction 0:'); expect(after.counts()).toEqual(before.counts());
    expect(after.render(handle)).toBe(before.render(handle));
  });

  test('bounded render constructs the evicted archive list only once', () => {
    const state = new ContinuationState(); state.absorb(history(), handle);
    const map = jest.spyOn(Array.prototype, 'map');
    const archive = jest.fn(handle);
    const text = state.render(archive, 1200);
    const listConstructions = map.mock.instances.filter((receiver) => Array.isArray(receiver) && receiver.length > 100 && receiver.every((item: unknown) => typeof item === 'string'));
    map.mockRestore();
    expect(text).toContain('Instruction 0:'); expect(archive).toHaveBeenCalledTimes(1);
    expect(listConstructions).toHaveLength(1);
  });

  test('evicted character accounting never rescans the whole retained list per instruction', () => {
    const state = new ContinuationState(); const input = history(1000);
    const reduce = jest.spyOn(Array.prototype, 'reduce');
    state.absorb(input, handle);
    const rescans = reduce.mock.instances.filter((receiver) => Array.isArray(receiver) && receiver.length > 100 && receiver.every((item: unknown) => typeof item === 'string'));
    reduce.mockRestore();
    expect(rescans).toHaveLength(0);
    const control = new BeforeContinuation(); control.absorb(input, handle);
    expect(state.render(handle)).toBe(control.render(handle));
  });

  test('adopted grouped archives and later evictions preserve counts and reasons exactly', () => {
    const before = new BeforeContinuation(), after = new ContinuationState();
    const seed = new BeforeContinuation(); seed.absorb(history(80), handle); const rendered = seed.render(handle)!;
    expect(before.adopt(rendered)).toBe(true); expect(after.adopt(rendered)).toBe(true);
    for (let i = 0; i < 12; i++) {
      const input = history(50).map((m) => ({ ...m, content: typeof m.content === 'string' ? `batch${i}: ${m.content}` : m.content }));
      before.absorb(input, handle); after.absorb(input, handle);
      expect(after.render(handle, 1200)).toBe(before.render(handle, 1200));
      expect(after.counts()).toEqual(before.counts());
    }
  });

  test('adopted archive characters remain accounted at every retention boundary', () => {
    const before = new BeforeContinuation(), after = new ContinuationState();
    const seed = new BeforeContinuation(); seed.absorb(history(80), handle); const rendered = seed.render(handle)!;
    before.adopt(rendered); after.adopt(rendered);
    for (let i = 0; i < 1000; i++) {
      const input: Message[] = [{ role: 'user', content: `new instruction ${i}: ${'x'.repeat(100 + i % 97)}` }];
      before.absorb(input, handle); after.absorb(input, handle);
      expect(after.render(handle)).toBe(before.render(handle));
      expect(after.counts()).toEqual(before.counts());
    }
  });

  test('archive failure remains explicit and rendering never mutates live continuation', () => {
    const before = new BeforeContinuation(), after = new ContinuationState();
    before.absorb(history(300), handle); after.absorb(history(300), handle);
    expect(after.render(() => null, 1200)).toBe(before.render(() => null, 1200));
    expect(after.render(handle)).toBe(before.render(handle));
  });
});
