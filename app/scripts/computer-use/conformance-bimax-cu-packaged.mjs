#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = execFileSync('git', ['-C', import.meta.dirname, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const desktopRoot = existsSync(path.join(repo, 'app/package.json')) ? path.join(repo, 'app') : repo;
const bundle = path.resolve(process.argv[2] || path.join(desktopRoot, 'release/mac-arm64/Bimax.app'));
const evidenceRoot = path.resolve(
  process.argv[3] || path.join(desktopRoot, 'benchmarks/computer-use/results/phase2'),
);
const contents = path.join(bundle, 'Contents');
const service = path.join(
  contents, 'XPCServices/BimaxCuService.xpc/Contents/MacOS/bimax-cu-service',
);
const bridge = path.join(contents, 'MacOS/bimax-cu-bridge');
const livePip = path.join(contents, 'MacOS/bimax-live-pip');
const provider = path.join(contents, 'MacOS/bimax-mac-capability');
const executable = path.join(contents, 'MacOS/Bimax');
const engine = path.join(contents, 'Resources/engine/bimax-engine');
const asar = path.join(contents, 'Resources/app.asar');
const stamp = new Date().toISOString().replaceAll(':', '-');
const outputDirectory = path.join(evidenceRoot, `run-${stamp}`);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'bimax-phase2-package-'));

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    command: [file, ...args],
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function jsonRun(file, args, options) {
  const result = run(file, args, options);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  return { ...result, parsed };
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function stopFixture(appPath) {
  // The pattern is the exact unique temporary bundle path created by this run.
  spawnSync('pkill', ['-f', appPath], { encoding: 'utf8' });
}

for (const required of [bundle, service, bridge, livePip, provider, executable, engine, asar]) {
  if (!existsSync(required)) throw new Error(`packaged conformance: missing ${required}`);
}

mkdirSync(evidenceRoot, { recursive: true });
mkdirSync(outputDirectory, { recursive: false });
const target = path.join(scratch, 'BimaxCuFixture.app');
const bystander = path.join(scratch, 'BimaxCuBystander.app');
const reminderState = path.join(scratch, 'reminders.json');
const typingState = path.join(scratch, 'typing.txt');

const report = {
  schemaVersion: 1,
  taskId: 'PHASE2-PACKAGED-LOCAL',
  startedAt: new Date().toISOString(),
  bundle,
  packageIdentity: {
    source: 'bundle',
    appExecutableSha256: sha256(executable),
    engineSha256: sha256(engine),
    serviceSha256: sha256(service),
    bridgeSha256: sha256(bridge),
    providerSha256: sha256(provider),
    appAsarSha256: sha256(asar),
    executableDescription: execFileSync('file', [executable], { encoding: 'utf8' }).trim(),
    engineDescription: execFileSync('file', [engine], { encoding: 'utf8' }).trim(),
    serviceDescription: execFileSync('file', [service], { encoding: 'utf8' }).trim(),
    providerDescription: execFileSync('file', [provider], { encoding: 'utf8' }).trim(),
  },
  machineProfile: {
    platform: os.platform(),
    architecture: os.arch(),
    osRelease: os.release(),
    osVersion: os.version(),
    cpuModel: os.cpus()[0]?.model || 'unknown',
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  networkProfile: {
    // Node cannot truthfully infer NWPath cost/constrained state or endpoint RTT. Those remain
    // unknown until the native Network framework profiler in the research playbook is measured.
    pathStatus: 'unknown',
    expensive: 'unknown',
    constrained: 'unknown',
    endpointRTT: 'unknown',
    interfaces: Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
      (entries || []).map((entry) => ({ name, family: entry.family, internal: entry.internal }))),
  },
  rows: {},
  assertions: {},
  passed: false,
};

try {
  report.rows.structure = run(process.execPath, [
    path.join(repo, 'scripts/verify-desktop-package.mjs'), bundle,
    os.arch() === 'x64' ? 'x86_64' : os.arch(),
  ]);
  report.rows.fixtureBuild = run(path.join(desktopRoot, 'scripts/computer-use/build-bimax-cu-fixture.sh'), [target]);
  if (report.rows.fixtureBuild.exitCode !== 0) throw new Error('target fixture build failed');

  report.rows.fixtureLaunch = run('open', [target, '--args', '--title-ui-element-fixture']);
  wait(3_000);
  report.rows.handshake = jsonRun(service, ['--self-test-handshake']);
  report.rows.semanticAndPhysical = jsonRun(service, ['--self-test-catalog', 'ai.bimax.cu.fixture']);
  report.rows.stop = jsonRun(service, ['--self-test-stop', 'ai.bimax.cu.fixture']);
  report.rows.visual = jsonRun(service, ['--self-test-capture', 'ai.bimax.cu.fixture']);

  stopFixture(target);
  report.rows.targetM02Build = run(path.join(desktopRoot, 'scripts/computer-use/build-bimax-cu-fixture.sh'), [target, 'target']);
  report.rows.bystanderBuild = run(
    path.join(desktopRoot, 'scripts/computer-use/build-bimax-cu-fixture.sh'), [bystander, 'bystander'],
  );
  if (report.rows.targetM02Build.exitCode !== 0 || report.rows.bystanderBuild.exitCode !== 0) {
    throw new Error('M02 fixture build failed');
  }
  report.rows.targetM02Launch = run('open', [
    '-g', target, '--args', '--m02-fixture', '--m02-state', reminderState,
  ]);
  wait(2_000);
  report.rows.bystanderLaunch = run('open', [
    bystander, '--args', '--bystander-fixture', '--typing-state', typingState,
  ]);
  wait(2_000);
  report.rows.m02 = jsonRun(service, [
    '--self-test-m02', 'ai.bimax.cu.fixture', 'ai.bimax.cu.bystander', reminderState, typingState,
  ]);

  const handshake = report.rows.handshake.parsed;
  const catalog = report.rows.semanticAndPhysical.parsed;
  const stop = report.rows.stop.parsed;
  const visual = report.rows.visual.parsed;
  const m02 = report.rows.m02.parsed;
  const expectedArchitecture = os.arch() === 'x64' ? 'x86_64' : os.arch();
  const packagedProviderStrings = execFileSync('strings', [provider], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  report.assertions = {
    packageStructure: report.rows.structure.exitCode === 0,
    bundleOnlyComponent: service.startsWith(`${contents}${path.sep}`),
    protocolSelected: handshake?.selectedProtocol === 'bimax.cu.v1',
    architectureMatchesHost: handshake?.platform?.architecture === expectedArchitecture,
    capacityAdvertised: handshake?.limits?.maxConcurrentReadSessions > 0
      && handshake?.limits?.maxCaptureStreams > 0
      && handshake?.limits?.maxElements > 0,
    // Phase 4 moved this owner out of the generic engine. Prove the shipped Desktop provider still
    // contains the immediate pre-delivery latch instead of looking for Desktop policy in Terminal.
    packagedTakeoverInterlock: packagedProviderStrings.includes('computer_use_paused')
      && packagedProviderStrings.includes('explicit resume is required'),
    temporalAxReadiness: packagedProviderStrings.includes('AX is still warming')
      && packagedProviderStrings.includes('AX is ready now')
      && packagedProviderStrings.includes('not a permanent app capability classification'),
    semanticContentPolicy: packagedProviderStrings.includes('AX already represents the window; no command catalog is needed'),
    searchSelectionTransaction: [
      'open_search', 'ground_result', 'menu_search needs expect',
      'selected it, and VERIFIED',
    ].every((needle) => packagedProviderStrings.includes(needle)),
    opaqueContentVisualPolicy: packagedProviderStrings.includes('menus cannot represent it')
      && packagedProviderStrings.includes('vision remains eligible'),
    backgroundNeverSilentlyFocuses: packagedProviderStrings.includes('foreground_required')
      && packagedProviderStrings.includes('Bimax did not switch apps'),
    semanticPerformed: catalog?.verified?.includes('set_value') && catalog?.overclaimed?.length === 0,
    physicalPerformed: catalog?.results?.some((row) =>
      row.action === 'type_text' && row.status === 'performed'
        && row.deliveryPath === 'physical_cgevent' && row.effectObserved === true),
    visualPerformed: visual?.status === 'ran'
      && (visual?.completeFrames > 0 || visual?.oneShotFallback === true),
    stopBeforeEffect: stop?.status === 'ran'
      && stop?.refusalCode === 'foreground_approval_required'
      && stop?.targetUnchanged === true && stop?.foregroundPreserved === true,
    m02ExactState: m02?.status === 'ran' && m02?.failed === 0 && m02?.passed === 9,
  };
  report.passed = Object.values(report.assertions).every(Boolean)
    && Object.values(report.rows).every((row) => row.exitCode === 0);
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
} finally {
  report.finishedAt = new Date().toISOString();
  stopFixture(target);
  stopFixture(bystander);
  writeFileSync(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify({ evidence: outputDirectory, passed: report.passed, assertions: report.assertions }, null, 2));
process.exit(report.passed ? 0 : 1);
