import fs from 'node:fs';
import path from 'node:path';
import { isDisabledProductCapabilityName, loadHostCapabilityServers } from '../mcp/config';
import { isDisabledMotionToolName } from '../mcp/client';
import { buildEngineChildEnv } from '../../app/src/main/coding.runtime.paths';

const root = path.resolve(__dirname, '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/**
 * Computer Use admission boundary — record 65, stage 2. It replaces the code-only gate of 2026-09-02 in the same commit
 * that let Computer Use back in, look only, as the plan required.
 *
 * What may exist now, and nothing more: one component (Cua Driver's in-process SDK, pinned, unpacked), off until the
 * person ticks one menu bar item, reachable by a ⌘2 task only through LookAtAppTool, which the engine registers only
 * when the app sets BIMAX_COMPUTER_LOOK for that engine. The old provider, its sidecars, its UI and its environment stay
 * gone, and the coding surfaces stay free of it. Widening any of this must make a test here fail.
 */
describe('Computer Use admission boundary (record 65 stage 2; was the code-only gate)', () => {
  test('the coding engine keeps the agentic IDE mutation tools', () => {
    const container = read('src/core/container.ts');
    for (const registration of [
      'createReadFileTool',
      'createWriteFileTool',
      'createEditFileTool',
      'createMultiEditTool',
      'createDeleteTool',
      'createMakeDirTool',
      'createBashTool',
      'createGitTool',
      'createLspQueryTool',
    ]) {
      expect(container).toContain(`toolRegistry.register(${registration}`);
    }
  });

  test('host and project MCP configuration cannot restore the removed Mac provider', () => {
    expect(isDisabledProductCapabilityName('bimax-mac')).toBe(true);
    expect(loadHostCapabilityServers(JSON.stringify({
      servers: [{ name: 'bimax-mac', command: '/Applications/Bimax.app/Contents/MacOS/provider' }],
    }))).toEqual([]);
    for (const name of ['mac_control', 'computer_control', 'computer']) {
      expect(isDisabledMotionToolName(name)).toBe(true);
    }
    expect(isDisabledMotionToolName('edit_file')).toBe(false);
  });

  test('Desktop launches the engine without the old host Computer Use capability', () => {
    const engine = read('app/src/main/engine.ts');
    const runtime = read('app/src/main/coding.runtime.paths.ts');
    expect(engine).toContain("from './coding.runtime.paths'");
    expect(engine).not.toContain("nativeComponent('macCapability')");
    expect(engine).not.toContain('BIMAX_HOST_CAPABILITIES_JSON');
    expect(runtime).toContain("'BIMAX_HOST_CAPABILITIES_JSON'");
    expect(runtime).toMatch(/delete env\[variable\]/);

    const env = buildEngineChildEnv({
      parentEnv: {
        BIMAX_HOST_CAPABILITIES_JSON: '{"servers":[{"name":"bimax-mac"}]}',
        BIMAX_MAC_CAPABILITY_PROVIDER: '/tmp/provider',
        BIMAX_CU_SERVICE_BINARY: '/tmp/service',
        BIMAX_CU_NATIVE_ROUTING_ENABLED: '1',
        KEEP_FOR_CODING: 'yes',
      },
      extraEnv: { BIMAX_AGENT_MAX_CONCURRENCY: '2' },
      path: '/usr/bin:/bin',
      projectDir: '/tmp/project',
    });
    expect(env.BIMAX_HOST_CAPABILITIES_JSON).toBeUndefined();
    expect(env.BIMAX_MAC_CAPABILITY_PROVIDER).toBeUndefined();
    expect(env.BIMAX_CU_SERVICE_BINARY).toBeUndefined();
    expect(env.BIMAX_CU_NATIVE_ROUTING_ENABLED).toBeUndefined();
    expect(env.KEEP_FOR_CODING).toBe('yes');
    expect(env.BIMAX_CWD).toBe('/tmp/project');
  });

  test('the Desktop package contains no old Computer Use payload', () => {
    const pkg = JSON.parse(read('app/package.json')) as { scripts: Record<string, string> };
    for (const command of [pkg.scripts['dist:mac'], pkg.scripts['dist:mac:x64'], pkg.scripts['dist:mac:local']]) {
      expect(command).not.toMatch(/prepare-native|computer-use|BimaxCuService/i);
    }
    const builder = read('app/electron-builder.yml');
    expect(builder).not.toMatch(/BimaxCuService|bimax-cu-bridge|bimax-desktop-helper|bimax-live-pip|bimax-mac-capability/);
    // This used to ban NSMicrophoneUsageDescription outright, as a proxy for the entitlements the
    // native provider needed. Voice dictation (app/native/voice/main.swift) shipped afterwards and
    // legitimately asks for the microphone, so the guard began failing on a feature that is
    // supposed to be present — a stale assertion, not a boundary violation. The line above already
    // covers the real payload, which is binaries.
    //
    // Assert the exact SET of declared capabilities rather than banning one member of it. That is
    // strictly stronger: any new capability string — including one Bimax Motion introduces — fails
    // here and has to be added deliberately, which is the review this test exists to force.
    const declaredCapabilities = [...builder.matchAll(/NS([A-Za-z]+)UsageDescription/g)]
      .map((m) => m[1]).sort();
    expect(declaredCapabilities).toEqual(['AppleEvents', 'Microphone']);
  });

  test('the primary UI has one code task lane and no Computer Use entry point', () => {
    // The only entry point is the menu bar item (next test); the windows have none.
    const app = read('app/src/renderer/src/App.tsx');
    const composer = read('app/src/renderer/src/components/Composer.tsx');
    const sidebar = read('app/src/renderer/src/components/TaskSidebar.tsx');
    const palette = read('app/src/renderer/src/components/CommandPalette.tsx');
    const inspector = read('app/src/renderer/src/inspector.model.ts');
    const preload = read('app/src/preload/index.ts');
    const models = read('app/src/renderer/src/components/ModelDialog.tsx');
    expect(app).not.toMatch(/PermissionsDialog|useTakeover|useTrust|waitingMacTask|submitMacTask/);
    expect(composer).not.toMatch(/inferLane|Control Mac|AppWindow|laneOverride/);
    expect(sidebar).not.toMatch(/label: 'Computer'|label: 'Permissions'/);
    expect(palette).not.toMatch(/Mac live target|Open Permissions/);
    expect(inspector).not.toMatch(/id: 'mac'/);
    expect(models).not.toMatch(/computerUseModelReadiness|Control Mac|computer-use/);
    expect(preload).not.toMatch(/permissionCoach|manualAlpha|takeover:|trust:report/);
  });

  test('look only is the whole capability: one engine tool, one host operation set, a manifest that denies input', () => {
    const container = read('src/core/container.ts');
    expect(container).toContain("if (process.env.BIMAX_COMPUTER_LOOK === '1') toolRegistry.register(createLookTool(governor));");
    const tool = read('src/tools/implementations/look.tool.ts');
    expect(tool).toContain("enum: ['list_apps', 'look']");
    const service = read('app/src/main/computer/look.service.ts');
    expect(service).toContain("if (msg.op === 'list_apps')");
    expect(service).toContain("if (msg.op !== 'look')");
    const manifest = read('app/src/main/computer/look.manifest.ts');
    for (const tool of ['click', 'type_text', 'set_value', 'press_key', 'hotkey', 'drag', 'scroll', 'invoke_menu', 'bring_to_front']) {
      expect(manifest).toContain(`'${tool}'`);
    }
    expect(manifest).toContain("export const LOOK_TOOLS = ['list_apps', 'list_windows', 'get_window_state', 'get_screen_size'] as const;");
  });

  test('it is off until the person turns it on, from one menu bar item, and only for ⌘2 tasks', () => {
    const main = read('app/src/main/index.ts');
    expect(main).toContain("label: 'Let Tasks Look at Other Apps (Preview)', type: 'checkbox', checked: loadSettings().computerLook === true");
    // macOS is asked for Accessibility when the person ticks it — only then, and only for Accessibility.
    expect(main.match(/isTrustedAccessibilityClient\(true\)/g)).toHaveLength(1);
    expect(main).toContain("if (item.checked && process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true);");
    expect(main).not.toMatch(/askForMediaAccess\(['"]screen|getMediaAccessStatus\(['"]screen|requestMacOSPermissions/);
    expect(main).toContain("enabled: () => loadSettings().computerLook === true");
    expect(main).toContain("...(loadSettings().computerLook === true && threads.get(threadId).summary.origin !== 'project' ? { BIMAX_COMPUTER_LOOK: '1' } : {})");
    // Exactly one place sets the flag for an engine.
    expect(main.match(/BIMAX_COMPUTER_LOOK: '1'/g)).toHaveLength(1);
  });

  test('one component ships for it: the pinned Cua Driver SDK, outside the archive, and nothing else of the driver', () => {
    const pkg = JSON.parse(read('app/package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@trycua/cua-driver']).toBe('0.31.0');
    expect(Object.keys(pkg.dependencies).filter((name) => /cua|computer|trycua/i.test(name))).toEqual(['@trycua/cua-driver']);
    const builder = read('app/electron-builder.yml');
    for (const line of ['  - node_modules/@trycua/cua-driver/**', '  - node_modules/@trycua/cua-driver-darwin-arm64/**', '  - node_modules/@trycua/**']) {
      expect(builder).toContain(line);
    }
    // Config lines only: the comment beside them explains what is left out, and may name it.
    const config = builder.split('\n').map((line) => line.replace(/#.*$/, '')).join('\n');
    expect(config).not.toMatch(/perception|CuaDriver\.app|cua-driver\b(?!-darwin|\/)/);
    const gate = read('scripts/verify-desktop-package.mjs');
    expect(gate).toContain("if (pinned !== '0.31.0')");
    expect(gate).toContain("if (name === 'cua-driver' || /perception/i.test(name))");
  });
});

