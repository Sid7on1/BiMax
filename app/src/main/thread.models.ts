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

/** How turns with a model have gone on this Mac: a running average over the last 20, and how many of them failed (FL9). */
export interface ModelTime { avgMs: number; turns: number; failed?: number }

/** The ⌘2 default that means "the fastest model measured to handle tools well" rather than one named model (FL9). */
export const AUTO_FASTEST = 'auto:fastest';
/** A model is judged on at least this many turns, and must fail at most this share of them. */
export const MIN_TURNS = 3;
export const MAX_FAIL_RATE = 0.2;

/**
 * One finished turn folded into a model's record. A failed turn counts against the model (often a malformed tool call
 * or a refused request) but not in its average time, which a failure would make look fast. Old counts decay: at 20
 * turns each new one weighs 1/20, and failures shrink in step, so a model that got better is seen to.
 */
export function recordTurn(prior: ModelTime | undefined, tookMs: number, failed: boolean): ModelTime {
  const turns = Math.min((prior?.turns ?? 0) + 1, 20);
  const oldFailed = prior?.failed ?? 0;
  const keptFailed = prior && prior.turns >= 20 ? oldFailed * (19 / 20) : oldFailed;
  const avgMs = failed ? (prior?.avgMs ?? tookMs) : Math.round((prior?.avgMs ?? tookMs) + (tookMs - (prior?.avgMs ?? tookMs)) / turns);
  return { avgMs, turns, failed: Math.round((keptFailed + (failed ? 1 : 0)) * 100) / 100 };
}

/**
 * The fastest model this Mac has measured that handles tools well: served by the provider, meant for coding (tool
 * use), judged on enough turns, and rarely failing. Null until there is such a measurement.
 */
/** What choosing needs from a catalogue entry. */
export type ModelLike = Pick<CatalogModel, 'id' | 'served'> & Partial<Pick<CatalogModel, 'tier' | 'recommendedFor'>>;

export function fastestCapable(models: readonly ModelLike[], times: Record<string, ModelTime>): { id: string; avgMs: number } | null {
  let best: { id: string; avgMs: number } | null = null;
  for (const m of models) {
    if (!m.served || !(m.tier === 'coding' || m.recommendedFor?.includes('coding'))) continue;
    const time = times[m.id];
    if (!time || time.turns < MIN_TURNS || (time.failed ?? 0) / time.turns > MAX_FAIL_RATE) continue;
    if (!best || time.avgMs < best.avgMs) best = { id: m.id, avgMs: time.avgMs };
  }
  return best;
}

/** The model a new ⌘2 task starts with: the saved choice, or — for "Fastest measured" — that model, else Bimax's own. */
export function quickModelFor(saved: string | undefined, models: readonly ModelLike[], times: Record<string, ModelTime>): string | undefined {
  if (saved !== AUTO_FASTEST) return saved || undefined;
  return fastestCapable(models, times)?.id;
}

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
  const fastest = fastestCapable(input.models, input.times);
  items.push(
    { kind: 'separator' },
    { kind: 'default', label: 'Use this model for new ⌘2 tasks', model: input.quickDefault === input.current ? null : input.current, checked: input.quickDefault === input.current },
    // FL9: let the measurements choose.
    { kind: 'default', label: fastest ? `New ⌘2 tasks: fastest measured — now ${shortModel(fastest.id)}, about ${seconds(fastest.avgMs)} a turn` : 'New ⌘2 tasks: fastest measured (after a few turns)',
      model: input.quickDefault === AUTO_FASTEST ? null : AUTO_FASTEST, checked: input.quickDefault === AUTO_FASTEST },
  );
  return items;
}
