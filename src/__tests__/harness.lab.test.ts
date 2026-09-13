import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../core/agent.loop';
import { LLMProvider, Message, ChatEvent } from '../core/llm.provider';
import { EpisodeWriter, RecordingProvider, listEpisodes } from '../mind/episode.recorder';
import { EventLedger, __setEventLedger, getEventLedger } from '../mind/event.ledger';
import { HarnessTuner, __setHarnessTuner } from '../mind/harness.tuner';
import {
  Experiment, HarnessLabStore, candidateFrom, experimentIdFor, renderHarnessBlock,
} from '../mind/harness.lab';
import {
  CounterfactualBackend, LAB_GATES, evaluateExperiment, explainExperiment, selectCohort,
} from '../mind/harness.lab.eval';

/**
 * Counterfactual Harness Lab (INFRA P4 #10): staged patches are validated offline against
 * recorded episodes — deterministic cohorts, paired hermetic replay, explicit gates — before
 * they may inject a live prompt token.
 */

/** Scripted provider: one pre-baked event stream per chat() call, in order. */
function scripted(streams: ChatEvent[][]): LLMProvider {
  let call = 0;
  return {
    async *chat(): AsyncGenerator<ChatEvent> {
      const events = streams[call++] || [{ type: 'token', text: 'out of script' }, { type: 'done' } as ChatEvent];
      for (const ev of events) yield ev;
    },
  };
}

// Boobytrap counter: every LIVE execution of the probe tool increments this. Recording
// legitimately executes it; a hermetic evaluation must never move it again.
let liveExecutions = 0;

function liveRegistry() {
  return {
    getSchemas: () => [{ type: 'function', function: { name: 'ProbeTool', parameters: { type: 'object', properties: {} } } }],
    getTool: (name: string) => name === 'ProbeTool'
      ? { name, isConcurrencySafe: false, execute: async () => { liveExecutions++; return 'probe ok'; } }
      : undefined,
  };
}

const SYSTEM = 'you are bimax, terse';
const RULE = 'ProbeTool keeps failing to match its target. Re-read the file immediately before editing.';
const PATCH = { id: 'hp-test-1', tool: 'ProbeTool', errorClass: 'no_match', rule: RULE };

describe('Counterfactual Harness Lab', () => {
  let dir: string;

  beforeEach(() => {
    delete process.env.BIMAX_HARNESS_LAB; // lab ON — the default under test
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-lab-'));
    __setEventLedger(new EventLedger(dir));
  });

  afterEach(() => {
    delete process.env.BIMAX_HARNESS_LAB;
    __setEventLedger(null);
    __setHarnessTuner(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Record one real 2-call episode (model calls ProbeTool, then answers). */
  async function recordEpisode(tag: string, system = SYSTEM): Promise<string> {
    const streams: ChatEvent[][] = [
      [{ type: 'tool_call', id: `c-${tag}`, name: 'ProbeTool', args: '{}' }, { type: 'done' }],
      [{ type: 'token', text: `answer ${tag}` }, { type: 'done' }],
    ];
    const writer = new EpisodeWriter(dir);
    const loop = new AgentLoop(new RecordingProvider(scripted(streams), writer), liveRegistry() as any);
    const initial: Message[] = [{ role: 'user', content: `task ${tag}` }];
    let text = '';
    for await (const chunk of loop.execute(initial, system, { maxIterations: 4 })) text += chunk;
    expect(text).toContain(`answer ${tag}`);
    return writer.id;
  }

  /** Synthetic typed failures matching the candidate signature, attributed to the LAST episode. */
  function seedFailures(n: number, errorClass = 'no_match') {
    for (let i = 0; i < n; i++) {
      getEventLedger().append('tool_outcome', { tool: 'ProbeTool', status: 'error', errorClass, isError: true });
    }
  }

  /** 3 signal-bearing episodes, each with 3 recorded no_match failures — a passing cohort. */
  async function recordPassingCohort(): Promise<void> {
    for (const tag of ['a', 'b', 'c']) {
      await recordEpisode(tag);
      seedFailures(3);
    }
  }

  // -------------------------------------------------------------------------
  // Cohort selection
  // -------------------------------------------------------------------------

  it('selects a deterministic cohort and skips bad episodes with visible reasons', async () => {
    const cand = candidateFrom(PATCH);
    await recordPassingCohort();

    // Tampered bundle (chain broken).
    const tamperedId = await recordEpisode('tampered');
    const tamperedFile = path.join(dir, '.bimax', 'episodes', `${tamperedId}.jsonl`);
    const lines = fs.readFileSync(tamperedFile, 'utf-8').trim().split('\n');
    lines[1] = lines[1].replace('task tampered', 'task EVIL');
    fs.writeFileSync(tamperedFile, lines.join('\n') + '\n');

    // Unparseable file.
    fs.writeFileSync(path.join(dir, '.bimax', 'episodes', 'e-garbage.jsonl'), 'not json at all\n');

    // Too-short episode (1 call).
    const w = new EpisodeWriter(dir);
    const shortLoop = new AgentLoop(
      // A sentence, not a lone word: a one-word reply is re-asked once as a stray fragment (agent.loop
      // isStrayFragment), which would make this a 2-call episode.
      new RecordingProvider(scripted([[{ type: 'token', text: 'short answer.' }, { type: 'done' }]]), w),
      liveRegistry() as any
    );
    for await (const _ of shortLoop.execute([{ role: 'user', content: 'short task' }], SYSTEM, { maxIterations: 2 })) { /* drain */ }

    // Contaminated episode (recorded prompt already contains the candidate rule).
    await recordEpisode('contaminated', `${SYSTEM}\n${RULE}`);

    const cohort = selectCohort(dir, cand);
    expect(cohort.episodes).toHaveLength(3);
    expect(cohort.episodes.every(e => e.signalBearing)).toBe(true);
    const reasons = cohort.skipped.map(s => s.reason).join(' ');
    expect(reasons).toContain('chain_broken');
    expect(reasons).toContain('unparseable');
    expect(reasons).toContain('too_few_calls');
    expect(reasons).toContain('contains_candidate_rule');

    // Determinism: same directory ⇒ same episodes, same order, same cohort hash.
    const again = selectCohort(dir, cand);
    expect(again.cohortHash).toBe(cohort.cohortHash);
    expect(again.episodes.map(e => e.id)).toEqual(cohort.episodes.map(e => e.id));
  });

  // -------------------------------------------------------------------------
  // Paired evaluation: verdicts and gates
  // -------------------------------------------------------------------------

  it('passes a well-evidenced candidate — deterministic, explainable verdict', async () => {
    await recordPassingCohort();
    const store = new HarnessLabStore(dir);
    const { exp } = store.getOrCreate(candidateFrom(PATCH));

    const ev = await evaluateExperiment(exp, dir, { activeRules: [] });
    expect(ev.verdict).toBe('pass');
    expect(ev.aggregate.episodesUsable).toBe(3);
    // Census: per episode 1 live ProbeTool call (loop-observed) + 3 seeded failures.
    expect(ev.aggregate.targetHits).toBe(9);
    expect(ev.aggregate.targetToolCalls).toBeGreaterThanOrEqual(9);
    expect(ev.aggregate.targetFailureRate!.wilsonLo).toBeGreaterThan(LAB_GATES.MIN_FAILURE_RATE_LO);
    expect(ev.aggregate.candidateCompletion).toBe(1);
    expect(ev.gates.every(g => g.pass)).toBe(true);
    expect(ev.gates.every(g => g.basis === 'measured')).toBe(true);

    // Determinism: same candidate × same cohort ⇒ same evaluation id, same evidence.
    const ev2 = await evaluateExperiment(exp, dir, { activeRules: [] });
    expect(ev2.id).toBe(ev.id);
    expect(ev2.verdict).toBe(ev.verdict);
    expect(ev2.aggregate).toEqual(ev.aggregate);
    expect(ev2.gates).toEqual(ev.gates);

    const text = explainExperiment({ ...exp, evaluations: [ev] });
    expect(text).toContain('PASS');
    expect(text).toContain('NOT measured offline');
  });

  it('rejects a weak sample — too few episodes can never auto-activate', async () => {
    await recordEpisode('only-one');
    seedFailures(3);
    const store = new HarnessLabStore(dir);
    const { exp } = store.getOrCreate(candidateFrom(PATCH));

    const ev = await evaluateExperiment(exp, dir, { activeRules: [] });
    expect(ev.verdict).toBe('insufficient_evidence');
    expect(ev.gates.find(g => g.gate === 'cohort_size')!.pass).toBe(false);
    expect(ev.confidence).toBe('low');
  });

  it('fails the harm gate closed when the ledger census is unavailable', async () => {
    await recordPassingCohort();
    const store = new HarnessLabStore(dir);
    const { exp } = store.getOrCreate(candidateFrom(PATCH));
    // Sever the census: a fresh ledger with no anchors for these episodes.
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-lab-orphan-'));
    __setEventLedger(new EventLedger(orphan));
    try {
      const ev = await evaluateExperiment(exp, dir, { activeRules: [] });
      expect(ev.verdict).toBe('insufficient_evidence');
      const harm = ev.gates.find(g => g.gate === 'addressable_harm')!;
      expect(harm.pass).toBe(false);
      expect(harm.detail).toContain('fail-closed');
    } finally {
      fs.rmSync(orphan, { recursive: true, force: true });
    }
  });

  it('vetoes on mechanical regression (backend reports candidate breakage)', async () => {
    await recordPassingCohort();
    const store = new HarnessLabStore(dir);
    const { exp } = store.getOrCreate(candidateFrom(PATCH));

    const breaking: CounterfactualBackend = {
      name: 'stub-breaking',
      evaluatePair: async (ref, root, cand) => {
        const real = await new (require('../mind/harness.lab.eval').RecordedReplayBackend)().evaluatePair(ref, root, cand);
        return { baseline: real.baseline, candidate: { ...real.candidate, completed: false, toolResultsMissing: 2 } };
      },
    };
    const ev = await evaluateExperiment(exp, dir, { activeRules: [], backend: breaking });
    expect(ev.verdict).toBe('veto');
    expect(ev.vetoReasons.join(' ')).toContain('candidate_mechanical');
  });

  it('vetoes duplicate steering and oversized prompt blocks', async () => {
    await recordPassingCohort();
    const store = new HarnessLabStore(dir);

    const { exp } = store.getOrCreate(candidateFrom(PATCH));
    const dup = await evaluateExperiment(exp, dir, { activeRules: [RULE] });
    expect(dup.verdict).toBe('veto');
    expect(dup.vetoReasons.join(' ')).toContain('steering_conflict');

    const fat = store.getOrCreate(candidateFrom({ ...PATCH, id: 'hp-fat', rule: 'x'.repeat(LAB_GATES.MAX_BLOCK_CHARS + 100) })).exp;
    const cost = await evaluateExperiment(fat, dir, { activeRules: [] });
    expect(cost.verdict).toBe('veto');
    expect(cost.vetoReasons.join(' ')).toContain('prompt_cost');
  });

  // -------------------------------------------------------------------------
  // Hermeticity — offline evaluation must have zero live side effects
  // -------------------------------------------------------------------------

  it('is hermetic: evaluation never re-executes tools, records episodes, or feeds observers', async () => {
    await recordPassingCohort();
    const executionsAfterRecording = liveExecutions;
    const episodesBefore = listEpisodes(dir).length;
    const outcomesBefore = getEventLedger().byType('tool_outcome').length;

    const store = new HarnessLabStore(dir);
    const { exp } = store.getOrCreate(candidateFrom(PATCH));
    const ev = await evaluateExperiment(exp, dir, { activeRules: [] });
    expect(ev.verdict).toBe('pass');

    expect(liveExecutions).toBe(executionsAfterRecording);              // no tool ran
    expect(listEpisodes(dir).length).toBe(episodesBefore);              // no self-recording
    expect(getEventLedger().byType('tool_outcome').length).toBe(outcomesBefore); // observers stood down
  });

  // -------------------------------------------------------------------------
  // Store: identity, idempotency, recovery, lifecycle
  // -------------------------------------------------------------------------

  it('derives experiment identity from candidate content — creation is idempotent', () => {
    const store = new HarnessLabStore(dir);
    const cand = candidateFrom(PATCH);
    const a = store.getOrCreate(cand);
    const b = store.getOrCreate(candidateFrom({ ...PATCH, id: 'hp-different-patch-id' }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false); // same tool×errorClass×rule ⇒ same experiment
    expect(a.exp.id).toBe(b.exp.id);
    expect(a.exp.id).toBe(experimentIdFor(PATCH));
    expect(store.list()).toHaveLength(1);
  });

  it('quarantines corrupt experiment files and keeps working (audited in the ledger)', () => {
    const store = new HarnessLabStore(dir);
    store.getOrCreate(candidateFrom(PATCH));
    fs.writeFileSync(path.join(store.dir(), 'cx-deadbeef0000.json'), '{ not valid json');

    const all = store.list();
    expect(all).toHaveLength(1); // the good one survives
    const leftovers = fs.readdirSync(store.dir());
    expect(leftovers.some(f => f.includes('.corrupt-'))).toBe(true);
    const recovered = getEventLedger().byType('harness_lab').filter(e => e.payload?.action === 'recovered');
    expect(recovered.length).toBeGreaterThanOrEqual(1);
  });

  it('guards lifecycle transitions — illegal moves are refused', () => {
    const store = new HarnessLabStore(dir);
    const { exp } = store.getOrCreate(candidateFrom(PATCH));

    expect(store.transition(exp.id, 'rolled_back', 'nope', 'user')).toBeNull(); // pending ↛ rolled_back
    expect(store.transition(exp.id, 'activated', 'manual', 'user')).not.toBeNull();
    expect(store.transition(exp.id, 'rejected', 'nope', 'user')).toBeNull();    // activated ↛ rejected
    expect(store.transition(exp.id, 'rolled_back', 'reverted', 'user')).not.toBeNull();
    expect(store.transition(exp.id, 'activated', 'nope', 'user')).toBeNull();   // terminal
    const final = store.get(exp.id)!;
    expect(final.status).toBe('rolled_back');
    expect(final.transitions.map(t => t.to)).toEqual(['pending', 'activated', 'rolled_back']);
  });

  // -------------------------------------------------------------------------
  // HarnessTuner integration — the staged pipeline end to end
  // -------------------------------------------------------------------------

  it('stages a mined patch, validates it offline, and only then activates it', async () => {
    await recordPassingCohort();
    seedFailures(4); // mining evidence in the recent window

    const tuner = new HarnessTuner(dir);
    __setHarnessTuner(tuner);
    expect(tuner.mine().created).toBe(1);
    const staged = tuner.all()[0];
    expect(staged.status).toBe('staged');
    expect(tuner.getPromptBlock()).toBe(''); // nothing live before the verdict

    const r = await tuner.labPass();
    expect(r.evaluated).toBe(1);
    expect(r.activated).toBe(1);

    const active = tuner.all()[0];
    expect(active.status).toBe('active');
    expect(active.activatedBy).toBe('lab');
    expect(active.activatedAt).toBeDefined();
    expect(tuner.getPromptBlock()).toContain('ProbeTool');
    expect(tuner.getPromptBlock()).toBe(renderHarnessBlock([active.rule]));

    const exp = tuner.labStore().get(active.labExperimentId!)!;
    expect(exp.status).toBe('activated');
    // Full audit trail in the ledger: created → evaluated → activated.
    const actions = getEventLedger().byType('harness_lab').map(e => e.payload?.action);
    expect(actions).toEqual(expect.arrayContaining(['created', 'evaluated', 'activated']));
  });

  it('keeps a weakly-evidenced patch staged and re-evaluates only when the cohort changes', async () => {
    await recordEpisode('lonely');
    seedFailures(4);
    const tuner = new HarnessTuner(dir);
    tuner.mine();

    const first = await tuner.labPass();
    expect(first.evaluated).toBe(1);
    expect(first.activated).toBe(0);
    expect(tuner.all()[0].status).toBe('staged'); // insufficient evidence ⇒ wait, don't reject

    const second = await tuner.labPass();
    expect(second.evaluated).toBe(0); // identical cohort ⇒ idempotent skip
    expect(second.skipped).toBe(1);

    // New evidence arrives → the cohort hash changes → re-evaluation happens.
    await recordEpisode('fresh-1');
    seedFailures(3);
    await recordEpisode('fresh-2');
    seedFailures(3);
    const third = await tuner.labPass();
    expect(third.evaluated).toBe(1);
    expect(third.activated).toBe(1);
    expect(tuner.all()[0].status).toBe('active');
  });

  it('concurrent lab passes do not duplicate evaluations', async () => {
    await recordPassingCohort();
    seedFailures(4);
    const tuner = new HarnessTuner(dir);
    tuner.mine();

    const [a, b] = await Promise.all([tuner.labPass(), tuner.labPass()]);
    expect(a.evaluated + b.evaluated).toBe(1); // one did the work, one stood down
    const exp = tuner.labStore().list()[0];
    expect(exp.evaluations).toHaveLength(1);
  });

  it('supports manual approve / reject / rollback with experiment bookkeeping', async () => {
    // No recorded episodes: the lab stays insufficient — manual control is the escape hatch.
    seedFailures(4);
    const tuner = new HarnessTuner(dir);
    tuner.mine();
    await tuner.labPass();
    const id = tuner.all()[0].id;
    expect(tuner.all()[0].status).toBe('staged');

    expect(tuner.approve(id)).toBe(true);
    expect(tuner.all()[0].status).toBe('active');
    expect(tuner.all()[0].activatedBy).toBe('user');
    expect(tuner.labStore().get(tuner.all()[0].labExperimentId!)!.status).toBe('activated');
    expect(tuner.approve(id)).toBe(false); // only staged patches can be approved

    expect(tuner.rollback(id)).toBe(true);
    expect(tuner.all()[0].status).toBe('retired');
    expect(tuner.labStore().get(tuner.all()[0].labExperimentId!)!.status).toBe('rolled_back');
    expect(tuner.rollback(id)).toBe(false);

    // Reject path on a fresh signature.
    seedFailures(4, 'timeout');
    const tuner2 = new HarnessTuner(dir);
    tuner2.mine();
    const staged = tuner2.all().find(p => p.status === 'staged')!;
    await tuner2.labPass();
    expect(tuner2.rejectStaged(staged.id)).toBe(true);
    expect(tuner2.all().find(p => p.id === staged.id)!.status).toBe('retired');
    expect(tuner2.labStore().get(tuner2.all().find(p => p.id === staged.id)!.labExperimentId!)!.status).toBe('rejected');
  });

  it('a vetoed candidate is retired with the lab verdict as its reason', async () => {
    await recordPassingCohort();
    // Hand-stage a patch whose block exceeds the prompt-cost cap.
    const fatRule = 'y'.repeat(LAB_GATES.MAX_BLOCK_CHARS + 50);
    fs.mkdirSync(path.join(dir, '.bimax'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.bimax', 'harness-patches.json'), JSON.stringify({
      patches: [{
        id: 'hp-fat', tool: 'ProbeTool', errorClass: 'no_match', rule: fatRule,
        createdAt: Date.now(), evidenceCount: 4, baselineRate: 0.5,
        samplesSince: 0, failuresSince: 0, status: 'staged', stagedAt: Date.now(),
      }],
    }));
    const tuner = new HarnessTuner(dir);
    const r = await tuner.labPass();
    expect(r.rejected).toBe(1);
    const p = tuner.all()[0];
    expect(p.status).toBe('retired');
    expect(p.retiredReason).toContain('lab veto');
    expect(tuner.labStore().get(p.labExperimentId!)!.status).toBe('rejected');
  });
});
