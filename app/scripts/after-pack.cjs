'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Strip extended attributes from the packed app before it is signed.
 *
 * `codesign` refuses any file carrying a resource fork or Finder info:
 *
 *   Bimax Helper (GPU): resource fork, Finder information, or similar detritus not allowed
 *
 * On this project that is not a stray file someone touched in Finder — the repository lives under
 * an iCloud-synced Desktop, so the sync client stamps `com.apple.fileprovider.fpfs#P` and
 * `com.apple.FinderInfo` onto files as they are written. Every helper unpacked from the Electron zip
 * inherits them, which makes the failure reproducible on this machine and invisible on CI.
 *
 * Clearing them is safe: none of these attributes carry app content, and the signature that matters
 * is applied immediately after this hook. Doing it here rather than by hand means the fix survives
 * the next build instead of being re-discovered.
 */
/**
 * Whether a path sits inside a tree the iCloud file provider manages.
 *
 * The marker is an xattr in the `com.apple.fileprovider.*` family on the directory itself. It is
 * checked on the OUTPUT directory rather than the repository, because only the output matters: the
 * sources can live anywhere, but the packed app is what codesign walks.
 */
function isFileProviderManaged(directory) {
  try {
    const attributes = execFileSync('xattr', [directory], { encoding: 'utf8' });
    return attributes.split('\n').some(line => line.startsWith('com.apple.fileprovider.'));
  } catch {
    return false;
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('xattr', ['-cr', bundle], { stdio: 'inherit' });
  console.log(`  • cleared extended attributes  bundle=${bundle}`);

  // Clearing is necessary but NOT sufficient inside a synced tree. electron-builder signs the
  // nested helpers after this hook returns, and the sync daemon re-stamps files while that walk is
  // in progress — so the clear wins the first race and loses a later one, failing on whichever
  // helper it happened to re-touch:
  //
  //   Bimax Helper (GPU): resource fork, Finder information, or similar detritus not allowed
  //
  // That is not fixable from here at any retry count: the writer is another process and there is no
  // window this hook controls. Fail now, with the remedy, rather than after several minutes of
  // packaging and signing — and refuse rather than warn, because the alternative is an error that
  // names a GPU helper and gives no hint that iCloud is the cause.
  if (isFileProviderManaged(context.appOutDir)) {
    throw new Error(
      `the output directory is inside an iCloud-synced tree (${context.appOutDir}).\n` +
      '  codesign will fail on a nested helper: the sync daemon re-stamps extended attributes\n' +
      '  during the signing walk, so clearing them beforehand cannot hold.\n' +
      '  Build outside the synced tree instead:\n' +
      '    npm run dist:mac:local\n' +
      '  or pass your own location:\n' +
      '    npx electron-builder --mac --arm64 -c.directories.output=/tmp/bimax-release'
    );
  }

  // Compile the app icon into an asset catalog and declare CFBundleIconName.
  //
  // This has to happen HERE — after packing, before electron-builder signs — because Assets.car and
  // Info.plist are both signed resources: adding them afterwards invalidates the signature, and
  // electron-builder has no hook of its own for "an extra resource, compiled by Xcode".
  //
  // Not fatal if it fails. Without the catalog the app still ships its `.icns` and renders with the
  // legacy icon treatment, which is exactly where it was before this existed — so a machine without
  // Xcode (actool lives inside it) should produce a slightly worse icon, not no build at all.
  try {
    const { installAppIcon } = await import('./make-app-icon-assets.mjs');
    installAppIcon(bundle);
  } catch (error) {
    console.warn(`  • app icon catalog SKIPPED (${error.message}) — shipping the legacy .icns only`);
  }
};
