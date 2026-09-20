#!/usr/bin/env node
// Is this built app actually releasable?
//
// A green build log is not evidence. electron-builder reports success for a bundle that Gatekeeper
// will refuse, because the things that make a release valid — every nested Mach-O signed with the
// same Team ID, hardened runtime, a STAPLED notarization ticket — are properties of the artifact,
// not of the build.
//
// This repository has shipped the artifact-was-never-checked failure three times
// (bimax-packaging-guard-is-dead, bimax-packaged-artifact-untested). So this inspects the bundle
// and asks the system, and it fails rather than skipping when it cannot.
//
//   node scripts/verify-release.mjs [--app /path/to/Bimax.app] [--allow-unsigned]
//
// --allow-unsigned downgrades the signature checks to warnings, for a deliberate local build. It
// never downgrades anything else, and it prints loudly, because a flag that quietly turns a gate
// off is the failure this file exists to prevent.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const allowUnsigned = argv.includes('--allow-unsigned');
const explicit = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : process.env.BIMAX_APP_PATH;

const appRoot = path.resolve(import.meta.dirname, '..');
const candidates = [explicit].filter(Boolean);
for (const dir of [process.env.BIMAX_RELEASE_DIR, path.join(appRoot, 'release'), '/tmp/bimax-release']) {
  if (!dir || !existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    const bundle = path.join(dir, entry, 'Bimax.app');
    if (existsSync(bundle)) candidates.push(bundle);
  }
}
candidates.push('/Applications/Bimax.app');

const app = candidates.find((c) => c && existsSync(path.join(c, 'Contents', 'Info.plist')));
if (!app) {
  console.error('✗ No built Bimax.app to verify.');
  console.error('  Looked in: ' + candidates.join(', '));
  process.exit(1);
}

const failures = [];
const warnings = [];
const passed = [];

const run = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

// ── 1. Every Mach-O is signed, with one Team ID ───────────────────────────────────────────────
//
// Notarization rejects the WHOLE app for one ad-hoc-signed helper, and names only that file after
// several minutes of upload. Checking here costs seconds. The Team ID has to be the SAME
// everywhere: a nested binary signed by a different team fails library validation under the
// hardened runtime at launch, not at build.
function machOFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // A nested bundle is signed as a unit; check the bundle, not each file inside it.
      if (/\.(app|appex|framework|xpc|bundle)$/.test(entry.name)) found.push(full);
      else machOFiles(full, found);
      continue;
    }
    if (!entry.isFile()) continue;
    const mode = statSync(full).mode;
    const executable = (mode & 0o111) !== 0;
    const nodeAddon = full.endsWith('.node') || full.endsWith('.dylib') || full.endsWith('.so');
    if (!executable && !nodeAddon) continue;
    if (run('file', ['-b', full]).out.includes('Mach-O')) found.push(full);
  }
  return found;
}

const binaries = machOFiles(app);
const teams = new Map();
// Three DIFFERENT states, and conflating them hides which one you are in
// (bimax-error-must-name-real-cause):
//   adhoc    — codesign ran with no identity at all
//   noTeam   — signed by a real identity that has no Team ID, i.e. a self-signed certificate
//   teamed   — signed by a Developer ID
const adhocFiles = [];
const noTeamFiles = [];
for (const file of binaries) {
  const { out } = run('codesign', ['-dv', '--verbose=2', file]);
  const team = out.match(/TeamIdentifier=(\S+)/)?.[1];
  if (/Signature=adhoc/.test(out)) adhocFiles.push(path.relative(app, file));
  else if (!team || team === 'not') noTeamFiles.push(path.relative(app, file));
  else teams.set(team, (teams.get(team) ?? 0) + 1);
}

const list = (files) => [
  ...files.slice(0, 6).map((f) => `  · ${f}`),
  files.length > 6 ? `  · …and ${files.length - 6} more` : '',
].filter(Boolean);

if (adhocFiles.length) {
  (allowUnsigned ? warnings : failures).push([
    `${adhocFiles.length} of ${binaries.length} Mach-O files are AD-HOC signed — no identity at all.`,
    'Notarization rejects the entire app for ONE of these, minutes into the upload, naming only it.',
    ...list(adhocFiles),
  ].join('\n    '));
}
if (noTeamFiles.length) {
  (allowUnsigned ? warnings : failures).push([
    `${noTeamFiles.length} of ${binaries.length} Mach-O files are signed by an identity with NO TEAM ID.`,
    'That is what a self-signed certificate produces. The signature is real and verifies locally;',
    'it just cannot be notarized, and macOS will not register an App Intents extension from it.',
    ...list(noTeamFiles),
  ].join('\n    '));
}
if (!adhocFiles.length && !noTeamFiles.length) {
  passed.push(`all ${binaries.length} Mach-O files signed with a Team ID`);
}

if (teams.size > 1) {
  failures.push([
    `The bundle carries ${teams.size} different Team IDs: ${[...teams.keys()].join(', ')}.`,
    'Under the hardened runtime a library whose Team ID differs from the process refuses to load,',
    'and the app dies in dyld before any of its own code runs (bimax-hardened-runtime-blocks-launch).',
  ].join('\n    '));
} else if (teams.size === 1) {
  passed.push(`one Team ID across the bundle: ${[...teams.keys()][0]}`);
}

// ── 2. Hardened runtime ───────────────────────────────────────────────────────────────────────
// Required for notarization. Also the thing that, with a SELF-SIGNED cert, ships an app dyld will
// not load — so this is reported as a fact rather than assumed good either way.
const appSig = run('codesign', ['-dv', '--verbose=2', app]).out;
const hardened = /flags=.*runtime/.test(appSig);
if (hardened) passed.push('hardened runtime enabled');
else (allowUnsigned ? warnings : failures).push(
  'Hardened runtime is OFF. Notarization will refuse the upload.\n    '
  + 'A local build turns it off deliberately, because it cannot load under a self-signed cert.');

// ── 3. Signature validity ─────────────────────────────────────────────────────────────────────
const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
if (verify.ok) passed.push('signature verifies (deep, strict)');
else failures.push(`codesign --verify --deep --strict failed:\n    ${verify.out.trim().split('\n').slice(0, 4).join('\n    ')}`);

// ── 4. Notarization ticket, STAPLED ───────────────────────────────────────────────────────────
// Stapling is what makes the app open on a Mac that is offline the first time it runs. Without it
// the app works on the build machine and fails on someone else's, which is the worst shape.
const staple = run('xcrun', ['stapler', 'validate', app]);
if (staple.ok) passed.push('notarization ticket stapled');
else if (allowUnsigned) warnings.push('No stapled notarization ticket (expected for a local build).');
else failures.push([
  'No stapled notarization ticket.',
  'The app will open on this Mac and fail on one that is offline at first launch.',
  `stapler said: ${staple.out.trim().split('\n').pop()}`,
].join('\n    '));

// ── 5. Gatekeeper's own verdict ───────────────────────────────────────────────────────────────
// The system's answer, not ours. Note bimax-dmg-second-mac: spctl rejects a downloaded artifact
// purely for the quarantine xattr, so a rejection here is read, not assumed fatal.
const spctl = run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
if (spctl.ok) passed.push('Gatekeeper accepts it');
else if (allowUnsigned) warnings.push('Gatekeeper rejects it (expected for a local build).');
else failures.push([
  'Gatekeeper rejects this app.',
  `spctl said: ${spctl.out.trim().split('\n').slice(0, 2).join(' / ')}`,
  'If this is a copy that was downloaded, strip the quarantine attribute first:',
  '  xattr -d com.apple.quarantine /path/to/Bimax.app',
].join('\n    '));

// ── 6. The App Intents extension is present and signed as a unit ──────────────────────────────
const extensions = path.join(app, 'Contents', 'Extensions');
const appex = existsSync(extensions) ? readdirSync(extensions).filter((e) => e.endsWith('.appex')) : [];
if (!appex.length) {
  warnings.push('No App Intents extension in Contents/Extensions — Siri and Shortcuts will show nothing.');
} else {
  for (const ext of appex) {
    const sig = run('codesign', ['-dv', '--verbose=2', path.join(extensions, ext)]).out;
    const team = sig.match(/TeamIdentifier=(\S+)/)?.[1];
    if (!team || team === 'not') {
      (allowUnsigned ? warnings : failures).push([
        `${ext} has no Team ID.`,
        'macOS will not register an App Intents extension without one — measured 2026-09-20 — so',
        'Siri, the Shortcuts action library and Spotlight indexing all stay dark, with no error.',
      ].join('\n    '));
    } else {
      passed.push(`${ext} signed (team ${team})`);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────
console.log(`Verifying ${app}\n`);
for (const p of passed) console.log(`  ✓ ${p}`);
for (const w of warnings) console.log(`  ! ${w}`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} release blocker(s):\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
if (allowUnsigned && warnings.length) {
  console.log(`\n! Structurally sound, but NOT releasable: --allow-unsigned downgraded ${warnings.length} check(s).`);
  console.log('  This build cannot be notarized and its App Intents will not register.');
} else {
  console.log(`\n✓ Releasable.${warnings.length ? ` ${warnings.length} warning(s) above.` : ''}`);
}
