// Phase 8 slice 6 — the Desktop Trust Center's evidence surface.
//
// The gate rows this grades, from docs/product-reset/08_ACCEPTANCE_GATES.md (section 28):
//   - "an evidence gap, dropped event or unavailable sensor cannot produce an unqualified safe
//     verdict" — the headline and the row confidence must both refuse to read as clean;
//   - "deterministic hard floors, learned anomaly ranking and model explanation are separate in
//     receipts" — a model's words never merge into a finding;
//   - §2.4 "disable, delete, revoke, and diagnostic controls" with a stated retention — a delete
//     control has to say what it removes before it is used.

import {
  COMPLETE, Decision, EvidenceRecord, Finding, Observation, gap,
} from '../evidence.schema';
import {
  buildEvidenceTimeline, notableRows, retentionControls, timelineHeadline,
} from '../evidence.timeline';

const TASK = 'task_1';
const OP = 'op_1';
const PARENT = 'op_0';

const base = { schema: 'bimax.evidence/1' as const, createdAt: 1_000 };

const taskIntent: EvidenceRecord = {
  ...base, kind: 'TaskIntent', id: TASK, summary: 'run the unit tests',
  projectRoot: '/work/app', approvalMode: 'interactive',
  boundary: {
    writeRoots: ['/work/app'], readRoots: ['/work/app'], allowedHosts: [], allowNetwork: false,
    allowInstall: false, allowDeploy: false, allowCredentialAccess: false, allowPersistence: false,
    allowSecuritySettings: false,
  },
};

const parentOperation: EvidenceRecord = {
  ...base, kind: 'OperationIntent', id: PARENT, taskIntentId: TASK, parentOperationId: null,
  subsystem: 'engine-tool', operation: 'Bash(npm test)',
  actor: { kind: 'agent', id: 'bimax.engine', provenance: 'observed' },
  declared: { reads: [], writes: [], deletes: [], hosts: [], processes: [], installsDependencies: false, readOnly: false },
  taint: [],
};

const operation: EvidenceRecord = {
  ...base, kind: 'OperationIntent', id: OP, taskIntentId: TASK, parentOperationId: PARENT,
  subsystem: 'engine-tool', operation: 'sh -c ./collect.sh',
  actor: { kind: 'process', id: 'sh', provenance: 'observed' },
  declared: { reads: [], writes: [], deletes: [], hosts: [], processes: [], installsDependencies: false, readOnly: true },
  taint: [],
};

const observation = (over: Partial<Observation> = {}): EvidenceRecord => ({
  ...base, kind: 'Observation', id: `obs_${Math.random().toString(36).slice(2, 8)}`,
  sensor: 'engine.tool', scope: 'task', sensitivity: 'project', retention: 'task',
  taskIntentId: TASK, operationIntentId: OP,
  subject: { kind: 'file', id: '/work/app/src/a.ts', provenance: 'observed' },
  relationship: null, facts: {}, freshnessMs: 0, completeness: COMPLETE, ...over,
} as Observation);

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: 'BMX-A-CREDENTIAL-READ', layer: 'A',
  what: 'sh -c ./collect.sh proposed to read the credential store /Users/dev/.ssh/id_ed25519',
  violated: 'the task did not approve credential access',
  subjects: [{ kind: 'process', id: 'sh' }, { kind: 'file', id: '/Users/dev/.ssh/id_ed25519' }],
  benignExplanations: [], evidence: [{ observationId: 'obs_1', why: 'the read' }], ...over,
});

const decision = (over: Partial<Decision> = {}): EvidenceRecord => ({
  ...base, kind: 'Decision', id: `dec_${Math.random().toString(36).slice(2, 8)}`,
  taskIntentId: TASK, operationIntentId: OP, ruleVersion: 'bimax.rules/1.0.0', modelVersion: null,
  layer: 'A',
  factors: {
    hardBoundary: true, taskMismatch: false, identityTrust: 'known', targetSensitivity: 'sensitive',
    persistencePotential: false, networkNovelty: false, causalCombination: false,
    observationCompleteness: COMPLETE, anomalyConfidence: null,
  },
  disposition: 'block', findings: [finding()], evidenceBasis: 'observed', modelExplanation: null,
  ...over,
} as Decision);

describe('the timeline reads the causal path the way a user would', () => {
  it('shows the nested operation with its parent chain', () => {
    const timeline = buildEvidenceTimeline([taskIntent, parentOperation, operation, observation(), decision()]);
    const row = timeline.rows.find(r => r.operationId === OP)!;
    expect(row.causalPath).toEqual(['sh -c ./collect.sh', 'Bash(npm test)']);
    expect(row.disposition).toBe('block');
    expect(timeline.task?.summary).toBe('run the unit tests');
  });

  it('lets a receipt-stage decision supersede the proposal it followed', () => {
    const timeline = buildEvidenceTimeline([
      taskIntent, operation, observation(),
      decision({ disposition: 'observe', findings: [], layer: 'B', factors: { ...(decision() as Decision).factors, hardBoundary: false } }),
      decision({ disposition: 'block' }),
    ]);
    const row = timeline.rows[0];
    expect(row.disposition).toBe('block');
    // Both decisions' findings remain visible; the current verdict is the later one.
    expect(row.findings).toHaveLength(1);
  });
});

describe('an evidence gap can never read as a clean bill of health', () => {
  it('marks the row incomplete and quotes the sensor\'s own reason', () => {
    const timeline = buildEvidenceTimeline([
      taskIntent, operation,
      observation({ completeness: gap('the native event queue overflowed', 42) }),
      decision({
        disposition: 'explain', layer: 'B', findings: [],
        factors: { ...(decision() as Decision).factors, observationCompleteness: gap('the native event queue overflowed', 42) },
      }),
    ]);
    const row = timeline.rows[0];
    expect(row.confidence).toBe('incomplete');
    expect(row.evidenceGap).toBe('the native event queue overflowed');
    expect(timeline.hasEvidenceGap).toBe(true);
  });

  it('refuses to headline a gap-bearing task as all clear', () => {
    const timeline = buildEvidenceTimeline([
      taskIntent, operation,
      observation({ completeness: gap('the sensor is unavailable') }),
      decision({ disposition: 'explain', layer: 'B', findings: [], factors: { ...(decision() as Decision).factors, observationCompleteness: gap('the sensor is unavailable') } }),
    ]);
    expect(timelineHeadline(timeline)).toBe(
      'no findings — but some evidence is incomplete, so this is not a clean bill of health',
    );
  });

  it('headlines a genuinely clean task plainly', () => {
    const timeline = buildEvidenceTimeline([
      taskIntent, operation, observation(),
      decision({ disposition: 'observe', layer: 'B', findings: [], factors: { ...(decision() as Decision).factors, hardBoundary: false } }),
    ]);
    expect(timelineHeadline(timeline)).toBe('1 operation recorded, all within the approved boundary');
    expect(timeline.hasEvidenceGap).toBe(false);
  });

  it('treats an eviction as a gap, so a shorter timeline is not a quieter machine', () => {
    const timeline = buildEvidenceTimeline(
      [taskIntent, operation, observation(), decision({ disposition: 'observe', layer: 'B', findings: [], factors: { ...(decision() as Decision).factors, hardBoundary: false } })],
      [{ reason: 'retention', droppedRecords: 12 }],
    );
    expect(timeline.hasEvidenceGap).toBe(true);
    expect(timeline.retention.evictions).toEqual([{ reason: 'retention', droppedRecords: 12 }]);
  });

  it('separates declared evidence from measured evidence', () => {
    const declared = buildEvidenceTimeline([
      taskIntent, operation,
      observation({ subject: { kind: 'file', id: '/work/app/src/a.ts', provenance: 'declared' } }),
      decision({ evidenceBasis: 'declared' }),
    ]);
    expect(declared.rows[0].confidence).toBe('declared');
    const measured = buildEvidenceTimeline([taskIntent, operation, observation(), decision()]);
    expect(measured.rows[0].confidence).toBe('measured');
  });
});

describe('a model explanation is kept apart from the deterministic findings', () => {
  it('carries the model\'s words in their own attributed field', () => {
    const timeline = buildEvidenceTimeline([
      taskIntent, operation, observation(),
      decision({
        layer: 'F', disposition: 'explain', modelVersion: 'bimax-explain/1',
        modelExplanation: 'this pattern often precedes credential exfiltration',
        findings: [finding({ ruleId: 'BMX-F-MODEL-HYPOTHESIS', layer: 'F', benignExplanations: ['a developer reading their own key'] })],
      }),
    ]);
    const row = timeline.rows[0];
    expect(row.modelExplanation).toEqual({
      version: 'bimax-explain/1',
      text: 'this pattern often precedes credential exfiltration',
    });
    expect(JSON.stringify(row.findings)).not.toContain('often precedes');
  });

  it('carries no model field when no model contributed', () => {
    const timeline = buildEvidenceTimeline([taskIntent, operation, observation(), decision()]);
    expect(timeline.rows[0].modelExplanation).toBeNull();
  });
});

describe('the surface shows receipts and verifications truthfully', () => {
  const receipt: EvidenceRecord = {
    ...base, kind: 'ActionReceipt', id: 'rcp_1', operationIntentId: OP, approvalId: null,
    executor: 'bash', outcome: 'applied',
    observed: { reads: [], writes: [], deletes: [], hosts: [], processes: [], installsDependencies: false, readOnly: true },
    before: [], after: ['obs_1'], reason: 'the tool completed',
  };

  it('shows an unknown verification as unknown, not as a pass', () => {
    const verification: EvidenceRecord = {
      ...base, kind: 'Verification', id: 'ver_1', actionReceiptId: 'rcp_1',
      postcondition: 'the bundle exists', satisfied: null, freshnessMs: 0, freshnessBudgetMs: 5_000,
      completeness: COMPLETE, basis: 'declared', evidence: [],
      reason: 'the postcondition could not be established: this rests on declared effects',
    };
    const timeline = buildEvidenceTimeline([taskIntent, operation, observation(), decision(), receipt, verification]);
    expect(timeline.rows[0].verification).toEqual({
      postcondition: 'the bundle exists',
      satisfied: null,
      reason: 'the postcondition could not be established: this rests on declared effects',
    });
  });

  it('surfaces a failed verification as notable even with no findings', () => {
    const failed: EvidenceRecord = {
      ...base, kind: 'Verification', id: 'ver_2', actionReceiptId: 'rcp_1',
      postcondition: 'the lockfile is unchanged', satisfied: false, freshnessMs: 0,
      freshnessBudgetMs: 5_000, completeness: COMPLETE, basis: 'observed',
      evidence: [{ observationId: 'obs_1', why: 'the lockfile digest' }],
      reason: 'the observed end state does not satisfy the postcondition',
    };
    const timeline = buildEvidenceTimeline([
      taskIntent, operation, observation(),
      decision({ disposition: 'observe', layer: 'B', findings: [], factors: { ...(decision() as Decision).factors, hardBoundary: false } }),
      receipt, failed,
    ]);
    expect(notableRows(timeline)).toHaveLength(1);
  });

  it('shows the executor and outcome of the receipt', () => {
    const timeline = buildEvidenceTimeline([taskIntent, operation, observation(), decision(), receipt]);
    expect(timeline.rows[0].receipt).toEqual({ executor: 'bash', outcome: 'applied', reason: 'the tool completed' });
  });
});

describe('retention controls state their blast radius before they are used', () => {
  const records = [taskIntent, parentOperation, operation, observation(), observation(), decision()];

  it('counts exactly what deleting this task would remove', () => {
    const controls = retentionControls(records, TASK);
    expect(controls[0].affectedRecords).toBe(records.length);
    expect(controls[0].effect).toContain('findings already shown are gone');
  });

  it('warns that deleting observations makes surviving decisions unverifiable', () => {
    const controls = retentionControls(records, TASK);
    expect(controls[1].affectedRecords).toBe(2);
    expect(controls[1].effect).toContain('unverifiable');
  });

  it('reports the retention summary by record kind', () => {
    const timeline = buildEvidenceTimeline(records);
    expect(timeline.retention.byKind).toEqual({
      TaskIntent: 1, OperationIntent: 2, Observation: 2, Decision: 1,
    });
    expect(timeline.retention.totalRecords).toBe(6);
  });

  it('says so plainly when there is nothing recorded yet', () => {
    expect(timelineHeadline(buildEvidenceTimeline([taskIntent])))
      .toBe('no operations recorded for this task yet');
  });
});
