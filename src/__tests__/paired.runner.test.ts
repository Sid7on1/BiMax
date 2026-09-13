import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runPaired, percentile, writeReport, processTreeRssBytes, summarize,
  PairedConfig, Arm, Grader, ArmOutcome,
} from '../eval/paired.runner';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A run "produces" a result by putting it in this map; the grader reads it back. Nothing trusts an arm. */
type Fixture = { produced: string | null };

const config = (over: Partial<PairedConfig> = {}): PairedConfig => ({
  name: 'harness-selfcheck',
  pairs: 8,
  qualityRegressionMargin: 0.1,
  minImprovementFraction: 0.05,
  minPairedSuccessFraction: 0.5,
  ...over,
});

/** Grades the END STATE. An arm's own `claimedSuccess` is never consulted. */
const gradeEndState: Grader<Fixture> = (outcome: ArmOutcome<Fixture>) => {
  const produced = outcome.value?.produced ?? null;
  return produced === 'expected-output'
    ? { accepted: true, reason: 'end state matched the expected output' }
    : { accepted: false, reason: `end state was ${produced === null ? 'absent' : 'wrong'}` };
};

const workingArm = (ms: number): Arm<Fixture> => async () => {
  await sleep(ms);
  return { claimedSuccess: true, value: { produced: 'expected-output' } };
};

describe('paired runner — statistics', () => {
  it('nearest-rank percentiles return observed values', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
  });

  it('runs both arms in every pair and alternates which goes first', async () => {
    const report = await runPaired({ config: config({ pairs: 4 }), baseline: workingArm(1), candidate: workingArm(1), grade: gradeEndState });
    expect(report.runs.length).toBe(8);
    const firstOfEachPair = [0, 1, 2, 3].map(p => report.runs.find(r => r.pairIndex === p && r.positionInPair === 0)!.arm);
    expect(firstOfEachPair).toEqual(['baseline', 'candidate', 'baseline', 'candidate']);
    expect(report.baseline.accepted).toBe(4);
    expect(report.candidate.accepted).toBe(4);
    expect(report.comparison.pairedSuccessN).toBe(4);
  });

  it('records the predeclared config, its hash, and a manifest that identifies a dirty checkout', async () => {
    const report = await runPaired({ config: config({ pairs: 2 }), baseline: workingArm(1), candidate: workingArm(1), grade: gradeEndState });
    expect(report.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.percentileMethod).toBe('nearest-rank');
    // A commit hash alone does not identify a modified checkout, so the diff digest travels with it.
    expect(report.manifest.gitHead === null || /^[0-9a-f]{40}$/.test(report.manifest.gitHead)).toBe(true);
    const dirty = report.manifest.dirtyState;
    if (dirty !== null) {
      expect(dirty.method).toBe('status+content-hash');
      expect(dirty.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(dirty.changedPaths).toBeGreaterThanOrEqual(0);
    }
    expect(report.manifest.cpuCount).toBeGreaterThan(0);
  });
});

describe('paired runner — verdicts', () => {
  it('calls two identical implementations no-change', async () => {
    const report = await runPaired({ config: config(), baseline: workingArm(4), candidate: workingArm(4), grade: gradeEndState });
    expect(report.comparison.verdict).toBe('no-change');
  });

  it('MUTANT known delay: 30 ms of extra work in the candidate is reported as a regression', async () => {
    const report = await runPaired({
      config: config(),
      baseline: workingArm(4),
      candidate: workingArm(34), // the deliberately slowed implementation
      grade: gradeEndState,
    });
    expect(report.comparison.verdict).toBe('regressed');
    expect(report.comparison.relativeChange).toBeGreaterThan(0);
    expect(report.comparison.p50DeltaMs).toBeGreaterThan(15);
    expect(summarize(report)).toMatch(/REGRESSED/);
  });

  it('calls a genuinely faster implementation improved', async () => {
    const report = await runPaired({ config: config(), baseline: workingArm(34), candidate: workingArm(4), grade: gradeEndState });
    expect(report.comparison.verdict).toBe('improved');
    expect(report.comparison.relativeChange).toBeLessThan(0);
    expect(report.candidate.acceptedFraction).toBe(1);
  });
});

describe('paired runner — a candidate cannot win by not doing the work', () => {
  it('MUTANT false success: an instant run that claims success but produces nothing is rejected, not fast', async () => {
    const liar: Arm<Fixture> = async () => ({ claimedSuccess: true, value: { produced: null } });
    const report = await runPaired({ config: config(), baseline: workingArm(34), candidate: liar, grade: gradeEndState });

    expect(report.comparison.verdict).toBe('regressed');
    // It claimed success every time and was accepted none of them.
    expect(report.runs.filter(r => r.arm === 'candidate').every(r => r.claimedSuccess)).toBe(true);
    expect(report.candidate.accepted).toBe(0);
    expect(report.candidate.rejected).toBe(8);
    // No latency is reported for an arm that never produced an accepted result.
    expect(report.candidate.p50Ms).toBeNull();
    expect(report.candidate.costPerAcceptedMs).toBeNull();
    // Its attempts are still charged, so "cheap because it did nothing" is visible.
    expect(report.candidate.totalWallMs).toBeGreaterThan(0);
    expect(report.comparison.pairedSuccessN).toBe(0);
    expect(report.comparison.reasons.join(' ')).toMatch(/no accepted run/);
  });

  it('MUTANT hidden abstentions: skipping the hard cases lowers latency and loses on the denominator', async () => {
    // The candidate is genuinely faster on what it answers, and simply refuses 3 of every 8 cases.
    const abstainer: Arm<Fixture> = async ctx => {
      if (ctx.pairIndex % 8 >= 5) return { claimedSuccess: false, value: { produced: null } };
      await sleep(2);
      return { claimedSuccess: true, value: { produced: 'expected-output' } };
    };
    const report = await runPaired({ config: config({ pairs: 8 }), baseline: workingArm(20), candidate: abstainer, grade: gradeEndState });

    expect(report.candidate.accepted).toBe(5);
    expect(report.baseline.accepted).toBe(8);
    expect(report.candidate.p50Ms!).toBeLessThan(report.baseline.p50Ms!); // faster on what it did answer
    expect(report.comparison.verdict).toBe('regressed');
    expect(report.comparison.reasons.join(' ')).toMatch(/acceptance rate fell/);
  });

  it('MUTANT expensive winner: a lower p50 bought with failed attempts is not an improvement', async () => {
    // Quality margin is deliberately wide here so the acceptance gate does NOT fire; the only thing
    // left to catch this candidate is cost per accepted result.
    const gambler: Arm<Fixture> = async ctx => {
      if (ctx.pairIndex % 2 === 1) { await sleep(120); return { claimedSuccess: false, value: { produced: null } }; }
      await sleep(2);
      return { claimedSuccess: true, value: { produced: 'expected-output' } };
    };
    const report = await runPaired({
      config: config({ pairs: 10, qualityRegressionMargin: 0.6 }),
      baseline: workingArm(20),
      candidate: gambler,
      grade: gradeEndState,
    });

    expect(report.comparison.relativeChange).toBeLessThan(0); // p50 really did improve
    expect(report.candidate.costPerAcceptedMs!).toBeGreaterThan(report.baseline.costPerAcceptedMs!);
    expect(report.comparison.verdict).toBe('inconclusive');
    expect(report.comparison.reasons.join(' ')).toMatch(/cost per accepted result/);
  });

  it('an arm that throws is counted against it, not silently skipped', async () => {
    const thrower: Arm<Fixture> = async () => { throw new Error('boom'); };
    const report = await runPaired({ config: config({ pairs: 4 }), baseline: workingArm(4), candidate: thrower, grade: gradeEndState });
    expect(report.candidate.errored).toBe(4);
    expect(report.candidate.valid).toBe(4);
    expect(report.candidate.acceptedFraction).toBe(0);
    expect(report.runs.filter(r => r.arm === 'candidate').every(r => r.error === 'boom')).toBe(true);
    expect(report.comparison.verdict).toBe('regressed');
  });
});

describe('paired runner — invalid runs', () => {
  it('excludes discarded runs from timing, counts their reasons, and keeps the valid denominator', async () => {
    // Every third candidate run hits a simulated outage: invalid environment, not a product failure.
    const flaky: Arm<Fixture> = async ctx => {
      if (ctx.pairIndex % 3 === 0) return { claimedSuccess: false, error: 'provider 503' };
      await sleep(4);
      return { claimedSuccess: true, value: { produced: 'expected-output' } };
    };
    const report = await runPaired({
      config: config({ pairs: 6 }),
      baseline: workingArm(4),
      candidate: flaky,
      grade: gradeEndState,
      discard: (_record, outcome) => (outcome.error === 'provider 503' ? 'provider outage' : null),
    });

    expect(report.candidate.discarded).toBe(2);
    expect(report.candidate.valid).toBe(4);
    expect(report.candidate.accepted).toBe(4);
    expect(report.candidate.acceptedFraction).toBe(1); // 4 of 4 VALID runs, not 4 of 6 attempts
    expect(report.discards).toEqual([{ reason: 'provider outage', count: 2 }]);
    expect(report.notes.join(' ')).toMatch(/discarded as invalid/);
  });

  it('reports invalid rather than a verdict when an arm produced no valid run at all', async () => {
    const report = await runPaired({
      config: config({ pairs: 3 }),
      baseline: workingArm(2),
      candidate: async () => ({ claimedSuccess: false, error: 'machine asleep' }),
      grade: gradeEndState,
      discard: (_r, outcome) => (outcome.error ? 'machine asleep' : null),
    });
    expect(report.candidate.valid).toBe(0);
    expect(report.comparison.verdict).toBe('invalid');
  });

  it('does not drop a slow but valid run', async () => {
    const occasionallySlow: Arm<Fixture> = async ctx => {
      await sleep(ctx.pairIndex === 2 ? 120 : 4);
      return { claimedSuccess: true, value: { produced: 'expected-output' } };
    };
    const report = await runPaired({ config: config({ pairs: 6 }), baseline: workingArm(4), candidate: occasionallySlow, grade: gradeEndState });
    expect(report.candidate.accepted).toBe(6);
    expect(report.candidate.maxMs!).toBeGreaterThan(100); // the outlier is still in the distribution
    expect(report.candidate.p95Ms!).toBeGreaterThan(100);
  });

  it('a grader that throws rejects the run instead of crashing the comparison', async () => {
    const report = await runPaired({
      config: config({ pairs: 2 }),
      baseline: workingArm(2),
      candidate: workingArm(2),
      grade: () => { throw new Error('grader exploded'); },
    });
    expect(report.baseline.accepted).toBe(0);
    expect(report.runs.every(r => r.gradeReason.includes('grader failed'))).toBe(true);
  });
});

describe('paired runner — report integrity', () => {
  it('writes a report once and refuses to replace it', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bimax-paired-'));
    try {
      const report = await runPaired({ config: config({ pairs: 2 }), baseline: workingArm(1), candidate: workingArm(1), grade: gradeEndState });
      const file = path.join(dir, 'report.json');
      writeReport(file, report);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).schema).toBe(1);
      expect(() => writeReport(file, report)).toThrow(/EEXIST/);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('measures whole-process-tree RSS or reports it as unavailable', () => {
    const bytes = processTreeRssBytes();
    if (bytes !== null) expect(bytes).toBeGreaterThanOrEqual(process.memoryUsage().rss * 0.5);
  });
});
