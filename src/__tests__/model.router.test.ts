import { heuristicTier, localTier, decideTier, isConversational } from '../engine/model.router';

describe('model.router — heuristicTier', () => {
  it('short-circuits obvious chat/acks to lite (no LLM)', () => {
    for (const p of ['hi', 'hey', 'thanks!', 'ok', 'cool', 'yeah', 'got it']) {
      expect(heuristicTier(p)).toBe('lite');
    }
  });

  it('never routes a real task to lite just because it starts chatty', () => {
    expect(heuristicTier('ok now refactor the parser to support async')).not.toBe('lite');
    expect(heuristicTier('fix the failing tests in src/engine')).not.toBe('lite');
  });

  it('routes unmistakable coding work straight to heavy (no LLM)', () => {
    expect(heuristicTier('refactor the parser to support async')).toBe('heavy');
    expect(heuristicTier('implement retry logic in the fetch layer')).toBe('heavy');
    expect(heuristicTier('fix the bug in session loading')).toBe('heavy');
    expect(heuristicTier('debug why startup hangs')).toBe('heavy');
  });

  it('routes code fences and stack traces straight to heavy', () => {
    expect(heuristicTier('why does this fail?\n```js\nconst x = await y;\n```')).toBe('heavy');
    expect(heuristicTier('crash:\nTypeError: boom\n    at run (/app/src/main.ts:10:3)')).toBe('heavy');
  });

  it('leaves ambiguous prompts to the local classifier', () => {
    expect(heuristicTier('please rework the tokenizer to stream')).toBeNull();
    expect(heuristicTier('what does the governor do here')).toBeNull();
  });

  it('empty input is lite', () => {
    expect(heuristicTier('   ')).toBe('lite');
  });
});

// The deterministic local classifier that replaced the remote lite-model round-trip. The historical
// failures of BOTH prior implementations are pinned here (anti-oscillation):
//  A. remote classifier — a malformed-but-200 response crashed at choices[0], cooled the sole API
//     key, and cost ~4s/turn (fixed separately; the round-trip itself still cost ~1.17s/turn);
//  B. shape fallback (>140 chars → heavy) — misrouted short imperatives to the quick model.
describe('model.router — localTier (deterministic classifier)', () => {
  it("B's historical failure: short imperatives are work, not chat", () => {
    expect(localTier('please rework the tokenizer to stream')).toBe('heavy'); // 38 chars — B sent this to lite
    expect(localTier('update the readme')).toBe('heavy');
    expect(localTier('clean up the imports')).toBe('heavy');
  });

  it('repo-referring questions need code access → heavy', () => {
    expect(localTier('what does the governor do here')).toBe('heavy');
    expect(localTier('why is my branch behind')).toBe('heavy');
    expect(localTier('what does src/index.ts export')).toBe('heavy');
  });

  it('self-contained knowledge questions stay on the quick model', () => {
    expect(localTier('what is the difference between tcp and udp?')).toBe('lite');
    expect(localTier('explain big-O notation')).toBe('lite');
    expect(localTier('when was ipv6 standardized?')).toBe('lite');
    // "http/2" carries a path-like token, which reads as a work signal → heavy. Accepted: the
    // safe misroute direction (costs tokens, never quality).
    expect(localTier('when was http/2 standardized?')).toBe('heavy');
  });

  it('ambiguity defaults to heavy — misroutes cost tokens, never quality', () => {
    expect(localTier('stream test')).toBe('heavy');
    expect(localTier('the deployment situation')).toBe('heavy');
  });

  it('a long question is work even in question shape', () => {
    expect(localTier('how would you ' + 'x'.repeat(220) + '?')).toBe('heavy');
  });
});

describe('model.router — decideTier (fully local, never calls a model)', () => {
  const fakeLlm = () => ({ userModel: 'big/coding-model', liteModel: 'small/lite-model', chatCompletion: jest.fn() }) as any;

  it('a manual pin wins outright', async () => {
    const llm = fakeLlm();
    const d = await decideTier(llm, 'refactor everything', 'heavy');
    expect(d).toEqual({ tier: 'heavy', via: 'pinned' });
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });

  it('obvious chat resolves via heuristic', async () => {
    const llm = fakeLlm();
    const d = await decideTier(llm, 'hi', null);
    expect(d).toEqual({ tier: 'lite', via: 'heuristic' });
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });

  it('ambiguous prompts resolve via the local classifier — NO model call ever', async () => {
    const llm = fakeLlm();
    const d = await decideTier(llm, 'please rework the tokenizer to stream', null);
    expect(d).toEqual({ tier: 'heavy', via: 'local' });
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });

  it("A's historical failure cannot recur: routing never touches the provider path", async () => {
    // The old remote classifier's malformed response crashed routing and cooled the API key.
    // chatCompletion throwing must be irrelevant now — routing never invokes it.
    const llm = { userModel: 'big/coding-model', liteModel: 'small/lite-model', chatCompletion: jest.fn().mockRejectedValue(new Error('boom')) } as any;
    const d = await decideTier(llm, 'do something ambiguous and long enough to pass the heuristic', null);
    expect(d.tier).toBe('heavy'); // imperative "do something" → work
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });
});

describe('model.router — unified single-model short-circuit', () => {
  it('skips all classification when both slots resolve to the same model', async () => {
    const llm = { userModel: 'stepfun-ai/step-3.7-flash', liteModel: 'stepfun-ai/step-3.7-flash', chatCompletion: jest.fn() } as any;
    const d = await decideTier(llm, 'refactor the parser to support async', null); // heavy-verb prompt — still unified
    expect(d).toEqual({ tier: 'lite', via: 'unified' });
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });

  it('short-circuits when no lite model is configured at all', async () => {
    const llm = { userModel: 'stepfun-ai/step-3.7-flash', liteModel: undefined, chatCompletion: jest.fn() } as any;
    const d = await decideTier(llm, 'please rework the tokenizer to stream', null);
    expect(d).toEqual({ tier: 'lite', via: 'unified' });
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });

  it('a manual pin still wins over unified', async () => {
    const llm = { userModel: 'same/model', liteModel: 'same/model', chatCompletion: jest.fn() } as any;
    const d = await decideTier(llm, 'anything', 'heavy');
    expect(d).toEqual({ tier: 'heavy', via: 'pinned' });
  });
});

describe('model.router — isConversational (lite conversation lane gate)', () => {
  it('routes greetings, acks, and simple meta questions to the lite lane', () => {
    for (const p of ['hi', 'hey', 'thanks!', 'ok', 'cool', 'who are you', 'what can you do', 'how are you?']) {
      expect(isConversational(p)).toBe(true);
    }
  });

  it('NEVER routes real work to the lite lane (protects coding turns)', () => {
    for (const p of [
      'fix the bug in session loading',
      'refactor the parser',
      'what does this function do',        // needs to read code → full harness
      'read src/index.ts',                 // file path
      'look at @App.tsx',                  // @mention
      'summarize https://example.com',     // URL
      'why does this fail?\n```js\nx()\n```', // code context
      'ok now implement retry logic',      // starts chatty but is work
    ]) {
      expect(isConversational(p)).toBe(false);
    }
  });

  it('no model call for a locally obvious greeting (the P0-3 gate)', async () => {
    const llm = { userModel: 'big/coding-model', liteModel: 'small/lite-model', chatCompletion: jest.fn() } as any;
    expect(isConversational('hi')).toBe(true);
    const d = await decideTier(llm, 'hi', null);
    expect(d.via).toBe('heuristic');
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });
});
