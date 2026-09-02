import type { CatalogModelEntry, EngineCatalog, EngineConfig } from './protocol';

export interface ComputerUseModelReadiness {
  ready: boolean;
  work?: CatalogModelEntry;
  vision?: CatalogModelEntry;
  reasons: string[];
}

/**
 * Fail-closed model preflight for Control Mac.
 *
 * A configured string is not a route. The active provider must have a key, its live catalogue must
 * confirm the work model, and screenshots must have a confirmed vision-capable route (either the
 * work model itself or the dedicated Vision slot). This check happens before the task reaches the
 * engine so an incompatible model cannot start a half-working Computer Use turn.
 */
export function computerUseModelReadiness(
  config: EngineConfig | null,
  catalog: EngineCatalog | null,
): ComputerUseModelReadiness {
  const reasons: string[] = [];
  if (!config) reasons.push('The engine configuration is not available.');
  if (!catalog) reasons.push('The provider catalogue has not loaded.');
  if (catalog?.error) reasons.push('The active provider could not be verified.');

  const provider = catalog?.providers.find((entry) => entry.active);
  if (catalog && !provider) reasons.push('Choose an active provider.');
  if (provider && !provider.hasKey) reasons.push(`Add an API key for ${provider.label}.`);

  // Slot membership is many-to-many. One unique row may be recommended for Work and Vision, so
  // validate `recommendedFor` rather than treating the row's primary display tier as exclusive.
  const rowsFor = (id: string): CatalogModelEntry[] => (catalog?.models ?? []).filter((entry) => entry.id === id);
  const workId = String(config?.model || '').trim();
  const workRows = rowsFor(workId);
  const recommendedForWork = (entry: CatalogModelEntry): boolean =>
    (entry.recommendedFor ?? (entry.tier === 'other' ? [] : [entry.tier])).includes('coding');
  const work =
    workRows.find((entry) => recommendedForWork(entry) && entry.served) ??
    workRows.find((entry) => recommendedForWork(entry)) ??
    workRows.find((entry) => entry.served) ??
    workRows[0];
  if (!workId) reasons.push('Choose a Work model.');
  else if (!work || !work.served) reasons.push('Choose a Work model confirmed by this provider.');
  else if (!work.curated || !recommendedForWork(work)) {
    reasons.push('Choose a Work model verified for agent tool use.');
  }

  // avoidAutoSelect is deliberately not an execution ban. It means Bimax must not silently move a
  // user onto that model; the catalogue contract explicitly permits an intentional selection.
  // Runtime `requireTool` enforcement remains the bounded truth test if a selected route cannot
  // emit the native function call.

  const visionId = work?.capabilities?.visionInput ? work.id : String(config?.visionModel || '').trim();
  const visionRows = rowsFor(visionId);
  const vision =
    visionRows.find((entry) => entry.served && entry.capabilities?.visionInput) ??
    visionRows.find((entry) => entry.capabilities?.visionInput) ??
    visionRows.find((entry) => entry.served) ??
    visionRows[0];
  if (!visionId) reasons.push('Choose a Vision model for screenshot grounding.');
  else if (!vision || !vision.served || !vision.capabilities?.visionInput) {
    reasons.push('Choose a served model that supports image input for Vision.');
  }

  return { ready: reasons.length === 0, work, vision, reasons };
}
