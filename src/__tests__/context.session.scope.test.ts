/**
 * Regression tests — deterministic context management (P0).
 *
 * 1. ContextManager is SESSION-scoped: the persona hands the same instance to every AgentLoop,
 *    so token calibration / warning latches / epochs survive across human turns, and it resets
 *    only on an explicit session boundary.
 * 2. FreeContextTool "tool_results" measurably reduces the live session context while preserving
 *    atomic assistant-tool-call/tool-result groupings.
 * 3. No sidecar/venv/listener work is reachable from foreground compaction: without the explicit
 *    BIMAX_ENABLE_HEADROOM=1 opt-in, the headroom proxy module is never invoked.
 * 4. Code survives compaction passes verbatim (Layer 0 is code-safe).
 * 5. File restoration re-stats files: externally modified files and partial reads are never
 *    falsely restored as current/complete content.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Spy on the headroom proxy module: foreground compaction must NEVER touch it without opt-in.
const ensureHeadroomProxySpy = jest.fn(async () => null);
jest.mock('../memory/headroomProxy', () => ({
  ensureHeadroomProxy: () => ensureHeadroomProxySpy(),
}));

import { ContextManager } from '../memory/context.manager';
import { AgentLoop } from '../core/agent.loop';
import { FileStateCache } from '../memory/file-state-cache';
import { releaseToolResults } from '../tools/implementations/free-context.tool';
import { Message } from '../core/llm.provider';

const fakeLlm: any = {
  chat: jest.fn(async function* () {
    yield { type: 'token', text: '## Goal\nsummary' };
  }),
};

describe('session-scoped ContextManager', () => {
  it('AgentLoop uses an injected (session-owned) ContextManager instead of a fresh one', () => {
    const shared = new ContextManager(fakeLlm, 128000);
    shared.updateTokens(50_000); // calibration state that must survive
    const loopA = new AgentLoop(fakeLlm, { getTool: () => undefined, getSchemas: () => [] } as any, undefined, 128000, shared);
    const loopB = new AgentLoop(fakeLlm, { getTool: () => undefined, getSchemas: () => [] } as any, undefined, 128000, shared);
    expect((loopA as any).contextManager).toBe(shared);
    expect((loopB as any).contextManager).toBe(shared);
    // Both turns see the SAME manager — epochs/warnings/calibration are not reset between turns.
    expect((loopA as any).contextManager.getEpoch()).toBe((loopB as any).contextManager.getEpoch());
  });

  it('persona keeps one ContextManager across turns and resets it only on an explicit boundary', () => {
    // Minimal harness around the persona helpers (avoid booting a full persona).
    const { AgentPersona } = require('../cli/personas/base.persona');
    const persona = Object.create(AgentPersona.prototype);
    persona.llmAdapter = fakeLlm;
    persona.sessionContextManager = null;
    persona.sessionContextWindow = undefined;

    const first = persona.sessionContext(128000);
    const second = persona.sessionContext(128000);
    expect(second).toBe(first); // survives turn #2

    persona.resetContextSession(); // /clear or session load
    const third = persona.sessionContext(128000);
    expect(third).not.toBe(first);

    // A changed context window is also a legitimate rebuild boundary.
    const fourth = persona.sessionContext(64000);
    expect(fourth).not.toBe(third);
  });
});

describe('FreeContextTool tool_results', () => {
  const toolMsg = (id: string, content: string): Message => ({ role: 'tool', tool_call_id: id, content } as any);
  const asst = (id: string): Message => ({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'T', arguments: '{}' } }] } as any);

  it('actually removes eligible historical tool-result bodies and reports measured savings', () => {
    const messages: Message[] = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 10; i++) {
      messages.push(asst(`c${i}`));
      messages.push(toolMsg(`c${i}`, `tool output ${i} ${'x'.repeat(400)}`));
    }
    const before = JSON.stringify(messages).length;
    const { cleared, tokensBefore, tokensAfter } = releaseToolResults(messages as any);
    expect(cleared).toBe(4); // 10 results, newest 6 kept
    expect(tokensAfter).toBeLessThan(tokensBefore);
    expect(JSON.stringify(messages).length).toBeLessThan(before);
    // Atomic groupings preserved: every tool message still exists with its tool_call_id,
    // directly after its assistant tool_calls message.
    for (let i = 0; i < 10; i++) {
      const idx = messages.findIndex(m => (m as any).tool_call_id === `c${i}`);
      expect(idx).toBeGreaterThan(0);
      expect((messages[idx - 1] as any).tool_calls?.[0]?.id).toBe(`c${i}`);
    }
    // The newest 6 are untouched.
    expect(String(messages[messages.length - 1].content)).toContain('tool output 9');
  });

  it('is honest when nothing is eligible', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }, asst('a'), toolMsg('a', 'small')];
    const { cleared } = releaseToolResults(messages as any);
    expect(cleared).toBe(0);
    expect(String(messages[2].content)).toBe('small');
  });
});

describe('foreground compaction is deterministic and in-process', () => {
  afterEach(() => {
    delete process.env.BIMAX_ENABLE_HEADROOM;
    ensureHeadroomProxySpy.mockClear();
  });

  const bigHistory = (): Message[] => {
    const msgs: Message[] = [{ role: 'user', content: 'task' }];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'assistant', tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'Bash', arguments: '{}' } }] } as any);
      msgs.push({ role: 'tool', tool_call_id: `t${i}`, content: `log line\n`.repeat(200) } as any);
    }
    return msgs;
  };

  it('never invokes the headroom proxy (sidecar/venv/listener) without the explicit opt-in', async () => {
    const cm = new ContextManager(fakeLlm, 2000); // tiny window → guaranteed pressure
    await cm.checkAndCompact(bigHistory(), 'smart');
    // Allow any microtask-queued dynamic import callbacks to run before asserting.
    await new Promise(r => setTimeout(r, 20));
    expect(ensureHeadroomProxySpy).not.toHaveBeenCalled();
  });

  it('code survives the compression layer verbatim', async () => {
    const code = [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'const x = add(1, 2);',
    ].join('\n');
    const msgs: Message[] = [
      { role: 'user', content: 'read the file' },
      { role: 'assistant', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'Read', arguments: '{}' } }] } as any,
      { role: 'tool', tool_call_id: 'r1', content: code } as any,
      // Enough log bulk to put the tiny window under pressure so Layer 0 actually runs.
      { role: 'assistant', tool_calls: [{ id: 'r2', type: 'function', function: { name: 'Bash', arguments: '{}' } }] } as any,
      { role: 'tool', tool_call_id: 'r2', content: 'build ok\n'.repeat(500) } as any,
      { role: 'user', content: 'now what' },
    ];
    const cm = new ContextManager(fakeLlm, 3000);
    const out = await cm.checkAndCompact(msgs, 'smart');
    const codeMsg = out.find(m => (m as any).tool_call_id === 'r1');
    // The code tool result is either present VERBATIM or explicitly stubbed by micro-compact —
    // never silently rewritten/compressed into a lossy variant.
    if (codeMsg && !String(codeMsg.content).startsWith('[tool result cleared to save context')) {
      expect(String(codeMsg.content)).toBe(code);
    }
  });
});

describe('post-compact file restoration is stat-verified and honestly labeled', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-restore-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('getRecentReads reports offset/limit and completeness', () => {
    const cache = new FileStateCache();
    cache.set('/a/full.ts', 111, 'full content');
    cache.set('/a/part.ts', 222, 'partial content', 10, 40);
    const reads = cache.getRecentReads();
    const full = reads.find(r => r.path === '/a/full.ts')!;
    const part = reads.find(r => r.path === '/a/part.ts')!;
    expect(full.complete).toBe(true);
    expect(part.complete).toBe(false);
    expect(part.offset).toBe(10);
    expect(part.limit).toBe(40);
    expect(full.mtime).toBe(111);
  });

  it('does not restore externally modified files, and labels partial reads as partial', async () => {
    const file = path.join(dir, 'live.ts');
    fs.writeFileSync(file, 'original');
    const mtime = fs.statSync(file).mtimeMs;

    const { fileStateCache } = require('../memory/file-state-cache');
    fileStateCache.set(file, mtime, 'original'); // complete read, current
    const stale = path.join(dir, 'stale.ts');
    fs.writeFileSync(stale, 'v1');
    fileStateCache.set(stale, fs.statSync(stale).mtimeMs, 'v1');
    // External edit AFTER the cached read:
    fs.writeFileSync(stale, 'v2 — changed externally');
    fs.utimesSync(stale, new Date(), new Date(Date.now() + 5000));
    const partial = path.join(dir, 'partial.ts');
    fs.writeFileSync(partial, 'line1\nline2\nline3\n');
    fileStateCache.set(partial, fs.statSync(partial).mtimeMs, 'line2', 2, 1); // offset/limit read

    // Enough history for compact() to have older messages to summarize.
    const msgs: Message[] = [];
    for (let i = 0; i < 25; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` } as any);

    const cm = new ContextManager(fakeLlm, 128000);
    const out = await cm.compact(msgs);
    const restorations = out.filter(m => typeof m.content === 'string' && (m.content as string).startsWith('[Post-Compact Restoration'));
    const text = restorations.map(m => String(m.content)).join('\n---\n');

    expect(text).toContain('live.ts');                     // unchanged file restored
    expect(text).toContain('complete file');
    expect(text).not.toContain('changed externally');      // stale content NEVER restored
    expect(text).not.toMatch(/stale\.ts/);
    if (text.includes('partial.ts')) {
      expect(text).toMatch(/PARTIAL read \(offset 2, limit 1\)/); // never claimed complete
    }
  });
});

describe('interactive loop is never power-delayed', () => {
  it('a multi-iteration tool loop completes without the 4s power backoff', async () => {
    jest.useRealTimers();
    // Force the (removed) advice to claim a 4s backoff — if any loop path consulted it, this
    // test would take >4s and trip the assertion below.
    jest.spyOn(require('../governor/power.monitor'), 'powerThrottleAdvice')
      .mockReturnValue({ level: 'soft', maxConcurrentSubagents: 1, loopBackoffMs: 4000, reason: 'test' });

    let round = 0;
    const llm: any = {
      chat: jest.fn(function* () {
        round++;
        if (round < 3) {
          yield { type: 'tool_call', id: `t${round}`, name: 'Noop', args: '{}' };
        } else {
          yield { type: 'token', text: 'done' };
        }
      }),
    };
    const tools: any = {
      getSchemas: () => [],
      getTool: (n: string) => (n === 'Noop' ? { isConcurrencySafe: true, execute: async () => 'ok' } : undefined),
    };
    const loop = new AgentLoop(llm, tools, undefined, 128000);
    const started = Date.now();
    const outputs: string[] = [];
    for await (const t of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 5 })) outputs.push(t);
    const elapsed = Date.now() - started;
    expect(round).toBeGreaterThanOrEqual(3); // the loop really iterated
    expect(elapsed).toBeLessThan(3000);      // 2 inter-iteration gaps × 4s would exceed this
  }, 15000);
});

describe('a >16k source file survives every compaction path verbatim', () => {
  // A genuinely code-dense >16k file read, with the bimax file-read header.
  const bigCode = 'FILE src/big.module.ts:\n' + Array.from({ length: 700 }, (_, i) =>
    `export function handler${i}(input: number): number {\n  const scaled = input * ${i};\n  return scaled + ${i};\n}`,
  ).join('\n');

  beforeAll(() => { expect(bigCode.length).toBeGreaterThan(16_000); });

  const codePair = (id: string): Message[] => ([
    { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'Read', arguments: '{}' } }] } as any,
    { role: 'tool', tool_call_id: id, content: bigCode } as any,
  ]);

  it('tool-result cap: never elides code, even far over the 16k cap', async () => {
    const cm = new ContextManager(fakeLlm, 128000);
    const msgs: Message[] = [{ role: 'user', content: 'read it' }, ...codePair('cap1')];
    const out = await cm.checkAndCompact(msgs, 'smart');
    const code = out.find(m => (m as any).tool_call_id === 'cap1');
    expect(String(code!.content)).toBe(bigCode);
    // A same-sized NON-code log dump IS capped — proving the code exemption is what protected it.
    const bigLog = Array.from({ length: 3000 }, (_, i) => `[12:00:${i % 60}] status heartbeat tick`).join('\n');
    const logOut = await cm.checkAndCompact([
      { role: 'user', content: 'run it' },
      { role: 'assistant', tool_calls: [{ id: 'log1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] } as any,
      { role: 'tool', tool_call_id: 'log1', content: bigLog } as any,
    ], 'smart');
    expect(String(logOut.find(m => (m as any).tool_call_id === 'log1')!.content)).toContain('chars elided');
  });

  it('proactive compaction under pressure: the recent code result stays verbatim', async () => {
    const cm = new ContextManager(fakeLlm, 8000); // small window → guaranteed pressure
    const msgs: Message[] = [{ role: 'user', content: 'task' }];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'assistant', tool_calls: [{ id: `b${i}`, type: 'function', function: { name: 'Bash', arguments: '{}' } }] } as any);
      msgs.push({ role: 'tool', tool_call_id: `b${i}`, content: 'log noise\n'.repeat(100) } as any);
    }
    msgs.push(...codePair('recent-code'));
    msgs.push({ role: 'user', content: 'now edit it' });
    const out = await cm.checkAndCompact(msgs, 'smart');
    const code = out.find(m => (m as any).tool_call_id === 'recent-code');
    expect(code).toBeDefined();
    expect(String(code!.content)).toBe(bigCode);
  });

  it('reactive compaction (API overflow): the recent code result stays verbatim', async () => {
    const cm = new ContextManager(fakeLlm, 128000);
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` } as any);
    msgs.push(...codePair('rc-code'));
    msgs.push({ role: 'user', content: 'continue' });
    const out = await cm.reactiveCompact(msgs, Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' }));
    const code = out.find(m => (m as any).tool_call_id === 'rc-code');
    expect(code).toBeDefined();
    expect(String(code!.content)).toBe(bigCode);
  });

  it('OLD code results are never silently truncated — evicted whole with a resolvable reference', async () => {
    const cm = new ContextManager(fakeLlm, 8000);
    const msgs: Message[] = [{ role: 'user', content: 'task' }, ...codePair('old-code')];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: 'assistant', tool_calls: [{ id: `n${i}`, type: 'function', function: { name: 'Bash', arguments: '{}' } }] } as any);
      msgs.push({ role: 'tool', tool_call_id: `n${i}`, content: 'noise\n'.repeat(120) } as any);
    }
    const out = await cm.checkAndCompact(msgs, 'smart');
    const code = out.find(m => (m as any).tool_call_id === 'old-code');
    expect(code).toBeDefined();
    const content = String(code!.content);
    // Either fully verbatim, or a WHOLE-result stub naming the exact file to re-read — never a
    // silently truncated middle ground.
    if (content !== bigCode) {
      expect(content).toContain('src/big.module.ts');
      expect(content).toContain('re-read');
      expect(content).not.toContain('chars elided');
    }
  });
});
