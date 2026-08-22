#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const asar = require('../app/node_modules/@electron/asar');
const bundleArgument = process.argv[2];
const expectedArchitecture = process.argv[3] || process.arch;

function fail(message) {
  console.error(`desktop package gate: FAIL: ${message}`);
  process.exit(1);
}

if (!bundleArgument) fail('usage: node scripts/verify-desktop-package.mjs /path/to/Bimax.app [arm64|x86_64]');
const bundle = path.resolve(bundleArgument);
if (!bundle.endsWith('.app') || !existsSync(bundle)) fail(`not an app bundle: ${bundle}`);

const contents = path.join(bundle, 'Contents');
const files = {
  appExecutable: path.join(contents, 'MacOS', 'Bimax'),
  engine: path.join(contents, 'Resources', 'engine', 'bimax-engine'),
  service: path.join(contents, 'XPCServices', 'BimaxCuService.xpc', 'Contents', 'MacOS', 'bimax-cu-service'),
  servicePlist: path.join(contents, 'XPCServices', 'BimaxCuService.xpc', 'Contents', 'Info.plist'),
  bridge: path.join(contents, 'MacOS', 'bimax-cu-bridge'),
  helper: path.join(contents, 'MacOS', 'bimax-desktop-helper'),
  livePip: path.join(contents, 'MacOS', 'bimax-live-pip'),
  macCapability: path.join(contents, 'MacOS', 'bimax-mac-capability'),
  asar: path.join(contents, 'Resources', 'app.asar'),
};

for (const [name, file] of Object.entries(files)) {
  if (!existsSync(file)) fail(`missing ${name}: ${file}`);
}

for (const name of ['appExecutable', 'engine', 'service', 'bridge', 'helper', 'livePip', 'macCapability']) {
  const file = files[name];
  if ((statSync(file).mode & 0o111) === 0) fail(`${name} is not executable: ${file}`);
  const description = execFileSync('file', [file], { encoding: 'utf8' }).trim();
  if (!description.includes(expectedArchitecture)) {
    fail(`${name} is not ${expectedArchitecture}: ${description}`);
  }
}

const packagedMain = asar.extractFile(files.asar, 'out/main/index.js').toString('utf8');
if (!packagedMain.includes('BIMAX_HOST_CAPABILITIES_JSON') || !packagedMain.includes('bimax-mac-capability')) {
  fail('packaged main process does not inject the generic local capability-provider contract');
}
if (!packagedMain.includes('BIMAX_DESKTOP_RELEASE_MODE') || !packagedMain.includes('packaged')) {
  fail('packaged main process does not force native-only production Computer Use routing');
}
for (const requiredPath of ['XPCServices', 'BimaxCuService.xpc', 'bimax-cu-bridge', 'bimax-desktop-helper', 'bimax-live-pip', 'bimax-mac-capability']) {
  if (!packagedMain.includes(requiredPath)) fail(`packaged main process does not resolve ${requiredPath}`);
}

// Phase 2, slice 2: the packaged app must resolve its own executables from the bundle. A shipped
// build that still reaches for a development engine, or that obeys an environment override, is the
// exact failure `05_TARGET_ARCHITECTURE.md` forbids ("cannot walk to ../src or silently compile
// whichever engine happens to be beside it"). These are read from the packaged bundle, not source.
if (!packagedMain.includes('refusing to fall back to a development engine')) {
  fail('packaged main process does not refuse a development engine fallback');
}
for (const variable of [
  'BIMAX_ENGINE_CMD', 'BIMAX_MAC_CAPABILITY_PROVIDER', 'BIMAX_CU_SERVICE_BINARY',
  'BIMAX_CU_BRIDGE_BINARY', 'BIMAX_DESKTOP_HELPER', 'BIMAX_LIVE_PIP_HELPER',
]) {
  if (!packagedMain.includes(variable)) fail(`packaged main process does not account for ${variable}`);
}
if (!packagedMain.includes('ignored') || !packagedMain.includes('packaged runs resolve from the app bundle only')) {
  fail('packaged main process does not report refused overrides');
}

const plistValue = (key) => execFileSync('plutil', ['-extract', key, 'raw', files.servicePlist], { encoding: 'utf8' }).trim();
if (plistValue('CFBundleIdentifier') !== 'ai.bimax.cu.service') fail('XPC service has the wrong bundle identifier');
if (plistValue('CFBundleExecutable') !== 'bimax-cu-service') fail('XPC service has the wrong executable contract');
if (plistValue('CFBundlePackageType') !== 'XPC!') fail('native service is not declared as an XPC bundle');

console.log(`desktop package gate: PASS ${bundle}`);
console.log(`desktop package gate: PASS ${expectedArchitecture} app, engine, provider, XPC service, bridge, helper, live target preview`);
console.log('desktop package gate: PASS packaged engine receives one generic local capability-provider contract');
console.log('desktop package gate: PASS packaged macOS capability provider is native-only and fail-closed');
console.log('desktop package gate: PASS packaged run resolves engine and native components from the bundle only');
