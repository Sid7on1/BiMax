import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyArcSource(root, manifest) {
  if (manifest.commit !== '74ffae1108b1cb4b1f6b161084af12646f544ba5' || manifest.license !== 'MIT' || manifest.files?.length !== 100) {
    throw new Error('Arc source provenance does not match the pinned complete MIT snapshot');
  }
  const actual = [];
  const visit = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
      const relative = prefix + name, full = path.join(dir, name), stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Arc source contains a symlink: ${relative}`);
      if (stat.isDirectory()) visit(full, relative + '/');
      else if (stat.isFile()) actual.push(relative);
      else throw new Error(`Arc source is not regular: ${relative}`);
    }
  };
  visit(root);
  const expected = manifest.files.map(file => file.path).sort();
  if (new Set(expected).size !== 100 || JSON.stringify(actual.sort()) !== JSON.stringify(expected)) {
    throw new Error('Arc source file inventory is incomplete or contains extra files');
  }
  for (const file of manifest.files) {
    const full = path.join(root, file.path);
    if (createHash('sha256').update(readFileSync(full)).digest('hex') !== file.sha256) throw new Error(`Arc source bytes differ: ${file.path}`);
    if ((lstatSync(full).mode & 0o111) !== (parseInt(file.mode, 8) & 0o111)) throw new Error(`Arc executable mode differs: ${file.path}`);
  }
  const modules = manifest.files.filter(file => file.path.startsWith('src/arc_cua/') && file.path.endsWith('.py'))
    .map(file => file.path.slice(4, -3).replaceAll('/', '.').replace(/\.__init__$/, '')).sort();
  return { files: expected.length, modules, commit: manifest.commit, license: manifest.license };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = verifyArcSource(process.argv[2], JSON.parse(readFileSync(process.argv[3], 'utf8')));
  console.log(`Bimax CU source gate: PASS ${result.files} exact upstream files, ${result.modules.length} package modules`);
}
