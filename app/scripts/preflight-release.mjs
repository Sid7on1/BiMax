#!/usr/bin/env node
// Can this machine cut a signed, notarized release right now?
//
// Run BEFORE `dist:mac`. Every check here is something that otherwise surfaces minutes into a
// build, or — worse — minutes into a notarization upload that then fails and names one file.
//
// NO SECRET IS EVER PRINTED. Credentials are checked for presence and shape only: this output is
// meant to be safe to paste into an issue or read over someone's shoulder.
//
//   node scripts/preflight-release.mjs

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const ok = [];
const blockers = [];
const notes = [];

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};

// ── 1. The Developer ID certificate ───────────────────────────────────────────────────────────
const identities = run('security', ['find-identity', '-v', '-p', 'codesigning']);
const developerIds = [...identities.matchAll(/"(Developer ID Application: [^"]+)"/g)].map((m) => m[1]);
const teamIds = [...new Set(developerIds.map((n) => n.match(/\(([A-Z0-9]{10})\)$/)?.[1]).filter(Boolean))];

if (!developerIds.length) {
  const selfSigned = /Bimax Local Code Signing/.test(identities);
  blockers.push([
    'No "Developer ID Application" certificate in the keychain.',
    selfSigned
      ? 'Only the self-signed "Bimax Local Code Signing" identity is present. That one builds a'
      : 'No signing identity is present at all. A Developer ID',
    selfSigned
      ? 'runnable local app and CANNOT notarize — and macOS will not register the App Intents'
      : 'certificate is required to notarize, and macOS will not register the App Intents',
    'extension without a Team ID, so Siri and Shortcuts stay dark with no error shown.',
    'See docs/DEVELOPER_ID_RELEASE.md, steps 1 and 2.',
  ].join('\n    '));
} else if (teamIds.length > 1) {
  blockers.push(`Several Developer ID certificates with different Team IDs: ${teamIds.join(', ')}.\n    `
    + 'Set CSC_NAME to the one you mean, or the build picks one arbitrarily.');
} else {
  ok.push(`Developer ID certificate present (team ${teamIds[0]})`);
}

// ── 2. Notarization credentials — presence and SHAPE only ─────────────────────────────────────
const env = process.env;
const apiKeyRoute = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
const appleIdRoute = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
const keychainRoute = env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE;

if (apiKeyRoute) {
  // APPLE_API_KEY is a PATH. Pointing it at a missing file fails after the upload starts.
  const keyPath = env.APPLE_API_KEY.replace(/^~(?=\/|$)/, env.HOME ?? '~');
  if (!existsSync(keyPath)) {
    blockers.push(`APPLE_API_KEY points at a file that does not exist: ${keyPath}\n    `
      + 'It is a path to the .p8, not the key itself.');
  } else {
    const mode = statSync(keyPath).mode & 0o777;
    ok.push('Notarization: App Store Connect API key (the recommended route)');
    if (mode & 0o077) {
      notes.push(`The API key is readable by others (mode ${mode.toString(8)}). chmod 600 it.`);
    }
    if (!/^[A-Z0-9]{10}$/.test(env.APPLE_API_KEY_ID)) {
      notes.push('APPLE_API_KEY_ID does not look like a 10-character key id.');
    }
  }
} else if (appleIdRoute) {
  ok.push('Notarization: Apple ID + app-specific password');
  notes.push([
    'The API key route is preferred: it is a file path rather than a password in the environment.',
    'See docs/DEVELOPER_ID_RELEASE.md, step 3.',
  ].join('\n    '));
  if (!/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/i.test(env.APPLE_APP_SPECIFIC_PASSWORD)) {
    notes.push('APPLE_APP_SPECIFIC_PASSWORD is not in the xxxx-xxxx-xxxx-xxxx shape Apple issues.');
  }
  if (teamIds.length && env.APPLE_TEAM_ID !== teamIds[0]) {
    blockers.push(`APPLE_TEAM_ID (${env.APPLE_TEAM_ID}) does not match the certificate's team (${teamIds[0]}).`);
  }
} else if (keychainRoute) {
  ok.push('Notarization: stored keychain profile');
} else {
  blockers.push([
    'No notarization credentials in the environment.',
    'Set one of these (see docs/DEVELOPER_ID_RELEASE.md, step 3):',
    '  APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER        ← recommended, a file path',
    '  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID',
    '  APPLE_KEYCHAIN + APPLE_KEYCHAIN_PROFILE',
  ].join('\n    '));
}

// ── 3. Auto-discovery must be on, or the build silently ships unsigned ────────────────────────
if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' && !env.CSC_LINK) {
  blockers.push('CSC_IDENTITY_AUTO_DISCOVERY=false and no CSC_LINK — electron-builder will skip signing entirely.');
} else {
  ok.push('Signing identity will be discovered from the keychain');
}

// ── 4. Config shape ───────────────────────────────────────────────────────────────────────────
const config = readFileSync(path.join(appRoot, 'electron-builder.yml'), 'utf8');

if (!/^\s*hardenedRuntime:\s*true/m.test(config)) {
  blockers.push('hardenedRuntime is not true in electron-builder.yml. Notarization refuses the upload without it.');
} else {
  ok.push('hardened runtime declared');
}

// electron-builder 26 takes `notarize` as a BOOLEAN. The v24 object shape
// (`notarize: { teamId: ... }`) is silently wrong here, which is the kind of thing that looks
// configured and does nothing.
const notarizeLine = config.match(/^\s*notarize:\s*(.+)$/m)?.[1]?.trim();
if (notarizeLine && !/^(true|false)$/.test(notarizeLine)) {
  blockers.push([
    `electron-builder ${electronBuilderVersion()} expects \`notarize\` to be a boolean; found: ${notarizeLine}`,
    'The `notarize: { teamId: ... }` object is the v24 shape. Credentials come from the environment now.',
  ].join('\n    '));
} else if (notarizeLine === 'false') {
  notes.push('notarize is explicitly false — this build will be signed but NOT notarized.');
} else {
  ok.push('notarize configuration is valid for this electron-builder');
}

const entitlements = path.join(appRoot, 'buildResources', 'entitlements.mac.plist');
if (!existsSync(entitlements)) blockers.push(`Missing entitlements file: ${entitlements}`);
else ok.push('release entitlements present');

// ── 5. The loose binaries that fail notarization ──────────────────────────────────────────────
// Anything shipped as a plain file rather than inside a bundle is signed as a RESOURCE unless
// something signs it explicitly. One ad-hoc-signed helper fails the whole notarization, and the
// error arrives minutes into the upload naming only that file.
const looseSources = [
  { path: path.join(appRoot, 'voice', 'bimax-voice'), what: 'the dictation helper', build: 'scripts/build-voice.sh' },
];
for (const { path: file, what, build } of looseSources) {
  if (!existsSync(file)) {
    notes.push(`${what} is not built yet (${build} runs as part of dist:mac).`);
    continue;
  }
  const sig = run('codesign', ['-dv', '--verbose=2', file]);
  if (/Signature=adhoc/.test(sig) || !/TeamIdentifier=(?!not)/.test(sig)) {
    notes.push([
      `${what} is currently ad-hoc signed (${path.relative(appRoot, file)}).`,
      'It must carry the Team ID in the packaged app or notarization rejects the whole bundle.',
      'verify:release checks the PACKAGED copy, which is the one that matters — run it after building.',
    ].join('\n    '));
  }
}

// ── 6. Output directory must not be inside an iCloud-synced tree ──────────────────────────────
// after-pack.cjs already refuses this, but finding out here costs seconds instead of a full pack.
const out = env.BIMAX_RELEASE_DIR || path.join(appRoot, 'release');
const synced = run('xattr', [path.dirname(out)]).split('\n').some((l) => l.startsWith('com.apple.fileprovider.'));
if (synced) {
  blockers.push([
    `The output directory is inside an iCloud-synced tree: ${out}`,
    'The sync daemon re-stamps extended attributes during the signing walk, so codesign fails on a',
    'nested helper and no amount of clearing beforehand holds. Set BIMAX_RELEASE_DIR elsewhere.',
  ].join('\n    '));
} else {
  ok.push('output directory is outside any synced tree');
}

function electronBuilderVersion() {
  try {
    return JSON.parse(readFileSync(path.join(appRoot, 'node_modules', 'electron-builder', 'package.json'), 'utf8')).version;
  } catch { return 'installed'; }
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────
console.log('Release preflight\n');
for (const o of ok) console.log(`  ✓ ${o}`);
for (const n of notes) console.log(`  ! ${n}`);
if (blockers.length) {
  console.error(`\n✗ ${blockers.length} blocker(s) — fix these before dist:mac:\n`);
  for (const b of blockers) console.error(`  - ${b}\n`);
  process.exit(1);
}
console.log(`\n✓ Ready to build a signed release.${notes.length ? ` ${notes.length} note(s) above.` : ''}`);
