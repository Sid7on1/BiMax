import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { sampleResources, ResourceSample, AttrValue } from '../telemetry/measure';

/**
 * The P01 paired baseline/candidate runner.
 *
 * `competitive/examples/P01_FAST_CODE_AND_COWORK.md` is an evaluation contract with a specific
 * shape, and most of the ways a performance comparison lies are shapes this runner refuses to make:
 *
 *  - **An arm never grades itself.** Every run is judged by an independent grader that inspects the
 *    end state. A run that claims success and fails the grader is `rejected`, and its time is still
 *    charged. "Finished instantly with no output" cannot win.
 *  - **The denominator is every valid run.** Acceptance rate is reported over valid attempts, not
 *    over whichever runs an arm happened to finish, so refusing hard cases lowers the score instead
 *    of lowering the latency.
 *  - **Quality gates before latency.** A candidate whose acceptance rate falls more than the
 *    predeclared margin below the baseline is `regressed`, however fast it was.
 *  - **Cost is charged, not the winner's highlights.** Total wall time of every attempt, including
 *    failed and rejected ones, divides into accepted results as cost per accepted result.
 *  - **Order alternates.** Pair 0 runs baseline first, pair 1 candidate first, so drift and warmup
 *    do not attach themselves to one arm.
 *  - **Slow valid runs stay in.** Nothing is dropped for being slow. A run leaves the timing set
 *    only through the explicit `discard` hook, which must name a reason, and every discard is
 *    reported.
 *  - **The comparison is predeclared.** Pair count and margins are hashed into the report, and the
 *    report file refuses to overwrite an existing one.
 *
 * Statistics are deliberately plain: nearest-rank percentiles over the raw samples, paired deltas
 * over pairs where both arms were accepted, and an explicit count of that subset. No smoothing, no
 * outlier rejection, no confidence claim the sample size does not support.
 */

export type ArmName = 'baseline' | 'candidate';

export interface RunContext {
  arm: ArmName;
  /** 0-based pair index. */
  pairIndex: number;
  /** Position within the pair: 0 ran first, 1 ran second. */
  positionInPair: number;
  /** Global run counter across both arms, including warmup runs (which are numbered negatively). */
  runIndex: number;
}

export interface ArmOutcome<T = unknown> {
  /** What the implementation says about itself. Never trusted; the grader decides. */
  claimedSuccess: boolean;
  value?: T;
  error?: string;
}

export type Arm<T = unknown> = (ctx: RunContext) => Promise<ArmOutcome<T>>;

export interface Grade {
  accepted: boolean;
  /** Why. Required for both outcomes so a report explains itself without the source. */
  reason: string;
  evidence?: Record<string, AttrValue>;
}

export type Grader<T = unknown> = (outcome: ArmOutcome<T>, ctx: RunContext) => Promise<Grade> | Grade;

export type RunStatus = 'accepted' | 'rejected' | 'error' | 'discarded';

export interface RunRecord {
  arm: ArmName;
  pairIndex: number;
  positionInPair: number;
  runIndex: number;
  status: RunStatus;
  /** Wall time of the attempt, monotonic. Present even for rejected and errored runs. */
  durationMs: number;
  claimedSuccess: boolean;
  gradeReason: string;
  gradeEvidence?: Record<string, AttrValue>;
  error?: string;
  discardReason?: string;
  rssDeltaBytes: number;
  peakEventLoopDelayMs: number | null;
  processTreeRssBytes: number | null;
}

export interface ArmStats {
  arm: ArmName;
  attempts: number;
  /** Attempts minus discarded runs — the denominator for acceptance. */
  valid: number;
  accepted: number;
  rejected: number;
  errored: number;
  discarded: number;
  /** accepted / valid, or null when nothing valid ran. */
  acceptedFraction: number | null;
  /** Latency over ACCEPTED runs only. Null when no run was accepted. */
  p50Ms: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  acceptedN: number;
  /** Wall time of every valid attempt, accepted or not. This is what a candidate actually costs. */
  totalWallMs: number;
  /** totalWallMs / accepted. Null when nothing was accepted — not Infinity, not zero. */
  costPerAcceptedMs: number | null;
  peakRssDeltaBytes: number;
  maxEventLoopDelayMs: number | null;
  maxProcessTreeRssBytes: number | null;
}

export type Verdict = 'improved' | 'no-change' | 'regressed' | 'inconclusive' | 'invalid';

export interface PairedComparison {
  /** Pairs where BOTH arms were accepted — the only pairs a paired delta can be computed from. */
  pairedSuccessN: number;
  /** candidate − baseline, one per paired-success pair. Negative is faster. */
  deltasMs: number[];
  p50DeltaMs: number | null;
  /** Relative change of the paired p50 latency. Negative is faster. */
  relativeChange: number | null;
  acceptedFractionDelta: number | null;
  costPerAcceptedChange: number | null;
  verdict: Verdict;
  reasons: string[];
}

export interface PairedConfig {
  name: string;
  /** Predeclared number of pairs. Every pair runs both arms. */
  pairs: number;
  /**
   * How far the candidate's acceptance rate may fall below the baseline's before the result is a
   * regression regardless of latency. Expressed in absolute fraction points (0.05 = 5 points).
   */
  qualityRegressionMargin: number;
  /** Relative paired-p50 change that counts as a real move rather than noise (0.05 = 5%). */
  minImprovementFraction: number;
  /** Runs per arm before measurement begins. Not recorded in the statistics. */
  warmupRuns?: number;
  /**
   * Minimum fraction of pairs that must produce a paired success before a latency verdict is
   * allowed. Below it the result is `inconclusive`, never `improved`. Default 0.5.
   */
  minPairedSuccessFraction?: number;
}

export interface PairedReport {
  schema: 1;
  name: string;
  startedAt: string;
  finishedAt: string;
  config: PairedConfig;
  /** SHA-256 of the predeclared config, so a post-hoc edit is visible. */
  configHash: string;
  manifest: RunManifest;
  percentileMethod: 'nearest-rank';
  runs: RunRecord[];
  baseline: ArmStats;
  candidate: ArmStats;
  comparison: PairedComparison;
  discards: { reason: string; count: number }[];
  notes: string[];
}

// --- statistics ---------------------------------------------------------------------------------

/**
 * Nearest-rank percentile: the smallest value at or above the q-th position of the sorted sample.
 * Chosen because it always returns an observed value and needs no interpolation assumption; the
 * method name travels with the report so a reader can reproduce it.
 */
export function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}

function statsFor(arm: ArmName, runs: RunRecord[]): ArmStats {
  const mine = runs.filter(r => r.arm === arm);
  const discarded = mine.filter(r => r.status === 'discarded');
  const valid = mine.filter(r => r.status !== 'discarded');
  const accepted = valid.filter(r => r.status === 'accepted');
  const acceptedMs = accepted.map(r => r.durationMs);
  const totalWallMs = valid.reduce((sum, r) => sum + r.durationMs, 0);
  const elDelays = valid.map(r => r.peakEventLoopDelayMs).filter((v): v is number => v !== null);
  const treeRss = valid.map(r => r.processTreeRssBytes).filter((v): v is number => v !== null);
  return {
    arm,
    attempts: mine.length,
    valid: valid.length,
    accepted: accepted.length,
    rejected: valid.filter(r => r.status === 'rejected').length,
    errored: valid.filter(r => r.status === 'error').length,
    discarded: discarded.length,
    acceptedFraction: valid.length ? accepted.length / valid.length : null,
    p50Ms: percentile(acceptedMs, 0.5),
    p95Ms: percentile(acceptedMs, 0.95),
    minMs: acceptedMs.length ? Math.min(...acceptedMs) : null,
    maxMs: acceptedMs.length ? Math.max(...acceptedMs) : null,
    acceptedN: accepted.length,
    totalWallMs,
    costPerAcceptedMs: accepted.length ? totalWallMs / accepted.length : null,
    peakRssDeltaBytes: valid.reduce((max, r) => Math.max(max, r.rssDeltaBytes), 0),
    maxEventLoopDelayMs: elDelays.length ? Math.max(...elDelays) : null,
    maxProcessTreeRssBytes: treeRss.length ? Math.max(...treeRss) : null,
  };
}

export function compare(config: PairedConfig, runs: RunRecord[], baseline: ArmStats, candidate: ArmStats): PairedComparison {
  const reasons: string[] = [];
  const byPair = new Map<number, { baseline?: RunRecord; candidate?: RunRecord }>();
  for (const run of runs) {
    if (run.pairIndex < 0) continue; // warmup
    const slot = byPair.get(run.pairIndex) ?? {};
    slot[run.arm] = run;
    byPair.set(run.pairIndex, slot);
  }
  const deltasMs: number[] = [];
  for (const slot of byPair.values()) {
    if (slot.baseline?.status === 'accepted' && slot.candidate?.status === 'accepted') {
      deltasMs.push(slot.candidate.durationMs - slot.baseline.durationMs);
    }
  }
  const p50DeltaMs = percentile(deltasMs, 0.5);
  const relativeChange =
    p50DeltaMs !== null && baseline.p50Ms !== null && baseline.p50Ms > 0 ? p50DeltaMs / baseline.p50Ms : null;
  const acceptedFractionDelta =
    candidate.acceptedFraction !== null && baseline.acceptedFraction !== null
      ? candidate.acceptedFraction - baseline.acceptedFraction
      : null;
  const costPerAcceptedChange =
    candidate.costPerAcceptedMs !== null && baseline.costPerAcceptedMs !== null && baseline.costPerAcceptedMs > 0
      ? (candidate.costPerAcceptedMs - baseline.costPerAcceptedMs) / baseline.costPerAcceptedMs
      : null;

  const minPairedFraction = config.minPairedSuccessFraction ?? 0.5;
  let verdict: Verdict;

  if (baseline.valid === 0 || candidate.valid === 0) {
    verdict = 'invalid';
    reasons.push('an arm produced no valid run; there is nothing to compare');
  } else if (candidate.accepted === 0 && baseline.accepted > 0) {
    // Covers the false-success mutant: it claimed success every time and was graded wrong every time.
    verdict = 'regressed';
    reasons.push(
      `candidate had no accepted run against ${baseline.accepted} for the baseline; ` +
      `it produced no result to be fast about`
    );
  } else if (
    acceptedFractionDelta !== null &&
    acceptedFractionDelta < -config.qualityRegressionMargin
  ) {
    // Covers the denominator mutant: skipping hard cases lowers latency and loses here.
    verdict = 'regressed';
    reasons.push(
      `acceptance rate fell ${(Math.abs(acceptedFractionDelta) * 100).toFixed(1)} points ` +
      `(${(baseline.acceptedFraction! * 100).toFixed(1)}% → ${(candidate.acceptedFraction! * 100).toFixed(1)}%), ` +
      `past the predeclared ${(config.qualityRegressionMargin * 100).toFixed(1)}-point margin`
    );
  } else if (deltasMs.length < Math.ceil(minPairedFraction * config.pairs)) {
    verdict = 'inconclusive';
    reasons.push(
      `only ${deltasMs.length} of ${config.pairs} pairs had both arms accepted; ` +
      `too few paired successes for a latency verdict`
    );
  } else if (relativeChange === null) {
    verdict = 'inconclusive';
    reasons.push('no baseline latency to compare against');
  } else if (relativeChange <= -config.minImprovementFraction) {
    if (costPerAcceptedChange !== null && costPerAcceptedChange > config.minImprovementFraction) {
      verdict = 'inconclusive';
      reasons.push(
        `paired p50 improved ${(Math.abs(relativeChange) * 100).toFixed(1)}% but cost per accepted result ` +
        `rose ${(costPerAcceptedChange * 100).toFixed(1)}%; a faster run that costs more per accepted ` +
        `result is not an improvement`
      );
    } else {
      verdict = 'improved';
      reasons.push(
        `paired p50 improved ${(Math.abs(relativeChange) * 100).toFixed(1)}% over ${deltasMs.length} paired successes`
      );
    }
  } else if (relativeChange >= config.minImprovementFraction) {
    verdict = 'regressed';
    reasons.push(`paired p50 worsened ${(relativeChange * 100).toFixed(1)}% over ${deltasMs.length} paired successes`);
  } else {
    verdict = 'no-change';
    reasons.push(
      `paired p50 moved ${(relativeChange * 100).toFixed(1)}%, inside the predeclared ` +
      `${(config.minImprovementFraction * 100).toFixed(1)}% band`
    );
  }

  if (verdict !== 'invalid' && candidate.p95Ms !== null && baseline.p95Ms !== null && baseline.p95Ms > 0) {
    const p95Change = (candidate.p95Ms - baseline.p95Ms) / baseline.p95Ms;
    if (verdict === 'improved' && p95Change >= config.minImprovementFraction) {
      reasons.push(`p95 rose ${(p95Change * 100).toFixed(1)}% while p50 fell; report both before adopting`);
    }
  }

  return { pairedSuccessN: deltasMs.length, deltasMs, p50DeltaMs, relativeChange, acceptedFractionDelta, costPerAcceptedChange, verdict, reasons };
}

// --- manifest -----------------------------------------------------------------------------------

export interface DirtyState {
  /**
   * How the digest was produced. `status+content-hash` hashes the working-tree bytes of every path
   * `git status --porcelain` reports as changed. `git diff HEAD` is deliberately not used: on this
   * checkout it takes over two minutes, and a manifest step that stalls a measurement run is worse
   * than one that identifies the same state a cheaper way.
   */
  method: 'status+content-hash';
  /** SHA-256 over `<path>\0<sha256 of working-tree bytes>` for each changed path, sorted. */
  sha256: string;
  changedPaths: number;
  /** Paths git reported as changed but whose bytes could not be read (deleted, unreadable). */
  unreadablePaths: number;
}

export interface RunManifest {
  startedAt: string;
  gitHead: string | null;
  /**
   * Identity of the working tree beyond the commit. Null when git is unavailable — a missing
   * digest stays missing rather than implying a clean checkout.
   */
  dirtyState: DirtyState | null;
  node: string;
  bun: string | null;
  platform: string;
  arch: string;
  osRelease: string;
  cpuModel: string;
  cpuCount: number;
  totalMemBytes: number;
  freeMemBytes: number;
  loadAverage: number[];
  /** SHA-256 of each named fixture or source file the comparison depends on. */
  files: Record<string, string>;
}

function git(args: string[], timeoutMs = 20_000): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Memoized: the checkout does not change during a run, and a repeated probe is pure overhead. */
let cachedIdentity: { head: string | null; dirty: DirtyState | null } | undefined;

export function checkoutIdentity(): { head: string | null; dirty: DirtyState | null } {
  if (cachedIdentity) return cachedIdentity;
  const head = git(['rev-parse', 'HEAD'])?.trim() ?? null;
  const status = git(['status', '--porcelain']);
  let dirty: DirtyState | null = null;
  if (status !== null) {
    const paths: string[] = [];
    for (const line of status.split('\n')) {
      if (!line.trim()) continue;
      // Porcelain v1: two status characters, a space, then the path (or `old -> new` for a rename).
      const raw = line.slice(3);
      const renamed = raw.split(' -> ');
      paths.push(renamed[renamed.length - 1].replace(/^"|"$/g, ''));
    }
    let unreadable = 0;
    const entries: string[] = [];
    for (const p of paths.sort()) {
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) { entries.push(`${p}\0directory`); continue; }
        entries.push(`${p}\0${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
      } catch {
        unreadable++;
        entries.push(`${p}\0unreadable`);
      }
    }
    dirty = {
      method: 'status+content-hash',
      sha256: createHash('sha256').update(entries.join('\n')).digest('hex'),
      changedPaths: paths.length,
      unreadablePaths: unreadable,
    };
  }
  cachedIdentity = { head, dirty };
  return cachedIdentity;
}

/** Test seam: forget the memoized checkout identity. */
export function __resetCheckoutIdentity(): void { cachedIdentity = undefined; }

export function buildManifest(files: string[] = []): RunManifest {
  const identity = checkoutIdentity();
  const cpus = os.cpus();
  const hashes: Record<string, string> = {};
  for (const file of files) {
    try {
      hashes[file] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (e: any) {
      hashes[file] = `unavailable: ${e?.code ?? 'read failed'}`;
    }
  }
  return {
    startedAt: new Date().toISOString(),
    gitHead: identity.head,
    dirtyState: identity.dirty,
    node: process.version,
    bun: (globalThis as any).Bun?.version ?? null,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    loadAverage: os.loadavg(),
    files: hashes,
  };
}

/**
 * Resident memory of this process and every descendant, in bytes. Null when `ps` is unavailable or
 * unparsable — a missing measurement stays missing rather than becoming this process's own RSS.
 */
export function processTreeRssBytes(rootPid = process.pid): number | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 5_000 });
  } catch {
    return null;
  }
  const children = new Map<number, number[]>();
  const rssKb = new Map<number, number>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    rssKb.set(pid, Number(m[3]));
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  if (!rssKb.has(rootPid)) return null;
  let total = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rssKb.get(pid) ?? 0;
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return total * 1024;
}

// --- the runner ---------------------------------------------------------------------------------

export interface PairedRunOptions<T> {
  config: PairedConfig;
  baseline: Arm<T>;
  candidate: Arm<T>;
  grade: Grader<T>;
  /**
   * Return a reason to invalidate a run (a provider outage, a machine that went to sleep). A
   * discarded run is excluded from timing and from the acceptance denominator, and every discard is
   * counted with its reason in the report. A product-caused hang or timeout is NOT a discard.
   */
  discard?: (record: Omit<RunRecord, 'status' | 'discardReason'>, outcome: ArmOutcome<T>) => string | null;
  /** Files whose hashes identify this comparison. */
  manifestFiles?: string[];
  /** Collect whole-process-tree RSS around each run. Off by default: it spawns `ps`. */
  measureProcessTree?: boolean;
}

export async function runPaired<T>(options: PairedRunOptions<T>): Promise<PairedReport> {
  const { config, grade } = options;
  if (!Number.isInteger(config.pairs) || config.pairs < 1) {
    throw new Error('pairs must be a positive integer, predeclared before the run');
  }
  const manifest = buildManifest(options.manifestFiles ?? []);
  const startedAt = new Date().toISOString();
  const runs: RunRecord[] = [];
  let runIndex = 0;

  const executeOne = async (arm: ArmName, pairIndex: number, positionInPair: number): Promise<void> => {
    const fn = arm === 'baseline' ? options.baseline : options.candidate;
    const ctx: RunContext = { arm, pairIndex, positionInPair, runIndex: runIndex++ };
    const before = sampleResources();
    const treeBefore = options.measureProcessTree ? processTreeRssBytes() : null;
    const t0 = performance.now();
    let outcome: ArmOutcome<T>;
    try {
      outcome = await fn(ctx);
    } catch (e: any) {
      outcome = { claimedSuccess: false, error: e?.message ?? String(e) };
    }
    const durationMs = performance.now() - t0;
    const after = sampleResources();
    const treeAfter = options.measureProcessTree ? processTreeRssBytes() : null;

    let graded: Grade;
    try {
      graded = await grade(outcome, ctx);
    } catch (e: any) {
      graded = { accepted: false, reason: `grader failed: ${e?.message ?? String(e)}` };
    }

    const partial: Omit<RunRecord, 'status' | 'discardReason'> = {
      arm,
      pairIndex,
      positionInPair,
      runIndex: ctx.runIndex,
      durationMs,
      claimedSuccess: outcome.claimedSuccess,
      gradeReason: graded.reason,
      gradeEvidence: graded.evidence,
      error: outcome.error,
      rssDeltaBytes: after.rssBytes - before.rssBytes,
      peakEventLoopDelayMs: after.eventLoopDelayMaxMs,
      processTreeRssBytes:
        treeAfter !== null && treeBefore !== null ? Math.max(treeAfter, treeBefore) : treeAfter ?? treeBefore,
    };

    const discardReason = options.discard?.(partial, outcome) ?? null;
    const status: RunStatus = discardReason
      ? 'discarded'
      : graded.accepted
        ? 'accepted'
        : outcome.error && !outcome.claimedSuccess
          ? 'error'
          : 'rejected';
    if (pairIndex >= 0) runs.push({ ...partial, status, ...(discardReason ? { discardReason } : {}) });
  };

  for (let w = 0; w < (config.warmupRuns ?? 0); w++) {
    await executeOne('baseline', -1, 0);
    await executeOne('candidate', -1, 1);
  }
  for (let pair = 0; pair < config.pairs; pair++) {
    // Alternate which arm goes first so warmup, cache and thermal drift do not favour one side.
    const order: ArmName[] = pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (let position = 0; position < order.length; position++) {
      await executeOne(order[position], pair, position);
    }
  }

  const baseline = statsFor('baseline', runs);
  const candidate = statsFor('candidate', runs);
  const comparison = compare(config, runs, baseline, candidate);

  const discardCounts = new Map<string, number>();
  for (const run of runs) {
    if (run.status === 'discarded' && run.discardReason) {
      discardCounts.set(run.discardReason, (discardCounts.get(run.discardReason) ?? 0) + 1);
    }
  }

  const notes: string[] = [];
  if (comparison.pairedSuccessN < config.pairs) {
    notes.push(
      `${config.pairs - comparison.pairedSuccessN} of ${config.pairs} pairs did not produce a paired ` +
      `success; the paired latency subset is ${comparison.pairedSuccessN} pairs`
    );
  }
  if (baseline.discarded || candidate.discarded) {
    notes.push(`${baseline.discarded + candidate.discarded} run(s) were discarded as invalid and excluded from timing`);
  }
  notes.push('Durations are attempt wall time on this machine, not product latency for any user-visible boundary.');

  return {
    schema: 1,
    name: config.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    config,
    configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    manifest,
    percentileMethod: 'nearest-rank',
    runs,
    baseline,
    candidate,
    comparison,
    discards: [...discardCounts.entries()].map(([reason, count]) => ({ reason, count })),
    notes,
  };
}

/** Write a report without ever replacing one. A rerun gets a new path or it does not get written. */
export function writeReport(filePath: string, report: PairedReport): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}

export function summarize(report: PairedReport): string {
  const ms = (v: number | null) => (v === null ? 'unavailable' : `${v.toFixed(1)} ms`);
  const pct = (v: number | null) => (v === null ? 'unavailable' : `${(v * 100).toFixed(1)}%`);
  const arm = (s: ArmStats) =>
    `${s.arm.padEnd(9)} accepted ${s.accepted}/${s.valid} (${pct(s.acceptedFraction)}) · ` +
    `p50 ${ms(s.p50Ms)} · p95 ${ms(s.p95Ms)} · total ${ms(s.totalWallMs)} · per accepted ${ms(s.costPerAcceptedMs)}`;
  return [
    `${report.name} — ${report.comparison.verdict.toUpperCase()}`,
    arm(report.baseline),
    arm(report.candidate),
    `paired successes: ${report.comparison.pairedSuccessN}/${report.config.pairs} · ` +
    `p50 delta ${ms(report.comparison.p50DeltaMs)} (${pct(report.comparison.relativeChange)})`,
    ...report.comparison.reasons.map(r => `  · ${r}`),
    ...report.notes.map(n => `  note: ${n}`),
  ].join('\n');
}
