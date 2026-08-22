import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ReceiptBackedJourneyStore,
  normalizedIntentDigest,
  semanticFingerprint,
  type FreshJourneyObservation,
  type JourneyStep,
} from '../journey.memory';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const app = { bundleId: 'ai.bimax.fixture', version: '3.4.0' };
const step = (action: JourneyStep['action'], index = 0): JourneyStep => ({
  index,
  action,
  target: { windowFingerprint: digest('a'), semanticFingerprint: digest('b') },
  postconditionDigest: digest('c'),
  receiptDigest: digest('d'),
});

describe('Phase 5 receipt-backed journey memory', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'bimax-journey-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('stores a bounded Desktop-owned record without instruction, labels, values, or coordinates', async () => {
    const store = new ReceiptBackedJourneyStore(directory, {
      enabled: true, exportEnabled: false, maxAgeMs: 86_400_000,
    }, () => 1_000);
    const journey = await store.remember({
      intent: 'Click Continue after entering TOP SECRET', app,
      steps: [step('click')],
    });
    expect(journey).toMatchObject({
      version: 1, intentDigest: normalizedIntentDigest('Click Continue after entering TOP SECRET'),
      app, steps: [{ action: 'click', index: 0 }],
    });
    const bytes = await readFile(path.join(directory, 'computer-use', 'journeys.v1.json'), 'utf8');
    expect(bytes).not.toContain('TOP SECRET');
    expect(bytes).not.toContain('Continue');
    expect(bytes).not.toMatch(/"(?:x|y|text|value|label|elementToken)"\s*:/);
    expect(await store.find(app, '  CLICK continue after entering top secret ')).toMatchObject({ id: journey?.id });
    expect(await store.find({ ...app, version: '3.5.0' }, 'Click Continue after entering TOP SECRET')).toBeNull();
    await expect(store.exportRedacted()).rejects.toThrow('journey_export_not_authorized');
  });

  test('reobserves and validates each step immediately before ordinary-ladder execution', async () => {
    const store = new ReceiptBackedJourneyStore(directory, {
      enabled: true, exportEnabled: true, maxAgeMs: 86_400_000,
    });
    const journey = await store.remember({
      intent: 'repeat fixture journey', app,
      steps: [step('click'), { ...step('arrange', 1) }],
    });
    const order: string[] = [];
    const receipt = await store.replay(journey!, {
      observe: async (current) => {
        order.push(`observe:${current.index}`);
        return {
          app, windowFingerprint: digest('a'), semanticFingerprint: digest('b'),
          frameId: `fresh-${current.index}`, eventRevision: current.index * 2 + 10,
          permissionGranted: true, takeoverEpoch: 7,
        };
      },
      executeThroughLadder: async (current, observation) => {
        order.push(`execute:${current.index}`);
        return {
          verified: true, action: current.action, receiptDigest: digest('e'),
          frameId: observation.frameId, eventRevisionAfter: observation.eventRevision + 1,
        };
      },
    });
    expect(receipt).toEqual({
      journeyId: journey?.id, outcome: 'performed', validatedSteps: 2, executedSteps: 2,
    });
    expect(order).toEqual(['observe:0', 'execute:0', 'observe:1', 'execute:1']);
    const exported = await store.exportRedacted();
    expect(exported).toContain(journey!.intentDigest);
    expect(exported).not.toContain('repeat fixture journey');
  });

  test.each([
    ['poisoned semantic fingerprint', (observation: FreshJourneyObservation) => ({ ...observation, semanticFingerprint: digest('f') }), 'semantic_fingerprint_changed'],
    ['revoked permission', (observation: FreshJourneyObservation) => ({ ...observation, permissionGranted: false }), 'computer_use_permission_revoked'],
    ['changed app version', (observation: FreshJourneyObservation) => ({ ...observation, app: { ...app, version: '4.0.0' } }), 'application_identity_or_version_changed'],
    ['changed target window', (observation: FreshJourneyObservation) => ({ ...observation, windowFingerprint: digest('f') }), 'target_window_changed'],
  ])('refuses %s before effect', async (_label, mutate, reason) => {
    const store = new ReceiptBackedJourneyStore(directory, {
      enabled: true, exportEnabled: false, maxAgeMs: 86_400_000,
    });
    const journey = await store.remember({ intent: 'repeat', app, steps: [step('click')] });
    const execute = jest.fn();
    const observation: FreshJourneyObservation = {
      app, windowFingerprint: digest('a'), semanticFingerprint: digest('b'), frameId: 'fresh-0',
      eventRevision: 10, permissionGranted: true, takeoverEpoch: 1,
    };
    const receipt = await store.replay(journey!, {
      observe: async () => mutate(observation), executeThroughLadder: execute,
    });
    expect(receipt).toMatchObject({ outcome: 'refused', reason, stoppedAtStep: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  test('takeover between steps and a reused frame abort before the next action', async () => {
    const store = new ReceiptBackedJourneyStore(directory, {
      enabled: true, exportEnabled: false, maxAgeMs: 86_400_000,
    });
    const journey = await store.remember({
      intent: 'repeat', app, steps: [step('click'), { ...step('arrange', 1) }],
    });
    const execute = jest.fn(async (current: JourneyStep, observation: FreshJourneyObservation) => ({
      verified: true, action: current.action, receiptDigest: digest('e'),
      frameId: observation.frameId, eventRevisionAfter: observation.eventRevision + 1,
    }));
    const receipt = await store.replay(journey!, {
      observe: async (current) => ({
        app, windowFingerprint: digest('a'), semanticFingerprint: digest('b'),
        frameId: `fresh-${current.index}`, eventRevision: 10 + current.index * 2,
        permissionGranted: true, takeoverEpoch: current.index === 0 ? 4 : 5,
      }),
      executeThroughLadder: execute,
    });
    expect(receipt).toMatchObject({
      outcome: 'refused', reason: 'user_takeover_intervened',
      validatedSteps: 1, executedSteps: 1, stoppedAtStep: 1,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('fingerprints normalize semantic text but reveal no source content', () => {
    const first = semanticFingerprint({ role: 'AXButton', identifier: 'Continue', label: 'Next Step' });
    const second = semanticFingerprint({ role: 'axbutton', identifier: ' continue ', label: 'next   step' });
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toContain('next');
  });
});
