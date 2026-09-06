import fs from 'node:fs';
import path from 'node:path';

/**
 * The Desktop release gate must read the packaged artifact, not the source tree.
 *
 * Rescued from `phase1.packaging.boundary.test.ts`, deleted 2026-09-04. That file was written before
 * the 2026-09-02 code-only reset and its other assertions REQUIRED Computer Use to be packaged —
 * `mac.extraFiles` had to contain `BimaxCuService.xpc`, `bimax-cu-bridge` and friends. With CU
 * disabled at the seams those assertions were not merely stale, they demanded the thing the product
 * had deliberately removed, so the whole file went. `code.only.product.boundary.test.ts` is the
 * boundary now.
 *
 * The Terminal (CLI) half of this file went to archive/cli-tui/ on 2026-09-06 along with the
 * `bimax` terminal product and its release pipeline; the gate it read
 * (scripts/verify-terminal-archives.mjs) no longer exists. What remains is the one assertion that
 * still guards a shipping product.
 */

const repo = path.resolve(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(repo, relative), 'utf8');

describe('desktop release gate', () => {
  test('the Desktop gate reads the real packaged bundle, not the source tree', () => {
    // Extracting main from the packed asar is what makes this gate an ARTIFACT check. Asserting
    // against sources instead is how a packaged app ships broken while every gate stays green.
    const desktopGate = read('scripts/verify-desktop-package.mjs');
    expect(desktopGate).toContain("asar.extractFile(files.asar, 'out/main/index.js')");
  });
});
