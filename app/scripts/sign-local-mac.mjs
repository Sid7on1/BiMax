#!/usr/bin/env node

import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { signAsync } from '@electron/osx-sign';

const appArgument = process.argv[2];
if (!appArgument) throw new Error('usage: node scripts/sign-local-mac.mjs /path/to/Bimax.app');
const app = path.resolve(appArgument);
if (!app.endsWith('.app') || !existsSync(app)) throw new Error(`not an app bundle: ${app}`);

const DEFAULT_LOCAL_IDENTITY = 'Bimax Local Code Signing';

function availableSigningIdentities() {
  try {
    return execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8', timeout: 5_000,
    });
  } catch (error) {
    return String(error?.stdout || '');
  }
}

const requestedIdentity = process.env.BIMAX_LOCAL_SIGNING_IDENTITY?.trim();
const identities = availableSigningIdentities();
if (requestedIdentity && !identities.includes(`\"${requestedIdentity}\"`)) {
  throw new Error(`requested local signing identity was not found: ${requestedIdentity}`);
}
const identity = requestedIdentity
  || (identities.includes(`\"${DEFAULT_LOCAL_IDENTITY}\"`) ? DEFAULT_LOCAL_IDENTITY : '-');

function codesignFacts(args) {
  const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `codesign exited ${result.status}`));
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

// A stable local certificate gives successive development builds the same designated requirement,
// so macOS can associate Accessibility and Screen Recording with the current Bimax host. This is
// still a manual-alpha identity: it is neither Developer ID nor notarized and must never be called
// a release signature. Hardened runtime remains disabled because a local certificate has no Apple
// Team ID and Electron's mapped frameworks otherwise fail library validation at launch.
//
// The XPC Computer Use service deliberately stays ad-hoc. Its existing manual-alpha trust gate is
// an exact Code Directory hash approval; signing it with a local certificate would incorrectly
// collapse that distinct service boundary into a generic non-ad-hoc signature. The staged service
// is already ad-hoc sealed, so osx-sign skips that bundle while signing the containing host.
const manualAlphaService = `${path.sep}Contents${path.sep}XPCServices${path.sep}BimaxCuService.xpc`;
const manualAlphaServiceBundle = path.join(app, 'Contents', 'XPCServices', 'BimaxCuService.xpc');
if (identity !== '-') {
  // electron-builder copies the staged XPC bundle after its resources have changed, so its staged
  // seal is not necessarily valid in the packaged location. The former all-ad-hoc sign pass
  // repaired that incidentally. Make the ownership explicit before the host's certificate pass.
  execFileSync('/usr/bin/codesign', [
    '--force', '--deep', '--sign', '-', '--timestamp=none', manualAlphaServiceBundle,
  ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
await signAsync({
  app,
  identity,
  // osx-sign's validator intentionally filters for Apple-issued identities on the `darwin`
  // platform. Local manual-alpha signing uses a non-Apple certificate, so validate its exact
  // keychain name above and let codesign plus the post-sign requirement checks validate the result.
  identityValidation: false,
  platform: 'darwin',
  type: 'development',
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  strictVerify: true,
  ...(identity !== '-' ? { ignore: (file) => file.includes(manualAlphaService) } : {}),
  optionsForFile: () => ({
    hardenedRuntime: false,
    timestamp: 'none',
    signatureFlags: [],
  }),
});

if (identity === '-') {
  console.warn(
    `warning: ${DEFAULT_LOCAL_IDENTITY} was not found; this ad-hoc build will need fresh macOS `
    + 'permission grants after every rebuild',
  );
} else {
  const requirement = codesignFacts(['--display', '--requirements', '-', app]);
  if (/designated\s*=>\s*cdhash/i.test(requirement)) {
    throw new Error('stable local signing produced a cdhash-only designated requirement');
  }
  const serviceFacts = codesignFacts(['--display', '--verbose=4', manualAlphaServiceBundle]);
  if (!/^Signature=adhoc$/m.test(serviceFacts) && !/flags=.*adhoc/i.test(serviceFacts)) {
    throw new Error('manual-alpha Computer Use service did not retain its ad-hoc seal');
  }
}

console.log(
  `local app signed without hardened runtime (${identity === '-' ? 'ad-hoc' : identity}): ${app}`,
);
