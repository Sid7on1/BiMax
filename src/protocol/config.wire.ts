/**
 * The settings surface behind protocol v3's `configGet` / `configSet`.
 *
 * This is the silent path a graphical front-end uses instead of driving transcript menus, and it
 * exists as its own module for one reason: it has to be testable without booting a container.
 *
 * The bug it was extracted to prevent — a settings screen that verifies the wrong thing:
 *
 *   `configSet` used to `saveConfig(patch)` and then answer with the config FILE. The file had
 *   genuinely changed, so the front-end's read-back compared its own request against its own
 *   request and reported "applied" every time. But `LlmAdapter` caches the model slots at boot
 *   (`userModel` / `defaultModel`), and nothing here ever told it. Every other write path —
 *   `/model` (engine/commands/meta.ts), `/config set` (engine/commands/builtins.ts), ModelTool — follows
 *   its save with an `applyConfig`. This one did not, so the desktop's model picker changed the
 *   file, said it worked, and every request kept going to the model loaded at startup.
 *
 * Two invariants follow, and both are pinned by `src/__tests__/config.wire.test.ts`:
 *
 *   1. A write that touches an adapter-owned key MUST reach the adapter.
 *   2. A read MUST report the adapter's loaded state for those keys, not the file's — so when the
 *      two disagree, the front-end sees the disagreement instead of a false success.
 */

/**
 * The allowlisted, JSON-safe subset of `EngineConfig` a front-end may read and write directly.
 * Sensitive / engine-internal keys (API keys, workspaceRoot, dangerouslySkipPermissions,
 * onboarding flags) stay OFF the wire on purpose.
 */
export const CONFIG_WIRE_KEYS = [
  'model', 'liteModel', 'visionModel', 'fallbackModel', 'subagentModel',
  'provider', 'providerBaseURL',
  'temperature', 'topP', 'maxTokens', 'timeout',
  'reasoningEffort', 'maxThinkingTokens',
  'contextMode', 'contextWindowTokens', 'parallelToolCalls',
  'maxToolIterations', 'maxSubAgents',
  'autoResumeAgents',
  'notificationBell', 'verbose', 'reducedMotion', 'theme',
  'autoIndex', 'gitAutoCommit', 'autoVerify', 'sandboxBash',
  'autoContinueOutcome',
  'selfCritic', 'adversarialVerify', 'diffApproval', 'blastGate',
  'showMapPanel', 'showTokenMeter',
] as const;

/**
 * The subset of the above that `LlmAdapter.applyConfig` owns. Persisting one of these is only half
 * the change; the adapter holds its own copy and answers every request from it.
 */
export const ADAPTER_KEYS = [
  'model', 'liteModel', 'visionModel', 'reasoningEffort',
  'temperature', 'topP', 'maxTokens', 'timeout', 'parallelToolCalls',
] as const;

/** The slice of `LlmAdapter` this module needs. Kept structural so tests can pass a stub. */
export interface ConfigWireAdapter {
  applyConfig?: (cfg: Record<string, any>) => void;
  readEffective?: () => Record<string, any>;
}

export interface ConfigWireDeps {
  getConfig: () => Record<string, any>;
  saveConfig: (updates: Record<string, any>) => Promise<unknown>;
  llmAdapter?: ConfigWireAdapter | null;
  /** Notifies attached front-ends + re-snapshots. Called only when something actually changed. */
  onChanged?: () => void;
}

export interface ConfigWire {
  /** Answer `configGet` / the result of `configSet`. */
  read: () => Record<string, any>;
  /** Handle `configSet`: filter, persist, apply to the live adapter, then answer with the truth. */
  write: (patch: Record<string, any>) => Promise<Record<string, any>>;
}

export function createConfigWire(deps: ConfigWireDeps): ConfigWire {
  const read = (): Record<string, any> => {
    const out: Record<string, any> = {};
    try {
      const file = deps.getConfig() ?? {};
      for (const key of CONFIG_WIRE_KEYS) if (file[key] !== undefined) out[key] = file[key];
    } catch { /* config not loaded yet — the adapter below may still have answers */ }
    // The adapter wins for its own keys: it is what the next request will actually use.
    try {
      const live = deps.llmAdapter?.readEffective?.();
      if (live) for (const key of ADAPTER_KEYS) if (live[key] !== undefined) out[key] = live[key];
    } catch { /* adapter optional in embeds/tests — the file subset still answers */ }
    return out;
  };

  const write = async (patch: Record<string, any>): Promise<Record<string, any>> => {
    const safe: Record<string, any> = {};
    for (const key of CONFIG_WIRE_KEYS) if (patch?.[key] !== undefined) safe[key] = patch[key];
    if (Object.keys(safe).length === 0) return read();

    await deps.saveConfig(safe);

    // Only forward keys actually present. `applyConfig` treats `undefined` as "leave alone", which
    // is what makes a single-key patch from one settings row safe.
    const adapterPatch: Record<string, any> = {};
    for (const key of ADAPTER_KEYS) if (safe[key] !== undefined) adapterPatch[key] = safe[key];
    if (Object.keys(adapterPatch).length > 0) {
      try { deps.llmAdapter?.applyConfig?.(adapterPatch); }
      catch { /* the saved config still applies on next boot; never fail the write over this */ }
    }

    deps.onChanged?.();
    return read();
  };

  return { read, write };
}
