// P01 harness self-check. Run from the repository root with Bun or tsx, supplying an output path:
//
//   bun scripts/p01-harness-selfcheck.ts <out.json>
//
// This does NOT measure Bimax. It measures the harness: it drives the paired runner against
// deliberately broken candidates and requires the runner to reach the right verdict for each. That
// is the stage-0 exit condition in the delivery sequence — "paired run schema, known-delay and
// false-success mutants work" — and it is what has to hold before any later stage is allowed to
// claim an improvement. A harness that cannot fail is not evidence of anything.
//
// Every case runs against a real temporary directory: the arms produce (or fail to produce) an
// actual file, and the grader reads the filesystem rather than believing the arm. The script exits
// non-zero if any mutant escapes its gate.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  runPaired, summarize, Arm, ArmOutcome, Grader, PairedConfig, PairedReport, Verdict,
} from '../src/eval/paired.runner';

const outPath = resolve(process.cwd(), process.argv[2] ?? 'p01-harness-selfcheck.json');
if (existsSync(outPath)) {
  console.error(`${outPath} already exists; evidence files are not overwritten. Choose a new path.`);
  process.exit(2);
}

const EXPECTED = 'the graded end state\n';
type Produced = { file: string };

/** The honest implementation: does the work, then writes the expected end state. */
function honestArm(workMs: number, dir: string): Arm<Produced> {
  return async ctx => {
    const file = join(dir, `${ctx.arm}-${ctx.pairIndex}.txt`);
    const until = performance.now() + workMs;
    while (performance.now() < until) { /* deterministic wall-clock work */ }
    await writeFile(file, EXPECTED);
    return { claimedSuccess: true, value: { file } };
  };
}

/** Reads the filesystem. An arm's own claim never reaches this function's decision. */
const grader: Grader<Produced> = async (outcome: ArmOutcome<Produced>) => {
  const file = outcome.value?.file;
  if (!file) return { accepted: false, reason: 'the run named no output file' };
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return { accepted: false, reason: 'the named output file does not exist' };
  }
  return content === EXPECTED
    ? { accepted: true, reason: 'output file contained the expected end state', evidence: { bytes: content.length } }
    : { accepted: false, reason: 'output file contained the wrong content' };
};

const config = (over: Partial<PairedConfig>): PairedConfig => ({
  name: 'p01-harness-selfcheck',
  pairs: 12,
  qualityRegressionMargin: 0.1,
  minImprovementFraction: 0.05,
  minPairedSuccessFraction: 0.5,
  warmupRuns: 1,
  ...over,
});

interface CaseResult {
  name: string;
  what: string;
  expectedVerdict: Verdict;
  observedVerdict: Verdict;
  passed: boolean;
  baselineAccepted: string;
  candidateAccepted: string;
  candidateP50Ms: number | null;
  reasons: string[];
}

const cases: CaseResult[] = [];
const reports: Record<string, PairedReport> = {};

async function check(
  name: string,
  what: string,
  expectedVerdict: Verdict,
  build: (dir: string) => { baseline: Arm<Produced>; candidate: Arm<Produced>; config: PairedConfig },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'bimax-p01-selfcheck-'));
  try {
    const built = build(dir);
    const report = await runPaired({
      config: built.config,
      baseline: built.baseline,
      candidate: built.candidate,
      grade: grader,
      manifestFiles: ['src/eval/paired.runner.ts', 'src/telemetry/measure.ts'],
    });
    reports[name] = report;
    cases.push({
      name,
      what,
      expectedVerdict,
      observedVerdict: report.comparison.verdict,
      passed: report.comparison.verdict === expectedVerdict,
      baselineAccepted: `${report.baseline.accepted}/${report.baseline.valid}`,
      candidateAccepted: `${report.candidate.accepted}/${report.candidate.valid}`,
      candidateP50Ms: report.candidate.p50Ms,
      reasons: report.comparison.reasons,
    });
    console.log(summarize(report), '\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Control: the same implementation on both sides must not look like a change.
await check('control-identical', 'the same implementation on both arms', 'no-change', dir => ({
  baseline: honestArm(8, dir),
  candidate: honestArm(8, dir),
  config: config({}),
}));

// Control: a real improvement must be recognised, or the harness is useless.
await check('control-real-improvement', 'a candidate that genuinely does the same work faster', 'improved', dir => ({
  baseline: honestArm(40, dir),
  candidate: honestArm(8, dir),
  config: config({}),
}));

// MUTANT 1 — known delay: 30 ms of extra work in the interactive path.
await check('mutant-known-delay', '30 ms of extra work added to the candidate', 'regressed', dir => ({
  baseline: honestArm(8, dir),
  candidate: honestArm(38, dir),
  config: config({}),
}));

// MUTANT 2 — false success: instant, claims success, produces no end state.
await check('mutant-false-success', 'a candidate that claims success without producing the output', 'regressed', dir => ({
  baseline: honestArm(40, dir),
  candidate: async () => ({ claimedSuccess: true, value: { file: join(dir, 'never-written.txt') } }),
  config: config({}),
}));

// MUTANT 3 — wrong output: fast, produces a file, but not the graded end state.
await check('mutant-wrong-output', 'a fast candidate whose output is wrong', 'regressed', dir => ({
  baseline: honestArm(40, dir),
  candidate: async ctx => {
    const file = join(dir, `wrong-${ctx.pairIndex}.txt`);
    await writeFile(file, 'not the graded end state\n');
    return { claimedSuccess: true, value: { file } };
  },
  config: config({}),
}));

// MUTANT 4 — hidden abstentions: faster on what it answers, refuses the rest.
await check('mutant-hidden-abstentions', 'a candidate that skips a third of the cases to look fast', 'regressed', dir => ({
  baseline: honestArm(40, dir),
  candidate: async ctx => {
    if (ctx.pairIndex % 3 === 0) return { claimedSuccess: false, error: 'declined this case' };
    return honestArm(8, dir)(ctx);
  },
  config: config({}),
}));

// MUTANT 5 — expensive winner: better p50, worse cost per accepted result.
await check('mutant-expensive-winner', 'a candidate with a better p50 bought by costly failed attempts', 'inconclusive', dir => ({
  baseline: honestArm(20, dir),
  candidate: async ctx => {
    if (ctx.pairIndex % 2 === 1) {
      const until = performance.now() + 150;
      while (performance.now() < until) { /* burnt on an attempt that produces nothing */ }
      return { claimedSuccess: false, error: 'attempt produced nothing' };
    }
    return honestArm(4, dir)(ctx);
  },
  // Deliberately permissive quality margin so the acceptance gate does NOT fire and the cost gate
  // is the only thing left to catch it.
  config: config({ pairs: 10, qualityRegressionMargin: 0.6 }),
}));

const passed = cases.filter(c => c.passed).length;
const report = {
  schema: 1,
  date: new Date().toISOString(),
  scope:
    'Self-check of the P01 paired runner against deliberately broken candidates. This measures the ' +
    'harness, not Bimax. No product performance claim is created by this file.',
  runtime: {
    node: process.version,
    bun: (globalThis as any).Bun?.version ?? null,
    platform: process.platform,
    arch: process.arch,
  },
  manifest: reports['control-identical']?.manifest ?? null,
  summary: { cases: cases.length, passed, failed: cases.length - passed },
  cases,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });

const failures = cases.filter(c => !c.passed);
if (failures.length) {
  console.error(
    `Harness self-check FAILED: ${failures.map(f => `${f.name} expected ${f.expectedVerdict}, got ${f.observedVerdict}`).join('; ')}`
  );
  process.exit(1);
}
console.log(`Harness self-check passed: ${passed}/${cases.length} cases reached the required verdict. Wrote ${outPath}`);
