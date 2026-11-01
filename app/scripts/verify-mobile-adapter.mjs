import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileLink, prepareMobile } from './mobile.integration.mjs';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const link = prepareMobile(mobileLink());
const directory = mkdtempSync(path.join(tmpdir(), 'bimax-mobile-adapter-'));
try {
  symlinkSync(path.join(link.mobileRoot, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  await build({
    entryPoints: [path.join(app, 'scripts/fixtures/mobile-adapter.ts')],
    outfile: path.join(directory, 'fixture.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    alias: { 'mobile-phone-approvals': path.join(link.mobileRoot, 'apps/mobile/lib/approvals/approvals.ts') },
  });
  const result = spawnSync(process.execPath, [path.join(directory, 'fixture.cjs')], {
    stdio: 'inherit',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Real mobile/Desktop adapter contract failed');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
