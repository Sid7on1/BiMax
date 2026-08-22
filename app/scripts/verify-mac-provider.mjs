#!/usr/bin/env node

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const appRoot = path.resolve(import.meta.dirname, '..');
const binary = path.resolve(process.argv[2] || path.join(appRoot, 'native-service/bimax-mac-capability'));
const sampleFile = path.join(appRoot, 'benchmarks/computer-use/contracts/mac-provider-tools.sample.json');
const expected = JSON.parse(readFileSync(sampleFile, 'utf8'));
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';

function normalizedTools(listed) {
  return (listed.tools || []).map((tool) => ({
    name: tool.name,
    required: [...(tool.inputSchema?.required || [])].sort(),
    additionalProperties: tool.inputSchema?.additionalProperties,
    actionEnum: [...(tool.inputSchema?.properties?.action?.enum || [])],
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function assertExpectedTools(tools, mode) {
  if (JSON.stringify(tools) !== JSON.stringify(expected.tools)) {
    throw new Error(`${mode} provider schema drifted from ${sampleFile}\nexpected=${JSON.stringify(expected.tools)}\nactual=${JSON.stringify(tools)}`);
  }
}

async function probeProvider(releaseMode, verify) {
  const client = new Client({ name: `bimax-provider-${releaseMode}-gate`, version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: binary,
    args: [],
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '',
      TMPDIR: process.env.TMPDIR || '/tmp',
      BIMAX_CWD: appRoot,
      BIMAX_HOST_ARCH: architecture,
      BIMAX_MAC_PROVIDER_AUTHORITY: 'electron-main',
      BIMAX_MAC_CONSENT_CHANNEL: 'engine-governor',
      BIMAX_MAC_PROVIDER_DISABLE_NATIVE: '1',
      BIMAX_DESKTOP_RELEASE_MODE: releaseMode,
    },
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    const tools = normalizedTools(await client.listTools());
    assertExpectedTools(tools, releaseMode);
    return await verify(client, tools);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const development = await probeProvider('development', async (client, tools) => {
  const status = await client.callTool({ name: 'mac_control', arguments: { action: 'status' } });
  if (!status.structuredContent || typeof status.structuredContent !== 'object') {
    throw new Error('development mac_control status did not preserve structuredContent');
  }
  return { tools: tools.map(tool => tool.name), structuredStatus: true };
});

const packaged = await probeProvider('packaged', async (client, tools) => {
  const result = await client.callTool({
    name: 'mac_control',
    arguments: { action: 'click', x: 10, y: 10 },
  });
  const refusal = result.structuredContent;
  if (!refusal || typeof refusal !== 'object') {
    throw new Error('packaged mac_control refusal did not preserve structuredContent');
  }
  const expectedRefusal = {
    ok: false,
    action: 'click',
    code: 'native_tools_unavailable',
    blocked: true,
    visible: true,
  };
  for (const [key, value] of Object.entries(expectedRefusal)) {
    if (refusal[key] !== value) {
      throw new Error(`packaged mac_control did not fail closed: expected ${key}=${JSON.stringify(value)}, received ${JSON.stringify(refusal[key])}`);
    }
  }
  if (typeof refusal.reason !== 'string' || !refusal.reason.includes('verified native service tools are unavailable')) {
    throw new Error(`packaged mac_control did not expose the native-route blocker: ${JSON.stringify(refusal)}`);
  }
  return {
    tools: tools.map(tool => tool.name),
    structuredRefusal: true,
    blocker: refusal.code,
    compatibilityActionReached: false,
  };
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  transport: 'stdio',
  architecture,
  development,
  packaged,
}, null, 2)}\n`);
