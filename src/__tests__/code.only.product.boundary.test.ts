import fs from 'node:fs';
import path from 'node:path';
import { isDisabledProductCapabilityName, loadHostCapabilityServers } from '../mcp/config';
import { isDisabledComputerUseToolName } from '../mcp/client';
import { buildEngineChildEnv } from '../../app/src/main/coding.runtime.paths';

const root = path.resolve(__dirname, '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('code-only product boundary', () => {
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
      expect(isDisabledComputerUseToolName(name)).toBe(true);
    }
    expect(isDisabledComputerUseToolName('edit_file')).toBe(false);
  });

  test('Desktop launches the engine without a host Computer Use capability', () => {
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

  test('the Desktop package contains no native Computer Use payload', () => {
    const pkg = JSON.parse(read('app/package.json')) as { scripts: Record<string, string> };
    for (const command of [pkg.scripts['dist:mac'], pkg.scripts['dist:mac:x64'], pkg.scripts['dist:mac:local']]) {
      expect(command).not.toMatch(/prepare-native|computer-use|BimaxCuService/i);
    }
    const builder = read('app/electron-builder.yml');
    expect(builder).not.toMatch(/BimaxCuService|bimax-cu-bridge|bimax-desktop-helper|bimax-live-pip|bimax-mac-capability/);
    expect(builder).not.toMatch(/NSMicrophoneUsageDescription/);
  });

  test('the primary UI has one code task lane and no Computer Use entry point', () => {
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
});
