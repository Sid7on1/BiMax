#!/usr/bin/env node
/** Record 65 stage 2: deterministic cancellation checks against the real driver wrapper, with a controlled SDK.
 * No native UI is read. This proves revocation ordering, not TCC or installed-app behavior.
 * Run: node app/scripts/computer/prove-look-revocation.cjs [--mutant]
 * The mutant removes generation validation in a temporary compiled copy; it must fail these same checks.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const appRoot = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-look-revoke-'));
const mutant = process.argv.includes('--mutant');
const key = Symbol.for('bimax.look.revocation.proof');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function main() {
  const driverSource = path.join(appRoot, 'src/main/computer/look.driver.ts');
  const compiled = path.join(temp, 'driver.cjs');
  await require(path.join(appRoot, 'node_modules/esbuild')).build({
    entryPoints: [driverSource], bundle: true, platform: 'node', format: 'cjs', outfile: compiled,
    plugins: mutant ? [{ name: 'ignore-generation', setup(build) {
      build.onLoad({ filter: /look\.driver\.ts$/ }, async args => ({ loader: 'ts', contents:
        fs.readFileSync(args.path, 'utf8').replace("if ((generations.get(threadId) ?? 0) !== generation) throw new Error('This look grant ended.');", '') }));
    } }] : [],
  });
  const { createLookDriver } = require(compiled);
  const results = [];
  for (const waitAt of ['start', 'list', 'list-error', 'state']) {
    const arrived = deferred();
    const release = deferred();
    const state = { calls: [], sessions: 0, closed: 0, pause: async stage => {
      if (stage !== waitAt) return;
      arrived.resolve(); await release.promise;
      if (stage === 'list-error') throw new Error('controlled list failure');
    } };
    globalThis[key] = state;
    const appPath = path.join(temp, waitAt);
    const sdkDir = path.join(appPath, 'node_modules/@trycua/cua-driver/dist');
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(sdkDir, '../package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(sdkDir, 'index.js'), `
      const state = globalThis[Symbol.for('bimax.look.revocation.proof')];
      await state.pause('start');
      const options = { create: o => o };
      export const ConfiguredDriverOptions = options, RuntimeAuthorizationOptions = options, TrustedSessionOptions = options;
      export const SessionPermissionMode = { Bounded: 'bounded' };
      export const CuaDriver = { createConfiguredWithActivityObserver: () => ({}) };
      export function createTrustedSession() {
        state.sessions++;
        return { close: async () => { state.closed++; }, callTool: async tool => {
          state.calls.push(tool);
          if (tool === 'list_windows') {
            await state.pause('list'); await state.pause('list-error');
            return { structuredJson: JSON.stringify({ windows: [{ window_id: 1, title: 'Fixture', is_on_screen: true, bounds: { width: 100, height: 100 } }] }) };
          }
          await state.pause('state');
          return { structuredJson: JSON.stringify({ tree_markdown: '- AXStaticText = "private observation"' }) };
        } };
      }
    `);
    const driver = createLookDriver({ stateDir: path.join(appPath, 'state'), packaged: false, resourcesPath: '', appPath });
    const pending = driver.look('t1', { name: 'Fixture', bundleId: 'ai.bimax.cu.fixture', pid: 123 });
    const result = pending.then(value => ({ ok: true, value }), error => ({ ok: false, error: error.message }));
    await arrived.promise;
    await driver.end('t1');
    release.resolve();
    const outcome = await result;
    assert.equal(outcome.ok, false, `${waitAt}: a revoked read returned success`);
    assert.equal(outcome.error, 'This look grant ended.', `${waitAt}: revocation must stop session renewal`);
    assert.equal(state.sessions, waitAt === 'start' ? 0 : 1, `${waitAt}: created a session after revocation`);
    assert.equal(state.closed, state.sessions, `${waitAt}: left a trusted session open`);
    assert.deepEqual(state.calls, waitAt === 'start' ? [] : waitAt === 'state' ? ['list_windows', 'get_window_state'] : ['list_windows']);
    results.push({ waitAt, outcome, sessions: state.sessions, closed: state.closed, calls: state.calls });
  }
  console.log(JSON.stringify({ kind: 'deterministic-controlled-sdk', mutant, passed: results.length, results }, null, 2));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  delete globalThis[key];
  fs.rmSync(temp, { recursive: true, force: true });
});
