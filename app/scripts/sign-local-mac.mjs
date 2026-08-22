#!/usr/bin/env node

import path from 'node:path';
import { existsSync } from 'node:fs';
import { signAsync } from '@electron/osx-sign';

const appArgument = process.argv[2];
if (!appArgument) throw new Error('usage: node scripts/sign-local-mac.mjs /path/to/Bimax.app');
const app = path.resolve(appArgument);
if (!app.endsWith('.app') || !existsSync(app)) throw new Error(`not an app bundle: ${app}`);

// A local/self-signed identity has no Apple Team ID. Hardened runtime then refuses Electron's own
// framework at dyld time because the main process and mapped framework cannot prove a shared team.
// Ad-hoc signing is the honest local-development identity: sign nested code in dependency order,
// retain Electron's per-helper entitlements, and disable both hardened runtime and timestamping.
// Stable/release builds do not call this script; they require Developer ID + notarization.
await signAsync({
  app,
  identity: '-',
  identityValidation: false,
  platform: 'darwin',
  type: 'development',
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  strictVerify: true,
  optionsForFile: () => ({
    hardenedRuntime: false,
    timestamp: 'none',
    signatureFlags: [],
  }),
});

console.log(`local app signed without hardened runtime: ${app}`);
