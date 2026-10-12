import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Select exactly the requested bundle. Discovery must never hide a bad explicit path. */
export function resolveReleaseArtifact({ argv = [], env = process.env, appRoot, installedApp = '/Applications/Bimax.app' }) {
  const appFlag = argv.indexOf('--app');
  if (appFlag >= 0 && (!argv[appFlag + 1] || argv[appFlag + 1].startsWith('--'))) {
    throw new Error('--app requires a bundle path.');
  }
  const explicit = appFlag >= 0 ? argv[appFlag + 1] : env.BIMAX_APP_PATH;
  const isBundle = file => existsSync(path.join(file, 'Contents', 'Info.plist'));
  if (explicit) {
    const app = path.resolve(explicit);
    if (!isBundle(app)) throw new Error(`Requested Bimax.app is missing Contents/Info.plist: ${app}`);
    return app;
  }
  // An explicit output directory likewise scopes discovery to that build output.
  const dirs = env.BIMAX_RELEASE_DIR
    ? [path.resolve(env.BIMAX_RELEASE_DIR)]
    : [path.join(appRoot, 'release'), '/tmp/bimax-release'];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const candidates = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(dir, entry.name, 'Bimax.app')).filter(isBundle);
    if (candidates.length > 1) throw new Error(`Several built Bimax.app bundles in ${dir}; pass --app for the exact architecture.`);
    if (candidates.length === 1) return candidates[0];
  }
  if (!env.BIMAX_RELEASE_DIR && isBundle(installedApp)) return installedApp;
  throw new Error(`No built Bimax.app found in ${dirs.join(', ')}. Build first or pass --app.`);
}
