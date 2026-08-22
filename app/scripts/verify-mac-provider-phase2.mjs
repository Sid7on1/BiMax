#!/usr/bin/env node

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const appRoot = path.resolve(import.meta.dirname, '..');
const provider = path.resolve(process.argv[2]);
const nativeFixture = path.resolve(process.argv[3]);
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const client = new Client({ name: 'bimax-phase2-verifier', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: provider,
  env: {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '', TMPDIR: process.env.TMPDIR || '/tmp',
    BIMAX_CWD: appRoot, BIMAX_HOST_ARCH: architecture,
    BIMAX_MAC_PROVIDER_AUTHORITY: 'electron-main',
    BIMAX_MAC_CONSENT_CHANNEL: 'engine-governor',
    BIMAX_DESKTOP_RELEASE_MODE: 'packaged',
    BIMAX_CU_NATIVE_ROUTING_ENABLED: '1',
    BIMAX_CU_SERVICE_BINARY: nativeFixture,
    BIMAX_CU_BRIDGE_BINARY: nativeFixture,
  },
  stderr: 'pipe',
});

async function logical(action, args = {}) {
  const result = await client.callTool({ name: 'mac_control', arguments: { action, ...args } });
  assert(result.structuredContent && typeof result.structuredContent === 'object',
    `${action} lost structuredContent`);
  return result.structuredContent;
}

async function observe() {
  const result = await logical('observe');
  assert(result.ok === true && result.frameId, `observe failed: ${JSON.stringify(result)}`);
  return result;
}

await client.connect(transport);
const results = {};
try {
  const status = await logical('status');
  assert(status.ok === true && status.route === 'native_logical_adapter', 'native adapter is inactive');

  const opened = await logical('open', { app: 'Phase2Fixture' });
  assert(opened.ok === true && opened.verified === true
    && opened.verification?.postcondition?.kind === 'app_running'
    && opened.verification?.delivery?.focusChanged === false,
  `launch was not independently verified: ${JSON.stringify(opened)}`);
  results.open = 'verified';

  const first = await observe();
  const countBeforeStops = (await logical('apps')).apps?.[0]?.app?.fixtureActionCount;
  const stopped = [
    await logical('click', { elementToken: 'continue', frameId: first.frameId }),
    await logical('key', { combo: 'return' }),
    await logical('menu_activate', { menuPath: '1.2' }),
    await logical('click', { x: 10, y: 10, frameId: first.frameId, expect: 'Done' }),
    await logical('quit_app'),
  ];
  assert(stopped.every(result => result.ok === false && result.executor === 'stop'
    && result.verification?.status === 'not_attempted'),
  `one unsupported/no-postcondition path escaped stop: ${JSON.stringify(stopped)}`);
  const countAfterStops = (await logical('apps')).apps?.[0]?.app?.fixtureActionCount;
  assert(countAfterStops === countBeforeStops, 'a stop path reached native action delivery');
  results.semanticMissingPostcondition = 'stopped_before_effect';
  results.physical = 'stopped_before_effect';
  results.menu = 'stopped_before_effect';
  results.visualDelivery = 'stopped_before_effect';
  results.stop = 'stopped_before_effect';

  const falseSuccess = await logical('click', {
    elementToken: 'continue', frameId: first.frameId, expect: 'NEVER_VERIFY',
  });
  assert(falseSuccess.ok === false && falseSuccess.actionAttempted === true
    && falseSuccess.code === 'postcondition_unverified'
    && falseSuccess.verification?.status === 'unverified',
  `performed-only false success escaped: ${JSON.stringify(falseSuccess)}`);
  results.falseSuccess = 'killed';

  const second = await observe();
  const click = await logical('click', {
    elementToken: 'continue', frameId: second.frameId, expect: 'Verified',
  });
  assert(click.ok === true && click.verified === true
    && click.verification?.freshObservation === true
    && click.verification?.delivery?.actual === 'background',
  `semantic mutation was not freshly verified: ${JSON.stringify(click)}`);
  results.semantic = 'verified';

  const third = await observe();
  const value = await logical('set_value', {
    elementToken: 'composer', frameId: third.frameId, value: 'phase2-value',
  });
  assert(value.ok === true && value.verification?.postcondition?.kind === 'semantic_value'
    && value.verification?.postcondition?.source === 'derived',
  `derived value postcondition failed: ${JSON.stringify(value)}`);
  results.derivedValue = 'verified';

  // Foreground-leased delivery: the caller explicitly requests a focus change, the native receipt
  // must prove a lease-backed policy plus the measured frontmost move, and the grader must hold
  // all of it to the inverse of the background rules.
  const fourth = await observe();
  const physical = await logical('type', {
    elementToken: 'composer', frameId: fourth.frameId,
    text: 'foreground-leased', expect: 'foreground-leased',
    delivery: 'foreground_lease',
  });
  assert(physical.ok === true && physical.verified === true
    && physical.verification?.delivery?.requested === 'foreground'
    && physical.verification?.delivery?.actual === 'foreground'
    && physical.verification?.delivery?.focusChanged === true
    && typeof physical.verification?.evidence?.focusLease === 'object',
  `foreground-leased delivery was not proven: ${JSON.stringify(physical)}`);
  results.physicalForeground = 'verified';

  await observe();
  const arranged = await logical('arrange', { layout: 'left' });
  assert(arranged.ok === true && arranged.verification?.postcondition?.kind === 'window_frame',
    `window read-back failed: ${JSON.stringify(arranged)}`);
  results.window = 'verified';

  await observe();
  const screenshot = await logical('screenshot');
  assert(screenshot.ok === true && screenshot.executor === 'visual',
    `read-only visual capture failed: ${JSON.stringify(screenshot)}`);
  results.visualRead = 'verified_read_only';

  const closed = await logical('close');
  assert(closed.ok === true && closed.verification?.postcondition?.kind === 'window_absent',
    `window disappearance was not verified: ${JSON.stringify(closed)}`);
  results.close = 'verified';
} finally {
  await client.close().catch(() => undefined);
}

process.stdout.write(`${JSON.stringify({
  ok: true, architecture, route: 'native_logical_adapter', results,
  fixture: 'deterministic-native-postcondition-and-false-success',
}, null, 2)}\n`);
