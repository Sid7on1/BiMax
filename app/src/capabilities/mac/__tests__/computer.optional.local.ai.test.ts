import {
  assessFineTuneReadiness,
  detectOptionalCuCapabilities,
  evaluateOptionalCuAI,
  rehearseHighRiskAction,
  type CuAiEvaluationBudget,
  type CuAiEvaluationMetrics,
} from '../optional.local.ai';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const budget: CuAiEvaluationBudget = {
  datasetDigest: digest('a'), evaluatorVersion: 'cu-frozen-v1', minimumQuality: 0.9,
  maximumFailureRate: 0.01, maximumWarmP95Ms: 1_000,
  maximumPeakMemoryBytes: 4_000_000_000, maximumEnergyProxy: 10,
  maximumModelSizeBytes: 4_000_000_000, minimumRepetitions: 5,
};
const metrics = (overrides: Partial<CuAiEvaluationMetrics> = {}): CuAiEvaluationMetrics => ({
  quality: 0.95, safetyPassed: true, failureRate: 0,
  coldP95Ms: 500, warmP95Ms: 250, peakMemoryBytes: 1_000_000_000,
  energyProxy: 3, modelSizeBytes: 1_500_000_000, repetitions: 5,
  ...overrides,
});

describe('Phase 7 optional local AI', () => {
  test('capability-detects macOS 26/27 Foundation Models and never removes the base controller', () => {
    const ready = detectOptionalCuCapabilities({
      platform: 'darwin', architecture: 'arm64', osMajor: 27,
      foundationModelsFrameworkLinked: true, foundationAvailability: 'available',
      foundationLocaleSupported: true, mlxWorkerAvailable: true,
      fastVlmArtifactDigest: digest('b'),
    });
    expect(ready.base).toEqual({
      id: 'deterministic', available: true, completeWithoutOptionalModels: true,
    });
    expect(ready.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'foundation_models', available: true }),
      expect.objectContaining({ id: 'fastvlm_mlx', available: true, artifactDigest: digest('b') }),
    ]));

    const oldMac = detectOptionalCuCapabilities({
      platform: 'darwin', architecture: 'x64', osMajor: 13,
      foundationModelsFrameworkLinked: false, foundationAvailability: 'unavailable',
      foundationLocaleSupported: false, mlxWorkerAvailable: false,
    });
    expect(oldMac.base.completeWithoutOptionalModels).toBe(true);
    expect(oldMac.candidates.every(candidate => !candidate.available)).toBe(true);
  });

  test('compares every candidate against one frozen quality/safety/resource budget', () => {
    const capabilities = detectOptionalCuCapabilities({
      platform: 'darwin', architecture: 'arm64', osMajor: 26,
      foundationModelsFrameworkLinked: true, foundationAvailability: 'available',
      foundationLocaleSupported: true, mlxWorkerAvailable: true,
      fastVlmArtifactDigest: digest('b'),
    });
    const receipt = evaluateOptionalCuAI({
      capabilities, budget,
      evaluations: [
        { id: 'deterministic', metrics: metrics({ warmP95Ms: 80, quality: 0.94, modelSizeBytes: 0 }) },
        { id: 'foundation_models', metrics: metrics({ quality: 0.97, warmP95Ms: 310, modelSizeBytes: 0 }) },
        { id: 'fastvlm_mlx', artifactDigest: digest('b'), metrics: metrics({ quality: 0.96, warmP95Ms: 220 }) },
      ],
    });
    expect(receipt).toMatchObject({
      datasetDigest: budget.datasetDigest, evaluatorVersion: budget.evaluatorVersion,
      baselinePassed: true, selectedAdviser: 'foundation_models',
    });
    expect(receipt.rows.every(row => row.accepted)).toBe(true);
  });

  test('rejects an unsafe or over-budget candidate and an unavailable candidate', () => {
    const capabilities = detectOptionalCuCapabilities({
      platform: 'darwin', architecture: 'arm64', osMajor: 25,
      foundationModelsFrameworkLinked: false, foundationAvailability: 'unavailable',
      foundationLocaleSupported: false, mlxWorkerAvailable: true,
      fastVlmArtifactDigest: digest('b'),
    });
    const receipt = evaluateOptionalCuAI({
      capabilities, budget,
      evaluations: [
        { id: 'deterministic', metrics: metrics({ modelSizeBytes: 0 }) },
        { id: 'foundation_models', metrics: metrics() },
        { id: 'fastvlm_mlx', artifactDigest: digest('b'), metrics: metrics({ safetyPassed: false, warmP95Ms: 2_000 }) },
      ],
    });
    expect(receipt.selectedAdviser).toBeNull();
    expect(receipt.rows.find(row => row.id === 'foundation_models')).toMatchObject({
      accepted: false, reasons: expect.arrayContaining(['candidate_unavailable']),
    });
    expect(receipt.rows.find(row => row.id === 'fastvlm_mlx')).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining(['safety_evaluator_failed', 'latency_above_budget']),
    });
  });

  test('rehearsal is additional only: deterministic refusal or disagreement always stops', () => {
    expect(rehearseHighRiskAction({
      enabled: true, deterministicAllowed: false, adviserAvailable: true, adviserAgrees: true,
    })).toMatchObject({ decision: 'stop', reason: 'deterministic_policy_refused' });
    expect(rehearseHighRiskAction({
      enabled: true, deterministicAllowed: true, adviserAvailable: true, adviserAgrees: false,
    })).toMatchObject({ decision: 'stop', reason: 'rehearsal_disagreed_or_abstained' });
    expect(rehearseHighRiskAction({
      enabled: true, deterministicAllowed: true, adviserAvailable: false,
    })).toMatchObject({ decision: 'stop', reason: 'enabled_rehearsal_unavailable' });
    expect(rehearseHighRiskAction({
      enabled: false, deterministicAllowed: true, adviserAvailable: false,
    })).toEqual({
      decision: 'allow', reason: 'optional_rehearsal_disabled', authority: 'deterministic_only',
    });
  });

  test('fine-tuning remains blocked until consent, redaction, licensing, and corpus sufficiency all pass', () => {
    expect(assessFineTuneReadiness({
      explicitConsent: false, redactionPassed: false, licensesAllowTraining: false,
      receiptCount: 5, minimumReceiptCount: 1_000, datasetDigest: 'missing',
      containsRawScreensOrTypedContent: true,
    })).toEqual({
      allowed: false,
      reasons: [
        'dataset_consent_missing', 'dataset_redaction_failed',
        'dataset_license_disallows_training', 'receipted_corpus_too_small',
        'dataset_digest_invalid',
      ],
    });
    expect(assessFineTuneReadiness({
      explicitConsent: true, redactionPassed: true, licensesAllowTraining: true,
      receiptCount: 1_500, minimumReceiptCount: 1_000, datasetDigest: digest('c'),
      containsRawScreensOrTypedContent: false,
    })).toEqual({ allowed: true, reasons: [] });
  });
});
