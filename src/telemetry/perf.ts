// Lightweight, local perf instrumentation for /perf. Measures what the engine can measure honestly:
// cold-start (process load → engine ready), a per-turn phase timeline (routing, context assembly,
// provider request, first raw chunk, first visible token, complete), and memory. Pure in-process
// counters — no egress (see PRIVACY.md). Frame-level TUI metrics live in the Go front-end.
//
// The phase timeline separates PROVIDER wait (out of our control) from BIMAX overhead (ours), which
// is the only honest way to attribute the "trivial turn is sometimes 12s, sometimes 68s" symptom.
// Durations are monotonic (performance.now), so an NTP step mid-turn can't produce a negative delta.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TokenUsage, USAGE_UNAVAILABLE } from './measure';

const processStart = Date.now();
let readyAt = 0;

/** Monotonic milliseconds. Immune to wall-clock adjustments, unlike Date.now(). */
function mono(): number { return performance.now(); }

/** Called once when the engine is wired and ready to accept the first turn. */
export function markReady(): void {
  if (readyAt === 0) readyAt = Date.now();
}

export interface TurnPerf {
  firstTokenMs: number;   // turn start → first streamed token (0 if the turn produced none)
  totalMs: number;        // turn start → turn end
  /**
   * Streamed CHARACTERS this turn. Named for what it is: this field used to be called `tokens`,
   * which invited every reader and every readout to treat a character count as tokenizer-derived
   * usage. Real token counts only ever come from a provider usage report — see `providerRounds`.
   */
  streamedChars: number;
}

/**
 * One model round. The turn timeline's `providerReqMs`/`firstRawChunkMs` are first-wins by design —
 * they answer "when did this turn start talking?" — so on a multi-round tool-using turn they
 * describe the first round and nothing else. This ring records EVERY round, which is what F01 needs
 * to attribute a slow turn to the round that was actually slow.
 */
export interface ProviderRound {
  wallStart: number;
  /** Provider request → first meaningful payload for THIS round. */
  waitMs: number;
  model?: string;
  /** Provider-reported usage, or the unavailable sentinel. Never estimated from characters. */
  usage: TokenUsage;
}

export type TurnLane = 'lite' | 'full';

/**
 * One turn's phase timeline. All fields are ms elapsed from turn start (`input received`), or
 * undefined when the phase didn't happen. Secret-free by construction: it holds timings, a lane, and
 * a model id — never prompt or response text — so it is safe to persist.
 */
export interface TurnTimeline {
  lane: TurnLane;
  model?: string;
  wallStart: number;         // Date.now() at turn start (for the persisted record + /perf "last turn")
  routedMs?: number;         // routing/tier decision complete
  assembledMs?: number;      // context assembly complete (about to call the provider path)
  providerReqMs?: number;    // provider request left the engine
  firstRawChunkMs?: number;  // provider's first meaningful payload arrived (empty SSE preambles ignored)
  firstVisibleMs?: number;   // first visible token emitted to the user
  completeMs?: number;       // turn complete
}

/** Derived split of a completed timeline. */
export interface TurnBreakdown {
  overheadMs: number;      // Bimax work before the provider request (routing + context assembly)
  providerWaitMs: number;  // provider request → first meaningful payload (provider queue/compute)
  renderMs: number;        // first meaningful payload → first visible token (filter/emit latency)
  totalMs: number;
  lane: TurnLane;
  model?: string;
  wallStart: number;
}

const turns: TurnPerf[] = [];
const timelines: TurnBreakdown[] = [];
const rounds: ProviderRound[] = [];
const MAX_TURNS = 100;
const MAX_ROUNDS = 200;

let current: TurnTimeline | null = null;
let currentBase = 0; // monotonic base for the active turn

/** Begin a turn's phase timeline. Overwrites any half-open one (turns are serialized). */
export function beginTurnTimeline(lane: TurnLane, model?: string): void {
  current = { lane, model, wallStart: Date.now() };
  currentBase = mono();
}
function delta(): number { return current ? mono() - currentBase : 0; }
function setDurationOnce(key: 'routedMs' | 'assembledMs' | 'providerReqMs' | 'firstRawChunkMs' | 'firstVisibleMs' | 'completeMs'): void {
  if (current && current[key] === undefined) current[key] = delta();
}

export function markRouted(): void { setDurationOnce('routedMs'); }
export function markAssembled(): void { setDurationOnce('assembledMs'); }
/** Provider request left the engine. First streaming call of the turn wins (later tool rounds ignored). */
export function markProviderRequest(): void { setDurationOnce('providerReqMs'); }
/** Provider's first meaningful payload (content/reasoning/tool call/finish). First wins. */
export function markFirstRawChunk(): void { setDurationOnce('firstRawChunkMs'); }
/** First visible token shown to the user. First wins. */
export function markFirstVisibleToken(): void { setDurationOnce('firstVisibleMs'); }

/** Complete the current timeline, derive the breakdown, ring-buffer + persist it, and clear. */
export function endTurnTimeline(): TurnBreakdown | null {
  if (!current) return null;
  current.completeMs = delta();
  const b: TurnBreakdown = {
    overheadMs: Math.max(0, Math.round(current.providerReqMs ?? current.assembledMs ?? 0)),
    providerWaitMs:
      current.providerReqMs !== undefined && current.firstRawChunkMs !== undefined
        ? Math.max(0, Math.round(current.firstRawChunkMs - current.providerReqMs))
        : 0,
    renderMs:
      current.firstRawChunkMs !== undefined && current.firstVisibleMs !== undefined
        ? Math.max(0, Math.round(current.firstVisibleMs - current.firstRawChunkMs))
        : 0,
    totalMs: Math.round(current.completeMs),
    lane: current.lane,
    model: current.model,
    wallStart: current.wallStart,
  };
  timelines.push(b);
  if (timelines.length > MAX_TURNS) timelines.shift();
  persist(b);
  current = null;
  return b;
}

export function recordTurn(t: TurnPerf): void {
  turns.push(t);
  if (turns.length > MAX_TURNS) turns.shift();
}

/** Record one completed model round. Called per round, unlike the first-wins turn marks. */
export function recordProviderRound(r: { waitMs: number; model?: string; usage?: TokenUsage }): void {
  rounds.push({
    wallStart: Date.now(),
    waitMs: Math.max(0, Math.round(r.waitMs)),
    model: r.model,
    usage: r.usage ?? USAGE_UNAVAILABLE,
  });
  if (rounds.length > MAX_ROUNDS) rounds.shift();
}

/** Attach provider-reported usage to the most recent round. No-op when no round is recorded yet. */
export function attachRoundUsage(usage: TokenUsage): void {
  if (rounds.length === 0) return;
  rounds[rounds.length - 1].usage = usage;
}

/** Sum a usage field across rounds that actually reported it. Null when none did. */
function sumUsage(field: 'inputTokens' | 'outputTokens' | 'cachedInputTokens'): number | null {
  const reported = rounds.filter(r => r.usage.source === 'provider' && r.usage[field] !== null);
  if (reported.length === 0) return null;
  return reported.reduce((sum, r) => sum + (r.usage[field] as number), 0);
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
function p(values: number[], q: number): number {
  return percentile(values.slice().sort((a, b) => a - b), q);
}

export interface PerfSnapshot {
  coldStartMs: number;
  uptimeMs: number;
  rssMb: number;
  heapMb: number;
  turns: number;
  firstTokenP50: number;
  firstTokenP95: number;
  lastTurn: TurnPerf | null;
  // Phase-timeline aggregates (0 when no timeline recorded this run).
  overheadP50: number;
  overheadP95: number;
  providerWaitP50: number;
  providerWaitP95: number;
  renderP95: number;
  // Lite-lane (greeting) overhead — the gate that must hold p95 <= 250ms.
  liteOverheadP95: number;
  lastBreakdown: TurnBreakdown | null;
  // Per-round provider accounting. Token totals are null — not zero — when no round carried a
  // provider usage report, because "we were not told" and "it cost nothing" are different facts.
  providerRounds: number;
  roundWaitP50: number;
  roundWaitP95: number;
  roundsWithUsage: number;
  providerInputTokens: number | null;
  providerOutputTokens: number | null;
  providerCachedInputTokens: number | null;
}

export function perfSnapshot(): PerfSnapshot {
  const mem = process.memoryUsage();
  const ft = turns.map(t => t.firstTokenMs).filter(x => x > 0).sort((a, b) => a - b);
  const overhead = timelines.map(t => t.overheadMs);
  const provider = timelines.map(t => t.providerWaitMs);
  const render = timelines.map(t => t.renderMs);
  const liteOverhead = timelines.filter(t => t.lane === 'lite').map(t => t.overheadMs);
  return {
    coldStartMs: readyAt ? readyAt - processStart : 0,
    uptimeMs: Date.now() - processStart,
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    turns: turns.length,
    firstTokenP50: percentile(ft, 0.5),
    firstTokenP95: percentile(ft, 0.95),
    lastTurn: turns.length ? turns[turns.length - 1] : null,
    overheadP50: p(overhead, 0.5),
    overheadP95: p(overhead, 0.95),
    providerWaitP50: p(provider, 0.5),
    providerWaitP95: p(provider, 0.95),
    renderP95: p(render, 0.95),
    liteOverheadP95: p(liteOverhead, 0.95),
    lastBreakdown: timelines.length ? timelines[timelines.length - 1] : null,
    providerRounds: rounds.length,
    roundWaitP50: p(rounds.map(r => r.waitMs), 0.5),
    roundWaitP95: p(rounds.map(r => r.waitMs), 0.95),
    roundsWithUsage: rounds.filter(r => r.usage.source === 'provider').length,
    providerInputTokens: sumUsage('inputTokens'),
    providerOutputTokens: sumUsage('outputTokens'),
    providerCachedInputTokens: sumUsage('cachedInputTokens'),
  };
}

/** Every retained round, oldest first. */
export function providerRounds(): ProviderRound[] { return rounds.slice(); }

// --- Bounded, secret-free persistence so /perf still explains the previous turn after a restart. ---

const MAX_PERSIST = 200;
function perfFile(): string {
  const dir = process.env.BIMAX_PERF_DIR || path.join(os.homedir(), '.bimax');
  return path.join(dir, 'perf.jsonl');
}
function persistDisabled(): boolean {
  return process.env.BIMAX_PERF_PERSIST === '0' || process.env.BIMAX_PERF_PERSIST === 'false';
}

function persist(b: TurnBreakdown): void {
  if (persistDisabled()) return;
  try {
    const file = perfFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lines: string[] = [];
    try { lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean); } catch { /* first write */ }
    lines.push(JSON.stringify(b));
    if (lines.length > MAX_PERSIST) lines = lines.slice(lines.length - MAX_PERSIST);
    fs.writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch { /* perf persistence is best-effort; never break a turn over it */ }
}

/** Seed the in-memory ring from the persisted file so /perf can explain prior turns after a restart. */
export function loadPersistedTimelines(): void {
  if (persistDisabled()) return;
  try {
    const lines = fs.readFileSync(perfFile(), 'utf-8').split('\n').filter(Boolean);
    for (const line of lines.slice(-MAX_TURNS)) {
      try {
        const b = JSON.parse(line) as TurnBreakdown;
        if (b && typeof b.totalMs === 'number') timelines.push(b);
      } catch { /* skip a corrupt line */ }
    }
  } catch { /* no file yet */ }
}

/** Test seam. */
export function __resetPerf(): void {
  turns.length = 0;
  timelines.length = 0;
  rounds.length = 0;
  readyAt = 0;
  current = null;
}
