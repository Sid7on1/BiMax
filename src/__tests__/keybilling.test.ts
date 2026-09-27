import { LlmAdapter } from '../core/llm.adapter';

// Anti-oscillation contract for key billing: once the provider has ANSWERED a request, the key
// did its job — client-side failures AFTER that point (malformed-but-200 response bodies, budget
// bookkeeping) must never re-bill the key as a server error. The historical failure: a response
// with no `choices` threw at `.choices[0]`, the catch reported 500, the sole key went on a 5s
// cooldown, and the NEXT call slept it out ("All keys cooling down… Sleeping 2.8s") — ~4s of
// self-inflicted first-token latency per turn, measured live against a 120ms mock provider.

function keyManagerSpy() {
  const reports: Array<{ idx: number; status: number }> = [];
  return {
    reports,
    manager: {
      acquire: async function (this: any) { return this.getNextKey(); },
      getNextKey: async () => ({ keyStr: 'k', model: 'mock', baseURL: 'http://127.0.0.1:9', provider: 'test', idx: 0, waitTimeSecs: 0 }),
      reportKeyResult: (idx: number, status: number) => { reports.push({ idx, status }); },
      reportKeyHang: () => {},
      reportKeyLatency: () => {},
      allKeysAuthDead: () => false,
      size: () => 1,
    } as any,
  };
}

function adapterWithResponse(response: any) {
  const { reports, manager } = keyManagerSpy();
  const adapter = new LlmAdapter(manager);
  const fakeClient = { chat: { completions: { create: async () => response } } };
  (adapter as any).createClient = () => fakeClient;
  return { adapter, reports };
}

describe('chatCompletion key billing', () => {
  it('a 200 response with NO choices returns empty content and bills the key 200, never 500', async () => {
    const { adapter, reports } = adapterWithResponse({ usage: undefined }); // no choices at all
    const out = await adapter.chatCompletion([{ role: 'user', content: 'route me' }], 'sys', { lite: true });
    expect(out).toBe('');
    expect(reports).toEqual([{ idx: 0, status: 200 }]);
  });

  it('an empty choices array is handled the same way', async () => {
    const { adapter, reports } = adapterWithResponse({ choices: [] });
    const out = await adapter.chatCompletion([{ role: 'user', content: 'x' }]);
    expect(out).toBe('');
    expect(reports.every(r => r.status === 200)).toBe(true);
  });

  it('a genuine request failure still bills the key with its real status', async () => {
    const { reports, manager } = keyManagerSpy();
    const adapter = new LlmAdapter(manager);
    const err: any = new Error('rate limited');
    err.status = 429;
    (adapter as any).createClient = () => ({ chat: { completions: { create: async () => { throw err; } } } });
    await expect(adapter.chatCompletion([{ role: 'user', content: 'x' }])).rejects.toThrow('rate limited');
    expect(reports).toEqual([{ idx: 0, status: 429 }]);
  });

  it('a normal response still returns its content and a single 200 report', async () => {
    const { adapter, reports } = adapterWithResponse({ choices: [{ message: { content: 'hello' } }] });
    const out = await adapter.chatCompletion([{ role: 'user', content: 'x' }]);
    expect(out).toBe('hello');
    expect(reports).toEqual([{ idx: 0, status: 200 }]);
  });
});
