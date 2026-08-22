import {
  buildMacCapabilityTools,
  type PackagedMacControlBlocker,
} from '../server';
import { DesktopCapabilityGovernor } from '../provider.policy';

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    BIMAX_MAC_PROVIDER_AUTHORITY: 'electron-main',
    BIMAX_DESKTOP_RELEASE_MODE: 'development',
    BIMAX_MAC_PROVIDER_DISABLE_NATIVE: '1',
    ...overrides,
  };
}

function nativeSurface() {
  return {
    coordinator: {} as never,
    tools: [{
      name: 'BimaxActionTool',
      description: 'low-level native action',
      schema: { type: 'object' },
      isDestructive: false,
      execute: async () => JSON.stringify({ ok: true }),
    }],
  };
}

async function blockedCode(
  code: PackagedMacControlBlocker,
  native: ReturnType<typeof nativeSurface> | null,
) {
  const tools = await buildMacCapabilityTools('/tmp', new DesktopCapabilityGovernor(), env({
    BIMAX_DESKTOP_RELEASE_MODE: 'packaged',
    BIMAX_MAC_PROVIDER_DISABLE_NATIVE: native ? undefined : '1',
  }), {
    createNative: async () => native,
  });
  expect(tools.map(tool => tool.name)).toEqual(['mac_control']);
  const result = JSON.parse(await tools[0].execute({ action: 'click', x: 10, y: 10 }, {}));
  expect(result).toMatchObject({ ok: false, blocked: true, visible: true, code });
  return result;
}

describe('packaged provider registration', () => {
  it('keeps compatibility available only in the development provider', async () => {
    const tools = await buildMacCapabilityTools('/tmp', new DesktopCapabilityGovernor(), env());
    expect(tools.map(tool => tool.name)).toEqual(['mac_control']);
    expect(tools[0].description).toContain('Default delivery is background');
  });

  it('fails closed when packaged native discovery is unavailable', async () => {
    const result = await blockedCode('native_tools_unavailable', null);
    expect(result.reason).toContain('verified native service tools are unavailable');
  });

  it('does not publish low-level native tools before the logical adapter exists', async () => {
    const tools = await buildMacCapabilityTools('/tmp', new DesktopCapabilityGovernor(), env({
      BIMAX_DESKTOP_RELEASE_MODE: 'packaged',
      BIMAX_MAC_PROVIDER_DISABLE_NATIVE: undefined,
    }), {
      createNative: async () => nativeSurface(),
    });
    expect(tools.map(tool => tool.name)).toEqual(['mac_control']);
    expect(tools[0].description).toContain('native macOS control');
    expect(JSON.parse(await tools[0].execute({ action: 'status' }, {}))).toMatchObject({
      ok: true, route: 'native_logical_adapter', nativeTools: ['BimaxActionTool'],
    });
  });
});
