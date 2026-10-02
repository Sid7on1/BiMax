#!/usr/bin/env electron
/**
 * Record 65 stage 6 (§6h), live, outside the installed app: the app's use service and Cua Driver 0.31 embedded in this
 * process, against Bimax's own fixture app — a scripted sequence of steps, with no model (the rule under test is the
 * app's, not a model's), the person played by an answer per card. Graded from evidence the service cannot write: the
 * fixture read by a SEPARATE reader (the standalone cua-driver under the terminal's own grant, stopped after each read)
 * and the embedded driver's own activity observer.
 *
 *   npx electron scripts/computer/prove-use-driver.js --out <evidence.json>
 *
 * Steps, each graded:
 *   1 look            "Let this task use …?" answered Allow using; the window is read
 *   2 type field      one line into the text field, which holds the fixture's own text: the overwrite card first
 *                     (answered Replace it); the box reads it back exactly, and so does the reader
 *   2b retype         again into the same box, now holding Bimax's own text: no card; read back exactly
 *   3 press button    the first press after typing: the app's card shows the typed text; answered Press; presses +1
 *   4 press checkbox  an ordinary press on the step 3 re-read (no look between): no card; the checkbox flips
 *   5 line break      typing with a line break is refused before the driver; the text area is unchanged
 *   6 never used      the never-used rule: a look at Bimax itself is refused (the bundle id) — no card, no read
 * Every authorized driver tool must be a look tool, click or set_value.
 *
 * Run from a terminal that holds Accessibility, with BimaxCuFixture.app open.
 *
 * `--mutant <name>` builds the service or driver with one fault planted, to show the grading catches it (each must
 * FAIL): no-card (a press after typing is not asked), wrong-text (the box is set to other text), double-press (each
 * press is sent twice).
 */
const { app } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const outPath = path.resolve(arg('out', path.join(os.tmpdir(), 'prove-use-driver.json')));
const mutantName = arg('mutant', '');
const MUTANTS = {
  'no-card': ['look.service.ts', '        if (reason) {', '        if ((reason) && Date.now() < 0) {'],
  'wrong-text': ['look.driver.ts', "await call(session, 'set_value', { pid: app.pid, element_token: box.token, value: text });", "await call(session, 'set_value', { pid: app.pid, element_token: box.token, value: `${text}!` });"],
  'double-press': ['look.driver.ts', "await call(session, 'click', { pid: app.pid, window_id: target.windowId, element_token: matches[0].token, action: 'press', delivery_mode: 'background' });", "await call(session, 'click', { pid: app.pid, window_id: target.windowId, element_token: matches[0].token, action: 'press', delivery_mode: 'background' }); await call(session, 'click', { pid: app.pid, window_id: target.windowId, element_token: matches[0].token, action: 'press', delivery_mode: 'background' });"],
};
if (mutantName && !MUTANTS[mutantName]) { console.error(`unknown mutant; one of ${Object.keys(MUTANTS).join(', ')}`); process.exit(2); }
const READER = path.join(appRoot, '..', 'docs', 'product-reset', 'evidence', '2026-10-02-cu-stage6', 'scripts', 'read_fixture6.py');
const CUA = path.join(os.homedir(), '.local', 'bin', 'cua-driver');
const LOOK_TOOLS = ['list_apps', 'list_windows', 'get_window_state', 'get_screen_size'];

async function loadModules() {
  const esbuild = require(path.join(appRoot, 'node_modules', 'esbuild'));
  const outfile = path.join(os.tmpdir(), `bimax-use-modules-${process.pid}.cjs`);
  await esbuild.build({
    stdin: {
      contents: "export * from './look.service'; export * from './look.driver'; export * from './look.manifest';",
      resolveDir: path.join(appRoot, 'src', 'main', 'computer'), loader: 'ts', sourcefile: 'proof-entry.ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error',
    plugins: mutantName ? [{ name: 'mutant', setup(build) {
      const [file, from, to] = MUTANTS[mutantName];
      build.onLoad({ filter: new RegExp(`${file.replace('.', '\\.')}$`) }, (args) => {
        const source = fs.readFileSync(args.path, 'utf8');
        if (source.split(from).length !== 2) throw new Error(`mutant ${mutantName}: source text not found exactly once`);
        return { loader: 'ts', contents: source.replace(from, to) };
      });
    } }] : [],
  });
  return require(outfile);
}

function readFixture() {
  try { return JSON.parse(execFileSync('python3', [READER], { encoding: 'utf8', timeout: 60_000 })); }
  finally { try { execFileSync(CUA, ['stop'], { timeout: 30_000, stdio: 'ignore' }); } catch { /* not running */ } }
}
const presses = (r) => Number(/presses=(\d+)/.exec(r?.status ?? '')?.[1] ?? NaN);

const evidence = { kind: 'live-driver-scripted', mutant: mutantName || null, startedAt: new Date().toISOString(), steps: [], cards: [], failures: [] };
const check = (ok, what) => { if (!ok) evidence.failures.push(what); return ok; };

app.whenReady().then(async () => {
  const cu = await loadModules();
  const driver = cu.createLookDriver({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-use-state-')), packaged: false, resourcesPath: '', appPath: appRoot });
  const service = cu.createLookService({
    enabled: () => true,
    useEnabled: () => true,
    driver: async () => driver,
    ask: async (_t, question, options, body) => {
      const answer = options[0];
      evidence.cards.push({ question, options, body, answer });
      return answer;
    },
    audit: (entry) => { (evidence.audit ??= []).push(entry); },
  });
  const threadId = 'proof-use';
  let id = 0;
  const call = async (step, capability, op, args) => {
    const cardsBefore = evidence.cards.length;
    const result = await service.handle(threadId, { t: 'host_call', id: ++id, capability, op, args });
    const record = { step, capability, op, args, ok: result.ok, code: result.value?.code, error: result.error, text: String(result.value?.text ?? '').slice(0, 1200), cards: evidence.cards.slice(cardsBefore).map((c) => c.question) };
    evidence.steps.push(record);
    return record;
  };
  try {
    const before = evidence.fixtureBefore = readFixture();
    const typed = `bimax stage six ${Date.now() % 100000}`;

    const look = await call('1 look', 'look', 'look', { app: 'BimaxCuFixture' });
    check(look.ok && look.cards[0] === 'Let this task use BimaxCuFixture?', '1: the use card and a read');
    const field = /AXTextField "([^"]*)"/.exec(look.text)?.[1] ?? before.textField;

    const t = await call('2 type field', 'type', 'type', { app: 'BimaxCuFixture', field, role: 'AXTextField', text: typed });
    const afterType = evidence.afterType = readFixture();
    // The box held the fixture's own text, not Bimax's: replacing it asks (measured in run 1, where this script wrongly
    // expected no card).
    check(t.ok && t.cards.length === 1 && t.cards[0] === `Replace the text in “${field}” in BimaxCuFixture?`, '2: typed after the overwrite card');
    check(t.text.includes(`reads exactly: “${typed}”`), '2: the service read the box back exactly');
    check(afterType.textField === typed, `2: the reader sees the text (${JSON.stringify(afterType.textField)})`);

    const typed2 = `${typed} again`;
    const t2 = await call('2b retype', 'type', 'type', { app: 'BimaxCuFixture', field: typed, role: 'AXTextField', text: typed2 });
    const afterRetype = evidence.afterRetype = readFixture();
    check(t2.ok && t2.cards.length === 0, '2b: retyping over Bimax’s own text asks nothing');
    check(afterRetype.textField === typed2, `2b: the reader sees the new text (${JSON.stringify(afterRetype.textField)})`);

    const p = await call('3 press after typing', 'press', 'press', { app: 'BimaxCuFixture', control: 'Fixture Button', role: 'AXButton' });
    const afterPress = evidence.afterPress = readFixture();
    const card = evidence.cards.find((c) => c.question === 'Press “Fixture Button” in BimaxCuFixture?');
    check(p.ok && p.cards.length === 1 && !!card, '3: the press after typing asked once');
    check(!!card && card.body.includes(`as the box reads now: “${typed2}”`), '3: the card shows the typed text as the box reads it');
    check(presses(afterPress) === presses(afterRetype) + 1, `3: the reader sees one press (${afterRetype.status} → ${afterPress.status})`);

    const c = await call('4 ordinary press', 'press', 'press', { app: 'BimaxCuFixture', control: 'Fixture Checkbox', role: 'AXCheckBox' });
    const afterCheck = evidence.afterCheckbox = readFixture();
    check(c.ok && c.cards.length === 0, '4: an ordinary press on the re-read, with no card and no look');
    check(afterCheck.checkbox !== afterPress.checkbox, `4: the reader sees the checkbox flip (${afterPress.checkbox} → ${afterCheck.checkbox})`);

    const area = /AXTextArea "([^"]*)"/.exec(c.text)?.[1] ?? before.textArea;
    const lb = await call('5 line break', 'type', 'type', { app: 'BimaxCuFixture', field: area, role: 'AXTextArea', text: 'one\ntwo' });
    const afterLb = evidence.afterLineBreak = readFixture();
    check(!lb.ok && lb.code === 'invalid_args', '5: a line break is refused');
    check(afterLb.textArea === afterCheck.textArea, '5: the reader sees the text area unchanged');

    const never = await call('6 never-used', 'look', 'look', { app: 'ai.bimax.app' });
    check(!never.ok && never.cards.length === 0, '6: Bimax itself is never looked at, and never asked about');

    const activity = evidence.driverActivity = driver.activity(threadId);
    const authorized = Object.keys(activity.authorized);
    evidence.authorizedTools = authorized;
    check(authorized.every((tool) => LOOK_TOOLS.includes(tool) || tool === 'click' || tool === 'set_value'), `only look tools, click and set_value authorized (${authorized.join(', ')})`);
    check(activity.authorized.click === 2 && activity.authorized.set_value === 2, `exactly two clicks and two set_values (${JSON.stringify(activity.authorized)})`);
    evidence.serviceCounts = service.counts(threadId);
    await driver.end(threadId);
  } catch (error) {
    evidence.failures.push(`threw: ${error instanceof Error ? error.stack : String(error)}`);
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.result = evidence.failures.length ? `FAIL — ${evidence.failures.length} check(s) failed` : 'PASS — every step graded from the reader and the driver observer';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
  console.log(`${evidence.result}\n${evidence.failures.join('\n')}\nevidence: ${outPath}`);
  app.exit(evidence.failures.length ? 1 : 0);
});
