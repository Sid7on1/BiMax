/**
 * The app-owned user takeover latch.
 *
 * `08_ACCEPTANCE_GATES.md` (Desktop computer-use gate): "pause/takeover prevents all agent input
 * until explicit resume". Phase 2/4 built the latch inside the capability provider; Phase 5 makes
 * Electron main its owner so the *user* can reach it. This file grades the ownership properties —
 * the ones that decide whether the visible control is real or decorative:
 *
 *   1. only main can change it (the provider's channel is read-only);
 *   2. an unreadable authority pauses rather than assuming consent;
 *   3. the mirror is applied to the same interlock every native mutation already consults;
 *   4. its credentials reach the mac provider and nothing else.
 */
import {
  UserTakeoverAuthority, parseTakeoverRequest, startUserTakeoverBroker,
} from '../main/takeover';
import {
  refreshTakeoverAuthority, readTakeoverConfig,
  TAKEOVER_ENDPOINT_ENV, TAKEOVER_TOKEN_ENV, TAKEOVER_REQUIRED_ENV,
} from '../capabilities/mac/takeover.authority';
import { buildTrustReport } from '../main/trust';
import { NativeInputInterlock } from '../capabilities/mac/native.input.interlock';
import { buildEngineChildEnv } from '../main/runtime.paths';

describe('takeover authority (Electron main)', () => {
  test('starts running and records who paused, when, and why', () => {
    let clock = 1_000;
    const authority = new UserTakeoverAuthority(() => clock);
    expect(authority.state()).toMatchObject({ paused: false, generation: 0 });

    clock = 2_000;
    const paused = authority.set({ paused: true, reason: 'You took control' });
    expect(paused).toMatchObject({
      paused: true, generation: 1, reason: 'You took control', actor: 'user', changedAtMs: 2_000,
    });
  });

  test('re-pausing does not bump the generation, so repeated clicks cannot stale a mirror', () => {
    const authority = new UserTakeoverAuthority(() => 1);
    authority.set({ paused: true });
    const first = authority.state();
    authority.set({ paused: true, reason: 'again' });
    expect(authority.state()).toEqual(first);
  });

  test('resuming clears the reason — a stale explanation on a running agent would be a lie', () => {
    const authority = new UserTakeoverAuthority(() => 1);
    authority.set({ paused: true, reason: 'You took control' });
    expect(authority.set({ paused: false }).reason).toBe('');
  });

  test('a pause with no reason still says something the user can read', () => {
    const authority = new UserTakeoverAuthority(() => 1);
    expect(authority.set({ paused: true }).reason).toBe('You took control');
  });

  test('malformed renderer payloads are refused, not coerced', () => {
    expect(parseTakeoverRequest({ paused: 'yes' })).toBeNull();
    expect(parseTakeoverRequest({})).toBeNull();
    expect(parseTakeoverRequest(null)).toBeNull();
    expect(parseTakeoverRequest([true])).toBeNull();
    expect(parseTakeoverRequest({ paused: true, actor: 'root' })).toBeNull();
    expect(parseTakeoverRequest({ paused: true, reason: 5 })).toBeNull();
    expect(parseTakeoverRequest({ paused: true, reason: 'ok' })).toEqual({ paused: true, reason: 'ok', actor: undefined });
  });

  test('the broker serves state to a correct token and refuses everything else', async () => {
    const authority = new UserTakeoverAuthority(() => 5);
    authority.set({ paused: true, reason: 'You took control' });
    const broker = await startUserTakeoverBroker(authority);
    try {
      const ask = async (body: unknown): Promise<{ status: number; json: any }> => {
        const response = await fetch(broker.endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: response.status, json: await response.json().catch(() => null) };
      };

      const ok = await ask({ token: broker.token });
      expect(ok.status).toBe(200);
      expect(ok.json.state).toMatchObject({ paused: true, reason: 'You took control' });

      expect((await ask({ token: 'wrong' })).status).toBe(403);
      expect((await ask({})).status).toBe(403);

      // The capability process must not be able to clear its own latch.
      const attempt = await ask({ token: broker.token, paused: false });
      expect(attempt.status).toBe(200);
      expect(authority.state().paused).toBe(true);
      expect(attempt.json.state.paused).toBe(true);
    } finally {
      await broker.close();
    }
  });

  test('the broker binds loopback only — there is no remote plane here', async () => {
    const broker = await startUserTakeoverBroker(new UserTakeoverAuthority());
    try {
      expect(broker.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/takeover\/state$/);
      expect(broker.token).toHaveLength(64);
    } finally {
      await broker.close();
    }
  });
});

describe('takeover mirror (mac capability provider)', () => {
  const config = { endpoint: 'http://127.0.0.1:1/v1/takeover/state', token: 'abc' };
  const answer = (state: Record<string, unknown>) =>
    async () => ({
      status: 200,
      text: JSON.stringify({ ok: true, code: 'state', state: { generation: 0, ...state } }),
    });

  test('a paused authority pauses the interlock every native mutation already consults', async () => {
    const interlock = new NativeInputInterlock();
    const result = await refreshTakeoverAuthority(
      config, interlock, answer({ paused: true, reason: 'You took control' }),
    );
    expect(result).toMatchObject({ configured: true, reachable: true, paused: true });
    expect(interlock.state()).toMatchObject({ paused: true, reason: 'You took control' });
  });

  test('a running authority releases it', async () => {
    const interlock = new NativeInputInterlock();
    interlock.pause('stale');
    await refreshTakeoverAuthority(config, interlock, answer({ paused: false, reason: '' }));
    expect(interlock.state().paused).toBe(false);
  });

  test('an unreachable authority FAILS CLOSED — an unknown is never treated as consent', async () => {
    const interlock = new NativeInputInterlock();
    const result = await refreshTakeoverAuthority(config, interlock, async () => {
      throw new Error('connection refused');
    });
    expect(result).toMatchObject({ configured: true, reachable: false, paused: true });
    expect(interlock.state().paused).toBe(true);
    expect(interlock.state().reason).toMatch(/could not confirm whether you have control/);
  });

  test('a non-200 or unparseable answer also fails closed', async () => {
    const interlock = new NativeInputInterlock();
    await refreshTakeoverAuthority(config, interlock, async () => ({ status: 403, text: '{"ok":false}' }));
    expect(interlock.state().paused).toBe(true);

    const second = new NativeInputInterlock();
    await refreshTakeoverAuthority(config, second, async () => ({ status: 200, text: 'not json' }));
    expect(second.state().paused).toBe(true);
  });

  test('with no authority configured the mirror is inert', async () => {
    const interlock = new NativeInputInterlock();
    const result = await refreshTakeoverAuthority({}, interlock, async () => {
      throw new Error('must not be called');
    });
    expect(result).toMatchObject({ configured: false, paused: false });
    expect(interlock.state().paused).toBe(false);
  });

  test('a steady running state does not churn the interlock generation', async () => {
    const interlock = new NativeInputInterlock();
    const running = answer({ paused: false, reason: '' });
    await refreshTakeoverAuthority(config, interlock, running);
    const generation = interlock.state().generation;
    await refreshTakeoverAuthority(config, interlock, running);
    expect(interlock.state().generation).toBe(generation);
  });

  test('a pause and resume entirely between reads still invalidates the old provider generation', async () => {
    const interlock = new NativeInputInterlock();
    await refreshTakeoverAuthority(config, interlock, answer({ paused: false, generation: 0, reason: '' }));
    const before = interlock.state().generation;

    // The provider did not observe main's paused generation 1. It next sees running generation 2.
    await refreshTakeoverAuthority(config, interlock, answer({ paused: false, generation: 2, reason: '' }));
    expect(interlock.state().paused).toBe(false);
    expect(interlock.state().generation).toBeGreaterThan(before);
  });

  test('a host that REQUIRED an authority and supplied none fails closed', () => {
    // This is the broker-failed-to-start case. Electron main always sets the required flag; if the
    // endpoint is missing, the app owes a takeover control it does not have, so nothing may act.
    const config = readTakeoverConfig({ [TAKEOVER_REQUIRED_ENV]: '1' });
    expect(config).toEqual({ required: true });
    return refreshTakeoverAuthority(config, new NativeInputInterlock(), async () => {
      throw new Error('must not be called — there is no endpoint to call');
    }).then(result => {
      expect(result).toMatchObject({ configured: true, reachable: false, paused: true });
      expect(result.reason).toMatch(/could not set up the control you would use to take over/);
    });
  });

  test('the required flag pauses the interlock every native mutation consults', async () => {
    const interlock = new NativeInputInterlock();
    await refreshTakeoverAuthority({ required: true }, interlock, async () => {
      throw new Error('no endpoint');
    });
    expect(interlock.state().paused).toBe(true);
  });

  test('MUTANT — treating a missing endpoint as "no host owns takeover" would run unguarded', async () => {
    // Without the required flag this is a unit test or a bare provider run: correctly inert.
    const inert = new NativeInputInterlock();
    await refreshTakeoverAuthority({}, inert, async () => { throw new Error('no endpoint'); });
    expect(inert.state().paused).toBe(false);
    // With it, the same missing endpoint must stop everything.
    const guarded = new NativeInputInterlock();
    await refreshTakeoverAuthority({ required: true }, guarded, async () => { throw new Error('no endpoint'); });
    expect(guarded.state().paused).toBe(true);
  });

  test('config comes from the provider environment only', () => {
    expect(readTakeoverConfig({})).toEqual({});
    expect(readTakeoverConfig({
      [TAKEOVER_ENDPOINT_ENV]: 'http://127.0.0.1:9/v1/takeover/state',
      [TAKEOVER_TOKEN_ENV]: 'tok',
    })).toEqual({ endpoint: 'http://127.0.0.1:9/v1/takeover/state', token: 'tok' });
    // A half-configured authority must not silently behave as "no authority".
    expect(readTakeoverConfig({ [TAKEOVER_ENDPOINT_ENV]: 'http://127.0.0.1:9/x' }))
      .toEqual({ endpoint: 'http://127.0.0.1:9/x' });
  });

  // Mutant: treating an unreadable authority as "probably fine".
  test('MUTANT — failing open would let the agent act while the user holds the machine', async () => {
    const failOpen = async (): Promise<boolean> => false; // "unreachable ⇒ not paused"
    expect(await failOpen()).toBe(false);
    const interlock = new NativeInputInterlock();
    await refreshTakeoverAuthority(config, interlock, async () => { throw new Error('down'); });
    expect(interlock.state().paused).toBe(true);
  });
});

describe('takeover credentials stay on the Desktop side of the boundary', () => {
  const base = {
    parentEnv: {} as Record<string, string | undefined>,
    extraEnv: {},
    path: '/usr/bin',
    projectDir: '/tmp/project',
    architecture: 'arm64' as const,
    takeover: { endpoint: 'http://127.0.0.1:7/v1/takeover/state', token: 'secret-token' },
  };

  test('they reach the mac provider descriptor, never the generic engine environment', () => {
    const env = buildEngineChildEnv({ ...base, resolved: { macCapability: '/Bimax.app/mac-capability' } });
    expect(env.BIMAX_CU_TAKEOVER_ENDPOINT).toBeUndefined();
    expect(env.BIMAX_CU_TAKEOVER_TOKEN).toBeUndefined();

    const descriptor = JSON.parse(env.BIMAX_HOST_CAPABILITIES_JSON as string);
    expect(descriptor.servers[0].name).toBe('bimax-mac');
    expect(descriptor.servers[0].env.BIMAX_CU_TAKEOVER_ENDPOINT).toBe(base.takeover.endpoint);
    expect(descriptor.servers[0].env.BIMAX_CU_TAKEOVER_TOKEN).toBe(base.takeover.token);
    expect(descriptor.servers[0].env.BIMAX_LIVE_PIP_HELPER).toBe('/Bimax.app/bimax-live-pip');
  });

  test('no provider means no descriptor and therefore no credentials anywhere', () => {
    const env = buildEngineChildEnv({ ...base, resolved: {} });
    expect(env.BIMAX_HOST_CAPABILITIES_JSON).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('secret-token');
  });

  test('without a broker the descriptor simply carries no takeover credentials', () => {
    const { takeover, ...withoutBroker } = base;
    const env = buildEngineChildEnv({ ...withoutBroker, resolved: { macCapability: '/Bimax.app/mac-capability' } });
    const descriptor = JSON.parse(env.BIMAX_HOST_CAPABILITIES_JSON as string);
    expect(descriptor.servers[0].env.BIMAX_CU_TAKEOVER_ENDPOINT).toBeUndefined();
    expect(takeover.token).toBe('secret-token');
  });
});


describe('the Trust Center reports a missing takeover authority honestly', () => {
  const base = {
    now: () => new Date('2026-08-09T00:00:00.000Z'),
    build: {
      packaged: true, appVersion: '1.1.0', electron: '43.3.0', chrome: '150', node: '24',
      platform: 'darwin', osRelease: '25.5.0', minimumMacOS: '13.0',
    },
    permissions: { accessibility: 'granted' as const, screenRecording: 'granted' as const },
    components: [
      { name: 'engine' as const, resolution: { path: '/app/engine', source: 'bundle' as const } },
      { name: 'macCapability' as const, resolution: { path: '/app/provider', source: 'bundle' as const } },
      { name: 'cuService' as const, resolution: { path: '/app/service', source: 'bundle' as const } },
      { name: 'cuBridge' as const, resolution: { path: '/app/bridge', source: 'bundle' as const } },
      { name: 'desktopHelper' as const, resolution: { path: '/app/helper', source: 'bundle' as const } },
    ],
    integrity: {
      app: {
        signature: {
          kind: 'unknown' as const,
          hardenedRuntime: null,
          gatekeeper: 'unknown' as const,
          notarization: 'unknown' as const,
        },
      },
      components: {},
    },
  };

  test('a working broker leaves Computer Use available', () => {
    const report = buildTrustReport({ ...base, userTakeover: { available: true } });
    expect(report.computerUse).toEqual({ available: true, blockers: [] });
    expect(report.coding.available).toBe(true);
  });

  test('a failed broker blocks Computer Use and says why — while coding stays available', () => {
    const report = buildTrustReport({
      ...base,
      userTakeover: { available: false, detail: 'Bimax could not set up the control you would use to take over, so it will not act on your Mac (EADDRINUSE)' },
    });
    expect(report.computerUse.available).toBe(false);
    expect(report.computerUse.blockers.join(' ')).toMatch(/take over/);
    // The invariant that must survive every failure mode.
    expect(report.coding.available).toBe(true);
    expect(report.coding.requiresPermissions).toEqual([]);
  });

  test('MUTANT — omitting the takeover blocker would advertise Computer Use with no way to stop it', () => {
    const withoutTheCheck = buildTrustReport({ ...base, userTakeover: { available: true } });
    expect(withoutTheCheck.computerUse.available).toBe(true);
    const withTheCheck = buildTrustReport({ ...base, userTakeover: { available: false } });
    expect(withTheCheck.computerUse.available).toBe(false);
  });
});
