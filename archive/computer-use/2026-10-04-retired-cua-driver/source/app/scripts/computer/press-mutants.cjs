#!/usr/bin/env node
/*
 * Record 65 stages 3 and 6 (§6h): each check removed in turn must fail the app's Computer Use tests
 * (computer.press.test.ts and computer.commit.test.ts). Edits look.service.ts or look.commit.ts in place for each mutant
 * and ALWAYS restores both (finally), then checks they are byte-identical to how they started. Prints one line per
 * mutant; exits 1 if any mutant survives.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const SERVICE = path.join(root, 'app/src/main/computer/look.service.ts');
const RULE = path.join(root, 'app/src/main/computer/look.commit.ts');
const originals = new Map([SERVICE, RULE].map((f) => [f, fs.readFileSync(f, 'utf8')]));

// A removed check is written `if ((check) && Date.now() < 0)`, never `if (false)`: the expression stays, so TypeScript's
// narrowing is unchanged and the suite still compiles — only behaviour can catch the mutant (a compile error is not a
// catch; measured: six mutants "caught" that way at first).
// Not listed: removing the re-check right after a card. The re-check after `deps.driver()` follows with no input in
// between, so that mutant is equivalent — measured in stage 3: it survives with no press made — and the later check is
// the one pinned.
const MUTANTS = [
  // Who may be used, and how.
  ['never-used apps: names ignored', SERVICE, 'isNeverUsed(app.name) || isNeverUsed(app.bundleId)', 'false'],
  ['use grant: a look-only grant acts without asking', SERVICE, 'if (!grants.mayUse(threadId, target.bundleId)) {', 'if ((!grants.mayUse(threadId, target.bundleId)) && Date.now() < 0) {'],
  ['use grant: “Only look” ignored', SERVICE, "if (lookOnly.has(key)) return refuse('denied'", "if ((lookOnly.has(key)) && Date.now() < 0) return refuse('denied'"],
  ['using switched off still acts', SERVICE, 'if (!deps.enabled() || !useOn()) {', 'if (!deps.enabled()) {'],
  // Wrong target, stale frame, duplicate effect.
  ['wrong target: any start of a name is enough', SERVICE, 'return w.length >= LONG_NAME_PREFIX && plainName(label)', 'return w.length >= 1 && plainName(label)'],
  ['wrong target: a shared name is pressed', SERVICE, "if (matches.length > 1) return refuse('ambiguous'", "if ((matches.length > 1) && Date.now() < 0) return refuse('ambiguous'"],
  ['wrong target: a control with no press is pressed', SERVICE, 'if (!el.pressable) {', 'if ((!el.pressable) && Date.now() < 0) {'],
  ['stale frame: any age is fresh', SERVICE, 'if (age > PRESS_FRESH_MS) {', 'if ((age > PRESS_FRESH_MS) && Date.now() < 0) {'],
  ['stale frame: one read allows many steps', SERVICE, '      observations.delete(key);\n      const state', '      const state'],
  ['duplicate effect: a replayed request runs again', SERVICE, 'if (handledSteps.has(seen)) return refuse(', 'if ((handledSteps.has(seen)) && Date.now() < 0) return refuse('],
  // The card before a commit.
  ['commit: no card at all', SERVICE, '        if (reason) {', '        if ((reason) && Date.now() < 0) {'],
  ['commit: any answer presses', SERVICE, 'if (answer !== PRESS(el.label)) {', 'if ((answer !== PRESS(el.label)) && Date.now() < 0) {'],
  ['commit: typing is not remembered', SERVICE, 'typedSinceLastCard: state.typed !== undefined', 'typedSinceLastCard: false'],
  ['commit: a dialog is not noticed', SERVICE, 'inDialog: el.inDialog === true, typedSinceLastCard: state.typed !== undefined', 'inDialog: false, typedSinceLastCard: state.typed !== undefined'],
  ['pick: a dialog is not noticed', SERVICE, '{ label: option, inDialog: el.inDialog === true,', '{ label: option, inDialog: false,'],
  ['commit: the typed text outlives the card that showed it', SERVICE, 'if (asked) state.typed = undefined;', 'if ((asked) && Date.now() < 0) state.typed = undefined;'],
  ['commit rule: unreadable names run', RULE, "  if (!/[a-z]/.test(foldName(step.label))) return { kind: 'unreadable' };\n", ''],
  ['commit rule: dialogs run', RULE, "  if (step.inDialog) return { kind: 'dialog' };\n", ''],
  ['commit rule: words match inside other words', RULE, 'if (folded.includes(` ${word} `)) return word;', 'if (folded.includes(word)) return word;'],
  ['commit rule: accents not folded', RULE, ".replace(/[\\u0300-\\u036f]/g, '')", ''],
  // Typing.
  ['typing: a line break is typed', SERVICE, 'if (/[\\r\\n\\u2028\\u2029]/.test(text)) return refuse(', 'if ((/[\\r\\n\\u2028\\u2029]/.test(text)) && Date.now() < 0) return refuse('],
  ['typing: a password field is typed into', SERVICE, "if (named.some((e) => e.role === 'AXSecureTextField')) return refuse(", "if ((named.some((e) => e.role === 'AXSecureTextField')) && Date.now() < 0) return refuse("],
  ['typing: the person’s text is replaced unasked', SERVICE, 'if (existing.trim() && !ours && !findBox) {', 'if ((existing.trim() && !ours && !findBox) && Date.now() < 0) {'],
  ['typing: a box that is not for searching counts as one when replacing', SERVICE, 'if (existing.trim() && !ours && !findBox) {', 'if (existing.trim() && !ours && findBox) {'],
  ['typing: any answer replaces', SERVICE, 'if (answer !== REPLACE) {', 'if ((answer !== REPLACE) && Date.now() < 0) {'],
  ['typing: the read-back is not compared', SERVICE, 'if (outcome.value !== text) {', 'if ((outcome.value !== text) && Date.now() < 0) {'],
  // Return in a box.
  ['return: always pressed after typing', SERVICE, '    if (!submit) {', '    if ((!submit) && Date.now() < 0) {'],
  ['return: no card in a message box', SERVICE, "    if (!searching) {\n      receipt.asked = 'submit';", "    if ((!searching) && Date.now() < 0) {\n      receipt.asked = 'submit';"],
  ['return: any answer presses Return', SERVICE, 'if (answer !== RETURN) return refuse(', 'if ((answer !== RETURN) && Date.now() < 0) return refuse('],
  ['return: the driver’s search-box mark ignored', SERVICE, 'const searching = el.searchBox === true || isSearchBox(el.role, el.label);', 'const searching = isSearchBox(el.role, el.label);'],
  // Picking from a pop-up.
  ['pick: no card at all', SERVICE, '        if (pickReason) {', '        if ((pickReason) && Date.now() < 0) {'],
  ['pick: any answer chooses', SERVICE, 'if (answer !== CHOOSE(option)) {', 'if ((answer !== CHOOSE(option)) && Date.now() < 0) {'],
  ['pick: the pop-up’s own name ignored', SERVICE, "?? (ownWord ? { kind: 'word', word: ownWord } : null);", '?? null;'],
  ['pick: not a pop-up is picked from', SERVICE, 'if (!el.pickable) return refuse(', 'if ((!el.pickable) && Date.now() < 0) return refuse('],
  ['pick: the item shown is not compared', SERVICE, 'if (!sameChoice(outcome.value, option)) {', 'if ((!sameChoice(outcome.value, option)) && Date.now() < 0) {'],
  // Scrolling.
  ['scroll: nothing moved counts as a scroll', SERVICE, 'if (!moved) return refuse(', 'if ((!moved) && Date.now() < 0) return refuse('],
  ['scroll: any direction is sent', SERVICE, 'if (scrolling && !DIRECTIONS.includes(direction)) return refuse(', 'if ((scrolling && !DIRECTIONS.includes(direction)) && Date.now() < 0) return refuse('],
  ['scroll: any distance is sent', SERVICE, 'if (scrolling && (pages < 1 || pages > MAX_SCROLL_PAGES)) return refuse(', 'if ((scrolling && (pages < 1 || pages > MAX_SCROLL_PAGES)) && Date.now() < 0) return refuse('],
  // Bringing the app forward for one step (ability 4).
  ['front: no card', SERVICE, 'if (front && receipt.front && !receipt.front.asked) {', 'if ((front && receipt.front && !receipt.front.asked) && Date.now() < 0) {'],
  ['front: any answer brings it forward', SERVICE, 'if (answer !== BRING(target.name)) {', 'if ((answer !== BRING(target.name)) && Date.now() < 0) {'],
  ['front: a commit card that never said so counts', SERVICE, '              ? `${frontLine} It presses once,', '              ? `It presses once,'],
  ['front: the person’s app is never checked', SERVICE, '    return after === before\n      ? ', '    return true\n      ? '],
  ['front: pressed from behind anyway', SERVICE, 'outcome = front ? await driver.press!(threadId, target, boundTo, true)', 'outcome = false ? await driver.press!(threadId, target, boundTo, true)'],
  ['front: typed from behind anyway', SERVICE, 'outcome = front ? await driver.typeFront!(', 'outcome = false ? await driver.typeFront!('],
  ['front: Return by confirm anyway', SERVICE, 'confirmed = front ? await driver.returnFront!(', 'confirmed = false ? await driver.returnFront!('],
  ['front: allowed for scrolling and choosing', SERVICE, 'if (front && (scrolling || picking)) return refuse(', 'if ((front && (scrolling || picking)) && Date.now() < 0) return refuse('],
  // A long run, takeover, no-op, wrong build.
  ['keep going: never asked', SERVICE, 'if (receipt.asked === null && !receipt.front && (stepsSinceCard.get(threadId) ?? 0) >= KEEP_GOING_EVERY) {', 'if ((receipt.asked === null && !receipt.front && (stepsSinceCard.get(threadId) ?? 0) >= KEEP_GOING_EVERY) && Date.now() < 0) {'],
  ['keep going: “Stop here” ignored', SERVICE, 'if (answer !== KEEP_GOING) {', 'if ((answer !== KEEP_GOING) && Date.now() < 0) {'],
  ['takeover: nothing re-checked before the driver', SERVICE, '      const driver = await deps.driver();\n      if (!live()) return cancelled();\n      if (typing', '      const driver = await deps.driver();\n      if (typing'],
  ['no-op: an unchanged window counts as success', SERVICE, 'if (!changed) {', 'if ((!changed) && Date.now() < 0) {'],
  ['wrong build: a rebuild since the read is not checked', SERVICE, 'if (!exeNow || exeNow.sha256 !== look.exe.sha256 || exeNow.path !== look.exe.path) {', 'if (!exeNow) {'],
];

// `--only <text>`: run just the mutants whose name contains it (the full run takes ~25 min on this Mac).
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1] : '';
let survived = 0;
try {
  for (const [name, file, from, to] of MUTANTS.filter(([n]) => !only || n.includes(only))) {
    const original = originals.get(file);
    if (original.split(from).length !== 2) throw new Error(`mutant "${name}": its source text is not found exactly once`);
    fs.writeFileSync(file, original.replace(from, to));
    const run = spawnSync('npx', ['jest', '--runInBand', '--coverage=false', '--runTestsByPath', 'app/src/__tests__/computer.press.test.ts', 'app/src/__tests__/computer.commit.test.ts'], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(file, original);
    const caught = run.status !== 0;
    if (!caught) survived += 1;
    const failed = /Tests:\s+(\d+) failed/.exec(run.stderr + run.stdout)?.[1] ?? '0';
    console.log(`${caught ? 'caught  ' : 'SURVIVED'}  ${name}  (${failed} failed)`);
  }
} finally {
  for (const [file, original] of originals) fs.writeFileSync(file, original);
}
for (const [file, original] of originals) {
  if (fs.readFileSync(file, 'utf8') !== original) { console.error(`${path.basename(file)} was NOT restored`); process.exit(2); }
}
const ran = MUTANTS.filter(([n]) => !only || n.includes(only)).length;
console.log(survived ? `${survived} mutant(s) survived` : `all ${ran} mutants${only ? ` matching "${only}"` : ''} caught; look.service.ts and look.commit.ts restored byte-identical`);
process.exit(survived ? 1 : 0);
