// Record 65 stage 2a: Cua Driver 0.31 embedded in-process (no daemon), one bounded trusted session per grant.
// Read-only grant for the fixture app; input tools and other apps must be refused, and the runtime's activity
// observer must count zero authorized input actions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as cua from '@trycua/cua-driver';

const {
  CuaDriver, createTrustedSession, ConfiguredDriverOptions, RuntimeAuthorizationOptions, TrustedSessionOptions,
  SessionPermissionMode, DriverActivityKind,
} = cua;

const here = path.dirname(new URL(import.meta.url).pathname);
const OBSERVE = ['list_apps', 'list_windows', 'get_window_state', 'get_screen_size', 'verify_state'];
const INPUT = ['click', 'double_click', 'right_click', 'type_text', 'set_value', 'press_key', 'hotkey', 'scroll', 'drag',
  'move_cursor', 'invoke_menu', 'bring_to_front', 'launch_app', 'kill_app', 'clipboard_write', 'clipboard_read',
  'set_window_frame', 'browser_click', 'browser_type', 'browser_navigate'];
const ms = (t0) => Math.round((performance.now() - t0) * 10) / 10;
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
const sockets = () => {
  try { return execFileSync('lsof', ['-a', '-i', '-n', '-P', '-p', String(process.pid)], { encoding: 'utf8' }).trim().split('\n').slice(1); }
  catch { return []; }
};

const manifestFor = (bundleId) => `version: 2
mode: bounded
expires_after: 10m
idle_timeout: 2m
resources:
  apps:
    - bundle_id: ${bundleId}
      windows: all
allow:
  tools: [${OBSERVE.join(', ')}]
deny:
  tools: [${INPUT.join(', ')}]
`;

const events = [];
const observer = { onActivity: (e) => events.push({ kind: DriverActivityKind[e.kind] ?? e.kind, tool: e.toolName, risk: e.riskClass, refusal: e.refusalCode }) };

const out = { node: process.version, electron: process.versions.electron ?? null, rssStartMb: rssMb(), steps: [] };
const step = (name, data) => { out.steps.push({ name, ...data }); console.log(name.padEnd(44), JSON.stringify(data).slice(0, 170)); };

const manifestPath = path.join(os.tmpdir(), `bimax-look-${process.pid}.yaml`);
fs.writeFileSync(manifestPath, manifestFor('ai.bimax.cu.fixture'), { mode: 0o600 });

let t0 = performance.now();
const driver = CuaDriver.createConfiguredWithActivityObserver(ConfiguredDriverOptions.create({
  claudeCodeCompatibility: false,
  authorization: RuntimeAuthorizationOptions.create({
    allowedModes: [SessionPermissionMode.Bounded],
    compatibilityMode: SessionPermissionMode.Bounded,
    compatibilityCapabilityManifestPath: manifestPath,
    unrestrictedAcknowledged: false,
    maxSessionTtlSeconds: 600n,
    maxIdleTtlSeconds: 120n,
  }),
}), observer);
step('create runtime (in-process, bounded)', { ms: ms(t0), rssMb: rssMb() });

t0 = performance.now();
const session = createTrustedSession(driver, TrustedSessionOptions.create({
  publicSession: 'bimax-thread-probe', mode: SessionPermissionMode.Bounded, ttlSeconds: 600n, idleTtlSeconds: 120n,
  capabilityManifestPath: manifestPath,
}));
step('open trusted session (fixture, look-only)', { ms: ms(t0) });

const call = async (name, args) => {
  const t = performance.now();
  try {
    const r = await session.callTool(name, JSON.stringify(args));
    let data = null; try { data = JSON.parse(r.structuredJson ?? 'null'); } catch {}
    return { ok: !r.isError, errorCode: r.errorCode ?? null, ms: ms(t), data, text: (r.text || '').slice(0, 160) };
  } catch (e) {
    return { ok: false, threw: true, ms: ms(t), error: String(e?.message ?? e).slice(0, 220), tag: e?.tag ?? e?.name };
  }
};

const fixturePid = Number(execFileSync('pgrep', ['-f', 'BimaxCuFixture.app/Contents/MacOS/bimax-cu-fixture'], { encoding: 'utf8' }).trim().split('\n')[0]);
const otherPid = Number(execFileSync('pgrep', ['-x', 'Finder'], { encoding: 'utf8' }).trim().split('\n')[0]);

const wins = await call('list_windows', { pid: fixturePid });
const wid = wins.data?.windows?.find((w) => w.title === 'Bimax-Cu Fixture')?.window_id;
step('list_windows (fixture)', { ok: wins.ok, ms: wins.ms, windowId: wid ?? null, error: wins.errorCode ?? wins.error ?? null });

const timings = [];
let elements = null;
for (let i = 0; i < 6; i += 1) {
  const r = await call('get_window_state', { pid: fixturePid, window_id: wid, include_screenshot: false });
  timings.push(r.ms);
  if (i === 0) { elements = r.data?.elements?.length ?? null; step('get_window_state (fixture), first', { ok: r.ok, ms: r.ms, elements, error: r.errorCode ?? r.error ?? null }); }
}
step('get_window_state (fixture), 6 reads', { ms: timings, rssMb: rssMb() });

const button = (await call('get_window_state', { pid: fixturePid, window_id: wid, include_screenshot: false }))
  .data?.elements?.find((e) => e.role === 'AXButton' && e.label === 'Fixture Button');
for (const [name, args] of [
  ['click', { pid: fixturePid, window_id: wid, element_token: button?.element_token }],
  ['type_text', { pid: fixturePid, window_id: wid, text: 'must not arrive' }],
  ['press_key', { pid: fixturePid, window_id: wid, key: 'return' }],
]) {
  const r = await call(name, args);
  step(`MUST REFUSE: ${name}`, { refused: !r.ok, errorCode: r.errorCode ?? null, threw: r.threw ?? false, error: (r.error ?? r.text ?? '').slice(0, 120) });
}
const other = await call('list_windows', { pid: otherPid });
const otherWin = other.data?.windows?.[0]?.window_id;
const outOfScope = await call('get_window_state', { pid: otherPid, window_id: otherWin, include_screenshot: false });
step('MUST REFUSE: look at Finder (not granted)', { refused: !outOfScope.ok, errorCode: outOfScope.errorCode ?? null, error: (outOfScope.error ?? outOfScope.text ?? '').slice(0, 120), listWindowsOk: other.ok });

const status = (await call('get_window_state', { pid: fixturePid, window_id: wid, include_screenshot: false })).data?.tree_markdown?.match(/presses=\d+ events=\d+ last=[a-z]+/)?.[0];
step('fixture status after the refused input', { status });

out.network = sockets();
step('network sockets held by this process', { count: out.network.length, sample: out.network.slice(0, 3) });
await session.close?.();
await driver.shutdown();
out.rssEndMb = rssMb();
out.events = events;
const tally = {};
for (const e of events) tally[`${e.kind}:${e.tool}`] = (tally[`${e.kind}:${e.tool}`] ?? 0) + 1;
out.tally = tally;
step('activity observer tally', tally);
fs.writeFileSync(path.join(here, `embed-probe-${out.electron ? 'electron' : 'node'}.json`), JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
fs.rmSync(manifestPath, { force: true });
