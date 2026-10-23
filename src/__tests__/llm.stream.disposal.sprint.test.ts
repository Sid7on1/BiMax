import { LlmAdapter } from '../core/llm.adapter';
import { ApiKeyManager } from '../credits/api.key.manager';
import { MemoryKeyUsageStore } from '../credits/key.usage.ledger';

test('ending consumption of a chat generator closes its unfinished provider stream', async () => {
  const keys = new ApiKeyManager([{ keyStr: 'fixture-key-abcdefghijkl', provider: 'nvidia' }], { store: new MemoryKeyUsageStore() });
  const adapter = new LlmAdapter(keys);
  adapter.applyConfig({ model: 'meta/llama-3.3-70b-instruct' });
  (adapter as any).implicitThink = false;
  const abort = jest.fn();
  const close = jest.fn(async () => ({ done: true as const, value: undefined }));
  const stream = {
    controller: { abort },
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: { choices: [{ delta: { content: 'first token' } }] } }), return: close }),
  };
  (adapter as any).createClient = () => ({ chat: { completions: { create: async () => stream } } });
  const chat = adapter.chat([{ role: 'user', content: 'hello' }], {});
  try {
    expect(await chat.next()).toEqual({ done: false, value: { type: 'token', text: 'first token' } });
  } finally {
    await chat.return(undefined);
  }
  expect(abort).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});
