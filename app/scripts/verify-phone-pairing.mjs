import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareMobile } from './mobile.integration.mjs';
const require = createRequire(import.meta.url),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  link = prepareMobile();
const output = path.join(root, 'out/mobile-fixture');
mkdirSync(output, { recursive: true });
const css = readdirSync(path.join(root, 'out/renderer/assets')).find(
  (name) => name.startsWith('index-') && name.endsWith('.css'),
);
if (!css) throw Error('Build Desktop before running the phone fixture.');
await build({
  entryPoints: [path.join(root, 'scripts/fixtures/phone-settings.tsx')],
  outfile: path.join(output, 'renderer.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
writeFileSync(
  path.join(output, 'index.html'),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'out/renderer/assets', css)).href}"><div id="root"></div><script src="renderer.js"></script>`,
);
const scratch = mkdtempSync(path.join(tmpdir(), 'bimax-phone-native-'));
symlinkSync(path.join(link.mobileRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
try {
  await build({
    entryPoints: [path.join(root, 'scripts/fixtures/phone-pairing.ts')],
    outfile: path.join(scratch, 'phone-pairing.fixture.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    alias: { 'mobile-phone-client': path.join(link.mobileRoot, 'apps/mobile/lib/relay/client.ts') },
  });
  const decoder = path.join(output, 'qr-decode');
  const compile = spawnSync('xcrun', ['swiftc', path.join(root, 'scripts/fixtures/qr-decode.swift'), '-o', decoder], {
    env: { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || '/Library/Developer/CommandLineTools' },
    stdio: 'inherit',
    timeout: 60000,
  });
  if (compile.error || compile.status !== 0) throw Error('QR decoder could not compile');
  const run = spawnSync(require('electron'), [path.join(scratch, 'phone-pairing.fixture.cjs')], {
    env: { ...process.env, BIMAX_QR_DECODER: decoder, BIMAX_PHONE_APP_ROOT: root },
    stdio: 'inherit',
    timeout: 60000,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw Error('Phone Settings pairing fixture failed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
