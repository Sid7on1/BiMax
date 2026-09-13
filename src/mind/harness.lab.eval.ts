import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { loadEpisode } from './episode.recorder';
import { replayEpisode, ReplayReport } from './replay.harness';
import { wilsonInterval } from './stats';
import { getEventLedger, LedgerEvent } from './event.ledger';
import { getTracer } from '../telemetry/trace';
import {
  ArmReplayResult, CohortEpisodeRef, CohortManifest, CohortSkip, EpisodeCensus,
  EpisodePairResult, Experiment, GateResult, LabCandidate, LabEvaluation, sha256,
} from './harness.lab';

/**
 * Counterfactual Harness Lab — deterministic offline evaluator (INFRA P4 #10).
 *
 * Evaluates a candidate steering patch against RECORDED episodes with zero live side
 * effects: both arms of every pair go through replayEpisode, whose LLM responses come
 * from the recording (ReplayProvider) and whose "tools" only re-serve recorded result
 * strings — no real tool, shell, network, or model call can occur, and the learning
 * observers stand down (setReplayActive). Recorded content is treated as untrusted data
 * to be measured, never as instructions to execute.
 *
 * What a pair honestly measures (all labeled 'measured' in the gate evidence):
 *   - baseline determinism — the episode replayed under its own recorded prompt is
 *     bit-for-bit identical; only then is the pair a valid instrument (else excluded,
 *     visibly);
 *   - candidate mechanical viability — under the patched prompt the loop still drives
 *     the full recorded trajectory to completion (the harness change breaks nothing);
 *   - addressable harm — the candidate's target failure signature counted from typed
 *     tool outcomes ledger-correlated to each episode (anchor-to-anchor, append-only
 *     ids ⇒ deterministic for a fixed cohort), with a Wilson interval on the rate;
 *   - prompt cost — the exact bytes the candidate adds to every request.
 *
 * What it deliberately does NOT claim: whether the model would behave better with the
 * patch. Recorded responses cannot answer that without re-inference, so behavioral
 * effect stays a live-accounting question (HarnessTuner auto-retire). The backend seam
 * (CounterfactualBackend) is where a future paid re-inference evaluator would plug in.
 */

// All gate thresholds in one exported block — tests and /harness lab explain cite these.
export const LAB_GATES = {
  /** Minimum usable paired episodes before any verdict other than insufficient_evidence. */
  MIN_USABLE_EPISODES: 3,
  /** Minimum recorded calls to the target tool across the cohort (census denominator). */
  MIN_TARGET_CALLS: 5,
  /** Minimum recorded failures matching the candidate's signature. */
  MIN_TARGET_HITS: 3,
  /** Wilson 95% LOWER bound on the target failure rate must clear this floor. */
  MIN_FAILURE_RATE_LO: 0.10,
  /** At least this fraction of selected baselines must replay bit-for-bit. */
  MIN_USABLE_FRACTION: 0.7,
  /** Prompt-cost veto: a steering block bigger than this never earns its tokens. */
  MAX_BLOCK_CHARS: 700,
  DEFAULT_COHORT_LIMIT: 12,
  MIN_EPISODE_CALLS: 2,
} as const;

export interface CohortCriteria {
  limit: number;
  minCalls: number;
}

// ---------------------------------------------------------------------------
// Deterministic cohort selection
// ---------------------------------------------------------------------------

/**
 * Select the evaluation cohort from recorded episodes. Deterministic: a fixed episode
 * directory always yields the same episodes in the same order (signal-bearing first,
 * then newest first, episode id as total-order tiebreak) and therefore the same
 * cohortHash. Every excluded episode carries a visible reason — corrupt or incompatible
 * recordings are never skipped silently.
 */
export function selectCohort(
  root: string,
  candidate: LabCandidate,
  criteria?: Partial<CohortCriteria>
): CohortManifest {
  const crit: CohortCriteria = {
    limit: criteria?.limit ?? LAB_GATES.DEFAULT_COHORT_LIMIT,
    minCalls: criteria?.minCalls ?? LAB_GATES.MIN_EPISODE_CALLS,
  };
  const dir = path.join(stateDir('.bimax', root), 'episodes');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { /* no episodes yet */ }

  const eligible: CohortEpisodeRef[] = [];
  const skipped: CohortSkip[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const fallbackId = f.replace(/\.jsonl$/, '');
    const ep = loadEpisode(full, root);
    if (!ep) { skipped.push({ id: fallbackId, reason: 'unparseable' }); continue; }
    if (!ep.chainOk) { skipped.push({ id: ep.header.id, reason: `chain_broken@line${ep.brokenAt}` }); continue; }
    if (ep.header.system === undefined) { skipped.push({ id: ep.header.id, reason: 'no_system_recorded' }); continue; }
    if (ep.calls.length < crit.minCalls) { skipped.push({ id: ep.header.id, reason: `too_few_calls(${ep.calls.length})` }); continue; }
    if (ep.calls[ep.calls.length - 1]?.response?.incomplete) { skipped.push({ id: ep.header.id, reason: 'incomplete_recording' }); continue; }
    if (ep.calls.some(c => c.reset)) { skipped.push({ id: ep.header.id, reason: 'spans_compaction' }); continue; }
    if (ep.calls.some(c => c.newMessages.some(m => typeof m.content === 'string' && m.content.startsWith('[multimodal content:')))) {
      skipped.push({ id: ep.header.id, reason: 'multimodal_content' }); continue;
    }
    // Contamination: an episode recorded WITH the candidate rule in its prompt is not a
    // valid control — the pair would compare the treatment against itself.
    if (ep.header.system.includes(candidate.rule)) { skipped.push({ id: ep.header.id, reason: 'contains_candidate_rule' }); continue; }
    const signalBearing = ep.calls.some(c => (c.response?.toolCalls || []).some(tc => tc.name === candidate.tool));
    eligible.push({
      id: ep.header.id,
      file: full,
      startedAt: ep.header.startedAt,
      calls: ep.calls.length,
      contentHash: sha256(fs.readFileSync(full).toString('utf-8')),
      signalBearing,
    });
  }

  eligible.sort((a, b) =>
    Number(b.signalBearing) - Number(a.signalBearing) || b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const episodes = eligible.slice(0, crit.limit);
  for (const e of eligible.slice(crit.limit)) skipped.push({ id: e.id, reason: 'beyond_cohort_limit' });

  return {
    selectedAt: Date.now(),
    criteria: crit,
    episodes,
    skipped,
    cohortHash: sha256(episodes.map(e => e.contentHash).join('|')),
  };
}

// ---------------------------------------------------------------------------
// Recorded-failure census (typed outcomes, ledger-correlated per episode)
// ---------------------------------------------------------------------------

/**
 * Count the candidate's target signature inside each cohort episode using the event
 * ledger's typed tool outcomes. Attribution is exact, not time-window fuzz: each
 * episode writes one 'episode' anchor event at its first LLM call, so an episode's
 * outcomes are the tool_outcome rows between its anchor and the same session's next
 * anchor (append-only ids ⇒ deterministic). No anchor ⇒ census 'unavailable' for that
 * episode — evidence gates then fail closed rather than inventing numbers.
 */
export function buildCensus(episodes: CohortEpisodeRef[], candidate: LabCandidate): Map<string, EpisodeCensus> {
  const out = new Map<string, EpisodeCensus>();
  let anchors: LedgerEvent[] = [];
  let outcomes: LedgerEvent[] = [];
  try {
    anchors = getEventLedger().byType('episode');
    outcomes = getEventLedger().byType('tool_outcome');
  } catch { /* ledger unavailable — every census below reports unavailable */ }

  for (const ref of episodes) {
    const anchor = anchors.find(a => a?.payload?.id === ref.id);
    if (!anchor) {
      out.set(ref.id, { available: false, targetToolCalls: 0, targetHits: 0, otherToolFailures: 0 });
      continue;
    }
    const next = anchors.find(a => a.session === anchor.session && a.id > anchor.id);
    let targetToolCalls = 0, targetHits = 0, otherToolFailures = 0;
    for (const o of outcomes) {
      if (o.session !== anchor.session || o.id <= anchor.id) continue;
      if (next && o.id >= next.id) continue;
      const p = o.payload || {};
      if (String(p.tool || '') !== candidate.tool) continue;
      targetToolCalls++;
      const failed = p.status === 'error' || p.isError === true;
      if (!failed) continue;
      // Mirror the tuner's signature classification exactly (errorClass, 'unknown' fallback).
      if (String(p.errorClass || 'unknown') === candidate.errorClass) targetHits++;
      else otherToolFailures++;
    }
    out.set(ref.id, { available: true, targetToolCalls, targetHits, otherToolFailures });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation backend seam
// ---------------------------------------------------------------------------

/**
 * The seam between "how a pair is produced" and "how evidence is scored". The default
 * backend replays recorded data hermetically at zero token cost. A future 'live-rejudge'
 * backend (real re-inference on the counterfactual prompt — network + spend) would
 * implement this same interface; until it exists nothing pretends to be it.
 */
export interface CounterfactualBackend {
  readonly name: string;
  evaluatePair(
    ref: CohortEpisodeRef,
    root: string,
    candidate: LabCandidate
  ): Promise<{ baseline: ArmReplayResult; candidate: ArmReplayResult }>;
}

function toArm(rep: ReplayReport | { error: string }): ArmReplayResult {
  if ('error' in rep) {
    return {
      completed: false, identical: false, callsRecorded: 0, callsServed: 0,
      divergences: 0, firstDivergence: null, toolResultsMissing: 0, finalTextHash: '',
      error: rep.error,
    };
  }
  return {
    completed: rep.callsServed === rep.callsRecorded && rep.toolResultsMissing === 0,
    identical: rep.identical,
    callsRecorded: rep.callsRecorded,
    callsServed: rep.callsServed,
    divergences: rep.divergences.length,
    firstDivergence: rep.divergences.length ? rep.divergences[0].idx : null,
    toolResultsMissing: rep.toolResultsMissing,
    finalTextHash: sha256(rep.finalText).slice(0, 16),
  };
}

/** Hermetic default: both arms replay the recording; nothing executes, nothing spends. */
export class RecordedReplayBackend implements CounterfactualBackend {
  readonly name = 'recorded-replay';

  async evaluatePair(ref: CohortEpisodeRef, root: string, candidate: LabCandidate) {
    const ep = loadEpisode(ref.file, root);
    if (!ep || ep.header.system === undefined) {
      const gone = toArm({ error: 'episode bundle unreadable at evaluation time' });
      return { baseline: gone, candidate: gone };
    }
    const baseline = toArm(await replayEpisode(ref.file, { root }));
    const candidateArm = toArm(await replayEpisode(ref.file, {
      root,
      systemPrompt: `${ep.header.system}\n\n${candidate.promptBlock}`,
    }));
    return { baseline, candidate: candidateArm };
  }
}

// ---------------------------------------------------------------------------
// Paired evaluation + gates + verdict
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** Pre-selected cohort (callers that hash-compare before evaluating pass it back in). */
  cohort?: CohortManifest;
  backend?: CounterfactualBackend;
  /** Rules of currently ACTIVE patches — input to the duplicate-steering veto. */
  activeRules?: string[];
  criteria?: Partial<CohortCriteria>;
}

export async function evaluateExperiment(
  exp: Experiment,
  root: string,
  opts: EvaluateOptions = {}
): Promise<LabEvaluation> {
  const span = getTracer().startSpan('harness.lab.evaluate', {
    expId: exp.id, tool: exp.candidate.tool, errorClass: exp.candidate.errorClass,
  });
  try {
    const backend = opts.backend ?? new RecordedReplayBackend();
    const cohort = opts.cohort ?? selectCohort(root, exp.candidate, opts.criteria);
    const census = buildCensus(cohort.episodes, exp.candidate);

    const pairs: EpisodePairResult[] = [];
    for (const ref of cohort.episodes) {
      const { baseline, candidate } = await backend.evaluatePair(ref, root, exp.candidate);
      const usable = baseline.identical && !baseline.error;
      const pair: EpisodePairResult = {
        episodeId: ref.id,
        signalBearing: ref.signalBearing,
        baseline,
        candidate,
        census: census.get(ref.id) ?? { available: false, targetToolCalls: 0, targetHits: 0, otherToolFailures: 0 },
        usable,
      };
      if (!usable) pair.excludedReason = baseline.error ? 'baseline_replay_error' : 'baseline_nondeterministic';
      pairs.push(pair);
      // Runs at episode boundaries in a live session — never hog the event loop.
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    const usable = pairs.filter(p => p.usable);
    const signalEpisodes = usable.filter(p => p.signalBearing).length;
    const censusPairs = usable.filter(p => p.census.available);
    const targetToolCalls = censusPairs.reduce((a, p) => a + p.census.targetToolCalls, 0);
    const targetHits = censusPairs.reduce((a, p) => a + p.census.targetHits, 0);
    const wilson = targetToolCalls > 0 ? wilsonInterval(targetHits, targetToolCalls) : null;
    const blockChars = exp.candidate.promptBlock.length;
    const G = LAB_GATES;

    const gates: GateResult[] = [];
    gates.push({
      gate: 'cohort_size', veto: false, basis: 'measured',
      pass: usable.length >= G.MIN_USABLE_EPISODES,
      detail: `${usable.length} usable paired episode(s) of ${pairs.length} selected (need ≥${G.MIN_USABLE_EPISODES})`,
    });
    gates.push({
      gate: 'baseline_determinism', veto: false, basis: 'measured',
      pass: pairs.length > 0 && usable.length / pairs.length >= G.MIN_USABLE_FRACTION,
      detail: pairs.length === 0
        ? 'no episodes selected — nothing to measure against'
        : `${usable.length}/${pairs.length} baselines replayed bit-for-bit (need ≥${Math.round(G.MIN_USABLE_FRACTION * 100)}%)`,
    });
    // Veto gates only fire on POSITIVE evidence of a problem — an empty cohort is
    // insufficient evidence (cohort_size), never a veto.
    const mechanicalBad = usable.filter(p =>
      !p.candidate.completed || !!p.candidate.error || p.candidate.toolResultsMissing > 0
      || p.candidate.finalTextHash !== p.baseline.finalTextHash);
    gates.push({
      gate: 'candidate_mechanical', veto: true, basis: 'measured',
      pass: mechanicalBad.length === 0,
      detail: usable.length === 0
        ? '0 usable pairs — not assessed'
        : mechanicalBad.length === 0
          ? `${usable.length}/${usable.length} candidate replays completed with identical recorded trajectory output`
          : `${mechanicalBad.length}/${usable.length} candidate replays broke (${mechanicalBad.map(p => p.episodeId).slice(0, 3).join(', ')})`,
    });
    const duplicate = (opts.activeRules || []).includes(exp.candidate.rule);
    gates.push({
      gate: 'steering_conflict', veto: true, basis: 'measured',
      pass: !duplicate,
      detail: duplicate ? 'an ACTIVE patch already carries this exact rule — duplicate steering' : 'no active patch duplicates this rule',
    });
    gates.push({
      gate: 'addressable_harm', veto: false, basis: 'measured',
      pass: censusPairs.length > 0 && targetToolCalls >= G.MIN_TARGET_CALLS
        && targetHits >= G.MIN_TARGET_HITS && (wilson?.lo ?? 0) >= G.MIN_FAILURE_RATE_LO,
      detail: censusPairs.length === 0
        ? 'no ledger census available for any usable episode — evidence unavailable (fail-closed)'
        : `${targetHits}/${targetToolCalls} recorded ${exp.candidate.tool} calls failed with ${exp.candidate.errorClass}`
          + ` (Wilson95 lo ${(100 * (wilson?.lo ?? 0)).toFixed(1)}%; need hits ≥${G.MIN_TARGET_HITS}, calls ≥${G.MIN_TARGET_CALLS}, lo ≥${Math.round(G.MIN_FAILURE_RATE_LO * 100)}%)`,
    });
    gates.push({
      gate: 'prompt_cost', veto: true, basis: 'measured',
      pass: blockChars <= G.MAX_BLOCK_CHARS,
      detail: `candidate block adds ${blockChars} chars (~${Math.round(blockChars / 4)} tokens) per request (cap ${G.MAX_BLOCK_CHARS})`,
    });

    const failedVetoes = gates.filter(g => g.veto && !g.pass);
    const verdict = failedVetoes.length > 0
      ? 'veto'
      : gates.every(g => g.pass) ? 'pass' : 'insufficient_evidence';
    const confidence = usable.length >= 8 && targetToolCalls >= 20
      ? 'high'
      : usable.length >= G.MIN_USABLE_EPISODES && targetToolCalls >= G.MIN_TARGET_CALLS ? 'moderate' : 'low';

    const notes: string[] = [
      'Candidate-arm divergence at call 0 is expected by construction (the system prompt is part of the request hash) — it is mechanical, not behavioral evidence.',
      'Measured offline: baseline determinism, candidate mechanical viability, recorded failure census, prompt cost. NOT measured offline (proxy): whether the steering actually reduces the target failure class — that stays a live post-activation question, judged by HarnessTuner effectiveness accounting (auto-retire).',
    ];
    const noCensus = usable.length - censusPairs.length;
    if (noCensus > 0) notes.push(`${noCensus} usable episode(s) had no ledger anchor — their outcomes are excluded from the harm census (fail-closed).`);
    if (cohort.skipped.length > 0) notes.push(`${cohort.skipped.length} episode(s) excluded from the cohort with visible reasons (see cohort.skipped).`);

    const evaluation: LabEvaluation = {
      id: `ev-${sha256(`${exp.candidate.blockHash}|${cohort.cohortHash}`).slice(0, 12)}`,
      at: Date.now(),
      backend: backend.name,
      cohort,
      pairs,
      aggregate: {
        episodesSelected: pairs.length,
        episodesUsable: usable.length,
        signalEpisodes,
        censusEpisodes: censusPairs.length,
        targetToolCalls,
        targetHits,
        targetFailureRate: wilson
          ? { point: targetHits / targetToolCalls, wilsonLo: wilson.lo, wilsonHi: wilson.hi }
          : null,
        candidateCompletion: usable.length > 0 ? (usable.length - mechanicalBad.length) / usable.length : 0,
        promptCostChars: blockChars,
        approxPromptCostTokens: Math.round(blockChars / 4),
      },
      gates,
      verdict,
      vetoReasons: failedVetoes.map(g => `${g.gate}: ${g.detail}`),
      confidence,
      notes,
    };
    span.setAttributes({
      verdict, confidence, episodes: pairs.length, usable: usable.length,
      cohortHash: cohort.cohortHash.slice(0, 12), evaluationId: evaluation.id,
    });
    return evaluation;
  } finally {
    span.end();
  }
}

// ---------------------------------------------------------------------------
// Explanation — the human-readable verdict, measured facts vs inferred conclusions
// ---------------------------------------------------------------------------

export function explainExperiment(exp: Experiment): string {
  const c = exp.candidate;
  const ev = exp.evaluations[exp.evaluations.length - 1];
  const lines: string[] = [
    `## Experiment \`${exp.id}\` — ${c.tool} × ${c.errorClass}`,
    `Status: **${exp.status}**${exp.statusReason ? ` — ${exp.statusReason}` : ''} · patch \`${c.patchId}\``,
    `Candidate steering: “${c.rule}”`,
  ];
  if (!ev) {
    lines.push('', `No evaluation yet — \`/harness lab run ${exp.id}\` evaluates it against recorded episodes.`);
    return lines.join('\n');
  }
  lines.push('', `### Verdict: ${ev.verdict.toUpperCase()} · confidence ${ev.confidence} · backend ${ev.backend}`);
  lines.push(`Cohort \`${ev.cohort.cohortHash.slice(0, 12)}\` — ${ev.aggregate.episodesSelected} episode(s) selected, `
    + `${ev.aggregate.episodesUsable} usable, ${ev.aggregate.signalEpisodes} exercising ${c.tool}, `
    + `${ev.aggregate.censusEpisodes} with a typed-outcome census.`);
  lines.push('', '**Gates** (every line below is measured from recorded data):');
  for (const g of ev.gates) {
    lines.push(`- ${g.pass ? '✓' : '✗'} \`${g.gate}\`${g.veto ? ' *(veto)*' : ''} — ${g.detail}`);
  }
  const r = ev.aggregate.targetFailureRate;
  if (r) {
    lines.push('', `Recorded harm: ${ev.aggregate.targetHits}/${ev.aggregate.targetToolCalls} ${c.tool} calls hit `
      + `${c.errorClass} — ${(r.point * 100).toFixed(1)}% (Wilson95 ${(r.wilsonLo * 100).toFixed(1)}–${(r.wilsonHi * 100).toFixed(1)}%). `
      + `Prompt cost: +${ev.aggregate.promptCostChars} chars (~${ev.aggregate.approxPromptCostTokens} tok) per request.`);
  }
  if (ev.vetoReasons.length) {
    lines.push('', '**Rejected because:**');
    for (const v of ev.vetoReasons) lines.push(`- ${v}`);
  }
  lines.push('', '**Measured vs inferred:**');
  for (const n of ev.notes) lines.push(`- ${n}`);
  if (ev.cohort.skipped.length) {
    const byReason = new Map<string, number>();
    for (const s of ev.cohort.skipped) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
    lines.push('', `Excluded episodes: ${[...byReason.entries()].map(([why, n]) => `${n}× ${why}`).join(' · ')}.`);
  }
  const unusable = ev.pairs.filter(p => !p.usable);
  if (unusable.length) {
    lines.push(`Unusable pairs: ${unusable.map(p => `${p.episodeId} (${p.excludedReason})`).join(' · ')}.`);
  }
  return lines.join('\n');
}
