#!/usr/bin/env node

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const appRoot = path.resolve(import.meta.dirname, '..');
const provider = path.resolve(process.argv[2]);
const nativeFixture = path.resolve(process.argv[3]);
const epochFile = path.resolve(process.argv[4]);
const expected = JSON.parse(readFileSync(
  path.join(appRoot, 'benchmarks/computer-use/contracts/mac-provider-tools.sample.json'), 'utf8',
));
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';

function providerEnv() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '',
    TMPDIR: process.env.TMPDIR || '/tmp',
    BIMAX_CWD: appRoot,
    BIMAX_HOST_ARCH: architecture,
    BIMAX_MAC_PROVIDER_AUTHORITY: 'electron-main',
    BIMAX_MAC_CONSENT_CHANNEL: 'engine-governor',
    BIMAX_DESKTOP_RELEASE_MODE: 'packaged',
    BIMAX_CU_NATIVE_ROUTING_ENABLED: '1',
    BIMAX_CU_SERVICE_BINARY: nativeFixture,
    BIMAX_CU_BRIDGE_BINARY: nativeFixture,
    BIMAX_PHASE1_FIXTURE_EPOCH_FILE: epochFile,
  };
}

async function start(label) {
  const client = new Client({ name: `bimax-phase1-${label}`, version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: provider, args: [], env: providerEnv(), stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, close: () => client.close().catch(() => undefined) };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function logical(client, action, args = {}) {
  const result = await client.callTool({ name: 'mac_control', arguments: { action, ...args } });
  assert(result.structuredContent && typeof result.structuredContent === 'object', `${action} lost structuredContent`);
  return result.structuredContent;
}

async function assertSurface(client) {
  const listed = await client.listTools();
  const tools = (listed.tools || []).map(tool => ({
    name: tool.name,
    required: [...(tool.inputSchema?.required || [])].sort(),
    additionalProperties: tool.inputSchema?.additionalProperties,
    actionEnum: [...(tool.inputSchema?.properties?.action?.enum || [])],
  })).sort((left, right) => left.name.localeCompare(right.name));
  assert(JSON.stringify(tools) === JSON.stringify(expected.tools),
    `packaged Phase 1 logical schema drifted: ${JSON.stringify(tools)}`);
  const status = await logical(client, 'status');
  assert(status.ok === true && status.route === 'native_logical_adapter',
    `packaged provider did not activate the native logical adapter: ${JSON.stringify(status)}`);
  assert(Array.isArray(status.nativeTools) && status.nativeTools.includes('BimaxWorkspaceTool'),
    'native workspace tool is not behind mac_control');
  return status;
}

writeFileSync(epochFile, '1\n');
const first = await start('initial');
let sequentialReads = 0;
let serviceRestartRecovered = false;
let providerRestartRecovered = false;

try {
  await assertSurface(first.client);
  for (let index = 0; index < 10; index += 1) {
    const result = await logical(first.client, 'apps');
    assert(result.ok === true && result.nativeTool === 'BimaxWorkspaceTool',
      `sequential read ${index + 1} did not use native workspace: ${JSON.stringify(result)}`);
    sequentialReads += 1;
  }

  writeFileSync(epochFile, '2\n');
  const afterServiceRestart = await logical(first.client, 'apps');
  serviceRestartRecovered = afterServiceRestart.ok === true
    && afterServiceRestart.apps?.[0]?.app?.displayName === 'Phase1FixtureEpoch2';
  assert(serviceRestartRecovered,
    `read did not recover after native service restart: ${JSON.stringify(afterServiceRestart)}`);
} finally {
  await first.close();
}

const second = await start('provider-restart');
try {
  await assertSurface(second.client);
  const result = await logical(second.client, 'apps');
  providerRestartRecovered = result.ok === true
    && result.apps?.[0]?.app?.displayName === 'Phase1FixtureEpoch2';
  assert(providerRestartRecovered,
    `new provider did not establish a fresh native session: ${JSON.stringify(result)}`);
} finally {
  await second.close();
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  transport: 'stdio',
  architecture,
  tools: ['mac_control'],
  route: 'native_logical_adapter',
  sequentialReads,
  serviceRestartRecovered,
  providerRestartRecovered,
  fixture: 'deterministic-no-input-native-protocol',
}, null, 2)}\n`);
