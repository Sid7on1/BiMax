import * as fs from 'fs';
import * as path from 'path';

/**
 * The packaging boundary, guarded against the files that EXIST.
 *
 * This replaces packaging.sidecar.test.ts, which read `scripts/lib-build.sh` and `tui/embed_prod.go`
 * — the Go TUI's build, archived 2026-09-06. It had therefore thrown ENOENT on every run since,
 * which is worse than no test: the boundary looked guarded while nothing checked it. Three separate
 * sessions rediscovered that. The rule it protected is unchanged — a code-only build must not ship a
 * Computer Use payload — so it is asserted here against the checker that really runs, plus the two
 * wirings that make a checker more than a file on disk.
 */
const REPO = path.resolve(__dirname, '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const verifier = read('scripts', 'verify-desktop-package.mjs');
const buildLocal = read('app', 'scripts', 'build-local-mac.sh');

const FORBIDDEN = [
  'bimax-cu-bridge',
  'bimax-cu-service',
  'bimax-desktop-helper',
  'bimax-live-pip',
  'bimax-mac-capability',
  'XPCServices',
];

describe('a code-only build ships no native-control payload', () => {
  it.each(FORBIDDEN)('the package verifier still refuses %s', (payload) => {
    expect(verifier).toContain(payload);
  });

  it('the verifier is actually wired into the local build', () => {
    // A gate nothing calls is the failure this file exists to stop repeating.
    expect(buildLocal).toContain('verify-desktop-package.mjs');
  });

  it('the build EXECUTES the engine it is about to ship', () => {
    // Reading a script to see what it says is not the same as running what it produced: v1.1.0
    // shipped a sidecar stub that exited 1 with every gate green.
    expect(buildLocal).toContain('verify-engine.js');
  });

  it('the engine ships as a bundle the verifier checks for substance, not as a binary', () => {
    // The engine became JavaScript run by Electron's own Node; an arch assertion here would fail
    // every build for the wrong reason, so the verifier checks size and the .wasm assets instead.
    expect(verifier).toContain('engine bundle looks truncated');
    expect(verifier).toContain('.wasm');
  });
});
