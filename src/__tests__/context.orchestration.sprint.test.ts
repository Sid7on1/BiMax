import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encode } from 'gpt-tokenizer';
import { ContextManager, boundSummaryInput } from '../memory/context.manager';
import { readArchivedOutput } from '../context/output.archive';
import { planRequest } from '../context/request.budget';
import * as evidence from '../context/evidence';
import * as recall from '../memory/recall';
import { latestHumanRequest, retainRecentHistory } from '../context/history';
import { fileStateCache } from '../memory/file-state-cache';
import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import type { LLMProvider, Message } from '../core/llm.provider';

const ok: LLMProvider = { async *chat() { yield { type: 'token', text: '## Goal\nContinue accurately.' }; } };
const request = (): Message => ({ role: 'user', content: `Keep this entire instruction: ${'constraint '.repeat(100)}` });
const backlog = (): Message[] => [request(), ...Array.from({ length: 35 }, (_, i): Message => ({ role: 'assistant', content: `work ${i}` }))];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

afterEach(() => jest.restoreAllMocks());

describe('context request accounting', () => {
  test('reserves the actual allowed reply including escalation above 15%', () => {
    const plan = planRequest({ window: 32000, systemPrompt: '', tools: [], outputBudget: 16384 });
    expect(plan.outputReserve).toBe(16384);
    expect(plan.messageBudget + plan.outputReserve + plan.margin).toBe(32000);
  });

  test('a reply larger than the whole window is refused rather than silently reduced', () => {
    expect(planRequest({ window: 3000, systemPrompt: '', tools: [], outputBudget: 4096 }).messageBudget).toBeLessThan(0);
  });

  test('text-part mutation invalidates cached content tokens', () => {
    const cm = new ContextManager(ok);
    const part = { type: 'text' as const, text: 'short' };
    const m: Message = { role: 'user', content: [part] };
    cm.requestTokens([m]);
    part.text = 'a changed instruction '.repeat(1000);
    expect(cm.requestTokens([m])).toBe(encode(part.text).length + 4);
  });

  test('in-place tool argument and metadata changes invalidate cached call tokens', () => {
    const cm = new ContextManager(ok);
    const m: Message = { role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'Read', arguments: '{}' } }] };
    cm.requestTokens([m]);
    m.tool_calls![0].function.arguments = JSON.stringify({ value: 'changed '.repeat(1000) });
    m.tool_calls![0].extra_content = { signature: 'signed by provider' };
    expect(cm.requestTokens([m])).toBe(encode(JSON.stringify(m.tool_calls)).length + 4);
  });

  test.each(['name', 'id', 'order', 'length', 'nested metadata'])('cached tool accounting follows a changed %s', (change) => {
    const cm = new ContextManager(ok);
    const m: Message = { role: 'assistant', tool_calls: ['a', 'b'].map((id) => ({ id, type: 'function', function: { name: 'Read', arguments: '{}' }, extra_content: { provider: { signature: 'initial' } } })) };
    cm.requestTokens([m]);
    const first = m.tool_calls![0];
    if (change === 'name') first.function.name = 'DifferentFunctionName';
    if (change === 'id') first.id = 'a-longer-request-identifier';
    if (change === 'order') m.tool_calls!.reverse();
    if (change === 'length') m.tool_calls!.pop();
    if (change === 'nested metadata') (first.extra_content as any).provider.signature = 'changed nested signature '.repeat(100);
    expect(cm.requestTokens([m])).toBe(encode(JSON.stringify(m.tool_calls)).length + 4);
  });
});

describe('bounded summary serialization', () => {
  test.each([2, 20, 120, 160, 200, 500])('always returns valid JSON within %i characters', (limit) => {
    const text = boundSummaryInput([{ role: 'user', content: 'huge'.repeat(1000) }], limit);
    expect(text.length).toBeLessThanOrEqual(limit);
    expect(Array.isArray(JSON.parse(text))).toBe(true);
  });

  test('a huge oldest message does not starve useful newest messages', () => {
    const out = boundSummaryInput([{ role: 'user', content: 'huge'.repeat(1000) }, { role: 'assistant', content: 'LATEST exact state' }], 500);
    expect(out).toContain('LATEST exact state');
  });

  test('a huge newest message does not starve useful oldest messages', () => {
    const out = boundSummaryInput([{ role: 'user', content: 'ORIGINAL exact goal' }, { role: 'assistant', content: 'huge'.repeat(1000) }], 500);
    expect(out).toContain('ORIGINAL exact goal');
  });

  test('a payload at its exact limit is byte-identical, including escaped Unicode', () => {
    const messages = [{ role: 'user', content: 'Hindi: नमस्ते; emoji: 🦊; lone unit: \ud800; quoted: "yes"' }];
    const exact = JSON.stringify(messages);
    expect(boundSummaryInput(messages, exact.length)).toBe(exact);
  });

  test('each message is serialized once even when the backlog is oversized', () => {
    let calls = 0;
    const messages = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `item ${i}`, toJSON() { calls++; return { role: this.role, content: this.content }; } }));
    const out = boundSummaryInput(messages, 500);
    expect(JSON.parse(out)).toEqual(expect.any(Array));
    expect(calls).toBe(messages.length);
  });
});

describe('history retention', () => {
  test('an engine nudge is not the protected human request', () => {
    const human = request();
    const history: Message[] = [human, ...backlog().slice(1), { role: 'user', content: '[ContextManager] window warning' }];
    expect(latestHumanRequest(history)).toBe(human);
    expect(retainRecentHistory(history, 4)).toContain(human);
  });

  test.each(['missing', 'unknown', 'duplicate'])('a %s result group is never reattached to a call', (kind) => {
    const owner: Message = { role: 'assistant', tool_calls: ['a', 'b', 'c'].map((id) => ({ id, type: 'function', function: { name: 'Read', arguments: '{}' } })) };
    const ids = kind === 'missing' ? ['a', 'b'] : kind === 'unknown' ? ['a', 'b', 'unknown'] : ['a', 'b', 'b'];
    const history: Message[] = [request(), owner, ...ids.map((id): Message => ({ role: 'tool', tool_call_id: id, content: id }))];
    expect(retainRecentHistory(history, 1).some((m) => m.role === 'tool')).toBe(false);
  });

  test.each(['compact', 'reactiveCompact', 'snip', 'truncateContext'])('%s keeps the full active human request', async (method) => {
    const history = backlog();
    let out: Message[];
    if (method === 'truncateContext') out = (new AgentLoop(ok, new ToolRegistry()) as any).truncateContext(history);
    else {
      const cm = new ContextManager(ok, 1);
      const input = method === 'snip' ? [...history, ...Array.from({ length: 100 }, (): Message => ({ role: 'assistant', content: 'more work' }))] : history;
      out = await (cm as any)[method](input, ...(method === 'reactiveCompact' ? [new Error('maximum context length')] : []));
    }
    expect(out).toContain(history[0]);
    expect(out.find((m) => m === history[0])?.content).toBe(history[0].content);
  });

  test.each(['compact', 'reactiveCompact', 'truncateContext'])('%s preserves a complete parallel tool exchange', async (method) => {
    const user = request();
    const owner: Message = { role: 'assistant', tool_calls: Array.from({ length: 20 }, (_, i) => ({ id: `call-${i}`, type: 'function' as const, function: { name: 'Read', arguments: '{}' } })) };
    const results: Message[] = owner.tool_calls!.map((c) => ({ role: 'tool', tool_call_id: c.id, content: `result ${c.id}` }));
    const history = [user, ...backlog().slice(1), owner, ...results];
    const cm = new ContextManager(ok);
    const out: Message[] = method === 'truncateContext'
      ? (new AgentLoop(ok, new ToolRegistry()) as any).truncateContext(history)
      : await (cm as any)[method](history, ...(method === 'reactiveCompact' ? [new Error('maximum context length')] : []));
    expect(out).toContain(user);
    expect(out).toContain(owner);
    expect(out.filter((m) => m.role === 'tool')).toEqual(results);
  });
});

describe('summary transactions', () => {
  test('the summarizer sees the active request even while it stays protected in the main window', async () => {
    let seen: Message[] = [];
    const cm = new ContextManager({ async *chat(messages) { seen = messages; yield { type: 'token', text: 'Goal and work preserved.' }; } });
    const history = backlog(); const out = await cm.compact(history);
    expect(seen[1].content).toContain(JSON.stringify(history[0].content));
    expect(out).toContain(history[0]);
  });

  test('failure preserves the previous summary and archives the removed conversation', async () => {
    const cm = new ContextManager({ async *chat() { yield* []; throw new Error('offline'); } });
    const out = await cm.compact([{ role: 'system', content: '[Previous Context Summary]\nEstablished architecture decision.' }, ...backlog()]);
    const summary = out.find((m) => String(m.content).startsWith('[Previous Context Summary]'));
    expect(summary?.content).toContain('Established architecture decision.');
    const handle = String(summary?.content).match(/archive:[0-9a-f]{32}/)![0];
    expect(readArchivedOutput(handle)).toMatchObject({ ok: true, text: expect.stringContaining('work 0') });
  });

  test('a failed retry does not publish partial tokens from either attempt', async () => {
    let attempts = 0;
    const cm = new ContextManager({ async *chat() {
      yield { type: 'token', text: `PARTIAL-${++attempts}` };
      throw new Error('maximum context length');
    } });
    const out = await cm.compact(backlog());
    const summary = out.find((m) => String(m.content).startsWith('[Previous Context Summary]'));
    expect(attempts).toBe(2);
    expect(summary?.content).toContain('summary unavailable');
    expect(summary?.content).not.toContain('PARTIAL-');
  });

  test('the whole summary deadline applies even before its timer callback runs', async () => {
    const clock = jest.spyOn(Date, 'now'); let now = 1000; clock.mockImplementation(() => now);
    const cm = new ContextManager({ async *chat() { yield { type: 'token', text: 'OVERDUE SUMMARY' }; now += 180_001; } });
    const out = await cm.compact(backlog());
    const summary = out.find((m) => String(m.content).startsWith('[Previous Context Summary]'));
    expect(summary?.content).toContain('summary unavailable');
    expect(summary?.content).not.toContain('OVERDUE SUMMARY');
  });

  test('unbounded provider output cannot become an unbounded summary', async () => {
    const cm = new ContextManager({ async *chat() { yield { type: 'token', text: 'x'.repeat(32_001) }; } });
    const out = await cm.compact(backlog());
    const summary = out.find((m) => String(m.content).startsWith('[Previous Context Summary]'));
    expect(summary?.content).toContain('summary unavailable');
    expect(String(summary?.content).length).toBeLessThan(1000);
  });

  test('retry discards partial output from the failed attempt', async () => {
    let attempts = 0;
    const cm = new ContextManager({ async *chat() {
      if (++attempts === 1) { yield { type: 'token', text: 'FALSE-PARTIAL' }; throw new Error('maximum context length'); }
      yield { type: 'token', text: 'CLEAN-RETRY' };
    } });
    const out = await cm.compact(backlog());
    const summary = out.find((m) => String(m.content).startsWith('[Previous Context Summary]'));
    expect(attempts).toBe(2);
    expect(summary?.content).toContain('CLEAN-RETRY');
    expect(summary?.content).not.toContain('FALSE-PARTIAL');
  });

  test('a context error event triggers the same retry as a thrown overflow', async () => {
    let attempts = 0;
    const cm = new ContextManager({ async *chat() {
      if (++attempts === 1) { yield { type: 'error', message: 'rejected', kind: 'context', recoverable: true }; return; }
      yield { type: 'token', text: 'RECOVERED' };
    } });
    const out = await cm.compact(backlog());
    expect(attempts).toBe(2);
    expect(out.some((m) => String(m.content).includes('RECOVERED'))).toBe(true);
  });

  test.each(['empty', 'error', 'truncated'])('a %s stream does not publish a partial or empty summary', async (kind) => {
    const cm = new ContextManager({ async *chat() {
      if (kind !== 'empty') {
        yield { type: 'token', text: 'UNTRUSTED-PARTIAL' };
        if (kind === 'error') yield { type: 'error', message: 'provider failed', recoverable: false };
        else yield { type: 'truncated' };
      }
    } });
    const out = await cm.compact(backlog());
    const summary = out.find((m) => String(m.content).startsWith('[Previous Context Summary]'));
    expect(String(summary?.content)).toContain('summary unavailable');
    expect(String(summary?.content)).not.toContain('UNTRUSTED-PARTIAL');
    const handle = String(summary?.content).match(/archive:[0-9a-f]{32}/)?.[0];
    expect(handle).toBeDefined();
    expect(readArchivedOutput(handle!)).toMatchObject({ ok: true, text: expect.stringContaining('work 0') });
  });

  test('Stop settles a stalled summarizer without publishing later tokens', async () => {
    const started = deferred<void>(); const release = deferred<void>(); const stop = new AbortController();
    let received: AbortSignal | undefined;
    const cm = new ContextManager({ async *chat(_m, options) {
      received = options.signal; started.resolve(); await release.promise;
      yield { type: 'token', text: 'LATE SUMMARY' };
    } });
    const task = (cm as any).compact(backlog(), stop.signal);
    await started.promise; stop.abort(new Error('user stopped'));
    const outcome = await Promise.race([task.then(() => 'committed', (e: Error) => e.message), new Promise<string>((r) => setTimeout(() => r('stalled'), 100))]);
    release.resolve(); await task.catch(() => {});
    expect(outcome).toBe('user stopped');
    expect(received?.aborted).toBe(true);
    expect(cm.continuation.isEmpty()).toBe(true);
    expect(cm.evidence.all()).toHaveLength(0);
  });

  test('a superseded compaction cannot commit during asynchronous file restoration', async () => {
    const entered = deferred<void>(); const release = deferred<string | null>();
    jest.spyOn(fileStateCache, 'getRecentReads').mockReturnValue([{ path: '/missing-fixture', content: 'fixture', mtime: 0, complete: true, offset: 0, limit: -1 }] as any);
    jest.spyOn(evidence, 'fileVersion').mockImplementationOnce(async () => { entered.resolve(); return release.promise; }).mockResolvedValue(null);
    const cm = new ContextManager(ok);
    const first = backlog(); first[1].content = 'Tests passed for STALE TRANSACTION.';
    const pending = cm.compact(first); await entered.promise;
    const second = backlog(); second[1].content = 'Tests passed for CURRENT TRANSACTION.';
    await cm.compact(second); release.resolve(null);
    expect(await pending).toBe(first);
    const carried = cm.continuation.render(() => null) ?? '';
    expect(carried).toContain('CURRENT TRANSACTION');
    expect(carried).not.toContain('STALE TRANSACTION');
  });
});

describe('AgentLoop context cancellation', () => {
  test('an impossible fixed request spends no auxiliary summary or recall request', async () => {
    let calls = 0;
    const llm: LLMProvider = { async *chat() { calls++; yield { type: 'token', text: 'auxiliary summary' }; } };
    const search = jest.spyOn(recall, 'recallForTurn').mockResolvedValue(null);
    const loop = new AgentLoop(llm, new ToolRegistry(), undefined, 1000, undefined, {} as any);
    let text = '';
    for await (const part of loop.execute(backlog(), 'instructions', { maxIterations: 1 })) text += part;
    expect(text).toContain('nothing was sent'); expect(calls).toBe(0); expect(search).not.toHaveBeenCalled();
  });

  test('Stop during compaction ends the run without a main model request', async () => {
    const entered = deferred<void>(), release = deferred<void>(); const stop = new AbortController();
    let main = 0;
    const llm: LLMProvider & { maxTokens: number } = { maxTokens: 100, async *chat(_m, options) {
      if (options.system !== undefined) { main++; yield { type: 'token', text: 'SHOULD NOT SEND' }; }
      else { entered.resolve(); await release.promise; yield { type: 'token', text: 'late summary' }; }
    } };
    const loop = new AgentLoop(llm, new ToolRegistry(), undefined, 1000);
    const task = (async () => { let text = ''; for await (const part of loop.execute(backlog().map((m) => ({ ...m, content: `${m.content} ${'large context '.repeat(100)}` })), 'system', { signal: stop.signal })) text += part; return text; })();
    await entered.promise; stop.abort(new Error('stopped'));
    const result = await Promise.race([task, new Promise<string>((r) => setTimeout(() => r('STALLED'), 100))]);
    release.resolve(); await task;
    expect(result).toBe(''); expect(main).toBe(0);
  });

  test('Stop during recall releases the run and rejects late evidence; the query can retry', async () => {
    const entered = deferred<void>(), release = deferred<recall.RecalledMemory | null>(); const stop = new AbortController();
    const search = jest.spyOn(recall, 'recallForTurn').mockImplementationOnce(async () => { entered.resolve(); return release.promise; }).mockResolvedValue(null);
    let main = 0;
    const llm: LLMProvider = { async *chat() { main++; yield { type: 'token', text: 'answer' }; } };
    const cm = new ContextManager(llm); const recalled = new Set<string>();
    const loop = new AgentLoop(llm, new ToolRegistry(), undefined, undefined, cm, {} as any, recalled);
    const history: Message[] = [{ role: 'user', content: 'Which file controls the upload retry limit?' }];
    const task = (async () => { for await (const _part of loop.execute(history, 'system', { signal: stop.signal, contextMode: 'full' })) { /* consume */ } })();
    await entered.promise; stop.abort(new Error('stopped'));
    const outcome = await Promise.race([task.then(() => 'stopped'), new Promise<string>((r) => setTimeout(() => r('STALLED'), 100))]);
    release.resolve({ text: '[Recalled memory]\nLATE DATA', ids: [], evidence: [] }); await task; await Promise.resolve();
    expect(outcome).toBe('stopped'); expect(main).toBe(0); expect(cm.evidence.all()).toHaveLength(0);
    expect((loop as any).messages.some((m: Message) => String(m.content).includes('LATE DATA'))).toBe(false);
    for await (const _part of loop.execute(history, 'system', { contextMode: 'full', maxIterations: 1 })) { /* consume */ }
    expect(search).toHaveBeenCalledTimes(2); expect(main).toBe(1);
  });

  test('a clean abstention stays deduplicated across tool rounds', async () => {
    const search = jest.spyOn(recall, 'recallForTurn').mockResolvedValue(null);
    const loop = new AgentLoop(ok, new ToolRegistry(), undefined, undefined, undefined, {} as any);
    (loop as any).messages = [{ role: 'user', content: 'Which file controls the upload retry limit?' }];
    await (loop as any).injectRecall(); await (loop as any).injectRecall();
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('evidence truth', () => {
  test('derived text does not claim an unseen dependency is resident', () => {
    const cm = new ContextManager(ok);
    const source = evidence.fileEvidence('/fixture.ts', 'full source text absent from request', 'v1');
    const derived = evidence.derivedEvidence('summary', 'Shown summary only.', [source]);
    cm.evidence.admitAll([source, derived]);
    const ids = cm.residentEvidence([{ role: 'system', content: derived.text }]);
    expect(ids).toContain(derived.id); expect(ids).not.toContain(source.id);
  });

  test('an archive pointer alone does not claim that its raw text was shown', () => {
    const cm = new ContextManager(ok); const handle = `archive:${'a'.repeat(32)}`;
    const span = evidence.evidenceSpan({ sourceId: 'output:a', sourceVersion: 'v1', locator: { kind: 'tool-output', handle }, rawHandle: handle, text: 'actual result bytes', scope: {}, derivedFrom: [], kind: 'observation' });
    cm.evidence.admit(span);
    expect(cm.residentEvidence([{ role: 'tool', content: `cleared output ${handle}` }])).not.toContain(span.id);
    expect(cm.residentEvidence([{ role: 'tool', content: `actual result bytes\n${handle}` }])).toContain(span.id);
  });

  test('restoring a different range of the same file does not claim an absent range', () => {
    const cm = new ContextManager(ok);
    const shown = evidence.fileEvidence('/fixture.ts', 'VISIBLE RANGE', 'v1', { partial: true });
    const absent = evidence.fileEvidence('/fixture.ts', 'ABSENT RANGE', 'v1', { partial: true });
    cm.evidence.admitAll([shown, absent]);
    const ids = cm.residentEvidence([{ role: 'system', content: '[Post-Compact Restoration — /fixture.ts — PARTIAL]\nVISIBLE RANGE' }]);
    expect(ids).toContain(shown.id); expect(ids).not.toContain(absent.id);
  });

  test('cancelled freshness checks do not mark unchanged files stale', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-context-stop-'));
    try {
      const file = path.join(dir, 'file.ts'); fs.writeFileSync(file, 'unchanged');
      const ledger = new evidence.ContextEvidence();
      const span = evidence.fileEvidence(file, 'unchanged', evidence.versionOfText('unchanged')); ledger.admit(span);
      const stop = new AbortController(); stop.abort(new Error('check stopped'));
      await expect(evidence.fileVersion(file, stop.signal)).rejects.toThrow('check stopped');
      await expect(ledger.refreshFileSources(stop.signal)).rejects.toThrow('check stopped');
      expect(ledger.isStale(span.id)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
