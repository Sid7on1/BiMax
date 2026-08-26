import { describe, expect, it } from '@jest/globals';
import { assessNativeControlRoute } from '../native.cu.route';

const service = {
  ready: true,
  detail: 'trusted',
  codeDirectoryHash: 'a'.repeat(40),
  permissions: { accessibility: 'granted', screenRecording: 'granted' },
};

const route = {
  connected: true,
  signingIdentifier: 'ai.bimax.cu.service',
  codeDirectoryHash: 'a'.repeat(40),
  signatureIntact: true,
  permissions: { accessibility: 'granted', screenRecording: 'granted' },
  detail: 'connected',
};

describe('packaged native Computer Use route assessment', () => {
  it('requires the bridge to reach the exact approved XPC service', () => {
    expect(assessNativeControlRoute(service, route)).toEqual({ ready: true, detail: 'connected' });
    expect(assessNativeControlRoute(service, { ...route, connected: false, detail: 'xpc dead' }))
      .toEqual({ ready: false, detail: 'xpc dead' });
    expect(assessNativeControlRoute(service, { ...route, codeDirectoryHash: 'b'.repeat(40) }).ready)
      .toBe(false);
  });

  it('surfaces a dead packaged route before a pending service approval', () => {
    expect(assessNativeControlRoute(
      { ...service, ready: false, detail: 'approval required' },
      { ...route, connected: false, detail: 'xpc dead' },
    )).toEqual({ ready: false, detail: 'xpc dead' });
  });

  it('kills wrong-identity, invalid-signature, and missing-permission mutants', () => {
    expect(assessNativeControlRoute(service, { ...route, signingIdentifier: 'bimax-cu-bridge' }).ready)
      .toBe(false);
    expect(assessNativeControlRoute(service, { ...route, signatureIntact: false }).ready).toBe(false);
    expect(assessNativeControlRoute(service, {
      ...route,
      permissions: { accessibility: 'denied', screenRecording: 'granted' },
    }).ready).toBe(false);
  });
});
