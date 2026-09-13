import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getEventLedger } from './event.ledger';
import { getTracer } from '../telemetry/trace';
import { Logger } from '../utils/logger';

/**
 * Counterfactual Harness Lab — experiment model + store (INFRA P4 #10).
 *
 * A proposed harness patch is no longer judged on live traffic first: it becomes a
 * counterfactual EXPERIMENT evaluated offline against recorded episodes (see
 * harness.lab.eval.ts) before it may inject a single live prompt token. This module owns
 * the durable half: the typed experiment record (immutable candidate identity, cohort
 * manifest + hash, paired per-episode results, gate evidence, verdict), its lifecycle,
 * and the on-disk store under .bimax/harness-lab/.
 *
 * Design invariants:
 *   - Experiment id is DERIVED from the candidate's content (tool|errorClass|rule), so
 *     concurrent sessions creating "the same" experiment converge on one file instead of
 *     duplicating — idempotency by construction, no lock daemon.
 *   - One JSON file per experiment, written atomically (tmp + rename). A corrupt file is
 *     quarantined (renamed aside, ledger-audited), never silently deleted or trusted.
 *   - Every lifecycle transition is guarded (illegal moves refused) and lands in the
 *     event ledger + trace layer, so create→evaluate→verdict→activate/reject/rollback is
 *     auditable end to end.
 *   - Artifacts store hashes, counts, and gate evidence — never raw episode content or
 *     recorded prompts (episodes already live in .bimax/episodes/; no second copy).
 */

// ---------------------------------------------------------------------------
// Typed experiment model
// ---------------------------------------------------------------------------

export type LabVerdict = 'pass' | 'insufficient_evidence' | 'veto';

export type ExperimentStatus =
  | 'pending'      // created, no evaluation yet
  | 'evaluated'    // has ≥1 evaluation; latest verdict did not activate or veto
  | 'activated'    // candidate went live (lab pass or manual approval)
  | 'rejected'     // candidate refused (gate veto or manual) — terminal
  | 'rolled_back'; // was activated, then reverted — terminal

/** Immutable identity of the steering change under test. */
export interface LabCandidate {
  /** HarnessPatch id this candidate came from (audit link; not part of identity). */
  patchId: string;
  tool: string;
  errorClass: string;
  rule: string;
  /** The exact system-prompt block the candidate arm appends (renderHarnessBlock([rule])). */
  promptBlock: string;
  /** sha256 of promptBlock — the candidate arm's identity. */
  blockHash: string;
}

export interface CohortEpisodeRef {
  id: string;
  file: string;
  startedAt: number;
  calls: number;
  /** sha256 of the bundle file bytes — pins the exact recording the experiment saw. */
  contentHash: string;
  /** Episode actually calls the candidate's target tool (carries effect signal). */
  signalBearing: boolean;
}

export interface CohortSkip { id: string; reason: string }

export interface CohortManifest {
  selectedAt: number;
  criteria: { limit: number; minCalls: number };
  episodes: CohortEpisodeRef[];
  /** Every considered-but-excluded episode with its reason — nothing is skipped silently. */
  skipped: CohortSkip[];
  /** sha256 over the ordered episode content hashes — the cohort's identity. */
  cohortHash: string;
}

/** One arm's hermetic replay outcome for one episode. */
export interface ArmReplayResult {
  /** The loop finished on recorded data (no crash, no unrecoverable replay error). */
  completed: boolean;
  /** Bit-for-bit trajectory match with the recording (baseline requirement). */
  identical: boolean;
  callsRecorded: number;
  callsServed: number;
  divergences: number;
  firstDivergence: number | null;
  toolResultsMissing: number;
  /** sha256(finalText) — lets pairs compare outputs without persisting transcript text. */
  finalTextHash: string;
  error?: string;
}

/** Recorded-failure census for one episode (ledger-correlated, typed outcomes). */
export interface EpisodeCensus {
  /** False when the ledger anchor for this episode is missing — evidence unavailable. */
  available: boolean;
  targetToolCalls: number;
  /** Failures on the target tool matching the candidate's errorClass. */
  targetHits: number;
  otherToolFailures: number;
}

export interface EpisodePairResult {
  episodeId: string;
  signalBearing: boolean;
  baseline: ArmReplayResult;
  candidate: ArmReplayResult;
  census: EpisodeCensus;
  /** Baseline replayed bit-for-bit — only then is the pair a valid instrument. */
  usable: boolean;
  excludedReason?: string;
}

export interface GateResult {
  gate: string;
  pass: boolean;
  /** 'measured' = computed from recorded data; 'proxy' = an honest stand-in, labeled. */
  basis: 'measured' | 'proxy';
  detail: string;
  /** Failing a veto gate is terminal for the candidate (retire), not just "wait for data". */
  veto: boolean;
}

export interface LabEvaluation {
  /** ev-<sha256(blockHash|cohortHash)> — deterministic: same candidate × cohort ⇒ same id. */
  id: string;
  at: number;
  backend: string;
  cohort: CohortManifest;
  pairs: EpisodePairResult[];
  aggregate: {
    episodesSelected: number;
    episodesUsable: number;
    signalEpisodes: number;
    censusEpisodes: number;
    targetToolCalls: number;
    targetHits: number;
    targetFailureRate: { point: number; wilsonLo: number; wilsonHi: number } | null;
    /** Fraction of usable pairs whose candidate arm completed cleanly (must be 1). */
    candidateCompletion: number;
    promptCostChars: number;
    approxPromptCostTokens: number;
  };
  gates: GateResult[];
  verdict: LabVerdict;
  vetoReasons: string[];
  confidence: 'high' | 'moderate' | 'low';
  /** Honesty rail: caveats + the measured-vs-inferred boundary, rendered by /harness lab explain. */
  notes: string[];
}

export interface ExperimentTransition {
  at: number;
  from: ExperimentStatus | null;
  to: ExperimentStatus;
  reason?: string;
  by: 'auto' | 'user';
}

export interface Experiment {
  v: 1;
  id: string;
  status: ExperimentStatus;
  createdAt: number;
  updatedAt: number;
  candidate: LabCandidate;
  /** The control arm is each episode's own recorded prompt — pinned by the cohort manifest. */
  baseline: { kind: 'recorded-episodes'; description: string };
  /** Append-only evaluation history; the latest entry governs status decisions. */
  evaluations: LabEvaluation[];
  statusReason?: string;
  transitions: ExperimentTransition[];
}

// ---------------------------------------------------------------------------
// Identity + rendering helpers (shared with the tuner — no tuner import, no cycle)
// ---------------------------------------------------------------------------

const BLOCK_HEADER =
  '### HARNESS PATCHES (self-tuned — mined from YOUR OWN recent failures; each is auto-retired if it stops helping)';

/** The one place the live prompt block is rendered — tuner and lab share it byte-for-byte. */
export function renderHarnessBlock(rules: string[]): string {
  if (rules.length === 0) return '';
  return `${BLOCK_HEADER}\n${rules.map(r => `- ${r}`).join('\n')}`;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Deterministic experiment id from candidate content — same candidate ⇒ same experiment. */
export function experimentIdFor(c: { tool: string; errorClass: string; rule: string }): string {
  return `cx-${sha256(`${c.tool}|${c.errorClass}|${c.rule}`).slice(0, 12)}`;
}

export function candidateFrom(p: { id: string; tool: string; errorClass: string; rule: string }): LabCandidate {
  const promptBlock = renderHarnessBlock([p.rule]);
  return {
    patchId: p.id,
    tool: p.tool,
    errorClass: p.errorClass,
    rule: p.rule,
    promptBlock,
    blockHash: sha256(promptBlock),
  };
}

/** The lab gate is on by default; BIMAX_HARNESS_LAB=0 restores legacy immediate activation. */
export function labEnabled(): boolean {
  return process.env.BIMAX_HARNESS_LAB !== '0';
}

// ---------------------------------------------------------------------------
// Ledger + trace plumbing — every lab action is auditable and correlatable
// ---------------------------------------------------------------------------

export function labEvent(action: string, fields: Record<string, any>): void {
  try { getEventLedger().append('harness_lab', { action, ...fields }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<ExperimentStatus> = new Set(['rejected', 'rolled_back']);
const LEGAL_MOVES: Record<ExperimentStatus, ExperimentStatus[]> = {
  pending: ['evaluated', 'activated', 'rejected'],
  evaluated: ['evaluated', 'activated', 'rejected'],
  activated: ['rolled_back'],
  rejected: [],
  rolled_back: [],
};
const EXPERIMENTS_KEPT = 50; // terminal experiments pruned beyond this (oldest first)

export class HarnessLabStore {
  constructor(private root: string) {}

  dir(): string {
    return path.join(stateDir('.bimax', this.root), 'harness-lab');
  }

  private fileFor(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  }

  /** Atomic write: no reader ever observes a half-written experiment. */
  private write(exp: Experiment): void {
    fs.mkdirSync(this.dir(), { recursive: true });
    const file = this.fileFor(exp.id);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(exp, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }

  /**
   * Load one experiment file; a corrupt/incompatible one is QUARANTINED (renamed aside,
   * ledger-audited) so the store recovers instead of crashing or silently trusting it.
   */
  private read(file: string): Experiment | null {
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { return null; }
    try {
      const exp = JSON.parse(raw);
      if (exp?.v !== 1 || typeof exp.id !== 'string' || !exp.candidate || !Array.isArray(exp.evaluations)) {
        throw new Error('unrecognized experiment shape');
      }
      return exp as Experiment;
    } catch (e: any) {
      const quarantined = `${file}.corrupt-${Date.now().toString(36)}`;
      try { fs.renameSync(file, quarantined); } catch { /* leave in place if rename fails */ }
      Logger.warn(`[HarnessLab] Quarantined corrupt experiment file ${path.basename(file)} (${e?.message}).`);
      labEvent('recovered', { file: path.basename(file), quarantined: path.basename(quarantined), error: String(e?.message || e).slice(0, 200) });
      return null;
    }
  }

  list(): Experiment[] {
    let files: string[];
    try { files = fs.readdirSync(this.dir()).filter(f => f.startsWith('cx-') && f.endsWith('.json')); } catch { return []; }
    const out: Experiment[] = [];
    for (const f of files.sort()) {
      const exp = this.read(path.join(this.dir(), f));
      if (exp) out.push(exp);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  get(id: string): Experiment | null {
    return this.read(this.fileFor(id));
  }

  /**
   * Create-or-load, idempotent: the id is content-derived, so two racing sessions write
   * the same initial record to the same file — the race collapses into one experiment.
   */
  getOrCreate(candidate: LabCandidate): { exp: Experiment; created: boolean } {
    const id = experimentIdFor(candidate);
    const existing = this.get(id);
    if (existing) return { exp: existing, created: false };
    const now = Date.now();
    const exp: Experiment = {
      v: 1,
      id,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      candidate,
      baseline: {
        kind: 'recorded-episodes',
        description: 'each cohort episode replayed under its own recorded system prompt (paired control)',
      },
      evaluations: [],
      transitions: [{ at: now, from: null, to: 'pending', by: 'auto', reason: 'staged by HarnessTuner' }],
    };
    this.write(exp);
    labEvent('created', { expId: id, patchId: candidate.patchId, tool: candidate.tool, errorClass: candidate.errorClass });
    getTracer().startSpan('harness.lab.create', { expId: id, tool: candidate.tool, errorClass: candidate.errorClass }).end();
    this.prune();
    return { exp, created: true };
  }

  /** Append one evaluation (dedup by deterministic evaluation id) and mark 'evaluated'. */
  appendEvaluation(id: string, ev: LabEvaluation): Experiment | null {
    const exp = this.get(id);
    if (!exp || TERMINAL.has(exp.status)) return null;
    if (!exp.evaluations.some(e => e.id === ev.id)) exp.evaluations.push(ev);
    if (exp.status !== 'activated') {
      this.recordTransition(exp, 'evaluated', `verdict: ${ev.verdict}`, 'auto');
    }
    exp.updatedAt = Date.now();
    this.write(exp);
    labEvent('evaluated', {
      expId: id, evaluationId: ev.id, verdict: ev.verdict, cohortHash: ev.cohort.cohortHash,
      episodes: ev.cohort.episodes.length, usable: ev.aggregate.episodesUsable, confidence: ev.confidence,
    });
    return exp;
  }

  /** Guarded lifecycle move; illegal transitions are refused, never silently applied. */
  transition(id: string, to: ExperimentStatus, reason: string, by: 'auto' | 'user'): Experiment | null {
    const exp = this.get(id);
    if (!exp) return null;
    if (!LEGAL_MOVES[exp.status]?.includes(to)) return null;
    this.recordTransition(exp, to, reason, by);
    exp.updatedAt = Date.now();
    this.write(exp);
    labEvent(to, { expId: id, reason, by });
    return exp;
  }

  private recordTransition(exp: Experiment, to: ExperimentStatus, reason: string, by: 'auto' | 'user'): void {
    if (exp.status === to && to !== 'evaluated') return;
    exp.transitions.push({ at: Date.now(), from: exp.status, to, reason, by });
    exp.status = to;
    exp.statusReason = reason;
  }

  /** Keep the artifact directory bounded: terminal experiments beyond the cap age out. */
  private prune(keep = EXPERIMENTS_KEPT): void {
    try {
      const all = this.list();
      const terminal = all.filter(e => TERMINAL.has(e.status)).sort((a, b) => a.updatedAt - b.updatedAt);
      const excess = all.length - keep;
      for (const e of terminal.slice(0, Math.max(0, excess))) {
        fs.unlinkSync(this.fileFor(e.id));
      }
    } catch { /* best-effort */ }
  }

  /**
   * Advisory cross-process evaluation lock (O_EXCL create; stale after TTL, dead-PID
   * pruned like file claims). Prevents two sessions from duplicating the same replay
   * work — correctness never depends on it, since evaluations are deterministic and
   * idempotent by id.
   */
  acquireEvalLock(ttlMs = 5 * 60_000): (() => void) | null {
    const lockFile = path.join(this.dir(), '.eval.lock');
    try {
      fs.mkdirSync(this.dir(), { recursive: true });
      try {
        const raw = fs.readFileSync(lockFile, 'utf-8'); // ENOENT ⇒ no lock, skip to acquire
        let stale = true; // unparseable lock counts as stale — it must never wedge the lab
        try {
          const prev = JSON.parse(raw);
          const fresh = Date.now() - Number(prev?.at || 0) <= ttlMs;
          let alive = false;
          try { process.kill(Number(prev?.pid), 0); alive = true; } catch { alive = false; }
          stale = !fresh || !alive;
        } catch { stale = true; }
        if (stale) fs.unlinkSync(lockFile);
      } catch { /* no lock file */ }
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return () => { try { fs.unlinkSync(lockFile); } catch { /* released elsewhere */ } };
    } catch {
      return null; // held by a live process — skip this pass, next boundary retries
    }
  }
}
