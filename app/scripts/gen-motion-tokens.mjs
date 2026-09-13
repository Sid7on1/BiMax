// Emit (or verify) the CSS spring tokens in styles.css from the SAME solver the JS animations use.
//
// The `linear()` curves and `--dur-*` values are COMPILED OUTPUT, not design values: they are
// `simulateSpring()` sampled at control size and pasted. Before this script that paste was manual,
// which is a silent-drift hazard of exactly the kind styles.css warns about ("Regenerate both
// together if a preset changes") — a preset could be edited and the CSS left describing the old
// physics, and nothing would fail.
//
//   node scripts/gen-motion-tokens.mjs          → print the block
//   node scripts/gen-motion-tokens.mjs --check  → exit 1 if styles.css disagrees with the solver
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = path.join(APP, 'src/renderer/src/styles.css');
const SOURCE = path.join(APP, 'src/renderer/src/components/ui/motion.ts');

// The CSS transitions run on buttons, rows and popovers. Anything large enough to need the size
// grading is animated from JS, where `springFor` applies it — so these tokens are the ungraded,
// control-size presets. 120 is `CONTROL_DIAGONAL`, the floor of both the grading and the settle
// band: any diagonal at or below it resolves identically.
const CONTROL_DIAGONAL = 120;
const PRESETS = [
  ['snappy', 'Presses, toggles, row selection.'],
  ['bouncy', 'The house bounce: menus, pills, chips.'],
  ['glass', 'Panels and sheets: a rebound that reads as weight.'],
];

const tmp = mkdtempSync(path.join(tmpdir(), 'bimax-motion-'));
try {
  // motion.ts is TypeScript and imports nothing at runtime, so a bundle is enough to execute it.
  execFileSync(path.join(APP, 'node_modules/.bin/esbuild'), [
    SOURCE, '--bundle', '--format=esm', '--platform=neutral',
    `--outfile=${path.join(tmp, 'motion.mjs')}`, '--log-level=error',
  ]);
  // `resolveSpring` emits a bezier fallback when it cannot prove `linear()` support, and in Node it
  // cannot. The browser this CSS ships to does support it, so assert that here rather than
  // generating the degraded curve.
  globalThis.CSS = { supports: () => true };
  const motion = await import(path.join(tmp, 'motion.mjs'));

  const lines = [];
  for (const [preset, note] of PRESETS) {
    const { stiffness, ratio } = motion.SPRINGS[preset];
    const { duration, easing, peak } = motion.springFor(preset, CONTROL_DIAGONAL);
    const overshoot = ((peak - 1) * 100).toFixed(1);
    lines.push(`  /* ${preset}: k=${stiffness}, ζ=${ratio} — ${overshoot}% overshoot. ${note} */`);
    lines.push(`  --ease-${preset}: ${easing};`);
    lines.push(`  --dur-${preset}: ${duration}ms;`);
    lines.push('');
  }
  const block = lines.join('\n').trimEnd();

  if (!process.argv.includes('--check')) {
    console.log(block);
  } else {
    const css = readFileSync(CSS, 'utf8');
    const drift = [];
    for (const [preset] of PRESETS) {
      const { duration, easing } = motion.springFor(preset, CONTROL_DIAGONAL);
      // Compare the VALUES, not the surrounding formatting: a reordered or reflowed block is fine,
      // a curve that no longer matches the physics is not.
      if (!css.includes(`--ease-${preset}: ${easing};`)) drift.push(`--ease-${preset} does not match the solver`);
      if (!css.includes(`--dur-${preset}: ${duration}ms;`)) drift.push(`--dur-${preset} is not ${duration}ms`);
    }
    if (drift.length) {
      console.error('motion tokens: DRIFT — styles.css no longer matches motion.ts');
      for (const d of drift) console.error(`  - ${d}`);
      console.error('\nRegenerate with: node scripts/gen-motion-tokens.mjs');
      process.exit(1);
    }
    console.log(`motion tokens: PASS (${PRESETS.map(([p]) => p).join(', ')} match the solver)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
