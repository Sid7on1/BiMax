import { AUTO_FASTEST, fastestCapable, modelMenuItems, quickModelFor, recordTurn } from '../main/thread.models';
import { DEFAULT_TALK_MODEL, talkModel } from '../main/talk.session';

/** Backlog FL9: talk mode and ⌘2 use the fastest model this Mac measured to handle tools well. */

const m = (id: string, tier = 'coding', served = true) => ({ id, tier, served });
const t = (avgMs: number, turns: number, failed = 0) => ({ avgMs, turns, failed });

test('a turn is folded in: failures count against a model but not in its time', () => {
  expect(recordTurn(undefined, 4000, false)).toEqual({ avgMs: 4000, turns: 1, failed: 0 });
  expect(recordTurn({ avgMs: 4000, turns: 1 }, 2000, false)).toEqual({ avgMs: 3000, turns: 2, failed: 0 });
  expect(recordTurn({ avgMs: 3000, turns: 2, failed: 0 }, 100, true)).toEqual({ avgMs: 3000, turns: 3, failed: 1 });
  expect(recordTurn(undefined, 0, true)).toEqual({ avgMs: 0, turns: 1, failed: 1 });
  // At 20 turns old failures fade in step with the average.
  expect(recordTurn({ avgMs: 3000, turns: 20, failed: 10 }, 3000, false).failed).toBe(9.5);
});

test('the fastest model that is served, meant for tools, measured enough and rarely failing', () => {
  const models = [m('a/fast-but-chat', 'lite'), m('b/fast-flaky'), m('c/fast-unproven'), m('d/steady'), m('e/slow'), m('f/unserved', 'coding', false),
    { id: 'g/recommended', tier: 'other', served: true, recommendedFor: ['coding'] }];
  const times = {
    'a/fast-but-chat': t(500, 10), 'b/fast-flaky': t(900, 10, 3), 'c/fast-unproven': t(800, 2), 'd/steady': t(2500, 5, 1),
    'e/slow': t(9000, 12), 'f/unserved': t(100, 20), 'g/recommended': t(2000, 3),
  };
  expect(fastestCapable(models, times)).toEqual({ id: 'g/recommended', avgMs: 2000 });
  expect(fastestCapable(models.filter((x) => x.id !== 'g/recommended'), times)).toEqual({ id: 'd/steady', avgMs: 2500 });
  expect(fastestCapable(models, {})).toBeNull();
});

test('"fastest measured" resolves to a model for new ⌘2 tasks; a named choice is kept as it is', () => {
  const models = [m('x/one'), m('y/two')];
  const times = { 'x/one': t(3000, 4), 'y/two': t(1500, 4) };
  expect(quickModelFor(AUTO_FASTEST, models, times)).toBe('y/two');
  expect(quickModelFor(AUTO_FASTEST, models, {})).toBeUndefined(); // Bimax's own until measured
  expect(quickModelFor('x/one', models, times)).toBe('x/one');
  expect(quickModelFor(undefined, models, times)).toBeUndefined();
});

test('talk mode takes the measured choice, and keeps its default until there is one', () => {
  const models = [m(DEFAULT_TALK_MODEL), m('y/two')];
  expect(talkModel(models, undefined, { 'y/two': t(1500, 4) })).toBe('y/two');
  expect(talkModel(models, undefined, {})).toBe(DEFAULT_TALK_MODEL);
  expect(talkModel([m('y/two')], AUTO_FASTEST, { 'y/two': t(1500, 2) })).toBeUndefined();
});

test('the ⌘2 model menu offers "fastest measured", naming what it picks now', () => {
  const items = modelMenuItems({ models: [m('y/two')], current: null, bimaxModel: 'z/bimax', quickDefault: AUTO_FASTEST, times: { 'y/two': t(1500, 4) }, mode: 'switch' });
  expect(items[items.length - 1]).toEqual({ kind: 'default', label: 'New ⌘2 tasks: fastest measured — now two, about 2s a turn', model: null, checked: true });
  const before = modelMenuItems({ models: [], current: null, bimaxModel: '', quickDefault: null, times: {}, mode: 'switch' });
  expect(before[before.length - 1]).toMatchObject({ label: 'New ⌘2 tasks: fastest measured (after a few turns)', model: AUTO_FASTEST, checked: false });
});
