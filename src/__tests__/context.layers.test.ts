import { ContextManager, injectRepoMap } from '../memory/context.manager';
import { LLMProvider, Message, ChatEvent } from '../core/llm.provider';
import { contentToText } from '../core/multimodal';

// The cheap passes never call the LLM; summarize uses this stub so we can assert it fired.
function summarizerLlm(marker = 'SUMMARY'): LLMProvider {
  return {
    async *chat(): AsyncGenerator<ChatEvent> {
      yield { type: 'token', text: marker } as ChatEvent;
    },
  };
}
const noopLlm: LLMProvider = { async *chat(): AsyncGenerator<ChatEvent> { /* nothing */ } };

function toolExchange(id: string, result: string): Message[] {
  return [
    { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}

describe('ContextManager — multimodal-safe summarization', () => {
  it('compact() flattens image content so a base64 data URL never reaches the summarizer', async () => {
    const captured: string[] = [];
    const llm: LLMProvider = {
      async *chat(messages: Message[]): AsyncGenerator<ChatEvent> {
        captured.push(JSON.stringify(messages));
        yield { type: 'token', text: 'S' } as ChatEvent;
      },
    };
    const bigB64 = 'A'.repeat(100000); // stand-in for a multi-MB image payload
    const messages: Message[] = [
      // An image turn that will age into the "older" (summarized) window.
      { role: 'user', content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${bigB64}` } },
      ] as any },
      ...Array.from({ length: 20 }).map((_, i) => ({ role: 'user', content: `m${i}` } as Message)),
    ];
    const out = await new ContextManager(llm, 1000).compact(messages);
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain(bigB64);   // the blob was stripped...
    expect(captured[0]).toContain('[image]');     // ...and replaced with a placeholder
    expect(out.some(m => m.role === 'system' && contentToText(m.content).includes('S'))).toBe(true);
  });
});

describe('ContextManager — layered passes (smart vs full)', () => {
  it('keeps RepoMap refreshes provider-valid after a tool screenshot observation', () => {
    const messages: Message[] = [
      { role: 'user', content: 'open calculator' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ComputerTool', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'assistant', content: 'Tool results received. I will inspect the fresh screenshot before choosing the next action.' },
      { role: 'user', content: [{ type: 'text', text: '[BrowserScreenshot] fresh screen' }] as any },
    ];

    const out = injectRepoMap(messages, '[RepoMap] current outline');

    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    expect(out[0].content).toBe('[RepoMap] current outline');
    expect(out.some((m, i) => m.role === 'system' && out[i - 1]?.role === 'tool')).toBe(false);
  });

  it('keeps RepoMap as a system message during an ordinary user turn', () => {
    const out = injectRepoMap([{ role: 'user', content: 'fix auth.ts' }], '[RepoMap] outline');
    expect(out.map(m => m.role)).toEqual(['system', 'user']);
  });

  it('full mode is a no-op: history passes through untouched', async () => {
    const cm = new ContextManager(noopLlm, 100); // tiny window, but full mode ignores it
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 10 }).flatMap((_, i) => toolExchange(`c${i}`, 'X'.repeat(2000))),
    ];
    const out = await cm.checkAndCompact(messages, 'full');
    expect(out).toBe(messages);
  });

  it('capToolResults truncates a single oversized tool result', async () => {
    const cm = new ContextManager(noopLlm);
    const huge = 'A'.repeat(40000);
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      ...toolExchange('c1', huge),
    ];
    const out = await cm.checkAndCompact(messages, 'smart');
    const toolMsg = out.find(m => m.role === 'tool')!;
    expect(toolMsg.content!.length).toBeLessThan(huge.length);
    expect(toolMsg.content).toContain('chars elided');
  });

  it('micro-compact under pressure clears OLD tool results but keeps the last 6 intact', async () => {
    // The padded user turn puts the estimate in the [50%, 70%) band of the 420-token window:
    // over the micro-compact gate, under the summarize threshold.
    const cm = new ContextManager(noopLlm, 420);
    const messages: Message[] = [
      { role: 'user', content: 'go ' + 'pad '.repeat(200) },
      ...Array.from({ length: 10 }).flatMap((_, i) => toolExchange(`c${i}`, `result-${i}`)),
    ];
    const out = await cm.checkAndCompact(messages, 'smart');
    const tools = out.filter(m => m.role === 'tool');
    expect(tools).toHaveLength(10); // none dropped — pairing preserved
    // First 4 cleared, last 6 kept.
    expect(tools.slice(0, 4).every(t => String(t.content).startsWith('[tool result cleared to save context'))).toBe(true);
    expect(tools.slice(-6).map(t => t.content)).toEqual(
      ['result-4', 'result-5', 'result-6', 'result-7', 'result-8', 'result-9'],
    );
  });

  it('the code eviction stub is resolvable but never promises verbatim restoration', async () => {
    // The stub is read by the MODEL, so an overclaim here is a correctness trap rather than a
    // wording nit: the agent edits files, so read foo.ts → evict → edit foo.ts → "re-read to
    // restore it verbatim" hands back different bytes while the model believes it recovered the
    // original. Only content-addressing could earn the stronger claim (see microCompact).
    // Driven through reactiveDrain, which runs micro-compact directly: going via checkAndCompact
    // would also fire snip/summarize at the pressure needed to trigger eviction, and those drop
    // messages, so the assertion would be reading whatever survived rather than the stubs.
    const cm = new ContextManager(noopLlm);
    const code = 'FILE src/auth.ts:\nexport function login() { return 1; }';
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      ...Array.from({ length: 10 }).flatMap((_, i) => toolExchange(`c${i}`, `${code} // ${i}`)),
    ];
    const { messages: out, changed } = cm.reactiveDrain(messages);
    expect(changed).toBe(true);
    const cleared = out.filter(m => m.role === 'tool').slice(0, 4).map(m => String(m.content));

    for (const stub of cleared) {
      // Resolvable: it still names the exact file, so the model re-reads real content instead of
      // reasoning over a truncated ghost.
      expect(stub).toContain('src/auth.ts');
      // ...and honest about what a re-read returns.
      expect(stub).toMatch(/current contents, which may have changed/i);
      expect(stub).not.toMatch(/verbatim|lossless|identical/i);
    }
  });

  it('micro-compact does NOT run at low pressure — old tool results stay intact', async () => {
    // Plenty of old tool results, but a huge window: destroying context the model may still
    // need (and churning history bytes → provider cache) buys nothing at 1% usage.
    const cm = new ContextManager(noopLlm); // default 128k window
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      ...Array.from({ length: 10 }).flatMap((_, i) => toolExchange(`c${i}`, `result-${i}`)),
    ];
    const out = await cm.checkAndCompact(messages, 'smart');
    const tools = out.filter(m => m.role === 'tool');
    expect(tools.map(t => t.content)).toEqual(Array.from({ length: 10 }).map((_, i) => `result-${i}`));
  });

  it('micro-compact never breaks tool pairing (no orphaned tool messages)', async () => {
    const cm = new ContextManager(noopLlm);
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      ...Array.from({ length: 8 }).flatMap((_, i) => toolExchange(`c${i}`, `r${i}`)),
    ];
    const out = await cm.checkAndCompact(messages, 'smart');
    // Every tool message is still immediately preceded by an assistant tool_calls turn.
    out.forEach((m, i) => {
      if (m.role === 'tool') {
        expect(out[i - 1].role).toBe('assistant');
        expect(out[i - 1].tool_calls).toBeDefined();
      }
    });
  });

  it('summarizes under token pressure after the cheap passes', async () => {
    // Tiny window forces the threshold; many sizeable text turns guarantee we stay over it.
    const cm = new ContextManager(summarizerLlm('SUMMARY'), 200);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 20 }).map((_, i) => ({ role: 'user', content: `message number ${i} ` + 'word '.repeat(50) } as Message)),
    ];
    const out = await cm.checkAndCompact(messages, 'smart');
    expect(out.some(m => m.role === 'system' && contentToText(m.content).includes('SUMMARY'))).toBe(true);
    expect(out.length).toBeLessThan(messages.length);
  });

  it('scales the summarize threshold to the configured context window', async () => {
    const bigText = 'word '.repeat(400); // ~400 tokens per message
    // >15 messages so compact() has "older" turns beyond the protected last-15 to summarize.
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 20 }).map((_, i) => ({ role: 'user', content: `m${i} ${bigText}` } as Message)),
    ];
    // Tiny window → over 70% → must summarize.
    const small = await new ContextManager(summarizerLlm('S'), 1000).checkAndCompact([...messages], 'smart');
    expect(small.some(m => m.role === 'system' && contentToText(m.content).includes('S'))).toBe(true);
    // Huge window → well under threshold → no summary, history intact.
    const big = await new ContextManager(summarizerLlm('S'), 1_000_000).checkAndCompact([...messages], 'smart');
    expect(big.some(m => m.role === 'system' && contentToText(m.content).includes('S'))).toBe(false);
  });

  it('treats a 0/invalid window as the safe 128k default', async () => {
    const cm = new ContextManager(noopLlm, 0);
    // A modest history must NOT trip compaction under the 128k default.
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 5 }).map((_, i) => ({ role: 'user', content: `m${i} ` + 'word '.repeat(100) } as Message)),
    ];
    const out = await cm.checkAndCompact(messages, 'smart');
    expect(out).toEqual(messages);
  });

  it('leaves a small conversation alone', async () => {
    const cm = new ContextManager(noopLlm);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
    ];
    const out = await cm.checkAndCompact(messages, 'smart');
    expect(out).toEqual(messages);
  });
});

describe('ContextManager — compaction hygiene (no transient accumulation)', () => {
  const durable = { role: 'system' as const, content: 'durable system rule' };
  const oldSummary = { role: 'system' as const, content: '[Previous Context Summary]\nOLD GOAL: refactor auth' };
  const oldRestore = { role: 'system' as const, content: '[Post-Compact Restoration — /x.ts — unchanged since last read]\nold file body' };
  const repoMap = { role: 'system' as const, content: '[RepoMap] outline...' };
  const turnCtx = { role: 'system' as const, content: '[TurnContext]\nstale memory' };
  const filler = (n: number): Message[] =>
    Array.from({ length: n }).map((_, i) => ({ role: 'user' as const, content: `m${i} ` + 'word '.repeat(30) } as Message));

  it('compact() drops stale transients, keeps durable system messages, and folds the prior summary into the new one', async () => {
    const captured: string[] = [];
    const llm: LLMProvider = {
      async *chat(messages: Message[]): AsyncGenerator<ChatEvent> {
        captured.push(JSON.stringify(messages));
        yield { type: 'token', text: 'NEW-SUMMARY' } as ChatEvent;
      },
    };
    const messages: Message[] = [durable, oldSummary, oldRestore, repoMap, turnCtx, ...filler(20)];
    const out = await new ContextManager(llm, 1000).compact(messages);

    // Durable system message survives; every stale transient is gone.
    expect(out).toContainEqual(durable);
    expect(out.map(m => contentToText(m.content)).join('\n')).not.toContain('stale memory');
    expect(out.map(m => contentToText(m.content)).join('\n')).not.toContain('old file body');
    expect(out.map(m => contentToText(m.content)).join('\n')).not.toContain('[RepoMap]');
    // Exactly ONE summary — the new one (accumulating a summary per compaction was context rot).
    const summaries = out.filter(m => m.role === 'system' && contentToText(m.content).startsWith('[Previous Context Summary]'));
    expect(summaries).toHaveLength(1);
    expect(contentToText(summaries[0].content)).toContain('NEW-SUMMARY');
    // ...but the OLD summary's content reached the summarizer, so its facts carry forward.
    expect(captured[0]).toContain('OLD GOAL: refactor auth');
  });

  it('reactiveCompact strips transients but keeps the newest prior summary (no new one is generated)', async () => {
    const newerSummary = { role: 'system' as const, content: '[Previous Context Summary]\nNEWER GOAL' };
    const messages: Message[] = [durable, oldSummary, oldRestore, repoMap, turnCtx, newerSummary, ...filler(10)];
    const out = await new ContextManager(noopLlm, 1000).reactiveCompact(messages, { status: 413, message: 'Request too large' });

    expect(out).toContainEqual(durable);
    const joined = out.map(m => contentToText(m.content)).join('\n');
    expect(joined).toContain('NEWER GOAL');            // newest summary preserved
    expect(joined).not.toContain('OLD GOAL');          // older duplicates dropped
    expect(joined).not.toContain('old file body');     // restorations dropped
    expect(joined).not.toContain('stale memory');      // turn context dropped
    expect(out.filter(m => m.role !== 'system')).toHaveLength(5); // hard tail cut intact
  });

  it('folds real reported usage into the pressure ratio (C4 — overhead calibration)', async () => {
    const cm = new ContextManager(summarizerLlm('OVERHEAD-SUMMARY'), 1000);
    const messages: Message[] = [...filler(20)];
    // Visible history alone is ~35% of the window → no summarization.
    const first = await cm.checkAndCompact([...messages], 'smart');
    expect(first.some(m => contentToText(m.content).includes('OVERHEAD-SUMMARY'))).toBe(false);
    // The provider reports the request was actually ~950 tokens (system prompt + schemas we can't
    // see). That overhead must count: the same history now sits near the window edge → summarize.
    cm.updateTokens(950);
    const second = await cm.checkAndCompact([...messages], 'smart');
    expect(second.some(m => contentToText(m.content).includes('OVERHEAD-SUMMARY'))).toBe(true);
  });
});
