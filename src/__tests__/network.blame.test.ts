import { LlmAdapter } from '../core/llm.adapter';
import { ApiKeyManager } from '../credits/api.key.manager';
import { heuristicTier } from '../engine/model.router';

// The "NIM is slow" saga, root-caused: local DNS/socket failures were billed to the API key
// (cooldowns, hang benches) and the router dumped substantial prompts on the quick lane whenever
// its classifier lost the 3s race. These tests pin the responsibility boundaries.
describe('local failures are never billed to the provider key', () => {
  it('classifies DNS and socket failures as local (status 0), API failures as the provider\'s', () => {
    const dns: any = new Error('getaddrinfo ENOTFOUND integrate.api.nvidia.com');
    dns.code = 'ENOTFOUND';
    expect(LlmAdapter.isLocalNetworkError(dns)).toBe(true);

    const nested: any = new Error('Connection error.');
    nested.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    expect(LlmAdapter.isLocalNetworkError(nested)).toBe(true);

    expect(LlmAdapter.isLocalNetworkError(Object.assign(new Error('Rate limited'), { status: 429 }))).toBe(false);
    expect(LlmAdapter.isLocalNetworkError(new Error('LLM stream timeout: model x sent no first token for 60s'))).toBe(false);
  });

  it('reportKeyResult(0) is neutral: no cooldown, no failure counters', () => {
    const mgr = new ApiKeyManager([{ keyStr: 'k1' }]);
    mgr.reportKeyResult(0, 0);
    const st = mgr.getStates()[0] as any;
    expect(st.total_fail ?? 0).toBe(0);
    expect(st.cooling ?? false).toBeFalsy();
  });

  it('a single-key pool never long-benches itself on a hang', () => {
    const mgr = new ApiKeyManager([{ keyStr: 'only-key' }]);
    const before = Date.now() / 1000;
    mgr.reportKeyHang(0);
    const s = (mgr as any).keyStates[0];
    expect(s.cooldown_until - before).toBeLessThanOrEqual(4); // capped at 3s, not 45s+
  });
});

describe('router treats computer operation as real work', () => {
  it('routes browser/desktop driving straight to heavy without a classifier call', () => {
    expect(heuristicTier('Use ComputerTool to take a screenshot of my desktop and describe it')).toBe('heavy');
    expect(heuristicTier('click on the submit button in the browser')).toBe('heavy');
    expect(heuristicTier('open the app called Notes and type into the first field')).toBe('heavy');
  });

  it('keeps genuine small talk on the quick lane', () => {
    expect(heuristicTier('thanks!')).toBe('lite');
    expect(heuristicTier('ok')).toBe('lite');
  });
});
