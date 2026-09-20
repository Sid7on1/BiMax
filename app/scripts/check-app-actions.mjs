#!/usr/bin/env node
// Does the BUILT app actually expose the actions Bimax says it exposes?
//
// Record 57, WP-9: "the documented failure for a non-Swift host app is that the intents compile
// into a Swift library that is never linked, embedded or copied into the bundle — macOS never
// discovers the action and every build stays green. That is this repository's most-repeated
// failure shape." The instruction there is explicit: write the gate BEFORE the App Intents
// extension, not after.
//
// This repository has shipped that shape three times (bimax-packaging-guard-is-dead,
// bimax-packaged-artifact-untested): v1.1.0 shipped a sidecar stub that `exit 1`'d while every
// gate stayed green, because no gate ran against the staged artifact. So this script inspects a
// real `.app` on disk and never a source file.
//
// It FAILS when it cannot find an artifact. That is deliberate and is the whole point: the
// previous guard degraded to a skip, and a skip is indistinguishable from a pass in CI.
//
//   node scripts/check-app-actions.mjs [--app /path/to/Bimax.app]
//
// Search order when --app is absent: the release output, then the installed app.

import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const explicit = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : process.env.BIMAX_APP_PATH;

const appRoot = path.resolve(import.meta.dirname, '..');
const candidates = [];
if (explicit) candidates.push(explicit);
for (const dir of [process.env.BIMAX_RELEASE_DIR, path.join(appRoot, 'release'), '/tmp/bimax-release']) {
  if (!dir || !existsSync(dir)) continue;
  // electron-builder writes mac/, mac-arm64/, mac-universal/ depending on target.
  for (const entry of readdirSync(dir)) {
    const bundle = path.join(dir, entry, 'Bimax.app');
    if (existsSync(bundle)) candidates.push(bundle);
  }
}
candidates.push('/Applications/Bimax.app');

const app = candidates.find((c) => c && existsSync(path.join(c, 'Contents', 'Info.plist')));
const failures = [];
const checked = [];

if (!app) {
  console.error('✗ No built Bimax.app to check.');
  console.error('');
  console.error('  Looked in: ' + candidates.join(', '));
  console.error('');
  console.error('  This gate inspects a real bundle on disk, because the failure it exists to catch');
  console.error('  — an action that compiles but is never copied into the bundle — is invisible in');
  console.error('  source. Build first (npm --prefix app run dist:mac:local), or pass --app.');
  console.error('');
  console.error('  It fails rather than skipping on purpose: the previous packaging guard degraded');
  console.error('  to a skip and stayed green through three separate shipped regressions.');
  process.exit(1);
}

const plist = path.join(app, 'Contents', 'Info.plist');
const read = (key) => {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, plist], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

// ── 1. The bimax:// URL scheme ────────────────────────────────────────────────────────────────
// This is what makes Shortcuts, Raycast, Stream Deck and a Focus mode able to start a ⌘2 task
// today (app/src/main/bimax.link.ts, backlog N2). It is declared in electron-builder.yml, and an
// electron-builder config change can drop it without any code changing.
const urlTypes = read(':CFBundleURLTypes');
checked.push('bimax:// URL scheme');
if (!urlTypes || !/\bbimax\b/.test(urlTypes)) {
  failures.push([
    'The built app does not register the `bimax` URL scheme.',
    'Shortcuts, Raycast and `open bimax://task?folder=…&prompt=…` would all silently do nothing —',
    'macOS would not know this app handles the link. Check `protocols:` in electron-builder.yml.',
  ].join('\n    '));
}

// ── 2. App Intents metadata, when an extension is present ─────────────────────────────────────
// WP-9's later steps add an App Intents extension. The failure shape is that the .appex is
// embedded but its generated `Metadata.appintents` is not, so macOS discovers no actions and the
// build stays green. Asserted conditionally: we do not claim intents exist before they do, but the
// moment an extension is embedded its metadata becomes mandatory.
// Contents/Extensions is where an ExtensionKit extension must live; Contents/PlugIns is the older
// NSExtension location. Both are scanned because an app may legitimately carry either, but an App
// Intents extension found only in PlugIns is itself the defect — measured 2026-09-20: macOS does
// not register it from there, silently.
const homes = [path.join(app, 'Contents', 'Extensions'), path.join(app, 'Contents', 'PlugIns')];
const appex = homes.flatMap((home) =>
  (existsSync(home) ? readdirSync(home) : []).filter((e) => e.endsWith('.appex')).map((e) => ({ home, ext: e })));
if (appex.length) {
  checked.push(`App Intents metadata for ${appex.length} extension(s)`);
  for (const { home, ext } of appex) {
    if (path.basename(home) === 'PlugIns') {
      failures.push([
        `${ext} is in Contents/PlugIns, where macOS will not discover it.`,
        'An ExtensionKit extension (one declaring EXAppExtensionAttributes) is only registered from',
        'Contents/Extensions. In PlugIns it is embedded, signed and shipped, and Launch Services',
        'records nothing at all — no log line, no pluginkit entry. Move it to Contents/Extensions.',
      ].join('\n    '));
    }
    const metadata = path.join(home, ext, 'Contents', 'Resources', 'Metadata.appintents');
    if (!existsSync(metadata)) {
      failures.push([
        `${ext} is embedded but carries no Metadata.appintents.`,
        'The intents compiled and were linked, and macOS will still discover no actions — Siri and',
        'the Shortcuts app will show nothing. This is the exact failure WP-9 ordered this gate to',
        'catch. Check that the extension target runs the App Intents metadata processor and that',
        'electron-builder copies Contents/Resources.',
      ].join('\n    '));
    }
  }
}

// ── 3. The engine the app spawns ──────────────────────────────────────────────────────────────
// bimax-packaged-artifact-untested: v1.1.0 shipped a sidecar stub that exit 1'd on every read
// verb. Nothing ran the staged artifact, so every gate was green.
const engine = path.join(app, 'Contents', 'Resources', 'engine');
checked.push('bundled engine');
if (!existsSync(engine)) {
  failures.push([
    'The built app carries no engine in Contents/Resources/engine.',
    'The app spawns the engine in a utilityProcess (record 55); without it every Thread fails to',
    'start, and nothing in the source tree would show it.',
  ].join('\n    '));
}

console.log(`Checking ${app}`);
for (const c of checked) console.log(`  · ${c}`);
console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length} packaging failure(s):\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log(`✓ ${checked.length} action(s) present in the built bundle.`);
