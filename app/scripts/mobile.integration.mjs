import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { realpathSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Resolve the installed links, not a particular developer's home or a guessed sibling directory. */
export function mobileLink(root = appRoot) {
  const require = createRequire(path.join(root, 'package.json'));
  const responderPackage = realpathSync(require.resolve('desktop-responder/package.json'));
  const protocolPackage = realpathSync(require.resolve('@bimax/protocol/package.json'));
  const mobileRoot = path.resolve(path.dirname(responderPackage), '../..');
  if (process.env.BIMAX_MOBILE_REPO && realpathSync(process.env.BIMAX_MOBILE_REPO) !== mobileRoot)
    throw new Error(
      'BIMAX_MOBILE_REPO differs from the installed responder link. Relink app dependencies before building.',
    );
  if (protocolPackage !== path.join(mobileRoot, 'packages/protocol/package.json'))
    throw new Error('Desktop responder and protocol must come from the same mobile repository.');
  const responder = JSON.parse(readFileSync(responderPackage, 'utf8'));
  const protocol = JSON.parse(readFileSync(protocolPackage, 'utf8'));
  if (responder.dependencies['@bimax/protocol'] !== protocol.version)
    throw new Error('Desktop/mobile protocol package versions disagree.');
  return { mobileRoot, responderPackage, protocolPackage, protocolVersion: protocol.version };
}
export function prepareMobile(link = mobileLink()) {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('Use Node 24 for the coordinated desktop/mobile build (bimax-mobile/.nvmrc).');
  const compiler = path.join(link.mobileRoot, 'node_modules/typescript/bin/tsc');
  for (const project of ['packages/core', 'apps/relay', 'apps/desktop-responder']) {
    const result = spawnSync(process.execPath, [compiler, '-p', path.join(project, 'tsconfig.json')], {
      cwd: link.mobileRoot,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Mobile build failed: ${project}`);
  }
  const require = createRequire(link.responderPackage),
    responder = require('./dist/index.js');
  for (const key of ['Responder', 'ApprovalsGate', 'encryptedIdentityStore', 'createRelayAuthorizer']) {
    if (typeof responder[key] !== 'function')
      throw new Error(`Linked responder lacks ${key}; build and version must match.`);
  }
  const renderer = spawnSync(process.execPath, [path.join(appRoot, 'scripts/build-mobile-renderer.mjs')], { cwd: appRoot, stdio: 'inherit' });
  if (renderer.error) throw renderer.error;
  if (renderer.status !== 0) throw new Error('Shared phone renderer build failed');
  return link;
}
export function verifyMobile() {
  const link = prepareMobile();
  const directory = mkdtempSync(path.join(tmpdir(), 'bimax-mobile-link-'));
  try {
    const resultPath = path.join(directory, 'integration.json');
    const result = spawnSync(process.execPath, ['apps/desktop-responder/test/integration-test.mjs'], {
      cwd: link.mobileRoot,
      stdio: 'inherit',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
        BIMAX_INTEGRATION_REPORT: resultPath,
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Linked mobile integration suite failed.');
    const report = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (
      report.schemaVersion !== 1 ||
      report.protocolVersion !== 2 ||
      JSON.stringify(report.passedCases) !== JSON.stringify(Array.from({ length: 14 }, (_, i) => i + 1))
    )
      throw new Error('Missing or incompatible mobile integration end-state report.');
    return { ...link, integration: report };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(process.argv.includes('--prepare') ? prepareMobile() : verifyMobile(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
