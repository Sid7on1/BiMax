// Compile the app icon into an asset catalog (Assets.car) and declare CFBundleIconName.
//
// WHY THIS EXISTS. macOS 26 renders app icons from a compiled catalog, and 27 ("Golden Gate") adds
// further glass layers to them. An app that ships only a flat `.icns` opts out: it renders with the
// legacy treatment while every icon beside it in the Dock gets the current one. Measured against
// the two reference apps, both Electron:
//
//            CFBundleIconName   Assets.car
//   Claude   Claude             1.81 MB     (layered: IconGroup + IconImageStack + gradients)
//   Codex    Icon               3.18 MB
//   Bimax    (none)             (none)
//
// So it is achievable in Electron — neither of them is a native app — and we were the only one not
// doing it.
//
// TWO SOURCES, IN ORDER OF PREFERENCE.
//
//   1. `buildResources/Bimax.icon` — an Icon Composer document. This is what Claude ships and it is
//      the only way to get a genuinely LAYERED icon: separate art layers the system parallaxes,
//      tints and glazes per appearance. Icon Composer is a GUI app (inside Xcode), and its
//      `icon.json` schema is not documented or sampled anywhere on disk, so this script does not
//      try to synthesise one — authoring it by hand would mean inventing a format and shipping
//      something that compiles and lies. Drop the file in and this picks it up automatically.
//
//   2. `buildResources/icon.png` — the flat 1024² brand icon, expanded into an `AppIcon.appiconset`.
//      This is the fallback used today. It gets the catalog and the Info.plist key (so the app is
//      no longer opted out, and the modern container is in place), but the art is a single flat
//      layer: it cannot parallax or re-tint the way a layered icon does.
//
// Run standalone for testing:  node scripts/make-app-icon-assets.mjs /path/to/Bimax.app
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_RESOURCES = path.join(APP_DIR, 'buildResources');
const ICON_NAME = 'AppIcon';
const MIN_MACOS = '13.0';

/** Every rendition macOS wants for a Mac app icon, as (points, scale). */
const RENDITIONS = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];

function buildAppIconSet(workDir) {
  const source = path.join(BUILD_RESOURCES, 'icon.png');
  if (!existsSync(source)) throw new Error(`no icon source at ${source}`);
  const set = path.join(workDir, 'Bimax.xcassets', `${ICON_NAME}.appiconset`);
  mkdirSync(set, { recursive: true });

  const images = RENDITIONS.map(([points, scale]) => {
    const px = points * scale;
    // A distinct file per rendition. Sharing one file between two entries (32@1x and 16@2x are the
    // same pixels) makes actool warn about duplicate references for no saving worth having.
    const filename = `icon_${points}x${points}@${scale}x.png`;
    execFileSync('sips', ['-z', String(px), String(px), source, '--out', path.join(set, filename)], { stdio: 'ignore' });
    return { idiom: 'mac', size: `${points}x${points}`, scale: `${scale}x`, filename };
  });

  writeFileSync(
    path.join(set, 'Contents.json'),
    `${JSON.stringify({ images, info: { version: 1, author: 'bimax' } }, null, 2)}\n`,
  );
  return path.join(workDir, 'Bimax.xcassets');
}

/** Compile whichever source exists, and return { carPath, iconName }. */
function compile(workDir) {
  const composer = path.join(BUILD_RESOURCES, 'Bimax.icon');
  const out = path.join(workDir, 'out');
  mkdirSync(out, { recursive: true });
  const partialPlist = path.join(workDir, 'partial.plist');

  let inputs;
  let appIcon;
  if (existsSync(composer)) {
    // Icon Composer documents are passed to actool directly, like a catalog.
    inputs = [composer];
    appIcon = path.basename(composer, '.icon');
    console.log(`  • app icon source: ${path.basename(composer)} (Icon Composer, layered)`);
  } else {
    inputs = [buildAppIconSet(workDir)];
    appIcon = ICON_NAME;
    console.log('  • app icon source: icon.png → AppIcon.appiconset (flat; see this script\'s header)');
  }

  execFileSync('xcrun', [
    'actool',
    '--output-format', 'human-readable-text',
    '--notices', '--warnings', '--errors',
    '--app-icon', appIcon,
    '--output-partial-info-plist', partialPlist,
    '--platform', 'macosx',
    '--target-device', 'mac',
    '--minimum-deployment-target', MIN_MACOS,
    '--compile', out,
    ...inputs,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });

  const car = path.join(out, 'Assets.car');
  if (!existsSync(car)) throw new Error('actool produced no Assets.car');

  // actool reports the key it wants set rather than us assuming the name survived compilation.
  const plist = readFileSync(partialPlist, 'utf8');
  const declared = /<key>CFBundleIconName<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  if (!declared) throw new Error('actool did not declare CFBundleIconName; the icon was not compiled as an app icon');
  return { car, iconName: declared[1] };
}

/** Install into a packed .app. Must run BEFORE signing — these are signed resources. */
export function installAppIcon(bundle) {
  const workDir = mkdtempSync(path.join(tmpdir(), 'bimax-icon-'));
  try {
    const { car, iconName } = compile(workDir);
    cpSync(car, path.join(bundle, 'Contents/Resources/Assets.car'));
    const infoPlist = path.join(bundle, 'Contents/Info.plist');
    // `Set` fails when the key is absent, so add first and fall back to overwriting an existing one.
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :CFBundleIconName string ${iconName}`, infoPlist], { stdio: 'ignore' });
    } catch {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIconName ${iconName}`, infoPlist], { stdio: 'ignore' });
    }
    const size = (readFileSync(car).byteLength / 1024).toFixed(0);
    console.log(`  • app icon catalog installed  CFBundleIconName=${iconName} Assets.car=${size}KB`);
    return { iconName, bytes: readFileSync(car).byteLength };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bundle = process.argv[2];
  if (!bundle) { console.error('usage: make-app-icon-assets.mjs /path/to/Bimax.app'); process.exit(1); }
  installAppIcon(bundle);
}
