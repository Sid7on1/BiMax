import type { CatalogModelEntry } from '../../protocol';

export type ModelPickerTier = CatalogModelEntry['tier'] | undefined;

export interface ModelPickerGroups {
  recommended: CatalogModelEntry[];
  unverified: CatalogModelEntry[];
  extra: CatalogModelEntry[];
  availableTotal: number;
}

const recommendedFor = (model: CatalogModelEntry, tier: ModelPickerTier): boolean =>
  !tier
  || (tier === 'other'
    ? model.tier === 'other'
    : (model.recommendedFor ?? (model.tier === 'other' ? [] : [model.tier])).includes(tier));

/**
 * Slot-aware catalogue projection used by the model window.
 *
 * With no query it returns a calm, curated first screen. Browse all expands the live inventory;
 * typing searches that same complete inventory immediately, so a heavy Work model remains
 * reachable from Quick without being presented as a speed recommendation.
 */
export function buildModelPickerGroups(
  all: CatalogModelEntry[],
  tier: ModelPickerTier,
  query: string,
  showAll: boolean,
): ModelPickerGroups {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? all.filter((model) =>
        [model.id, model.label, model.desc, model.parameters, model.releaseDate, ...(model.tags ?? [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : all;
  const recommended = matches.filter((model) => model.curated && model.served && recommendedFor(model, tier));
  const unverified = matches.filter((model) => model.curated && !model.served && recommendedFor(model, tier));
  const extra =
    needle || showAll || !tier ? matches.filter((model) => model.served && !recommended.includes(model)) : [];
  const availableTotal = new Set(all.filter((model) => model.served).map((model) => model.id)).size;
  return { recommended, unverified, extra, availableTotal };
}
