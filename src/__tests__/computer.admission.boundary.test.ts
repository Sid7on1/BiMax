import fs from 'node:fs';
import path from 'node:path';
import { isDisabledProductCapabilityName, loadHostCapabilityServers } from '../mcp/config';
import { isDisabledMotionToolName } from '../mcp/client';
import { buildEngineChildEnv } from '../../app/src/main/coding.runtime.paths';

const root = path.resolve(__dirname, '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/**
 * Computer Use admission boundary — record 65, stages 2, 3 and 6. It replaced the code-only gate of 2026-09-02 in the
 * commit that let Computer Use back in, look only; stage 3 widened it by one press in Bimax's test apps; stage 6 (§6h,
 * the owner's choice on 2026-10-02) widened it to using any app the person allows: press and type.
 *
 * What may exist now, and nothing more: one component (Cua Driver's in-process SDK, pinned, unpacked), off until the
 * person ticks a menu bar item, reachable by a ⌘2 task only through LookAtAppTool (BIMAX_COMPUTER_LOOK) and, with a
 * second item ticked too, PressInAppTool and TypeInAppTool (BIMAX_COMPUTER_USE): an AX press of one named control or one
 * line set into one text box, by element token, in the background, in an app the person allowed for the task — never
 * a password, wallet or banking app, System Settings or Bimax — with the app's card before anything that commits. The
 * old provider, its sidecars, its UI and its environment stay gone, and the coding surfaces stay free of it. Widening
 * any of this must make a test here fail.
 */
describe('Computer Use admission boundary (record 65 stages 2, 3 and 6; was the code-only gate)', () => {
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

  test('looking, pressing and typing are the whole capability: three engine tools, three host capabilities, manifests that deny the rest', () => {
    const container = read('src/core/container.ts');
    expect(container).toContain("if (process.env.BIMAX_COMPUTER_LOOK === '1') toolRegistry.register(createLookTool(governor));");
    expect(container).toContain("if (process.env.BIMAX_COMPUTER_LOOK === '1' && process.env.BIMAX_COMPUTER_USE === '1') {\n    toolRegistry.register(createPressTool(governor));\n    toolRegistry.register(createTypeTool(governor));\n  }");
    // Exactly these three computer tools are registered anywhere in the engine.
    expect(container.match(/toolRegistry\.register\(create(Look|Press|Type)Tool\(/g)).toHaveLength(3);
    const tool = read('src/tools/implementations/look.tool.ts');
    expect(tool).toContain("enum: ['list_apps', 'look']");
    const press = read('src/tools/implementations/press.tool.ts');
    expect(press).toContain("required: ['app', 'control']");
    expect(press).not.toMatch(/\b(x|y|text|keys?|coordinates?)\s*:\s*\{\s*type/);
    const type = read('src/tools/implementations/type.tool.ts');
    expect(type).toContain("required: ['app', 'text']");
    expect(type).not.toMatch(/\b(x|y|keys?|coordinates?|submit|send|enter)\s*:\s*\{\s*type/);
    expect(type).toContain('if (/[\\r\\n\\u2028\\u2029]/.test(args.text))');
    const protocol = read('src/protocol/protocol.ts');
    expect(protocol).toContain("export type HostCapability = 'look' | 'press' | 'type';");
    const service = read('app/src/main/computer/look.service.ts');
    expect(service).toContain("if (msg.op === 'list_apps')");
    expect(service).toContain("if (msg.op !== 'look')");
    expect(service).toContain("if (msg.capability === 'press' || msg.capability === 'type') return useAnswer(threadId, msg, c, current);");
    expect(service).toContain('if (msg.op !== msg.capability)');
    // Typing never carries a line break (Return sends in many apps), and is bounded.
    expect(service).toContain('if (/[\\r\\n\\u2028\\u2029]/.test(text)) return refuse(');
    expect(service).toContain('export const MAX_TYPE_CHARS = 2000;');
    // Each step is bound to a read under two minutes old; a long run of unasked steps stops for the person.
    expect(service).toContain('export const PRESS_FRESH_MS = 2 * 60 * 1000;');
    expect(service).toContain('export const KEEP_GOING_EVERY = 40;');
    const manifest = read('app/src/main/computer/look.manifest.ts');
    for (const tool of ['click', 'type_text', 'set_value', 'press_key', 'hotkey', 'drag', 'scroll', 'invoke_menu', 'bring_to_front']) {
      expect(manifest).toContain(`'${tool}'`);
    }
    expect(manifest).toContain("export const LOOK_TOOLS = ['list_apps', 'list_windows', 'get_window_state', 'get_screen_size'] as const;");
    // Stage 6: two input tools, one app per session, never a password field.
    expect(manifest).toContain("export const USE_TOOLS = ['click', 'set_value'] as const;");
    expect(manifest).toContain("export const TYPE_ROLES: ReadonlySet<string> = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);");
    expect(manifest).not.toMatch(/TYPE_ROLES[^;]*AXSecureTextField/);
    expect(manifest).toContain("if (!validBundleId(bundleId) || NEVER_LOOK.has(bundleId)) throw new Error(`not an app a task may use: ${JSON.stringify(bundleId)}`);");
    for (const id of ['ai.bimax.app', 'com.apple.SecurityAgent', 'com.apple.loginwindow', 'com.apple.keychainaccess', 'com.apple.Passwords', 'com.apple.systempreferences']) {
      expect(manifest).toContain(`'${id}'`);
    }
    // The driver presses only by element token, as an AX press, and types only by element token, as an AX value — in
    // the background, never coordinates, never keystrokes.
    const driver = read('app/src/main/computer/look.driver.ts');
    expect(driver.match(/'click'/g)).toHaveLength(1);
    expect(driver).toContain("await call(session, 'click', { pid: app.pid, window_id: target.windowId, element_token: matches[0].token, action: 'press', delivery_mode: 'background' });");
    expect(driver.match(/'set_value'/g)).toHaveLength(1);
    expect(driver).toContain("await call(session, 'set_value', { pid: app.pid, element_token: box.token, value: text });");
    expect(driver).not.toMatch(/'(type_text|press_key|hotkey|drag|scroll|bring_to_front|launch_app|double_click|right_click)'/);
  });

  test('a step meets the governor floors, then the app decides — and the app asks before anything that commits', () => {
    const factory = read('src/tools/tool.factory.ts');
    expect(factory).toContain("PressInAppTool: 'COMPUTER_CONTROL',");
    expect(factory).toContain("TypeInAppTool: 'COMPUTER_CONTROL',");
    for (const file of ['src/tools/implementations/press.tool.ts', 'src/tools/implementations/type.tool.ts']) {
      const code = read(file);
      expect(code).toContain('isDestructive: true,');
      expect(code).not.toContain('approvalHandledInternally');
    }
    const governor = read('src/governor/governor.ts');
    // The computer-control floors come before the Bimax Thread branch that returns early (record 46's trap), and plan
    // mode refuses before the Thread hands computer control to the app.
    const threadBranch = governor.indexOf('if (process.env.BIMAX_THREAD_ROOT && taskType !== \'API_CALL\')');
    expect(governor.indexOf("if (this.mode === 'unattended') throw new GovernorVetoError('Computer control is not allowed while unattended.');")).toBeLessThan(threadBranch);
    const handOff = governor.indexOf("if (taskType === 'COMPUTER_CONTROL') routine = true;");
    expect(handOff).toBeGreaterThan(governor.indexOf("if (this.mode === 'plan' && payload.isDestructive !== false) throw new GovernorVetoError('Plan mode: approve the plan before changing files.');", threadBranch));
    expect(governor.match(/taskType === 'COMPUTER_CONTROL'\) routine = true/g)).toHaveLength(1);
    // The app's rule runs on every press before the driver is reached; its card answers with exactly one yes.
    const service = read('app/src/main/computer/look.service.ts');
    expect(service).toContain("const reason = commitReasonForPress({ label: el.label, inDialog: el.inDialog === true, typedSinceLastCard: state.typed !== undefined });");
    expect(service.indexOf('commitReasonForPress(')).toBeLessThan(service.indexOf('outcome = await driver.press!('));
    expect(service).toContain('if (answer !== PRESS(el.label)) {');
    const rule = read('app/src/main/computer/look.commit.ts');
    for (const word of ["'send'", "'pay'", "'buy'", "'delete'", "'confirm'", "'ok'", "'allow'", "'submit'", "'transfer'"]) expect(rule).toContain(word);
    expect(rule).toContain("if (!/[a-z]/.test(foldName(step.label))) return { kind: 'unreadable' };");
  });

  test('it is off until the person turns it on, from one menu bar item, and only for ⌘2 tasks', () => {
    const main = read('app/src/main/index.ts');
    expect(main).toContain("label: 'Let Tasks Look at Other Apps (Preview)', type: 'checkbox', checked: loadSettings().computerLook === true");
    // macOS is asked for Accessibility when the person ticks it — only then, and only for Accessibility.
    expect(main.match(/isTrustedAccessibilityClient\(true\)/g)).toHaveLength(1);
    expect(main).toContain("if (item.checked && process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true);");
    expect(main).not.toMatch(/askForMediaAccess\(['"]screen|getMediaAccessStatus\(['"]screen|requestMacOSPermissions/);
    expect(main).toContain("enabled: () => loadSettings().computerLook === true");
    expect(main).toContain('if (!item.checked) void lookService.revokeAll();');
    expect(main).toContain("...(loadSettings().computerLook === true && threads.get(threadId).summary.origin !== 'project' ? { BIMAX_COMPUTER_LOOK: '1' } : {})");
    // Exactly one place sets the flag for an engine.
    expect(main.match(/BIMAX_COMPUTER_LOOK: '1'/g)).toHaveLength(1);
    // Stage 6: using has its own item, usable only while looking is on, under a NEW setting (the stage 3 test-app switch
    // is not carried over); unticking it revokes; one place sets its flag; the stage 3 flag is set nowhere.
    expect(main).toContain("label: 'Let Tasks Use Other Apps (Preview)', type: 'checkbox', checked: loadSettings().computerUse === true, enabled: loadSettings().computerLook === true");
    expect(main).toContain("useEnabled: () => loadSettings().computerLook === true && loadSettings().computerUse === true");
    expect(main).toContain("...(loadSettings().computerLook === true && loadSettings().computerUse === true && threads.get(threadId).summary.origin !== 'project' ? { BIMAX_COMPUTER_USE: '1' } : {})");
    expect(main.match(/BIMAX_COMPUTER_USE: '1'/g)).toHaveLength(1);
    expect(main).not.toMatch(/BIMAX_COMPUTER_PRESS|computerPress/);
    expect(main.match(/if \(!item\.checked\) void lookService\.revokeAll\(\);/g)).toHaveLength(2);
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
