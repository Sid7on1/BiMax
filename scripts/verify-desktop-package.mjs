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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  engine: path.join(contents, 'Resources', 'engine', 'index.js'),
  asar: path.join(contents, 'Resources', 'app.asar'),
};

for (const [name, file] of Object.entries(files)) {
  if (!existsSync(file)) fail(`missing ${name}: ${file}`);
}

// The app executable is a Mach-O binary and must match the target architecture.
if ((statSync(files.appExecutable).mode & 0o111) === 0) fail(`appExecutable is not executable: ${files.appExecutable}`);
const appDescription = execFileSync('file', [files.appExecutable], { encoding: 'utf8' }).trim();
if (!appDescription.includes(expectedArchitecture)) {
  fail(`appExecutable is not ${expectedArchitecture}: ${appDescription}`);
}

// The engine is JAVASCRIPT now, not a per-chip Mach-O binary — Electron's own Node runs it as a
// worker thread, so there is no architecture to check and one artifact serves arm64 and x64. An
// arch assertion here would fail every build for the wrong reason. What matters instead is that the
// bundle is real and complete: a non-trivial module plus the tree-sitter .wasm assets it loads at
// runtime, which are emitted beside it and are exactly the kind of thing a bundler silently drops.
const engineBytes = statSync(files.engine).size;
if (engineBytes < 1_000_000) fail(`engine bundle looks truncated: ${engineBytes} bytes at ${files.engine}`);
const engineDir = path.dirname(files.engine);
const wasm = readdirSync(engineDir).filter((f) => f.endsWith('.wasm'));
if (!wasm.length) fail(`engine bundle ships no .wasm assets; tree-sitter will not load: ${engineDir}`);

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

// No retired Computer Use driver dependency may ship, inside or outside ASAR.
const unpacked = path.join(contents, 'Resources', 'app.asar.unpacked', 'node_modules');
const archivedPaths = asar.listPackage(files.asar);
for (const name of ['@trycua', '@ubjs']) {
  if (existsSync(path.join(unpacked, name)) || archivedPaths.some(p => p.includes(`/node_modules/${name}/`))) {
    fail(`retired Computer Use dependency is packaged: ${name}`);
  }
}

const packagedMain = asar.extractFile(files.asar, 'out/main/index.js').toString('utf8');

for (const marker of ['Let Tasks Look at Other Apps', 'Let Tasks Use Other Apps',
  'createLookService', 'createLookDriver', 'isTrustedAccessibilityClient']) {
  if (packagedMain.includes(marker)) fail(`retired Computer Use integration is packaged: ${marker}`);
}
const packagedEngine = readFileSync(files.engine, 'utf8');
for (const name of ['LookAtAppTool', 'PressInAppTool', 'TypeInAppTool', 'ScrollInAppTool']) {
  if (packagedEngine.includes(name)) fail(`retired Computer Use engine tool is packaged: ${name}`);
}

// A shipped build must resolve its engine from inside the bundle and must not obey an environment
// override — "cannot walk to ../src or silently compile whichever engine happens to be beside it"
// (05_TARGET_ARCHITECTURE.md). Read from the packaged asar, not from source.
if (!packagedMain.includes('refusing a development fallback')) {
  fail('packaged main process does not refuse a development engine fallback');
}
// Since record 64's M4 there is no override left to refuse: the engine runs only as a worker thread, and the separate
// engine process with its BIMAX_ENGINE_CMD / BIMAX_ENGINE_TRANSPORT switches is gone. Matched on code, not on names,
// because a comment that explains the removal may keep the names.
for (const [pattern, what] of [
  [/utilityProcess\s*\.\s*fork\s*\(/, 'still forks the engine as a separate process (utilityProcess)'],
  [/env\s*\.\s*BIMAX_ENGINE_CMD\b/, 'still reads BIMAX_ENGINE_CMD'],
  [/env\s*\.\s*BIMAX_ENGINE_TRANSPORT\b/, 'still reads BIMAX_ENGINE_TRANSPORT'],
]) {
  if (pattern.test(packagedMain)) fail(`packaged main process ${what}`);
}
// The bundler keeps the module prefix (`new node_worker_threads.Worker(`), so allow one.
if (!/new\s+(?:[\w$]+\.)*Worker\s*\(/.test(packagedMain)) {
  fail('packaged main process never starts a worker thread, so it cannot run the engine');
}

console.log(`desktop package gate: PASS ${bundle}`);
console.log(`desktop package gate: PASS ${expectedArchitecture} app executable and bundled engine`);
console.log('desktop package gate: PASS no Computer Use sidecar or driver SDK is packaged');
console.log('desktop package gate: PASS packaged run resolves the engine from the bundle, as a worker thread, with no override');
