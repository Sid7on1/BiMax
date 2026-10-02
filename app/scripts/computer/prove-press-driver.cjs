#!/usr/bin/env node
/** Record 65 stages 3 and 6: the real driver wrapper's press and typing paths, run against a controlled SDK that
 * records every call. No native UI is touched. This proves the wrapper's ordering and refusals — what is clicked or set,
 * when, and how often — not TCC, the real driver or installed-app behaviour.
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
  // Typing: a box name two boxes share is typed into anyway.
  'type-no-uniqueness': ['look.driver.ts', 'if (matches.length !== 1 || !matches[0].editable || !matches[0].token) {', 'if (!matches[0] || !matches[0].editable || !matches[0].token) {'],
  // Typing: something that is not a text box (a password field) is typed into.
  'type-no-editable': ['look.driver.ts', 'if (matches.length !== 1 || !matches[0].editable || !matches[0].token) {', 'if (matches.length !== 1 || !matches[0].token) {'],
  // Typing: an error from set_value is retried.
  'type-retry': ['look.driver.ts', "        return { kind: 'uncertain', detail: reasonText.slice(0, 200) };", "        try { await call(session, 'set_value', { pid: app.pid, element_token: box.token, value: text }); } catch { /* retried */ }\n        return { kind: 'uncertain', detail: reasonText.slice(0, 200) };"],
  // Typing: the read-back takes any box's value, not the box that was typed into.
  'type-any-box': ['look.driver.ts', 'e.role === box.role && box.at !== undefined && e.at === box.at', 'e.role === box.role'],
  // Return: the box is found by its (old) name, not its position, so a box renamed by its text is never found again.
  'confirm-by-name': ['look.driver.ts', '(target.at !== undefined ? e.at === target.at : e.label === target.label)', 'e.label === target.label'],
  // Pick: anything, not only a pop-up, is set.
  'pick-any-role': ['look.driver.ts', 'if (matches.length !== 1 || !matches[0].pickable || !matches[0].token) {', 'if (matches.length !== 1 || !matches[0].token) {'],
  // Scroll: sent in the foreground.
  'scroll-foreground': ['look.driver.ts', "amount: Math.min(50, Math.max(1, Math.round(pages)) * SCROLL_NOTCHES_PER_PAGE), delivery_mode: 'background' });", "amount: Math.min(50, Math.max(1, Math.round(pages)) * SCROLL_NOTCHES_PER_PAGE), delivery_mode: 'foreground' });"],
  // Scroll: an error is retried.
  'scroll-retry': ['look.driver.ts', "await call(session, 'scroll', { pid: app.pid, element_token: matches[0].token, direction, by: 'page', amount: Math.min(50, Math.max(1, Math.round(pages)) * SCROLL_NOTCHES_PER_PAGE), delivery_mode: 'background' });", "try { await call(session, 'scroll', { pid: app.pid, element_token: matches[0].token, direction, by: 'page', amount: Math.min(50, Math.max(1, Math.round(pages)) * SCROLL_NOTCHES_PER_PAGE), delivery_mode: 'background' }); } catch { await call(session, 'scroll', { pid: app.pid, element_token: matches[0].token, direction, by: 'page', amount: Math.min(50, Math.max(1, Math.round(pages)) * SCROLL_NOTCHES_PER_PAGE), delivery_mode: 'background' }); }"],
};
if (mutantArg && !MUTANTS[mutantArg]) { console.error(`unknown mutant ${mutantArg}; one of ${Object.keys(MUTANTS).join(', ')}`); process.exit(2); }

const WINDOW = { element_index: 62, role: 'AXWindow', label: 'Bimax-Cu Fixture' };
const button = (extra = {}) => ({ element_index: 63, parent_index: 62, role: 'AXButton', label: 'Fixture Button', actions: ['AXPress'], enabled: true, ...extra });
const tree = (status) => `- [62] AXWindow "Bimax-Cu Fixture"\n  - [63] AXButton "Fixture Button"\n  - [90] AXStaticText = "${status}"`;
const FIXTURE = { name: 'BimaxCuFixture', bundleId: 'ai.bimax.cu.fixture', pid: 123 };
const NOTES = { name: 'Notes', bundleId: 'com.apple.Notes', pid: 9 };
const TARGET = { windowId: 1228, role: 'AXButton', label: 'Fixture Button' };
const BOX_TARGET = { windowId: 1228, role: 'AXTextField', label: 'Compose message' };
// A text box the driver names by its title while empty and by its value once filled (measured on the fixture).
const box = (value, extra = {}) => ({ element_index: 65, parent_index: 62, role: 'AXTextField', label: value || 'Compose message', value, actions: ['AXConfirm'], enabled: true, frame: { x: 219, y: 371, w: 300, h: 26 }, ...extra });

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
  // Stage 6: any app the person allowed (the service checks the grant), never one a task never uses.
  { name: 'another-app', elements: [WINDOW, button()], afterStatus: 'presses=1', app: NOTES, expect: { kind: 'pressed', clicks: 1, unchanged: false } },
  { name: 'never-used-app', elements: [WINDOW, button()], app: { name: 'Bimax', bundleId: 'ai.bimax.app', pid: 8 }, expect: { thrown: 'not an app a task may use', clicks: 0, sessions: 0 } },
  { name: 'a-row', elements: [WINDOW, button({ role: 'AXRow' })], afterStatus: 'presses=1', target: { ...TARGET, role: 'AXRow' }, expect: { kind: 'pressed', clicks: 1, unchanged: false } },
  { name: 'a-pop-up', elements: [WINDOW, button({ role: 'AXPopUpButton', actions: ['AXShowMenu', 'AXPress'] })], target: { ...TARGET, role: 'AXPopUpButton' }, expect: { kind: 'not_pressed', reason: 'changed', clicks: 0 } },
  // Typing.
  { name: 'typed', type: 'running late', box: '', expect: { kind: 'typed', sets: 1, value: 'running late' } },
  { name: 'type-did-not-land', type: 'running late', box: '', ignoreSet: true, expect: { kind: 'typed', sets: 1, value: '' } },
  { name: 'type-box-gone', type: 'x', noBox: true, expect: { kind: 'not_typed', reason: 'changed', sets: 0 } },
  { name: 'type-shared-name', type: 'x', box: '', twoBoxes: true, expect: { kind: 'not_typed', reason: 'ambiguous', sets: 0 } },
  { name: 'type-password-field', type: 'x', box: '', secure: true, expect: { kind: 'not_typed', reason: 'changed', sets: 0 } },
  // Same role and name, but disabled: only the wrapper's own "is it a box Bimax may type into" check can refuse it.
  { name: 'type-disabled-box', type: 'x', box: '', disabled: true, expect: { kind: 'not_typed', reason: 'changed', sets: 0 } },
  { name: 'type-refused', type: 'x', box: '', setError: 'stale element token: a newer snapshot superseded it', expect: { kind: 'not_typed', reason: 'refused', sets: 1 } },
  { name: 'type-unknown', type: 'x', box: '', setError: 'the request timed out', expect: { kind: 'uncertain', sets: 1 } },
  { name: 'type-stopped-during-read', type: 'x', box: '', stopDuringRead: true, expect: { thrown: 'This look grant ended.', sets: 0 } },
  // Return in a box: its own AX confirm, the box found by where it starts (typing renamed it to its text).
  { name: 'confirm', confirm: true, box: 'running late', expect: { kind: 'pressed', clicks: 1, action: 'confirm' } },
  { name: 'confirm-box-gone', confirm: true, noBox: true, expect: { kind: 'not_pressed', reason: 'changed', clicks: 0 } },
  // Pick: a pop-up's item set by its name, never by opening the menu; anything else is refused.
  { name: 'pick', pick: 'Second', expect: { kind: 'typed', sets: 1, value: 'Second', token: 's1:68' } },
  { name: 'pick-unknown-item', pick: 'Tenth', expect: { kind: 'not_typed', reason: 'refused', sets: 1, token: 's1:68' } },
  { name: 'pick-not-a-pop-up', pick: 'Second', pickTarget: TARGET, expect: { kind: 'not_typed', reason: 'changed', sets: 0 } },
  // Scroll: the wheel over one row, by token, in the background; never retried.
  { name: 'scroll', scroll: { direction: 'down', pages: 2 }, expect: { kind: 'pressed', scrolls: 1, unchanged: false, amount: 10 } },
  { name: 'scroll-row-gone', scroll: { direction: 'down', pages: 1 }, scrollTarget: { windowId: 1228, role: 'AXRow', label: 'Row 99' }, expect: { kind: 'not_pressed', reason: 'changed', scrolls: 0 } },
  { name: 'scroll-unknown', scroll: { direction: 'up', pages: 1 }, scrollError: 'the request timed out', expect: { kind: 'uncertain', scrolls: 1, amount: 5 } },
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
    const state = { calls: [], clicks: [], sets: [], scrolls: [], sessions: 0, manifests: [], scenario, status: 'presses=0', box: scenario.box ?? '', offset: 0, popup: 'First', confirmed: false, onRead: null };
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
            const sc = state.scenario;
            const rows = [0, 1, 2, 3, 4].map((i) => ({ element_index: 80 + i, parent_index: 62, role: 'AXRow', label: 'Row ' + (i + 1 + state.offset), actions: ['AXPress'], frame: { x: 10, y: 100 + 30 * i, w: 300, h: 28 } }));
            const popup = { element_index: 68, parent_index: 62, role: 'AXPopUpButton', label: 'First', value: state.popup, actions: ['AXShowMenu', 'AXPress'], frame: { x: 582, y: 332, w: 145, h: 23 } };
            const base = sc.pick !== undefined ? [{ element_index: 62, role: 'AXWindow', label: 'Bimax-Cu Fixture' }, popup, ${'{'} element_index: 63, parent_index: 62, role: 'AXButton', label: 'Fixture Button', actions: ['AXPress'], enabled: true }]
              : sc.scroll !== undefined ? [{ element_index: 62, role: 'AXWindow', label: 'Bimax-Cu Fixture' }, ...rows]
              : sc.type === undefined && !sc.confirm ? sc.elements : [
              ${'{'} element_index: 62, role: 'AXWindow', label: 'Bimax-Cu Fixture' },
              ...(sc.noBox ? [] : [sc.secure ? { ...(${box.toString()})(state.box), role: 'AXSecureTextField' } : { ...(${box.toString()})(state.box), ...(sc.disabled ? { enabled: false } : {}) }]),
              ...(sc.twoBoxes ? [{ ...(${box.toString()})(''), element_index: 66, frame: { x: 219, y: 300, w: 300, h: 26 } }] : []),
              // Another box elsewhere, holding text of its own: a read-back must not take its value.
              { ...(${box.toString()})('elsewhere'), element_index: 67, frame: { x: 219, y: 500, w: 300, h: 26 } },
            ];
            const elements = base.map((e) => ({ ...e, element_token: 's' + state.calls.length + ':' + e.element_index }));
            return { structuredJson: JSON.stringify({ window_title: 'Bimax-Cu Fixture', elements, tree_markdown: (${tree.toString()})(state.status) + '\\n  - offset=' + state.offset + ' popup=' + state.popup + ' confirmed=' + state.confirmed }) };
          }
          if (tool === 'scroll') {
            state.scrolls.push(args);
            if (state.scenario.scrollError) return { isError: true, text: state.scenario.scrollError };
            state.offset += 1;
            return { structuredJson: '{}' };
          }
          if (tool === 'set_value' && state.scenario.pick !== undefined) {
            state.sets.push(args);
            if (!['First', 'Second', 'Third'].includes(args.value)) return { isError: true, text: 'no child option matches ' + args.value };
            state.popup = args.value;
            return { structuredJson: '{}' };
          }
          if (tool === 'set_value') {
            state.sets.push(args);
            if (state.scenario.setError) return { isError: true, text: state.scenario.setError };
            if (!state.scenario.ignoreSet) state.box = args.value;
            return { structuredJson: '{}' };
          }
          if (tool === 'click') {
            state.clicks.push(args);
            if (state.scenario.clickError) return { isError: true, text: state.scenario.clickError };
            if (args.action === 'confirm') { state.confirmed = true; return { structuredJson: '{}' }; }
            state.status = state.scenario.afterStatus;
            return { structuredJson: '{}' };
          }
          return { isError: true, text: 'unexpected tool ' + tool };
        } };
      }
    `);
    const driver = createLookDriver({ stateDir: path.join(appPath, 'state'), packaged: false, resourcesPath: '', appPath });
    if (scenario.stopDuringRead) state.onRead = () => driver.end('t1');
    const ROWS_TARGET = { windowId: 1228, role: 'AXRow', label: 'Row 3' };
    const POPUP_TARGET = { windowId: 1228, role: 'AXPopUpButton', label: 'First' };
    const act = scenario.type !== undefined ? driver.type('t1', scenario.app || FIXTURE, BOX_TARGET, scenario.type)
      // The box was typed into: it is named by its text now, so it is asked for by where it starts.
      : scenario.confirm ? driver.confirm('t1', scenario.app || FIXTURE, { ...BOX_TARGET, at: '219,371' })
      : scenario.pick !== undefined ? driver.pick('t1', scenario.app || FIXTURE, scenario.pickTarget || POPUP_TARGET, scenario.pick)
      : scenario.scroll !== undefined ? driver.scroll('t1', scenario.app || FIXTURE, scenario.scrollTarget || ROWS_TARGET, scenario.scroll.direction, scenario.scroll.pages)
      : driver.press('t1', scenario.app || FIXTURE, scenario.target || TARGET);
    const outcome = await act.then((value) => ({ value }), (error) => ({ thrown: error.message }));
    const e = scenario.expect;
    const label = `${scenario.name}:`;
    assert.equal(state.clicks.length, e.clicks ?? 0, `${label} clicked ${state.clicks.length} times, expected ${e.clicks ?? 0}`);
    assert.equal(state.sets.length, e.sets ?? 0, `${label} set ${state.sets.length} values, expected ${e.sets ?? 0}`);
    assert.equal(state.scrolls.length, e.scrolls ?? 0, `${label} scrolled ${state.scrolls.length} times, expected ${e.scrolls ?? 0}`);
    for (const scroll of state.scrolls) {
      // Only ever the wheel over one element, by a token from this session's own fresh read, in the background.
      assert.deepEqual(Object.keys(scroll).sort(), ['amount', 'by', 'delivery_mode', 'direction', 'element_token', 'pid'], `${label} scroll args`);
      assert.equal(scroll.delivery_mode, 'background', `${label} scroll in the background`);
      assert.equal(scroll.by, 'page');
      assert.equal(scroll.amount, e.amount, `${label} scroll amount`);
      assert.match(scroll.element_token, /^s1:82$/, `${label} the token must be the named row's, from the read just before`);
    }
    if (e.value !== undefined) assert.equal(outcome.value?.value, e.value, `${label} the box read back ${JSON.stringify(outcome.value?.value)}`);
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
      assert.equal(click.action, e.action ?? 'press', `${label} click action`); assert.equal(click.delivery_mode, 'background');
      assert.match(click.element_token, /^s1:/, `${label} the token must come from the read just before the click`);
    }
    for (const set of state.sets) {
      // Only ever an AX value write by a token from this session's own fresh read: no keystrokes, no coordinates.
      assert.deepEqual(Object.keys(set).sort(), ['element_token', 'pid', 'value'], `${label} set_value args`);
      assert.equal(set.element_token, e.token ?? 's1:65', `${label} the token must be the box's (or the pop-up's), from the read just before`);
    }
    for (const manifest of state.manifests) {
      assert.match(manifest, /allow:\n {2}tools: \[list_apps, list_windows, get_window_state, get_screen_size, click, set_value, scroll\]/, `${label} use manifest allows`);
      assert.doesNotMatch(manifest.split('deny:')[1], /\bclick\b|\bset_value\b|, scroll\b/, `${label} use manifest denies none of them`);
      assert.match(manifest.split('deny:')[1], /type_text, set_value|type_text, press_key|press_key, hotkey/, `${label} use manifest denies keys`);
      assert.match(manifest, new RegExp(`bundle_id: ${(scenario.app || FIXTURE).bundleId.replace(/\./g, '\\.')}`), `${label} use manifest names the one app`);
    }
    results.push({ scenario: scenario.name, outcome: outcome.thrown ? { thrown: outcome.thrown } : { kind: outcome.value.kind, reason: outcome.value.reason, value: outcome.value.value }, calls: state.calls, clicks: state.clicks.length, sets: state.sets.length, scrolls: state.scrolls.length, sessions: state.sessions });
  }
  console.log(JSON.stringify({ kind: 'deterministic-controlled-sdk', mutant: mutantArg || null, passed: results.length, results }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  delete globalThis[key];
  fs.rmSync(temp, { recursive: true, force: true });
});
