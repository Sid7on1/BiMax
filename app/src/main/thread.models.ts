/**
 * The ⌘2 bar's model menu: choose the model for a task, or answer again with another one. Pure, so the order, the
 * labels and the checkmarks can be tested without Electron.
 *
 * "Faster" is never guessed from a model's name. The menu shows how long turns have actually taken with each model
 * on this Mac (recorded when a turn ends) and lists the quickest first; models without a measurement follow.
 */
export interface CatalogModel {
  id: string;
  label?: string;
  tier: string;
  served: boolean;
  recommendedFor?: string[];
  capabilities?: { thinking?: boolean };
}

export interface ModelTime { avgMs: number; turns: number }

export type ModelMenuItem =
  | { kind: 'header'; label: string }
  | { kind: 'separator' }
  | { kind: 'model'; label: string; model: string | null; checked: boolean }
  | { kind: 'default'; label: string; model: string | null; checked: boolean };

export const shortModel = (id: string): string => id.split('/').pop() || id;

const seconds = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);

function describe(model: CatalogModel, times: Record<string, ModelTime>): string {
  const time = times[model.id];
  return `${shortModel(model.id)}${time ? ` — about ${seconds(time.avgMs)} a turn` : ''}${model.capabilities?.thinking ? ' · thinks first' : ''}`;
}

export function modelMenuItems(input: {
  models: readonly CatalogModel[];
  /** The task's own model; null when it uses Bimax's. */
  current: string | null;
  bimaxModel: string;
  quickDefault: string | null;
  times: Record<string, ModelTime>;
  mode: 'switch' | 'retry';
}): ModelMenuItem[] {
  const seen = new Set<string>();
  const candidates = input.models.filter((m) => m.served && m.tier !== 'other' && !seen.has(m.id) && seen.add(m.id) !== undefined);
  const rank = (m: CatalogModel): number => (m.recommendedFor?.includes('lite') ? 0 : m.recommendedFor?.includes('coding') ? 1 : 2);
  candidates.sort((a, b) => {
    const ta = input.times[a.id]?.avgMs ?? Number.POSITIVE_INFINITY;
    const tb = input.times[b.id]?.avgMs ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });
  const listed = candidates.slice(0, 14);
  const bimax = input.bimaxModel ? `Same as Bimax — ${shortModel(input.bimaxModel)}` : 'Same as Bimax';

  if (input.mode === 'retry') {
    const answeredWith = input.current ?? input.bimaxModel;
    return [
      { kind: 'header', label: 'Answer again with' },
      ...(input.current ? [{ kind: 'model' as const, label: bimax, model: null, checked: false }] : []),
      ...listed.filter((m) => m.id !== answeredWith).map((m) => ({ kind: 'model' as const, label: describe(m, input.times), model: m.id, checked: false })),
    ];
  }

  const items: ModelMenuItem[] = [
    { kind: 'header', label: 'Model for this task' },
    { kind: 'model', label: bimax, model: null, checked: input.current === null },
    { kind: 'separator' },
    ...listed.map((m) => ({ kind: 'model' as const, label: describe(m, input.times), model: m.id, checked: input.current === m.id })),
  ];
  if (!listed.length) items.push({ kind: 'header', label: 'More models appear once a task has started' });
  items.push(
    { kind: 'separator' },
    { kind: 'default', label: 'Use this model for new ⌘2 tasks', model: input.quickDefault === input.current ? null : input.current, checked: input.quickDefault === input.current },
  );
  return items;
}
