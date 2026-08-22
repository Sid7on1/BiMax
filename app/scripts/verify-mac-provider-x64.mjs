#!/usr/bin/env node

// x64 parity check for the compiled mac capability provider.
//
// arm64 remains the release host, so this script is deliberately NOT part of cu:phase*:check.
// It proves the two things an x64 DMG needs from this machine today:
//   1. the provider cross-compiles for bun-darwin-x64 and the artifact is a real Mach-O x86_64;
//   2. when Rosetta 2 is installed, the x64 binary actually boots and passes the same Phase 0
//      packaged-refusal stdio probe the arm64 binary passes — including the host-architecture
//      admission gate, which is driven here with BIMAX_HOST_ARCH=x64 exactly as an x64 DMG
//      would inject it.
// Without Rosetta the script exits 0 with an explicit `executed:false` record instead of failing,
// because a missing translator is an environment fact, not a code defect.

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const appRoot = path.resolve(import.meta.dirname, '..');
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rosettaAvailable() {
  const probe = spawnSync('arch', ['-x86_64', '/usr/bin/true'], { encoding: 'utf8' });
  return probe.status === 0;
}

const outDir = mkdtempSync(path.join(tmpdir(), 'bimax-mac-capability-x64-'));
const provider = path.join(outDir, 'bimax-mac-capability-x64');
const result = {
  ok: true, hostArchitecture: architecture, target: 'x64',
  compiled: false, machO: false, executed: false,
};

try {
  execFileSync('bun', [
    'build', '--compile', '--target=bun-darwin-x64',
    path.join(appRoot, 'src', 'capabilities', 'mac', 'provider.entry.ts'),
    '--outfile', provider,
  ], { stdio: 'pipe' });
  result.compiled = true;

  const description = execFileSync('file', [provider], { encoding: 'utf8' });
  result.machO = /Mach-O.*x86_64/.test(description);
  if (!result.machO) throw new Error(`x64 artifact is not a Mach-O x86_64 binary: ${description.trim()}`);

  if (!rosettaAvailable()) {
    result.executed = false;
    result.skipped = 'Rosetta 2 is not installed; the x64 binary was built and header-checked but not booted';
  } else {
    const client = new Client({ name: 'bimax-x64-parity-verifier', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: provider,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.HOME || '', TMPDIR: process.env.TMPDIR || '/tmp',
        BIMAX_CWD: appRoot, BIMAX_HOST_ARCH: 'x64',
        BIMAX_MAC_PROVIDER_AUTHORITY: 'electron-main',
        BIMAX_MAC_CONSENT_CHANNEL: 'engine-governor',
        BIMAX_DESKTOP_RELEASE_MODE: 'packaged',
        BIMAX_CU_NATIVE_ROUTING_ENABLED: '1',
      },
      stderr: 'pipe',
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert(tools.tools.length === 1 && tools.tools[0].name === 'mac_control',
        `x64 tools/list did not contain exactly mac_control: ${JSON.stringify(tools.tools.map(t => t.name))}`);

      // The x64 machine has no bundled native service in this simulation, so packaged mode must
      // produce the same visible Phase 0 refusal the arm64 binary produces.
      const refused = await client.callTool({
        name: 'mac_control',
        arguments: { action: 'click', elementToken: 'any', frameId: 'none', expect: 'anything' },
      });
      const body = refused.structuredContent;
      assert(body && body.ok === false && body.blocked === true && body.visible === true
        && body.code === 'native_tools_unavailable',
      `x64 packaged click did not return the structured refusal: ${JSON.stringify(body)}`);
      result.executed = true;
      result.probe = { tools: ['mac_control'], structuredRefusal: true, blocker: body.code };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
