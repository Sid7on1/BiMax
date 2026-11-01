import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArcSource } from './computer-source.mjs';
import { spawnSync } from 'node:child_process';
const vendor = fileURLToPath(new URL('../native/computer/vendor/arc-cua', import.meta.url));
const manifest = JSON.parse(readFileSync(vendor + '.BIMAX_IMPORT.json', 'utf8'));

test('the full owned source snapshot includes every module, optional decision layer and adapter', () => {
  const actual = verifyArcSource(vendor, manifest);
  assert.equal(actual.files, 100); assert.equal(actual.modules.length, 34);
  for (const module of ['arc_cua.mcp_server', 'arc_cua.cli', 'arc_cua.runtime', 'arc_cua.backends.chrome', 'arc_cua.policies.typesafe']) assert(actual.modules.includes(module));
});
test('every reviewed source file and its provenance are trackable in Git', () => {
  const paths = [...manifest.files.map(file => path.join(vendor, file.path)), vendor + '.BIMAX_IMPORT.json'];
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { input: paths.join('\n') + '\n', encoding: 'utf8', cwd: vendor });
  assert.equal(result.status, 1, result.stdout || result.stderr); assert.equal(result.stdout, '');
});
for (const fault of ['missing', 'changed', 'extra', 'symlink', 'wrong-pin']) {
  test(`complete-source gate catches ${fault} snapshot`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bimax-cu-source-')); const target = path.join(dir, 'source');
    try {
      cpSync(vendor, target, { recursive: true });
      const file = path.join(target, 'src/arc_cua/driver.py');
      if (fault === 'missing') unlinkSync(file);
      if (fault === 'changed') writeFileSync(file, '# neutered driver');
      if (fault === 'extra') writeFileSync(path.join(target, 'unexpected.py'), '# extra');
      if (fault === 'symlink') { unlinkSync(file); symlinkSync(path.join(vendor, 'src/arc_cua/driver.py'), file); }
      assert.throws(() => verifyArcSource(target, fault === 'wrong-pin' ? { ...manifest, commit: 'wrong' } : manifest));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
