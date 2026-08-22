/**
 * Phase 7 optional local-AI policy for Computer Use.
 *
 * The deterministic controller is always the complete base product. Foundation Models and
 * FastVLM/MLX are capability-probed, measured candidates that may advise selection or add a
 * rehearsal check; they can never create action authority or relax a deterministic refusal.
 */

export type OptionalCuModel = 'foundation_models' | 'fastvlm_mlx';
export type FoundationAvailability =
  | 'available' | 'device_not_eligible' | 'model_not_ready' | 'locale_unsupported' | 'unavailable';

export interface OptionalCuHostProbe {
  platform: string;
  architecture: string;
  osMajor: number;
  foundationModelsFrameworkLinked: boolean;
  foundationAvailability: FoundationAvailability;
  foundationLocaleSupported: boolean;
  mlxWorkerAvailable: boolean;
  fastVlmArtifactDigest?: string;
}

export interface OptionalCuCapabilities {
  base: { id: 'deterministic'; available: true; completeWithoutOptionalModels: true };
  candidates: Array<{
    id: OptionalCuModel;
    available: boolean;
    reason: string;
    artifactDigest?: string;
  }>;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function detectOptionalCuCapabilities(probe: OptionalCuHostProbe): OptionalCuCapabilities {
  const supportedOS = probe.platform === 'darwin' && probe.osMajor >= 26;
  const foundationAvailable = supportedOS && probe.foundationModelsFrameworkLinked
    && probe.foundationAvailability === 'available' && probe.foundationLocaleSupported;
  const fastVlmAvailable = probe.platform === 'darwin' && probe.architecture === 'arm64'
    && probe.mlxWorkerAvailable && !!probe.fastVlmArtifactDigest && DIGEST.test(probe.fastVlmArtifactDigest);
  return {
    base: { id: 'deterministic', available: true, completeWithoutOptionalModels: true },
    candidates: [
      {
        id: 'foundation_models', available: foundationAvailable,
        reason: foundationAvailable
          ? 'Foundation Models host probe reports an available model and supported locale.'
          : !supportedOS ? 'Foundation Models requires a capability-probed macOS 26 or newer host.'
            : !probe.foundationModelsFrameworkLinked ? 'The optional Foundation Models bridge is not linked.'
              : probe.foundationAvailability !== 'available'
                ? `The system model reports ${probe.foundationAvailability}.`
                : 'The current locale is unsupported.',
      },
      {
        id: 'fastvlm_mlx', available: fastVlmAvailable,
        reason: fastVlmAvailable
          ? 'An isolated MLX worker and digest-bound FastVLM artifact are available on Apple silicon.'
          : 'FastVLM/MLX needs Apple silicon, an isolated worker, and a valid artifact digest.',
        ...(probe.fastVlmArtifactDigest && DIGEST.test(probe.fastVlmArtifactDigest)
          ? { artifactDigest: probe.fastVlmArtifactDigest } : {}),
      },
    ],
  };
}

export interface CuAiEvaluationMetrics {
  quality: number;
  safetyPassed: boolean;
  failureRate: number;
  coldP95Ms: number;
  warmP95Ms: number;
  peakMemoryBytes: number;
  energyProxy: number;
  modelSizeBytes: number;
  repetitions: number;
}

export interface CuAiEvaluationBudget {
  datasetDigest: string;
  evaluatorVersion: string;
  minimumQuality: number;
  maximumFailureRate: number;
  maximumWarmP95Ms: number;
  maximumPeakMemoryBytes: number;
  maximumEnergyProxy: number;
  maximumModelSizeBytes: number;
  minimumRepetitions: number;
}

export interface CuAiCandidateEvaluation {
  id: 'deterministic' | OptionalCuModel;
  metrics: CuAiEvaluationMetrics;
  artifactDigest?: string;
}

export interface CuAiEvaluationReceipt {
  datasetDigest: string;
  evaluatorVersion: string;
  baselinePassed: boolean;
  rows: Array<CuAiCandidateEvaluation & { available: boolean; accepted: boolean; reasons: string[] }>;
  selectedAdviser: OptionalCuModel | null;
}

function metricProblems(metrics: CuAiEvaluationMetrics, budget: CuAiEvaluationBudget): string[] {
  const reasons: string[] = [];
  if (!metrics.safetyPassed) reasons.push('safety_evaluator_failed');
  if (metrics.quality < budget.minimumQuality) reasons.push('quality_below_budget');
  if (metrics.failureRate > budget.maximumFailureRate) reasons.push('failure_rate_above_budget');
  if (metrics.warmP95Ms > budget.maximumWarmP95Ms) reasons.push('latency_above_budget');
  if (metrics.peakMemoryBytes > budget.maximumPeakMemoryBytes) reasons.push('memory_above_budget');
  if (metrics.energyProxy > budget.maximumEnergyProxy) reasons.push('energy_above_budget');
  if (metrics.modelSizeBytes > budget.maximumModelSizeBytes) reasons.push('model_size_above_budget');
  if (metrics.repetitions < budget.minimumRepetitions) reasons.push('insufficient_repetitions');
  for (const value of [metrics.quality, metrics.failureRate, metrics.coldP95Ms, metrics.warmP95Ms,
    metrics.peakMemoryBytes, metrics.energyProxy, metrics.modelSizeBytes, metrics.repetitions]) {
    if (!Number.isFinite(value) || value < 0) reasons.push('invalid_metric');
  }
  return [...new Set(reasons)];
}

export function evaluateOptionalCuAI(input: {
  capabilities: OptionalCuCapabilities;
  budget: CuAiEvaluationBudget;
  evaluations: CuAiCandidateEvaluation[];
}): CuAiEvaluationReceipt {
  if (!DIGEST.test(input.budget.datasetDigest)) throw new Error('cu_ai_dataset_digest_invalid');
  if (!input.budget.evaluatorVersion.trim()) throw new Error('cu_ai_evaluator_version_required');
  const capability = new Map(input.capabilities.candidates.map(row => [row.id, row]));
  const baseline = input.evaluations.find(row => row.id === 'deterministic');
  if (!baseline) throw new Error('deterministic_baseline_required');
  const rows = input.evaluations.map(row => {
    const availability = row.id === 'deterministic' ? true : capability.get(row.id)?.available === true;
    const reasons = metricProblems(row.metrics, input.budget);
    if (!availability) reasons.push('candidate_unavailable');
    if (row.id !== 'deterministic' && row.artifactDigest && !DIGEST.test(row.artifactDigest)) {
      reasons.push('artifact_digest_invalid');
    }
    return { ...row, available: availability, accepted: reasons.length === 0, reasons };
  });
  const baselineRow = rows.find(row => row.id === 'deterministic')!;
  const optional = rows.filter((row): row is typeof row & { id: OptionalCuModel } => row.id !== 'deterministic' && row.accepted);
  optional.sort((a, b) => b.metrics.quality - a.metrics.quality
    || a.metrics.failureRate - b.metrics.failureRate
    || a.metrics.warmP95Ms - b.metrics.warmP95Ms
    || a.metrics.peakMemoryBytes - b.metrics.peakMemoryBytes);
  return {
    datasetDigest: input.budget.datasetDigest,
    evaluatorVersion: input.budget.evaluatorVersion,
    baselinePassed: baselineRow.accepted,
    rows,
    // An optional model is an adviser only. A failing base product cannot be hidden by it.
    selectedAdviser: baselineRow.accepted ? optional[0]?.id ?? null : null,
  };
}

export interface RehearsalDecision {
  decision: 'allow' | 'stop';
  reason: string;
  authority: 'deterministic_only' | 'deterministic_plus_rehearsal';
}

export function rehearseHighRiskAction(input: {
  enabled: boolean;
  deterministicAllowed: boolean;
  adviserAvailable: boolean;
  adviserAgrees?: boolean;
}): RehearsalDecision {
  if (!input.deterministicAllowed) {
    return { decision: 'stop', reason: 'deterministic_policy_refused', authority: 'deterministic_only' };
  }
  if (!input.enabled) {
    return { decision: 'allow', reason: 'optional_rehearsal_disabled', authority: 'deterministic_only' };
  }
  if (!input.adviserAvailable) {
    return { decision: 'stop', reason: 'enabled_rehearsal_unavailable', authority: 'deterministic_plus_rehearsal' };
  }
  if (input.adviserAgrees !== true) {
    return { decision: 'stop', reason: 'rehearsal_disagreed_or_abstained', authority: 'deterministic_plus_rehearsal' };
  }
  return {
    decision: 'allow', reason: 'deterministic_policy_allowed_and_rehearsal_agreed',
    authority: 'deterministic_plus_rehearsal',
  };
}

export interface FineTuneDatasetReadiness {
  explicitConsent: boolean;
  redactionPassed: boolean;
  licensesAllowTraining: boolean;
  receiptCount: number;
  minimumReceiptCount: number;
  datasetDigest: string;
  containsRawScreensOrTypedContent: boolean;
}

export function assessFineTuneReadiness(input: FineTuneDatasetReadiness): {
  allowed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!input.explicitConsent) reasons.push('dataset_consent_missing');
  if (!input.redactionPassed || input.containsRawScreensOrTypedContent) reasons.push('dataset_redaction_failed');
  if (!input.licensesAllowTraining) reasons.push('dataset_license_disallows_training');
  if (!Number.isSafeInteger(input.receiptCount) || !Number.isSafeInteger(input.minimumReceiptCount)
      || input.minimumReceiptCount < 1 || input.receiptCount < input.minimumReceiptCount) {
    reasons.push('receipted_corpus_too_small');
  }
  if (!DIGEST.test(input.datasetDigest)) reasons.push('dataset_digest_invalid');
  return { allowed: reasons.length === 0, reasons };
}
