import {
  markReady, recordTurn, perfSnapshot, __resetPerf,
  beginTurnTimeline, markRouted, markAssembled, markProviderRequest,
  markFirstRawChunk, markFirstVisibleToken, endTurnTimeline, loadPersistedTimelines,
  recordProviderRound, attachRoundUsage, providerRounds,
} from '../telemetry/perf';
import { providerUsage, USAGE_UNAVAILABLE } from '../telemetry/measure';
import { renderPerf } from '../engine/commands/perf';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

afterEach(() => __resetPerf());

describe('perf tracker', () => {
  it('reports cold-start after markReady and aggregates turn latency', () => {
    __resetPerf();
    markReady();
    recordTurn({ firstTokenMs: 120, totalMs: 800, streamedChars: 500 });
    recordTurn({ firstTokenMs: 300, totalMs: 1500, streamedChars: 900 });
    const s = perfSnapshot();
    expect(s.coldStartMs).toBeGreaterThanOrEqual(0);
    expect(s.turns).toBe(2);
    expect(s.firstTokenP50).toBeGreaterThan(0);
    expect(s.firstTokenP95).toBeGreaterThanOrEqual(s.firstTokenP50);
    expect(s.lastTurn?.streamedChars).toBe(900);
    expect(s.rssMb).toBeGreaterThan(0);
  });

  it('markReady is idempotent (first ready wins)', () => {
    __resetPerf();
    markReady();
    const first = perfSnapshot().coldStartMs;
    markReady();
    expect(perfSnapshot().coldStartMs).toBe(first);
  });

  it('renderPerf surfaces the headline numbers', () => {
    __resetPerf();
    markReady();
    recordTurn({ firstTokenMs: 90, totalMs: 500, streamedChars: 200 });
    const out = renderPerf(perfSnapshot());
    expect(out).toMatch(/Cold start/);
    expect(out).toMatch(/first-token/i);
    expect(out).toMatch(/Memory/);
  });
});

describe('perf phase timeline', () => {
  it('marks phases, splits overhead vs provider wait vs render, and marks are first-wins', () => {
    __resetPerf();
    beginTurnTimeline('lite', 'stepfun-ai/step-3.7-flash');
    markRouted();
    markAssembled();
    markProviderRequest();
    markFirstRawChunk();
    markFirstVisibleToken();
    markFirstVisibleToken(); // idempotent — must not overwrite
    const b = endTurnTimeline();
    expect(b).not.toBeNull();
    expect(b!.lane).toBe('lite');
    expect(b!.overheadMs).toBeGreaterThanOrEqual(0);
    expect(b!.providerWaitMs).toBeGreaterThanOrEqual(0);
    expect(b!.renderMs).toBeGreaterThanOrEqual(0);
    const s = perfSnapshot();
    expect(s.lastBreakdown?.lane).toBe('lite');
    expect(s.liteOverheadP95).toBeGreaterThanOrEqual(0);
  });

  it('marks are safe no-ops when no turn is active', () => {
    __resetPerf();
    expect(() => { markProviderRequest(); markFirstRawChunk(); }).not.toThrow();
    expect(endTurnTimeline()).toBeNull();
  });

  it('persists a bounded, secret-free record that survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-perf-'));
    const prev = process.env.BIMAX_PERF_DIR;
    process.env.BIMAX_PERF_DIR = dir;
    try {
      __resetPerf();
      beginTurnTimeline('full', 'stepfun-ai/step-3.7-flash');
      markProviderRequest();
      markFirstRawChunk();
      endTurnTimeline();
      const raw = fs.readFileSync(path.join(dir, 'perf.jsonl'), 'utf-8');
      expect(raw).toContain('"lane":"full"');
      expect(raw).not.toMatch(/prompt|content|message/i); // secret-free
      // Simulate a restart: fresh in-memory state, then reload from disk.
      __resetPerf();
      expect(perfSnapshot().lastBreakdown).toBeNull();
      loadPersistedTimelines();
      expect(perfSnapshot().lastBreakdown?.lane).toBe('full');
    } finally {
      if (prev === undefined) delete process.env.BIMAX_PERF_DIR; else process.env.BIMAX_PERF_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * F01: the turn marks are first-wins, so on a tool-using turn they describe round 1 and nothing
 * else. Rounds are recorded individually, and token counts exist only when a provider reported them.
 */
describe('perf per-round provider accounting', () => {
  it('records every round, not just the first', () => {
    __resetPerf();
    beginTurnTimeline('full', 'm');
    markProviderRequest();
    markFirstRawChunk();
    recordProviderRound({ waitMs: 100, model: 'm' });
    recordProviderRound({ waitMs: 900, model: 'm' }); // the slow later round the turn marks ignore
    recordProviderRound({ waitMs: 200, model: 'm' });
    endTurnTimeline();

    const s = perfSnapshot();
    expect(s.providerRounds).toBe(3);
    expect(s.roundWaitP95).toBe(900);
    expect(providerRounds().map(r => r.waitMs)).toEqual([100, 900, 200]);
  });

  it('reports token totals as null — not zero — when no round carried provider usage', () => {
    __resetPerf();
    recordProviderRound({ waitMs: 50 });
    recordTurn({ firstTokenMs: 10, totalMs: 100, streamedChars: 4096 });

    const s = perfSnapshot();
    expect(s.roundsWithUsage).toBe(0);
    expect(s.providerInputTokens).toBeNull();
    expect(s.providerOutputTokens).toBeNull();
    expect(s.providerCachedInputTokens).toBeNull();
    // The streamed character count is present and stays a character count.
    expect(s.lastTurn?.streamedChars).toBe(4096);
    expect(providerRounds()[0].usage).toEqual(USAGE_UNAVAILABLE);
  });

  it('sums only the rounds a provider actually reported', () => {
    __resetPerf();
    recordProviderRound({ waitMs: 50 });
    attachRoundUsage(providerUsage({ inputTokens: 900, outputTokens: 120, cachedInputTokens: 800 }));
    recordProviderRound({ waitMs: 60 }); // this round's provider sent no usage chunk
    recordProviderRound({ waitMs: 70 });
    attachRoundUsage(providerUsage({ inputTokens: 100, outputTokens: 30 }));

    const s = perfSnapshot();
    expect(s.providerRounds).toBe(3);
    expect(s.roundsWithUsage).toBe(2);
    expect(s.providerInputTokens).toBe(1000);
    expect(s.providerOutputTokens).toBe(150);
    expect(s.providerCachedInputTokens).toBe(800); // only the round that reported a cached count
  });

  it('attachRoundUsage is a no-op when no round has been recorded', () => {
    __resetPerf();
    expect(() => attachRoundUsage(providerUsage({ inputTokens: 1, outputTokens: 1 }))).not.toThrow();
    expect(perfSnapshot().providerRounds).toBe(0);
    expect(perfSnapshot().providerInputTokens).toBeNull();
  });

  it('renders rounds and unavailable usage honestly in /perf', () => {
    __resetPerf();
    markReady();
    recordProviderRound({ waitMs: 250 });
    const out = renderPerf(perfSnapshot());
    expect(out).toMatch(/Provider rounds:\s+1/);
    expect(out).toMatch(/in unavailable/);
    expect(out).not.toMatch(/in 0 /);
  });
});
