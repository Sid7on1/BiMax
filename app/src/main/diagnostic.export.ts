import type { CrashRecord, SupervisorStatus } from './supervisor/types';

export const DIAGNOSTIC_EXPORT_OMISSIONS = [
  'API keys, tokens, passwords and environment variables',
  'project paths, file contents and source code',
  'conversation and model transcript content',
  'raw engine logs and crash log tails',
] as const;

/**
 * A deliberately allowlisted support bundle. Adding a new field requires choosing it here; passing
 * a large runtime object through JSON.stringify can never silently widen the privacy boundary.
 */
export function buildDiagnosticExport(input: {
  now: () => Date;
  status: SupervisorStatus | null;
  crashes: CrashRecord[];
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: input.now().toISOString(),
    privacy: {
      localFirst: true,
      destinationChosenByUser: true,
      omitted: [...DIAGNOSTIC_EXPORT_OMISSIONS],
    },
    product: {
      mode: 'agentic-coding-ide',
      nativeAutomation: 'disabled',
    },
    supervisor: input.status ? {
      phase: input.status.phase,
      reason: input.status.reason,
      attempt: input.status.attempt,
      generation: input.status.generation,
      profile: input.status.profile,
      capabilities: input.status.capabilities,
      degradedCapabilities: input.status.degradedCapabilities,
      lastHeartbeat: input.status.lastHeartbeat,
    } : null,
    crashes: input.crashes.slice(-10).map((crash) => ({
      at: crash.at,
      kind: crash.kind,
      lastPhase: crash.lastPhase,
      uptimeMs: crash.uptimeMs,
      exitCode: crash.exitCode,
      signal: crash.signal,
      protocol: crash.protocol,
      memory: crash.memory,
      profile: crash.profile,
      capabilities: crash.capabilities,
      attempt: crash.attempt,
      interruptedWork: crash.interruptedWork,
      recovery: crash.recovery,
    })),
  };
}
