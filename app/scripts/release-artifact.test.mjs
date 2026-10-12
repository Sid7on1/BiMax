import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveReleaseArtifact } from './release-artifact.mjs';

test('release checks select the exact artifact and refuse stale substitutes', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bimax-release-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = name => {
    const app = path.join(root, name, 'Bimax.app');
    mkdirSync(path.join(app, 'Contents'), { recursive: true });
    writeFileSync(path.join(app, 'Contents', 'Info.plist'), 'fixture');
    return app;
  };
  const installedApp = bundle('installed');
  const appRoot = path.join(root, 'app');
  const options = { appRoot, installedApp, env: {} };
  const missing = path.join(root, 'missing.app');
  assert.throws(() => resolveReleaseArtifact({ ...options, argv: ['--app', missing] }), /Requested.*missing/);
  assert.throws(() => resolveReleaseArtifact({ ...options, env: { BIMAX_APP_PATH: missing } }), /Requested.*missing/);
  assert.throws(() => resolveReleaseArtifact({ ...options, argv: ['--app'] }), /requires a bundle path/);
  assert.throws(() => resolveReleaseArtifact({ ...options, argv: ['--app', '--allow-unsigned'] }), /requires a bundle path/);
  assert.throws(() => resolveReleaseArtifact({ ...options, env: { BIMAX_RELEASE_DIR: path.join(root, 'empty') } }), /No built/);
  const arm = bundle('app/release/mac-arm64');
  assert.equal(resolveReleaseArtifact(options), arm);
  bundle('app/release/mac');
  assert.throws(() => resolveReleaseArtifact(options), /Several built/);
  assert.equal(resolveReleaseArtifact({ ...options, argv: ['--app', arm] }), arm);
});

for (const script of ['check-app-actions.mjs', 'verify-release.mjs']) {
  test(`${script} fails before checking another app when --app is invalid`, () => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, script), '--app', '/no-such-bimax-artifact/Bimax.app'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Requested Bimax.app is missing/);
    assert.doesNotMatch(result.stdout, /Checking |Verifying |Releasable|action\(s\) present/);
  });
}
