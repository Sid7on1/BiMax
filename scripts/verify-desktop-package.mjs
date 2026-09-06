#!/usr/bin/env node

// Desktop package gate. This reads the PACKAGED bundle — the .app that would be handed to a user —
// never the source tree. That distinction is the whole point: unit tests pass against source while
// a packaged app ships broken (v1.1.0 shipped a sidecar stub that exit 1'd and every gate stayed
// green, because none of them ran the staged artifact).
//
// Rewritten 2026-09-06 for the code-only product. It previously required a nested XPC Computer Use
// service, a CU bridge, a desktop helper, a live-target preview and a Mac capability provider —
// five binaries that electron-builder.yml has not packaged since the 2026-09-02 reset. The gate was
// therefore failing on `missing service:` before it could check anything that still ships.

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
  asar: path.join(contents, 'Resources', 'app.asar'),
};

for (const [name, file] of Object.entries(files)) {
  if (!existsSync(file)) fail(`missing ${name}: ${file}`);
}

for (const name of ['appExecutable', 'engine']) {
  const file = files[name];
  if ((statSync(file).mode & 0o111) === 0) fail(`${name} is not executable: ${file}`);
  const description = execFileSync('file', [file], { encoding: 'utf8' }).trim();
  if (!description.includes(expectedArchitecture)) {
    fail(`${name} is not ${expectedArchitecture}: ${description}`);
  }
}

// The product is code-only. A packaged bundle that has grown a Computer Use sidecar back is a
// regression, so assert their ABSENCE rather than their presence.
for (const forbidden of [
  path.join(contents, 'XPCServices'),
  path.join(contents, 'MacOS', 'bimax-cu-bridge'),
  path.join(contents, 'MacOS', 'bimax-cu-service'),
  path.join(contents, 'MacOS', 'bimax-desktop-helper'),
  path.join(contents, 'MacOS', 'bimax-live-pip'),
  path.join(contents, 'MacOS', 'bimax-mac-capability'),
]) {
  if (existsSync(forbidden)) fail(`code-only build packaged a Computer Use component: ${forbidden}`);
}

const packagedMain = asar.extractFile(files.asar, 'out/main/index.js').toString('utf8');

// A shipped build must resolve its engine from inside the bundle and must not obey an environment
// override — "cannot walk to ../src or silently compile whichever engine happens to be beside it"
// (05_TARGET_ARCHITECTURE.md). Read from the packaged asar, not from source.
if (!packagedMain.includes('refusing a development fallback')) {
  fail('packaged main process does not refuse a development engine fallback');
}
if (!packagedMain.includes('BIMAX_ENGINE_CMD')) {
  fail('packaged main process does not account for BIMAX_ENGINE_CMD');
}
if (!packagedMain.includes('refusedOverride')) {
  fail('packaged main process does not report a refused engine override');
}

console.log(`desktop package gate: PASS ${bundle}`);
console.log(`desktop package gate: PASS ${expectedArchitecture} app executable and bundled engine`);
console.log('desktop package gate: PASS no Computer Use components are packaged (code-only build)');
console.log('desktop package gate: PASS packaged run resolves the engine from the bundle and refuses overrides');
