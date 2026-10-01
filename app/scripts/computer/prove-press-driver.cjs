#!/usr/bin/env node
/** Record 65 stage 3: the real driver wrapper's press path, run against a controlled SDK that records every call.
 * No native UI is touched. This proves the wrapper's ordering and refusals — what is clicked, when, and how often — not
 * TCC, the real driver or installed-app behaviour.
 * Run: node app/scripts/computer/prove-press-driver.cjs [--mutant=<name>]
 * Each mutant edits a temporary compiled copy; every one must fail these same checks (exit 1).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const appRoot = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-press-proof-'));
const mutantArg = (process.argv.find((a) => a.startsWith('--mutant=')) || '').slice('--mutant='.length);
const key = Symbol.for('bimax.press.driver.proof');

const CLICK_ARGS = "{ pid: app.pid, window_id: target.windowId, element_token: matches[0].token, action: 'press', delivery_mode: 'background' }";
const MUTANTS = {
  // A label shared by two controls is pressed anyway.
  'no-uniqueness': ['look.driver.ts', 'if (matches.length !== 1 || !matches[0].pressable || !matches[0].token) {', 'if (!matches[0] || !matches[0].pressable || !matches[0].token) {'],
  // A disabled or non-pressing control is pressed anyway.
  'no-pressable': ['look.driver.ts', 'if (matches.length !== 1 || !matches[0].pressable || !matches[0].token) {', 'if (matches.length !== 1 || !matches[0].token) {'],
  // A Stop during the fresh read does not cancel the press.
  'no-generation-before-click': ['look.driver.ts', "      // The last moment a Stop or a switch turned off can cancel it: nothing has been sent yet.\n      requireCurrent(threadId, generation);\n", ''],
  // An error from click is retried.
  'retry-click': ['look.driver.ts', "        return { kind: 'uncertain', detail: text.slice(0, 200) };", `        try { await call(session, 'click', ${CLICK_ARGS}); } catch { /* retried */ }\n        return { kind: 'uncertain', detail: text.slice(0, 200) };`],
};
if (mutantArg && !MUTANTS[mutantArg]) { console.error(`unknown mutant ${mutantArg}; one of ${Object.keys(MUTANTS).join(', ')}`); process.exit(2); }

const WINDOW = { element_index: 62, role: 'AXWindow', label: 'Bimax-Cu Fixture' };
const button = (extra = {}) => ({ element_index: 63, parent_index: 62, role: 'AXButton', label: 'Fixture Button', actions: ['AXPress'], enabled: true, ...extra });
const tree = (status) => `- [62] AXWindow "Bimax-Cu Fixture"\n  - [63] AXButton "Fixture Button"\n  - [90] AXStaticText = "${status}"`;
const FIXTURE = { name: 'BimaxCuFixture', bundleId: 'ai.bimax.cu.fixture', pid: 123 };
const TARGET = { windowId: 1228, role: 'AXButton', label: 'Fixture Button' };

const SCENARIOS = [
  { name: 'pressed', elements: [WINDOW, button()], afterStatus: 'presses=1', expect: { kind: 'pressed', clicks: 1, unchanged: false } },
  { name: 'no-op', elements: [WINDOW, button()], afterStatus: 'presses=0', expect: { kind: 'pressed', clicks: 1, unchanged: true } },
  { name: 'control-gone', elements: [WINDOW], expect: { kind: 'not_pressed', reason: 'changed', clicks: 0 } },
  { name: 'shared-name', elements: [WINDOW, button(), button({ element_index: 64 })], expect: { kind: 'not_pressed', reason: 'ambiguous', clicks: 0 } },
  { name: 'disabled', elements: [WINDOW, button({ enabled: false })], expect: { kind: 'not_pressed', reason: 'changed', clicks: 0 } },
  { name: 'menu-bar-only', elements: [WINDOW, { element_index: 0, role: 'AXMenuBar' }, button({ element_index: 3, parent_index: 0 })], expect: { kind: 'not_pressed', reason: 'changed', clicks: 0 } },
  { name: 'stopped-during-read', elements: [WINDOW, button()], stopDuringRead: true, expect: { thrown: 'This look grant ended.', clicks: 0 } },
  { name: 'click-unknown', elements: [WINDOW, button()], clickError: 'the request timed out', expect: { kind: 'uncertain', clicks: 1 } },
  { name: 'click-refused', elements: [WINDOW, button()], clickError: 'stale element token: a newer snapshot superseded it', expect: { kind: 'not_pressed', reason: 'refused', clicks: 1 } },
  { name: 'not-the-test-app', elements: [WINDOW, button()], app: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 9 }, expect: { thrown: 'not an app a task may press in', clicks: 0, sessions: 0 } },
];

async function main() {
  const compiled = path.join(temp, 'driver.cjs');
  const mutant = MUTANTS[mutantArg];
  await require(path.join(appRoot, 'node_modules/esbuild')).build({
    entryPoints: [path.join(appRoot, 'src/main/computer/look.driver.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: compiled,
    plugins: mutant ? [{ name: 'mutant', setup(build) {
      build.onLoad({ filter: /look\.driver\.ts$/ }, async (args) => {
        const source = fs.readFileSync(args.path, 'utf8');
        if (source.split(mutant[1]).length !== 2) throw new Error(`mutant ${mutantArg}: source text not found exactly once`);
        return { loader: 'ts', contents: source.replace(mutant[1], mutant[2]) };
      });
    } }] : [],
  });
  const { createLookDriver } = require(compiled);
  const results = [];
  for (const scenario of SCENARIOS) {
    const state = { calls: [], clicks: [], sessions: 0, manifests: [], scenario, status: 'presses=0', onRead: null };
    globalThis[key] = state;
    const appPath = path.join(temp, scenario.name);
    const sdkDir = path.join(appPath, 'node_modules/@trycua/cua-driver/dist');
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(sdkDir, '../package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(sdkDir, 'index.js'), `
      import fs from 'node:fs';
      const state = globalThis[Symbol.for('bimax.press.driver.proof')];
      const options = { create: (o) => o };
      export const ConfiguredDriverOptions = options, RuntimeAuthorizationOptions = options, TrustedSessionOptions = options;
      export const SessionPermissionMode = { Bounded: 'bounded' };
      export const CuaDriver = { createConfiguredWithActivityObserver: () => ({}) };
      export function createTrustedSession(_driver, o) {
        state.sessions++;
        state.manifests.push(fs.readFileSync(o.capabilityManifestPath, 'utf8'));
        return { close: async () => {}, callTool: async (tool, json) => {
          const args = JSON.parse(json);
          state.calls.push(tool);
          if (tool === 'get_window_state') {
            const hook = state.onRead; state.onRead = null; if (hook) await hook();
            const elements = state.scenario.elements.map((e) => ({ ...e, element_token: 's' + state.calls.length + ':' + e.element_index }));
            return { structuredJson: JSON.stringify({ window_title: 'Bimax-Cu Fixture', elements, tree_markdown: (${tree.toString()})(state.status) }) };
          }
          if (tool === 'click') {
            state.clicks.push(args);
            if (state.scenario.clickError) return { isError: true, text: state.scenario.clickError };
            state.status = state.scenario.afterStatus;
            return { structuredJson: '{}' };
          }
          return { isError: true, text: 'unexpected tool ' + tool };
        } };
      }
    `);
    const driver = createLookDriver({ stateDir: path.join(appPath, 'state'), packaged: false, resourcesPath: '', appPath });
    if (scenario.stopDuringRead) state.onRead = () => driver.end('t1');
    const outcome = await driver.press('t1', scenario.app || FIXTURE, TARGET).then((value) => ({ value }), (error) => ({ thrown: error.message }));
    const e = scenario.expect;
    const label = `${scenario.name}:`;
    assert.equal(state.clicks.length, e.clicks, `${label} clicked ${state.clicks.length} times, expected ${e.clicks}`);
    if (e.thrown) assert.match(String(outcome.thrown), new RegExp(e.thrown), `${label} expected a refusal before any click`);
    else {
      assert.equal(outcome.value.kind, e.kind, `${label} outcome ${outcome.value?.kind ?? outcome.thrown}`);
      if (e.reason) assert.equal(outcome.value.reason, e.reason, `${label} reason`);
      if (e.unchanged !== undefined) assert.equal(outcome.value.before === outcome.value.after, e.unchanged, `${label} before/after`);
    }
    if (e.sessions !== undefined) assert.equal(state.sessions, e.sessions, `${label} sessions`);
    for (const click of state.clicks) {
      // Only ever an AX press by a token from this session's own fresh read: no coordinates, no foreground.
      assert.deepEqual(Object.keys(click).sort(), ['action', 'delivery_mode', 'element_token', 'pid', 'window_id'], `${label} click args`);
      assert.equal(click.action, 'press'); assert.equal(click.delivery_mode, 'background');
      assert.match(click.element_token, /^s1:/, `${label} the token must come from the read just before the click`);
    }
    for (const manifest of state.manifests) {
      assert.match(manifest, /allow:\n {2}tools: \[list_apps, list_windows, get_window_state, get_screen_size, click\]/, `${label} press manifest allows`);
      assert.doesNotMatch(manifest.split('deny:')[1], /\bclick\b/, `${label} press manifest denies click`);
      assert.match(manifest, /bundle_id: ai\.bimax\.cu\.fixture/, `${label} press manifest names the test app`);
    }
    results.push({ scenario: scenario.name, outcome: outcome.thrown ? { thrown: outcome.thrown } : { kind: outcome.value.kind, reason: outcome.value.reason }, calls: state.calls, clicks: state.clicks.length, sessions: state.sessions });
  }
  console.log(JSON.stringify({ kind: 'deterministic-controlled-sdk', mutant: mutantArg || null, passed: results.length, results }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  delete globalThis[key];
  fs.rmSync(temp, { recursive: true, force: true });
});
