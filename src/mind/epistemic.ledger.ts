import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { mindSingletonRoot } from './self.model';
import { wilsonInterval, isotonicFit, expectedCalibrationError } from './stats';
import { TestDependencyMap, importReachable } from '../substrate/tdm';

/**
 * EpistemicLedger v2 — calibrated confidence with SCOPED attribution.
 *
 * v1's fatal flaw: any build/test evidence within 15 minutes resolved EVERY open claim,
 * so one pre-existing red test refuted innocent edits and the calibration curve
 * converged to biased noise. v2 resolves a claim only with evidence that plausibly
 * COVERS it:
 *
 *   - Claims carry the FILE they mutated.
 *   - RED evidence refutes only claims whose file appears in the failure output
 *     (compiler/test runners print paths — tsc `a.ts(12,3)`, jest `FAIL src/x.test.ts`,
 *     go `./pkg/f.go:33`). Red output naming no files resolves NOTHING — it is
 *     counted as unattributed evidence instead of poisoning the labels.
 *   - GREEN evidence from a repo-wide command (no path arguments) confirms all open
 *     claims in the window — a green full check is legitimately global. Green from a
 *     path-scoped command (e.g. `jest src/x.test.ts`) confirms only matching claims.
 *
 * From resolved claims: a calibration curve (stated confidence deciles vs. observed
 * accuracy) and overconfident domains that get a verification-escalation prompt rule.
 * Unresolved claims expire — silence is not evidence — and the expiry rate itself is
 * reported (it measures how much of the agent's work nothing ever verifies).
 */

export interface OpenClaim {
  id?: string;        // legacy claims may lack identity; never eligible for background settlement
  domain: string;      // file extension the mutation touched
  file?: string;       // the mutated path — the scoping key
  confidence: number;  // 0..1, stated at claim time (grounded in the self-model)
  at: number;          // epoch ms
}

/** Engine-authored receipt describing both settlement and the exact verification scope. */
export interface EvidenceResolution {
  settled: number;
  coveredFiles: string[];
  /** True only for a successful evidence command with no path arguments. */
  repoWide: boolean;
}

interface Bucket { n: number; correct: number }

interface DomainStat { n: number; correct: number; confSum: number }

interface LedgerFile {
  version: 2;
  open: OpenClaim[];
  buckets: Bucket[];             // 10 deciles: [0-10%), [10-20%) … [90-100%]
  domains: Record<string, DomainStat>;
  expired: number;               // claims that timed out unverified (verification-coverage gap)
  unattributed: number;          // red evidence that named no files (couldn't be scoped)
}

export const CLAIM_TTL_MS = 30 * 60_000;   // unresolved claims expire — silence is not evidence
const EVIDENCE_WINDOW_MS = 15 * 60_000; // evidence only resolves claims this recent
const MIN_DOMAIN_SAMPLES = 5;       // weighted samples before a domain can escalate

// Attribution weights (the plan's TDM tiers, path-evidence flavor): an exact path-suffix
// match is strong evidence about THAT claim; a basename-only match might be a same-named
// file elsewhere; a repo-wide green check is legitimately global.
const W_EXACT = 1.0;
const W_BASENAME = 0.7;

/** Does this shell command produce correctness evidence (build/test/typecheck)? */
export function isEvidenceCommand(command: string): boolean {
  const c = (command || '').toLowerCase();
  if (/\b(node\s+--test|bun\s+test)\b/.test(c)) return true;
  return /\b(npm (run )?(test|build)|npx? (tsc|jest|vitest|eslint)|yarn (test|build)|pnpm (test|build)|go (build|test|vet)|cargo (build|test|check)|pytest|tsc\b|jest\b|vitest\b|make (test|build|check))\b/.test(c);
}

/** File-ish tokens in a shell command (path arguments) — used to detect scoped vs repo-wide runs. */
export function commandPathTokens(command: string): string[] {
  return (command || '')
    .split(/\s+/)
    .filter(t => !t.startsWith('-') && /\.[A-Za-z]{1,5}$/.test(t) && !/^\d+\.\d+/.test(t))
    .map(t => t.replace(/^['"]|['"]$/g, ''));
}

export const EVIDENCE_OUTPUT_MAX_CHARS = 20_000; // existing diagnostic parser input ceiling

/** Source-file paths named in build/test output (tsc, jest, vitest, go, cargo, pytest formats). */
export function outputFilePaths(output: string): string[] {
  const found = new Set<string>();
  const re = /([A-Za-z0-9_$@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|rb|c|cc|cpp|h|hpp))(?=[:(\s'"]|$)/gm;
  let m: RegExpExecArray | null;
  const capped = (output || '').slice(0, EVIDENCE_OUTPUT_MAX_CHARS);
  while ((m = re.exec(capped)) !== null) {
    found.add(m[1]);
    if (found.size >= 50) break;
  }
  return Array.from(found);
}

/**
 * Files a runner's own LCOV report proves it EXECUTED (`SF:` with a non-zero `LH:`).
 *
 * This is the only positive scope accepted. Green stdout cannot supply one: measured on
 * node 22.23.1 under piped capture, `node --test` names only test names on success and
 * jest prints aggregate counts with no per-file line even at `--verbose`, while both name
 * paths on failure. Reporters report exceptions, not the routine.
 *
 * Coverage is independent of the command in the way that matters: a path can be named on
 * the command line and still never run — filtered, skipped, or never imported — and such a
 * file gets no `SF:` record at all. `SF:` carries the full project-relative path, so no
 * basename reassembly (and therefore no basename matching) is involved. `LH: 0` is not
 * verification: the file was loaded but nothing in it ran. A record stranded without its
 * `LH:` by a truncated tail counts as nothing, never as a hit.
 */
export function coverageExecutedPaths(output: string): string[] {
  const executed = new Set<string>();
  const capped = (output || '').slice(0, EVIDENCE_OUTPUT_MAX_CHARS);
  let file: string | null = null;
  for (const raw of capped.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) { file = line.slice(3).trim() || null; continue; }
    if (!file) continue;
    if (line === 'end_of_record') { file = null; continue; }
    if (line.startsWith('LH:')) {
      const hit = Number(line.slice(3).trim());
      if (Number.isInteger(hit) && hit > 0) executed.add(file);
      file = null;
      if (executed.size >= 50) break;
    }
  }
  return Array.from(executed);
}

/**
 * How strongly does the named evidence cover this claim's file?
 * 1.0 = a path-suffix match (same file), 0.7 = basename-only (could be a same-named
 * file elsewhere — evidence, but weaker), 0 = not covered at all.
 */
function matchWeight(claimFile: string | undefined, evidencePaths: string[]): number {
  if (!claimFile || evidencePaths.length === 0) return 0;
  const cBase = path.basename(claimFile);
  const cNorm = claimFile.replace(/\\/g, '/');
  let best = 0;
  for (const p of evidencePaths) {
    const pNorm = p.replace(/\\/g, '/');
    if (pNorm.endsWith(cNorm) || cNorm.endsWith(pNorm)) return W_EXACT;
    if (path.basename(pNorm) === cBase) best = Math.max(best, W_BASENAME);
  }
  return best;
}

/**
 * Import-tier reachability over the live code graph, resolved lazily (and via require,
 * so mind ↛ memory doesn't become a static import cycle). Unavailable graph = tier off.
 */
function graphImportReach(from: string, to: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getContextManagerGraphStore } = require('../memory/context.manager');
    const store = getContextManagerGraphStore();
    return store ? importReachable(store, from, to) : false;
  } catch { return false; }
}

export class EpistemicLedger {
  private data: LedgerFile = {
    version: 2,
    open: [],
    buckets: Array.from({ length: 10 }, () => ({ n: 0, correct: 0 })),
    domains: {},
    expired: 0,
    unattributed: 0,
  };
  private loaded = false;
  private dirty = false;
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private tdm: TestDependencyMap;

  constructor(projectRoot: string = process.cwd()) {
    this.filePath = path.join(projectRoot, '.bimax', 'epistemic.json');
    this.tdm = new TestDependencyMap(projectRoot);
  }

  /**
   * Path heuristics OR the Test-Dependency Map, whichever covers more strongly. The TDM
   * is what lets `jest src/__tests__/x.test.ts` evidence settle a claim on `src/x.ts` —
   * different paths, but the map knows that check verifies that file (coverage 1.0 /
   * naming convention 0.7 / import reachability 0.3).
   */
  private coverWeight(claimFile: string | undefined, evidencePaths: string[]): number {
    let best = matchWeight(claimFile, evidencePaths);
    if (!claimFile || best >= W_EXACT) return best;
    for (const p of evidencePaths) {
      const hit = this.tdm.weightFor(p, claimFile, { importReach: graphImportReach });
      if (hit && hit.weight > best) best = hit.weight;
      if (best >= W_EXACT) break;
    }
    return best;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (parsed && Array.isArray(parsed.open) && Array.isArray(parsed.buckets) && parsed.buckets.length === 10 && parsed.domains) {
        this.data = {
          version: 2,
          open: parsed.open,
          buckets: parsed.buckets,
          domains: parsed.domains,
          expired: parsed.expired || 0,
          unattributed: parsed.unattributed || 0,
        };
      }
    } catch { /* first run */ }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1500);
    this.saveTimer.unref?.();
  }

  saveNow(): void {
    if (!this.dirty) return;
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(temporary, this.filePath);
      this.dirty = false;
    } catch { /* retain dirty state for retry; old complete snapshot remains readable */ }
    finally { try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ } }
  }

  private expire(now: number): void {
    const before = this.data.open.length;
    this.data.open = this.data.open.filter(c => now - c.at <= CLAIM_TTL_MS);
    this.data.expired += before - this.data.open.length;
  }

  /** A mutating tool succeeded — the agent implicitly claims the change is correct. */
  openClaim(domain: string, confidence: number, file?: string): string {
    this.load();
    const now = Date.now();
    this.expire(now);
    const id = randomUUID();
    this.data.open.push({ id, domain, file, confidence: Math.min(1, Math.max(0, confidence)), at: now });
    this.scheduleSave();
    return id;
  }

  /** Immutable launch-time claim identities for delayed evidence. */
  claimSnapshot(): OpenClaim[] {
    this.load();
    return this.data.open.map(claim => ({ ...claim }));
  }

  /** Weighted settlement — a claim resolved by weaker evidence moves the stats less. */
  private settle(claims: { claim: OpenClaim; w: number }[], evidenceOk: boolean): void {
    for (const { claim: c, w } of claims) {
      const bucket = Math.min(9, Math.floor(c.confidence * 10));
      this.data.buckets[bucket].n += w;
      if (evidenceOk) this.data.buckets[bucket].correct += w;
      const d = this.data.domains[c.domain] || (this.data.domains[c.domain] = { n: 0, correct: 0, confSum: 0 });
      d.n += w;
      d.confSum += c.confidence * w;
      if (evidenceOk) d.correct += w;
    }
  }

  /**
   * Hard evidence arrived (build/test run). Resolves only the open claims the evidence
   * COVERS (see module docs). Returns how many claims were settled.
   */
  resolveDetailed(evidenceOk: boolean, opts?: { command?: string; output?: string; claimIds?: readonly string[]; exactFiles?: readonly string[] }): EvidenceResolution {
    this.load();
    const now = Date.now();
    this.expire(now);
    const cmdPaths = commandPathTokens(opts?.command || '');
    // Attested scope is deliberately narrow: it never widens into a repo-wide settle.
    const repoWide = evidenceOk && opts?.exactFiles === undefined && cmdPaths.length === 0;
    const inWindow = this.data.open.filter(c => now - c.at <= EVIDENCE_WINDOW_MS
      && (opts?.claimIds === undefined || (!!c.id && opts.claimIds.includes(c.id))));
    if (inWindow.length === 0) return { settled: 0, coveredFiles: [], repoWide };

    // Opportunistic TDM growth: a path-scoped coverage run just PROVED which files that
    // check executes — remember it for every future attribution (v2 §3.4 tier 1).
    try { this.tdm.ingestCoverageRun(opts?.command || ''); } catch { /* best-effort */ }

    let covered: { claim: OpenClaim; w: number }[];

    if (evidenceOk) {
      // Green: a repo-wide run is legitimately global (full weight); a path-scoped run
      // covers only claims whose file it plausibly targets, at the match tier's weight.
      // Attested green: the caller proved which files the run EXECUTED, so only those
      // claims settle — never the command's targets, which express intent, not outcome.
      covered = opts?.exactFiles !== undefined
        ? inWindow.map(c => ({ claim: c, w: c.file && opts.exactFiles!.includes(c.file) ? W_EXACT : 0 })).filter(x => x.w > 0)
        : cmdPaths.length === 0
          ? inWindow.map(c => ({ claim: c, w: W_EXACT }))
          : inWindow.map(c => ({ claim: c, w: this.coverWeight(c.file, cmdPaths) })).filter(x => x.w > 0);
    } else {
      // Red: only claims whose file the FAILURE OUTPUT names are refuted. A red run
      // that names no files (or only files nobody claimed) refutes nothing — the
      // failure may predate every open claim, and guessing poisons calibration.
      const failPaths = outputFilePaths(opts?.output || '');
      const scope = failPaths; // A command target is not a file named by the failure.
      if (scope.length === 0) {
        this.data.unattributed++;
        this.scheduleSave();
        return { settled: 0, coveredFiles: [], repoWide: false };
      }
      covered = inWindow.map(c => ({ claim: c, w: opts?.exactFiles !== undefined
        ? (c.file && opts.exactFiles.includes(c.file) ? W_EXACT : 0)
        : this.coverWeight(c.file, scope) })).filter(x => x.w > 0);
      if (covered.length === 0) this.data.unattributed++;
    }

    if (covered.length > 0) {
      const coveredSet = new Set(covered.map(x => x.claim));
      this.data.open = this.data.open.filter(c => !coveredSet.has(c));
      this.settle(covered, evidenceOk);
    }
    this.scheduleSave();
    return {
      settled: covered.length,
      coveredFiles: [...new Set(covered.map(item => item.claim.file).filter((file): file is string => !!file))].sort(),
      repoWide,
    };
  }

  /** Backwards-compatible count-only API used by calibration callers. */
  resolve(evidenceOk: boolean, opts?: { command?: string; output?: string }): number {
    return this.resolveDetailed(evidenceOk, opts).settled;
  }

  /**
   * Domains whose overconfidence is STATISTICALLY significant: stated confidence lies
   * above the Wilson 95% upper bound of observed accuracy. No fixed gap threshold —
   * small samples get wide intervals and simply can't escalate yet (v2 §4.2 in the
   * honest pre-bootstrap form).
   */
  overconfidentDomains(): { domain: string; stated: number; observed: number; n: number }[] {
    this.load();
    const out: { domain: string; stated: number; observed: number; n: number }[] = [];
    for (const [domain, d] of Object.entries(this.data.domains)) {
      if (d.n < MIN_DOMAIN_SAMPLES) continue;
      const stated = d.confSum / d.n;
      const observed = d.correct / d.n;
      if (stated > wilsonInterval(d.correct, d.n).hi) out.push({ domain, stated, observed, n: d.n });
    }
    return out.sort((a, b) => (b.stated - b.observed) - (a.stated - a.observed));
  }

  /** Global weighted ECE over the decile bins — the one-number calibration summary. */
  ece(): number {
    this.load();
    return expectedCalibrationError(
      this.data.buckets
        .map((b, i) => ({ conf: i / 10 + 0.05, acc: b.n > 0 ? b.correct / b.n : 0, w: b.n }))
        .filter(b => b.w > 0)
    );
  }

  /** Monotone reliability curve (PAV isotonic fit over the decile bins). */
  isotonicCurve(): { stated: number; corrected: number }[] {
    this.load();
    const pts = this.data.buckets
      .map((b, i) => ({ x: i / 10 + 0.05, y: b.n > 0 ? b.correct / b.n : 0, w: b.n }))
      .filter(p => p.w > 0);
    return isotonicFit(pts).map(p => ({ stated: p.x, corrected: p.yhat }));
  }

  /** Escalation rule for the prompt — only when there's a real calibration gap. */
  getPromptBlock(): string {
    const over = this.overconfidentDomains().slice(0, 3);
    if (over.length === 0) return '';
    const lines = over.map(o =>
      `- \`${o.domain}\`: you claim ${Math.round(o.stated * 100)}% confidence but are right only ${Math.round(o.observed * 100)}% of the time (n=${Math.round(o.n * 10) / 10}, significant at 95%). In this domain, ALWAYS run the build/tests before declaring a change done.`
    );
    return `### CALIBRATION (your measured overconfidence — escalate verification)\n${lines.join('\n')}`;
  }

  /** Aggregate counters — feeds the verification-coverage drive and /self. */
  stats(): { resolved: number; expired: number; open: number; unattributed: number } {
    this.load();
    return {
      resolved: this.data.buckets.reduce((a, b) => a + b.n, 0),
      expired: this.data.expired,
      open: this.data.open.length,
      unattributed: this.data.unattributed,
    };
  }

  /** Calibration curve rows for /self — stated-confidence decile vs. observed accuracy. */
  calibration(): { range: string; n: number; observed: number }[] {
    this.load();
    return this.data.buckets
      .map((b, i) => ({ range: `${i * 10}–${i * 10 + 10}%`, n: b.n, observed: b.n > 0 ? b.correct / b.n : 0 }))
      .filter(r => r.n > 0);
  }

  report(): string[] {
    this.load();
    const rows = this.calibration();
    const totalResolved = rows.reduce((a, r) => a + r.n, 0);
    if (totalResolved === 0 && this.data.expired === 0) {
      return ['- No resolved claims yet — claims open on edits and resolve when a build/test run names (or clears) the touched files.'];
    }
    const lines = [`- Resolved (weighted): ${Math.round(totalResolved * 10) / 10} · open: ${this.data.open.length} · expired unverified: ${this.data.expired} · unattributed red evidence: ${this.data.unattributed}`];
    if (totalResolved > 0) {
      lines.push(`- ECE ${Math.round(this.ece() * 100)}% (weighted decile bins, isotonic-monotone curve below)`);
    }
    const verified = totalResolved + this.data.expired > 0
      ? Math.round((totalResolved / (totalResolved + this.data.expired)) * 100)
      : 0;
    if (this.data.expired > 0) {
      lines.push(`- Verification coverage: ${verified}% of claims ever met evidence — the rest is work nothing checks.`);
    }
    for (const r of rows) {
      lines.push(`  · stated ${r.range}: observed ${Math.round(r.observed * 100)}% correct (n=${Math.round(r.n * 10) / 10})`);
    }
    const over = this.overconfidentDomains();
    if (over.length > 0) {
      lines.push(`- ⚠ Overconfident in: ${over.map(o => `${o.domain} (${Math.round(o.stated * 100)}%→${Math.round(o.observed * 100)}%)`).join(', ')} — verification escalated.`);
    } else if (totalResolved > 0) {
      lines.push('- Calibration healthy — no domain shows an overconfidence gap.');
    }
    return lines;
  }
}

let _global: EpistemicLedger | null = null;
export function getEpistemicLedger(): EpistemicLedger {
  if (!_global) {
    _global = new EpistemicLedger(mindSingletonRoot());
    process.once('exit', () => { try { _global?.saveNow(); } catch { /* exiting */ } });
  }
  return _global;
}
export function __setEpistemicLedger(l: EpistemicLedger | null): void { _global = l; }
