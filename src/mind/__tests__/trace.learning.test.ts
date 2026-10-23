import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attributeTrace, TraceSpan } from '../trace.attribution';
import { mineTraces, readTraceEpisodes } from '../trace.miner';
import { loadEpisode, listEpisodes } from '../episode.recorder';
import { PolicyArms } from '../policy.arms';
import { EpistemicLedger } from '../epistemic.ledger';

const nano = (ms: number) => String(BigInt(ms) * 1_000_000n);
function span(id: string, op: string, start: number, end: number, attributes = {}, parentSpanId?: string): TraceSpan {
  return { traceId: 'fixture', spanId: id, parentSpanId, name: op,
    startTimeUnixNano: nano(start), endTimeUnixNano: nano(end),
    status: 'ok', attributes: { 'gen_ai.operation.name': op, ...attributes } };
}
function fixture(): TraceSpan[] {
  return [span('agent', 'invoke_agent', 0, 100),
    span('edit', 'execute_tool', 1, 2, { 'bimax.claim.confidence': 0.8, 'bimax.claim.file': 'src/a.ts' }, 'agent'),
    span('check', 'execute_tool', 3, 4, { 'bimax.evidence.files': ['src/a.ts'], 'bimax.evidence.ok': false }, 'agent')];
}
const edited = (s: TraceSpan[]) => attributeTrace(s, 1000, 100).operations.find(o => o.spanId === 'edit')!;

describe('trace attribution: observations without invented blame', () => {
  it('labels only an explicit same-file postcondition and never causal blame', () => {
    const row = edited(fixture());
    expect(row.claim).toBe('refuted');
    expect(row.evidenceSpanId).toBe('check');
    expect(row.causalBlame).toBeNull();
    const green = fixture(); green[2].attributes['bimax.evidence.ok'] = true;
    expect(edited(green).claim).toBe('verified');
  });
  it.each(['file', 'scope', 'wrong-target', 'parent', 'cycle', 'time', 'sibling-agent', 'duplicate-edit', 'late'])('%s mutation must prevent settlement', kind => {
    const s = fixture();
    if (kind === 'file') delete s[1].attributes['bimax.claim.file'];
    if (kind === 'scope') delete s[2].attributes['bimax.evidence.files'];
    if (kind === 'wrong-target') s[2].attributes['bimax.evidence.files'] = ['other/a.ts'];
    if (kind === 'parent') s[1].parentSpanId = 'missing';
    if (kind === 'cycle') s[0].parentSpanId = 'edit';
    if (kind === 'time') s[2].startTimeUnixNano = nano(0);
    if (kind === 'sibling-agent') {
      s.push(span('other', 'invoke_agent', 0, 100)); s[2].parentSpanId = 'other';
    }
    if (kind === 'duplicate-edit') s.push(span('edit2', 'execute_tool', 2, 3, { 'bimax.claim.file': 'src/a.ts' }, 'agent'));
    if (kind === 'late') { s[0].endTimeUnixNano = nano(1000); s[2].endTimeUnixNano = nano(500); }
    expect(edited(s).claim).toBe('expired');
    expect(edited(s).attribution).toBe('unattributed');
    expect(edited(s).evidenceSpanId).toBeNull();
  });
  it('an error parent and successful tool execution never resolve correctness', () => {
    const s = fixture(); s[0].status = 'error'; s.pop();
    const ep = attributeTrace(s, 50, 100);
    expect(ep.operations[1].claim).toBe('open');
    expect(ep.operations[1].execution).toBe('ok');
    expect(ep.operations.every(o => o.causalBlame === null)).toBe(true);
  });
});

describe('disk-backed mining end states', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-trace-test-')); fs.mkdirSync(path.join(root, '.bimax/traces'), { recursive: true }); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('joins reversed cross-file trees, expires missing scope, preserves replay exclusion, and reruns idempotently', async () => {
    const s = fixture();
    fs.writeFileSync(path.join(root, '.bimax/traces/a.jsonl'), JSON.stringify(s[2]) + '\n' + JSON.stringify(s[1]) + '\n');
    fs.writeFileSync(path.join(root, '.bimax/traces/b.jsonl'), JSON.stringify(s[0]) + '\n' + JSON.stringify(s[0]) + '\nnot-json\n');
    const opts = { asOfMs: 1000, maxTraceSpans: s.length };
    const a = await mineTraces(root, opts);
    const episodes = []; for await (const ep of readTraceEpisodes(root)) episodes.push(ep);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].operations.find(o => o.spanId === 'edit')?.claim).toBe('refuted');
    expect(a.claims.resolved).toBe(1);
    expect(listEpisodes(root)).toEqual([]); // observational data is never admitted to replay/pruning
    expect(a.malformed).toBe(1); expect(a.duplicates).toBe(1);
    expect(loadEpisode(path.join(root, '.bimax/episodes/mined/trace-outcomes.jsonl'), root)).toBeNull();
    const b = await mineTraces(root, opts);
    expect(b.episodesSha256).toBe(a.episodesSha256);
    expect(b.claims).toEqual(a.claims);
    expect(b.holdout.effect).toBeNull();
  });
  it('does not let command scope refute an edit when red output names no file', () => {
    const ledger = new EpistemicLedger(root);
    ledger.openClaim('ts', 0.8, 'src/a.ts');
    expect(ledger.resolve(false, { command: 'tsc src/a.ts', output: 'compiler unavailable' })).toBe(0);
    expect(ledger.stats().open).toBe(1);
    expect(ledger.stats().unattributed).toBe(1);
    expect(ledger.resolve(false, { command: 'tsc src/a.ts', output: 'src/a.ts(1,2): error TS1000' })).toBe(1);
    ledger.saveNow();
  });
  it('quarantines entire conflicting or oversized traces', async () => {
    const s = fixture();
    fs.writeFileSync(path.join(root, '.bimax/traces/a.jsonl'), s.map(x => JSON.stringify(x)).join('\n'));
    const small = await mineTraces(root, { asOfMs: 1000, maxTraceSpans: s.length - 1 });
    expect(small.episodes).toBe(0); expect(small.quarantinedSpans).toBe(s.length);
    fs.appendFileSync(path.join(root, '.bimax/traces/a.jsonl'), '\n' + JSON.stringify({ ...s[1], status: 'error' }));
    const conflict = await mineTraces(root, { asOfMs: 1000, maxTraceSpans: s.length });
    expect(conflict.episodes).toBe(0); expect(conflict.quarantinedSpans).toBe(s.length);
  });
});

describe('holdout uncertainty', () => {
  const arms = new PolicyArms(os.tmpdir());
  const samples = [
    { shown: true, propensity: 0.5, reward: 1 },
    { shown: false, propensity: 0.5, reward: 0 },
  ];
  it('does not equate two opposite outcomes with a certain effect', () => {
    const small = arms.holdoutComparison(samples);
    expect(small.interval!.lo).toBeLessThan(0);
    expect(small.interval!.hi).toBe(1);
    const larger = arms.holdoutComparison(Array.from({ length: 10 }, () => samples).flat());
    expect(larger.interval!.lo).toBeGreaterThan(small.interval!.lo);
    expect(larger.lift).toBe(small.lift);
  });
  it('refuses missing, shadow, adaptive, and nonbinary comparisons', () => {
    expect(arms.holdoutComparison([]).interval).toBeNull();
    expect(arms.holdoutComparison(samples.slice(0, 1)).interval).toBeNull();
    for (const patch of [{ propensity: 0 }, { propensity: 0.9 }, { reward: 0.2 }]) {
      expect(arms.holdoutComparison([samples[0], { ...samples[1], ...patch }]).interval).toBeNull();
    }
  });
});
