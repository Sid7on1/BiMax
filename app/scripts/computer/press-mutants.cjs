#!/usr/bin/env node
/*
 * Record 65 stage 3: each press check removed in turn must fail app/src/__tests__/computer.press.test.ts.
 * Edits app/src/main/computer/look.service.ts in place for each mutant and ALWAYS restores it (finally), then checks
 * the file is byte-identical to how it started. Prints one line per mutant; exits 1 if any mutant survives.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const file = path.join(root, 'app/src/main/computer/look.service.ts');
const original = fs.readFileSync(file, 'utf8');

// Not listed: removing the re-check right after the card. The re-check after `deps.driver()` follows with no input in
// between, so that mutant is equivalent — measured: it survives with no press made — and the later check is the one pinned.
const MUTANTS = [
  // Keeps PRESS_APPS referenced, so the suite still compiles and only behaviour can catch it.
  ['wrong target: any app may be pressed', "if (!PRESS_APPS.has(target.bundleId) || NEVER_LOOK.has(target.bundleId)) {", 'if (PRESS_APPS.size < 0) {'],
  ['wrong target: a shared name is pressed', 'if (matches.length > 1) {', 'if (false) {'],
  ['wrong target: a non-pressable control is pressed', "if (!el.pressable) return refuse(", 'if (false) return refuse('],
  ['stale frame: any age is fresh', 'if (age > PRESS_FRESH_MS) {', 'if (false) {'],
  ['stale frame: one look allows many presses', '      observations.delete(key);\n\n      const receipt', '\n      const receipt'],
  ['duplicate effect: a replayed request runs again', 'if (handledPresses.has(seen)) return refuse(', 'if (false) return refuse('],
  ['approval skipped: any answer presses', 'if (answer !== PRESS(el.label)) {', 'if (false) {'],
  ['takeover: nothing re-checked before the driver', "      const driver = await deps.driver();\n      if (!live()) return cancelled();", '      const driver = await deps.driver();'],
  ['no-op: an unchanged window counts as success', 'if (!changed) {', 'if (false) {'],
  ['pressing switched off still presses', 'if (!deps.enabled() || !pressOn()) {', 'if (!deps.enabled()) {'],
  ['wrong build: a rebuild since the look is not checked', 'if (!exeNow || exeNow.sha256 !== look.exe.sha256 || exeNow.path !== look.exe.path) {', 'if (!exeNow) {'],
];

let survived = 0;
try {
  for (const [name, from, to] of MUTANTS) {
    if (original.split(from).length !== 2) throw new Error(`mutant "${name}": its source text is not found exactly once`);
    fs.writeFileSync(file, original.replace(from, to));
    const run = spawnSync('npx', ['jest', '--runInBand', '--coverage=false', '--runTestsByPath', 'app/src/__tests__/computer.press.test.ts'], { cwd: root, encoding: 'utf8' });
    const caught = run.status !== 0;
    if (!caught) survived += 1;
    const failed = /Tests:\s+(\d+) failed/.exec(run.stderr + run.stdout)?.[1] ?? '0';
    console.log(`${caught ? 'caught  ' : 'SURVIVED'}  ${name}  (${failed} failed)`);
  }
} finally {
  fs.writeFileSync(file, original);
}
if (fs.readFileSync(file, 'utf8') !== original) { console.error('look.service.ts was NOT restored'); process.exit(2); }
console.log(survived ? `${survived} mutant(s) survived` : `all ${MUTANTS.length} mutants caught; look.service.ts restored byte-identical`);
process.exit(survived ? 1 : 0);
