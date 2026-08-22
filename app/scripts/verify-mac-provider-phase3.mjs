#!/usr/bin/env node

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const appRoot = path.resolve(import.meta.dirname, '..');
const provider = path.resolve(process.argv[2]);
const nativeFixture = path.resolve(process.argv[3]);
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
const contract = JSON.parse(readFileSync(path.join(
  appRoot, 'benchmarks/computer-use/contracts/cu-phase3-latency-budget.json',
), 'utf8'));

function assert(condition, message) { if (!condition) throw new Error(message); }
function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0;
}

const client = new Client({ name: 'bimax-phase3-verifier', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: provider,
  env: {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '',
    TMPDIR: process.env.TMPDIR || '/tmp', BIMAX_CWD: appRoot, BIMAX_HOST_ARCH: architecture,
    BIMAX_MAC_PROVIDER_AUTHORITY: 'electron-main', BIMAX_MAC_CONSENT_CHANNEL: 'engine-governor',
    BIMAX_DESKTOP_RELEASE_MODE: 'packaged', BIMAX_CU_NATIVE_ROUTING_ENABLED: '1',
    BIMAX_CU_SERVICE_BINARY: nativeFixture, BIMAX_CU_BRIDGE_BINARY: nativeFixture,
  },
  stderr: 'pipe',
});

async function logical(action, args = {}) {
  const result = await client.callTool({ name: 'mac_control', arguments: { action, ...args } });
  return result.structuredContent;
}

const coldStart = performance.now();
await client.connect(transport);
const coldProviderConnect = performance.now() - coldStart;
const samples = { observe: [], capture: [], verification: [] };
const frames = new Set();
try {
  const opened = await logical('open', { app: 'Phase2Fixture' });
  assert(opened?.ok === true, `open failed: ${JSON.stringify(opened)}`);
  for (let index = 0; index < contract.sampleCount; index += 1) {
    const observation = await logical('observe');
    assert(observation?.ok === true && observation?.perception?.state === 'ready',
      `observation ${index} was not ready: ${JSON.stringify(observation)}`);
    assert(observation?.snapshotAuthority?.usable === true
      && observation?.snapshotAuthority?.cache === 'disabled_pending_mutation_proof',
      `observation ${index} changed authority/cache rules`);
    assert(observation?.observationTrust?.classification === 'untrusted_observation',
      `observation ${index} was not quarantined`);
    frames.add(observation.frameId);
    samples.observe.push(observation.adapterTiming?.durationMs);

    const capture = await logical('screenshot', { frameId: observation.frameId });
    assert(capture?.ok === true && capture?.observationTrust?.classification === 'untrusted_observation',
      `capture ${index} failed or became trusted: ${JSON.stringify(capture)}`);
    samples.capture.push(capture.adapterTiming?.durationMs);

    const action = await logical('click', {
      frameId: observation.frameId, elementToken: 'continue', expect: 'Verified',
    });
    assert(action?.ok === true && action?.verified === true,
      `verification ${index} failed: ${JSON.stringify(action)}`);
    samples.verification.push(action.adapterTiming?.durationMs);
  }
  assert(frames.size === contract.sampleCount, 'an observe cache reused snapshot authority');
  for (const values of Object.values(samples)) assert(values.every(Number.isFinite), 'a timing sample is missing');
  const measured = {
    coldProviderConnect,
    warmObserveP95: p95(samples.observe),
    captureP95: p95(samples.capture),
    verificationP95: p95(samples.verification),
  };
  for (const [key, budget] of Object.entries(contract.budgetsMs)) {
    assert(measured[key] <= budget, `${key} ${measured[key]}ms exceeded frozen budget ${budget}ms`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true, architecture, corpus: contract.corpus, sampleCount: contract.sampleCount,
    measured, budgetsMs: contract.budgetsMs,
    authorityCache: contract.authorityCache,
  }, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
}
