import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { WorktreeManager } from '../evolution/worktree.manager';
import { getEventLedger } from './event.ledger';
import { mindSingletonRoot } from './self.model';
import { betaMean } from './stats';

/**
 * MutationEngine — dream v2's flagship generator: self-play with KNOWN ground truth.
 *
 * v1 dream practice could only train on drive deviations (needs something to be wrong).
 * Mutation self-play manufactures training tasks from healthy code: plant one realistic
 * defect in a function that tests actually cover, verify the tests CATCH it (a mutant
 * the tests don't kill is discarded — undetectable means ungradeable), then hand the
 * agent "these tests fail, find and fix the defect" in a sandboxed worktree where the
 * mutant is COMMITTED (no `git diff` shortcut to the answer). Because the original is
 * ground truth, grading is fully objective: tests green again + was the fix the exact
 * restoration or a plausible alternative. Fixes are never merged — the un-mutated
 * original is truth; the value of the episode is the experience, distilled into ledger
 * events, per-operator skill posteriors, and exemplars.
 *
 * Honest scope (per the plan's own self-critique): TS/JS + Go only; operators are
 * line-surgical with spacing heuristics rather than a tree-sitter fleet. The curriculum
 * is per-operator Beta posteriors targeting the P(success)≈0.65 frontier until ≥100
 * gradeable episodes exist; from there a 2-parameter Elo/IRT model (one agent skill θ,
 * one difficulty b per task class, jointly updated per episode) takes over the sampler —
 * exactly the cold-start sequencing the plan's DeepMind critique demanded. Coverage
 * linkage is convention-based (test file naming), the plan's "related" tier, upgraded
 * to coverage-verified only where the TDM has proof.
 */

export interface MutationOperator {
  id: string;
  /** Cold-start difficulty prior (1 = easiest to diagnose) — the curriculum's tiebreak. */
  difficulty: number;
  apply(line: string): string | null;
}

/** Replace the first occurrence of `from` when surrounded by the given spacing pattern. */
function swapFirst(line: string, from: string, to: string): string | null {
  const i = line.indexOf(from);
  return i === -1 ? null : line.slice(0, i) + to + line.slice(i + from.length);
}

export const OPERATORS: MutationOperator[] = [
  {
    id: 'negate-equality', difficulty: 1,
    // `===`→`!==` first; the reverse when only the negated form appears. Word-exact,
    // so `==`-vs-`===` subtleties never produce a still-parsing-but-different token.
    apply: (l) => l.includes('===') ? swapFirst(l, '===', '!==') : l.includes('!==') ? swapFirst(l, '!==', '===') : null,
  },
  {
    id: 'boundary', difficulty: 2,
    // Spaced comparisons only — ` < ` is a comparison; `<` bare is likely a generic
    // parameter or JSX in TS, and mutating those makes compile-error junk mutants.
    apply: (l) => l.includes(' <= ') ? swapFirst(l, ' <= ', ' < ') : l.includes(' < ') ? swapFirst(l, ' < ', ' <= ')
      : l.includes(' >= ') ? swapFirst(l, ' >= ', ' > ') : l.includes(' > ') ? swapFirst(l, ' > ', ' >= ') : null,
  },
  {
    id: 'logic-swap', difficulty: 2,
    apply: (l) => l.includes(' && ') ? swapFirst(l, ' && ', ' || ') : l.includes(' || ') ? swapFirst(l, ' || ', ' && ') : null,
  },
  {
    id: 'off-by-one', difficulty: 3,
    apply: (l) => l.includes('+ 1') ? swapFirst(l, '+ 1', '- 1') : l.includes('- 1') ? swapFirst(l, '- 1', '+ 1') : null,
  },
  {
    id: 'bool-const', difficulty: 1,
    apply: (l) => /\btrue\b/.test(l) ? l.replace(/\btrue\b/, 'false') : /\bfalse\b/.test(l) ? l.replace(/\bfalse\b/, 'true') : null,
  },
];

/**
 * Regeneration (dream v2's second generator): not a line operator — the whole body of a
 * well-tested function is deleted ("implement from spec"). Joins the curriculum as its
 * own class; hardest prior since the agent must synthesize, not just diagnose.
 */
export const REGENERATION = 'regeneration';
const REGENERATION_DIFFICULTY = 4;
// IRT takes the sampler over only past this many gradeable episodes (plan's cold-start rule);
// K is the Elo-style learning rate for the joint θ/b updates.
export const IRT_MIN_N = 100;
const IRT_K = 0.1;

/** Deterministic PRNG (mulberry32) — a seeded cycle reproduces its mutant selection. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MutationCandidate {
  file: string;      // repo-relative source file
  testFile: string;  // repo-relative covering test file (convention tier)
}

export interface MutantTask {
  candidate: MutationCandidate;
  op: string;
  line: number;        // 1-based
  original: string;    // the un-mutated line — ground truth
  mutated: string;
}

export interface SelfPlayReport {
  attempted: boolean;
  generator?: 'mutation' | 'regeneration';
  note?: string;
  task?: { file: string; testFile: string; op: string; line: number };
  /** Mutants planted that the tests did NOT catch — each one is a verification gap. */
  survivors: number;
  killed?: boolean;      // tests caught the planted defect (episode became gradeable)
  fixed?: boolean;       // agent's fix turned the tests green again
  exactRestore?: boolean;// fix was byte-identical to the ground-truth original
  durationMs?: number;
}

export interface FunctionSpan {
  name: string;
  sigLine: number;   // 1-based line of the signature
  bodyStart: number; // 1-based first line INSIDE the braces
  bodyEnd: number;   // 1-based last line inside the braces
}

/**
 * Function bodies by brace counting (TS/JS `function name(`, Go `func Name(`) — the
 * honest non-tree-sitter tier. Naive about braces inside strings, so only bodies of
 * 3–40 lines with a clean brace balance qualify; a miscount just disqualifies a span.
 */
export function findFunctions(lines: string[], isGo: boolean): FunctionSpan[] {
  const sig = isGo
    ? /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/
    : /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
  const out: FunctionSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = sig.exec(lines[i]);
    if (!m) continue;
    // Find the opening brace on the signature line (or the next couple of lines).
    let open = -1;
    for (let j = i; j < Math.min(i + 3, lines.length) && open === -1; j++) {
      if (lines[j].includes('{')) open = j;
    }
    if (open === -1) continue;
    let depth = 0;
    let close = -1;
    for (let j = open; j < lines.length && close === -1; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { close = j; break; } }
      }
    }
    if (close === -1) continue;
    const bodyLines = close - open - 1;
    if (bodyLines >= 3 && bodyLines <= 40) {
      out.push({ name: m[1], sigLine: i + 1, bodyStart: open + 2, bodyEnd: close });
    }
    i = close; // don't re-match inside this function
  }
  return out;
}

type CheckRunner = (worktree: string, testFile: string) => { ok: boolean; output: string };
type FixAttempter = (worktree: string, prompt: string, stamp: string) => Promise<void>;

const CHECK_TIMEOUT_MS = 240_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', '.bimax', '__tests__']);
const MAX_SCAN = 4000;

/** Default kill-check: run exactly the covering test file, bounded (never the full suite). */
function defaultRunCheck(worktree: string, testFile: string): { ok: boolean; output: string } {
  try {
    const args = testFile.endsWith('_test.go')
      ? ['go', ['test', './' + (path.dirname(testFile) || '.') + '/']]
      : ['npx', ['jest', testFile, '--coverage=false', '--maxWorkers=2', '--silent']];
    const out = execFileSync(args[0] as string, args[1] as string[], {
      cwd: worktree, stdio: 'pipe', timeout: CHECK_TIMEOUT_MS, encoding: 'utf-8',
    });
    return { ok: true, output: String(out).slice(-4000) };
  } catch (e: any) {
    return { ok: false, output: String(e?.stdout || '') .slice(-4000) + String(e?.stderr || '').slice(-2000) };
  }
}

/** Default fixer: a sandboxed sub-agent episode (net: none, writes confined to the worktree). */
async function defaultAttemptFix(worktree: string, prompt: string, stamp: string): Promise<void> {
  const { SubAgentManager } = await import('../core/subagent.manager');
  await new SubAgentManager().spawnWorker(`dream-mut-${stamp}`, {
    agentType: 'OpenClaw',
    prompt,
    cwd: worktree,
    parentMode: 'auto',
    sandboxFloorRoot: worktree,
  });
}

export class MutationEngine {
  private rng: () => number;
  private runCheck: CheckRunner;
  private attemptFix: FixAttempter;

  constructor(
    private projectRoot: string = mindSingletonRoot(),
    opts?: { seed?: number; runCheck?: CheckRunner; attemptFix?: FixAttempter }
  ) {
    this.rng = mulberry32(opts?.seed ?? (Date.now() & 0xffffffff));
    this.runCheck = opts?.runCheck || defaultRunCheck;
    this.attemptFix = opts?.attemptFix || defaultAttemptFix;
  }

  /**
   * Source files with a covering test by naming convention (the plan's "related" tier):
   * `x.test.ts` / `x.spec.ts` beside or under __tests__/, `x_test.go` beside.
   */
  findCandidates(limit = 20): MutationCandidate[] {
    const out: MutationCandidate[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      if (out.length >= limit || scanned >= MAX_SCAN) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit || ++scanned >= MAX_SCAN) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full);
          continue;
        }
        const rel = path.relative(this.projectRoot, full);
        const test = this.coveringTest(rel);
        if (test) out.push({ file: rel, testFile: test });
      }
    };
    walk(this.projectRoot);
    return out;
  }

  private coveringTest(relFile: string): string | null {
    const base = path.basename(relFile);
    const dir = path.dirname(relFile);
    if (/\.(test|spec)\.[jt]sx?$/.test(base) || base.endsWith('_test.go') || base.endsWith('.d.ts')) return null;
    if (/\.[jt]sx?$/.test(base)) {
      const stem = base.replace(/\.[jt]sx?$/, '');
      for (const cand of [
        path.join(dir, `${stem}.test.ts`), path.join(dir, `${stem}.spec.ts`),
        path.join(dir, '__tests__', `${stem}.test.ts`),
        path.join(dir, '..', '__tests__', `${stem}.test.ts`),
      ]) {
        if (fs.existsSync(path.join(this.projectRoot, cand))) return path.normalize(cand);
      }
      return null;
    }
    if (base.endsWith('.go')) {
      const cand = path.join(dir, base.replace(/\.go$/, '_test.go'));
      return fs.existsSync(path.join(this.projectRoot, cand)) ? cand : null;
    }
    return null;
  }

  /** Per-class success posterior (operators + regeneration) from the ledger's own dream episodes. */
  classStats(): Record<string, { n: number; pSuccess: number }> {
    const out: Record<string, { n: number; pSuccess: number }> = {};
    for (const op of OPERATORS) out[op.id] = { n: 0, pSuccess: betaMean(1, 1) };
    out[REGENERATION] = { n: 0, pSuccess: betaMean(1, 1) };
    try {
      const events = getEventLedger().byType('dream_episode');
      const counts: Record<string, { s: number; f: number }> = {};
      for (const e of events) {
        const p = e.payload || {};
        if ((p.generator !== 'mutation' && p.generator !== 'regeneration') || typeof p.op !== 'string' || p.killed !== true) continue;
        const c = counts[p.op] || (counts[p.op] = { s: 0, f: 0 });
        if (p.fixed) c.s++; else c.f++;
      }
      for (const [op, c] of Object.entries(counts)) {
        out[op] = { n: c.s + c.f, pSuccess: betaMean(1 + c.s, 1 + c.f) };
      }
    } catch { /* ledger optional */ }
    return out;
  }

  private classDifficulty(id: string): number {
    return id === REGENERATION ? REGENERATION_DIFFICULTY : (OPERATORS.find(o => o.id === id)?.difficulty ?? 99);
  }

  /**
   * 2-parameter IRT/Elo (v2 dream step 3): agent skill θ and per-class difficulty b,
   * P(success) = σ(θ − b), updated jointly per gradeable episode (Elo-style gradient,
   * K=0.1). Folded fresh from the ledger — a VIEW, deterministic and rebuildable like
   * everything else. Difficulty priors seed b so the model starts sane; per the plan's
   * cold-start rule the sampler only TRUSTS it once n ≥ 100.
   */
  irt(): { theta: number; b: Record<string, number>; n: number; active: boolean } {
    const bInit = (id: string) => (this.classDifficulty(id) - 2.5) * 0.8;
    const b: Record<string, number> = {};
    for (const op of OPERATORS) b[op.id] = bInit(op.id);
    b[REGENERATION] = bInit(REGENERATION);
    let theta = 0;
    let n = 0;
    try {
      for (const e of getEventLedger().byType('dream_episode')) {
        const p = e.payload || {};
        if ((p.generator !== 'mutation' && p.generator !== 'regeneration') || typeof p.op !== 'string' || p.killed !== true) continue;
        if (!(p.op in b)) b[p.op] = bInit(p.op);
        const pred = 1 / (1 + Math.exp(-(theta - b[p.op])));
        const err = (p.fixed ? 1 : 0) - pred;
        theta += IRT_K * err;
        b[p.op] -= IRT_K * err;
        n++;
      }
    } catch { /* ledger optional */ }
    return { theta, b, n, active: n >= IRT_MIN_N };
  }

  /**
   * Curriculum over ALL task classes (operators + regeneration): same frontier logic as
   * pickOperator, one more arm. Regeneration's high difficulty prior keeps it out of the
   * cold-start rotation until the mutation classes have data.
   */
  pickClass(): string {
    const ids = [...OPERATORS.map(o => o.id), REGENERATION];
    return this.frontierPick(ids);
  }

  /**
   * Shared sampler: cold start = difficulty prior (easiest two); Beta frontier below
   * IRT_MIN_N; IRT predictions above it, with the plan's mix — 20% easy (regression
   * canary), 10% hard (exploration, IRT mode only), rest at the P≈0.65 frontier.
   */
  private frontierPick(ids: string[]): string {
    const stats = this.classStats();
    const anyData = ids.some(id => (stats[id]?.n ?? 0) > 0);
    if (!anyData) {
      const sorted = [...ids].sort((a, b) => this.classDifficulty(a) - this.classDifficulty(b));
      return sorted[Math.floor(this.rng() * Math.min(2, sorted.length))];
    }
    const irt = this.irt();
    const pOf = irt.active
      ? (id: string) => 1 / (1 + Math.exp(-(irt.theta - (irt.b[id] ?? (this.classDifficulty(id) - 2.5) * 0.8))))
      : (id: string) => stats[id]?.pSuccess ?? 0.5;
    const r = this.rng();
    if (r < 0.2) return [...ids].sort((a, b) => pOf(b) - pOf(a))[0];               // easy floor
    if (irt.active && r < 0.3) return [...ids].sort((a, b) => pOf(a) - pOf(b))[0]; // hard exploration
    return [...ids].sort((a, b) =>
      Math.abs(pOf(a) - 0.65) - Math.abs(pOf(b) - 0.65)
      || this.classDifficulty(a) - this.classDifficulty(b)
    )[0];
  }

  /**
   * Practice-saturation check (the plan's plateau rule, honest minimal form): compare
   * the success rate of the older half vs the recent half of the last 40 gradeable
   * episodes. Saturated = enough data AND the recent half shows no improvement beyond
   * one combined standard error — then the sampler should shift generators or halt.
   */
  saturation(): { n: number; priorRate: number; recentRate: number; plateaued: boolean } {
    try {
      const eps = getEventLedger().byType('dream_episode')
        .filter(e => e.payload?.killed === true)
        .slice(-40)
        .map(e => (e.payload?.fixed ? 1 : 0) as number);
      const n = eps.length;
      if (n < 20) return { n, priorRate: 0, recentRate: 0, plateaued: false };
      const half = Math.floor(n / 2);
      const rate = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      const prior = rate(eps.slice(0, half));
      const recent = rate(eps.slice(half));
      const se = Math.sqrt(
        (prior * (1 - prior)) / half + (recent * (1 - recent)) / (n - half)
      );
      return { n, priorRate: prior, recentRate: recent, plateaued: recent - prior <= se };
    } catch {
      return { n: 0, priorRate: 0, recentRate: 0, plateaued: false };
    }
  }

  /**
   * Curriculum-lite: 20% of the time practice the easiest class (regression canary);
   * otherwise the class whose posterior sits closest to the maximally-informative
   * P(success) ≈ 0.65 frontier. Cold start falls back to the difficulty prior.
   */
  pickOperator(): MutationOperator {
    const id = this.frontierPick(OPERATORS.map(o => o.id));
    return OPERATORS.find(o => o.id === id) || OPERATORS[0];
  }

  /** Plant one mutation from `op` into the candidate file. Null when no line is eligible. */
  makeMutant(candidate: MutationCandidate, op: MutationOperator): MutantTask | null {
    let lines: string[];
    try { lines = fs.readFileSync(path.join(this.projectRoot, candidate.file), 'utf-8').split('\n'); }
    catch { return null; }
    const eligible: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('import ') || t.startsWith('export type')) continue;
      if (op.apply(lines[i]) !== null) eligible.push(i);
    }
    if (eligible.length === 0) return null;
    const line = eligible[Math.floor(this.rng() * eligible.length)];
    return {
      candidate, op: op.id, line: line + 1,
      original: lines[line],
      mutated: op.apply(lines[line])!,
    };
  }

  /**
   * One full self-play episode, either generator:
   * plant (a line defect, or a deleted function body) → verify the tests CATCH it
   * (else discard, log the verification gap) → commit the defect → sandboxed fix
   * attempt → objective grade → distill to ledger + exemplar → discard the worktree
   * (self-play fixes are never merged; the original is truth).
   */
  async selfPlay(
    log: (level: 'info' | 'success' | 'error', msg: string) => void = () => {},
    opts?: { generator?: 'mutation' | 'regeneration' }
  ): Promise<SelfPlayReport> {
    const report: SelfPlayReport = { attempted: false, survivors: 0 };
    const started = Date.now();

    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.projectRoot, stdio: 'pipe' });
    } catch {
      report.note = 'skipped: not a git repository';
      return report;
    }

    const candidates = this.findCandidates();
    if (candidates.length === 0) {
      report.note = 'skipped: no source file with a covering test found (convention tier)';
      return report;
    }

    const stamp = Date.now().toString(36);
    const branch = `dream/mut-${stamp}`;
    const worktrees = new WorktreeManager(this.projectRoot);
    let worktreePath: string;
    try {
      ({ worktreePath } = await worktrees.createWorktree(branch, 'HEAD'));
    } catch (e: any) {
      report.note = `skipped: could not create worktree (${e?.message})`;
      return report;
    }

    const generator = opts?.generator
      || (this.pickClass() === REGENERATION ? 'regeneration' : 'mutation');
    report.generator = generator;

    try {
      // PLANT — up to 4 attempts. A plant the tests don't catch (green on a defect) is
      // discarded AND logged, because "the tests didn't notice" is itself a finding (§9.6).
      // Either generator yields the same shape: a defective file, its ground truth, and
      // the prompt for the fixer.
      type Planted = {
        file: string; testFile: string; op: string; line: number;
        originalFile: string; originalLine?: string; defectPreview: string; prompt: string;
      };
      let planted: Planted | null = null;

      for (let attempt = 0; attempt < 4 && !planted; attempt++) {
        const cand = candidates[Math.floor(this.rng() * candidates.length)];
        const absFile = path.join(worktreePath, cand.file);
        const originalFile = fs.readFileSync(absFile, 'utf-8');
        const lines = originalFile.split('\n');
        let attemptPlant: Planted | null = null;

        if (generator === 'regeneration') {
          const fns = findFunctions(lines, cand.file.endsWith('.go'));
          if (fns.length === 0) continue;
          const fn = fns[Math.floor(this.rng() * fns.length)];
          const stub = cand.file.endsWith('.go')
            ? '\tpanic("not implemented") // bimax dream: regenerate from the tests'
            : `  throw new Error('not implemented'); // bimax dream: regenerate from the tests`;
          fs.writeFileSync(absFile, [...lines.slice(0, fn.bodyStart - 1), stub, ...lines.slice(fn.bodyEnd)].join('\n'), 'utf-8');
          attemptPlant = {
            file: cand.file, testFile: cand.testFile, op: REGENERATION, line: fn.sigLine,
            originalFile, defectPreview: `body of ${fn.name}() deleted`,
            prompt:
              `The test file \`${cand.testFile}\` is failing: the function \`${fn.name}\` in \`${cand.file}\` is an ` +
              `unimplemented stub. Implement it from its signature and the expectations in the tests ` +
              `(do NOT change the tests). Verify by re-running that test file before finishing. ` +
              `You are in an isolated practice worktree — work only here.`,
          };
        } else {
          const t = this.makeMutant(cand, this.pickOperator());
          if (!t) continue;
          lines[t.line - 1] = t.mutated;
          fs.writeFileSync(absFile, lines.join('\n'), 'utf-8');
          attemptPlant = {
            file: cand.file, testFile: cand.testFile, op: t.op, line: t.line,
            originalFile, originalLine: t.original, defectPreview: t.mutated.trim().slice(0, 200),
            prompt:
              `The test file \`${cand.testFile}\` is failing. Run it, diagnose the defect in the source it covers, ` +
              `and fix the source (do NOT change the tests). Verify by re-running that test file before finishing. ` +
              `You are in an isolated practice worktree — work only here.`,
          };
        }

        log('info', `Planted ${attemptPlant.op} in ${attemptPlant.file}:${attemptPlant.line} — checking the tests catch it…`);
        const check = this.runCheck(worktreePath, attemptPlant.testFile);
        if (check.ok) {
          report.survivors++;
          getEventLedger().append('mutant_survived', { file: attemptPlant.file, testFile: attemptPlant.testFile, op: attemptPlant.op, line: attemptPlant.line });
          log('info', `Defect SURVIVED its tests (${attemptPlant.testFile}) — discarded, verification gap logged.`);
          fs.writeFileSync(absFile, originalFile, 'utf-8');
          continue;
        }
        planted = attemptPlant;
      }

      if (!planted) {
        report.note = report.survivors > 0
          ? `no gradeable defect: ${report.survivors} plant(s) survived their tests — that's a test-coverage finding, not an agent failure`
          : generator === 'regeneration'
            ? 'no function with a 3–40 line body found in the sampled candidates'
            : 'no eligible mutation site found in the sampled candidates';
        return report;
      }

      report.attempted = true;
      report.killed = true;
      report.task = { file: planted.file, testFile: planted.testFile, op: planted.op, line: planted.line };

      // Commit the planted defect so `git diff`/`git status` in the worktree are clean —
      // the agent must diagnose from the failing tests, not read the answer.
      await worktrees.commitChanges(worktreePath, `chore: snapshot (${stamp})`);

      log('info', `Defect killed by ${planted.testFile} — dispatching sandboxed fix attempt…`);
      try {
        await this.attemptFix(worktreePath, planted.prompt, stamp);
      } catch (e: any) {
        log('error', `Fix attempt errored: ${e?.message}`);
      }

      // Objective grade — the same check that killed the defect, plus ground truth:
      // mutation compares the mutated LINE (reformats elsewhere shouldn't fail "exact");
      // regeneration compares the whole file (only a byte-identical body is "exact").
      const after = this.runCheck(worktreePath, planted.testFile);
      report.fixed = after.ok;
      if (after.ok) {
        const fixedContent = fs.readFileSync(path.join(worktreePath, planted.file), 'utf-8');
        report.exactRestore = planted.originalLine !== undefined
          ? fixedContent.split('\n')[planted.line - 1] === planted.originalLine
          : fixedContent === planted.originalFile;
      }
      report.durationMs = Date.now() - started;

      getEventLedger().append('dream_episode', {
        generator,
        op: planted.op, file: planted.file, testFile: planted.testFile, line: planted.line,
        killed: true, fixed: report.fixed, exactRestore: report.exactRestore ?? false,
        survivors: report.survivors, durationMs: report.durationMs,
      });

      if (report.fixed) {
        this.appendExemplar({
          at: new Date().toISOString(),
          kind: generator === 'regeneration' ? 'regeneration' : 'mutation-fix',
          op: planted.op, file: planted.file, testFile: planted.testFile,
          outcome: report.exactRestore ? 'exact' : generator === 'regeneration' ? 'regenerated' : 'alternative',
          defect: planted.defectPreview,
          fix: report.exactRestore && planted.originalLine
            ? planted.originalLine.trim().slice(0, 200)
            : '(verified by the covering tests)',
        });
        log('success', `Fix ${report.exactRestore ? 'EXACTLY restored the original' : 'passed the covering tests'} — exemplar stored.`);
      } else {
        log('info', 'Fix attempt failed the objective grade — the failure event is the lesson.');
      }
      return report;
    } finally {
      try { await worktrees.removeWorktree(branch, true); } catch { /* best-effort cleanup */ }
    }
  }

  /** Verified-outcome exemplars — retrieval-augmented prompting's corpus (embeddings later). */
  private appendExemplar(ex: Record<string, any>): void {
    try {
      const file = path.join(stateDir('.bimax', this.projectRoot), 'exemplars.json');
      let all: any[] = [];
      try { const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')); if (Array.isArray(parsed)) all = parsed; } catch { /* first exemplar */ }
      all.push(ex);
      if (all.length > 200) all.splice(0, all.length - 200);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }

  exemplars(): any[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(stateDir('.bimax', this.projectRoot), 'exemplars.json'), 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
}
