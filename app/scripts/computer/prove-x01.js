#!/usr/bin/env electron
/**
 * Record 65 stage 5 — X01, build → run → prove (docs/product-reset/competitive/examples/X01_BUILD_RUN_PROVE.md).
 *
 * Real: the engine bundle the app ships (app/engine/index.js) as a worker in Bimax Thread mode with looking and pressing
 * on, a live model turn, the app's look/press service with build identity (look.identity.ts) and Cua Driver 0.31
 * in-process, and a fresh copy of app/benchmarks/x01-todo in its own folder (a git repository, so the diff is kept).
 * Played: the person, who answers cards — file changes inside the folder and an allowlist of commands are allowed,
 * everything else is denied. The model writes the change, the test, builds, launches, looks and presses.
 *
 * Nothing here grades: the grader (docs/product-reset/evidence/2026-10-02-cu-stage5/grade_x01.py) reads the evidence
 * this writes plus the run folder itself — re-running the tests, hashing the build, reading data/todos.json and the
 * window through the standalone driver.
 *
 *   npx electron scripts/computer/prove-x01.js --out <evidence.json>
 */
const { app } = require('electron');
const { Worker, MessageChannel } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const outPath = path.resolve(arg('out', path.join(os.tmpdir(), 'prove-x01.json')));
const target = path.join(appRoot, 'engine', 'index.js');
const fixture = path.join(appRoot, 'benchmarks', 'x01-todo');
const LIMIT_MS = 30 * 60 * 1000;
const OPEN_PROMPT = [
  'Add a "Clear Completed" button to this Mac to-do app: it removes the to-dos that are done, keeps the others, and saves',
  'the list. Keep the current visual style (Sources/App.swift for the window, Sources/TodoCore.swift for the data).',
  'Add a test for it in Tests/TodoCoreTests.swift. Then run ./run-tests.sh, build with ./build.sh, and launch the app',
  'with `open build/BimaxTodo.app`. Look at the app named BimaxTodo with LookAtAppTool, press the "Clear Completed" button',
  'once with PressInAppTool, and look again. Finally tell me which to-dos remain, the executable SHA-256 that ./build.sh',
  'printed, and the one the press reported.',
].join(' ');
// Run 1 with the open prompt spent 23 minutes reading files without an edit while each reply took minutes (record 65
// §6g). The guided prompt says where each change goes; the model still writes the code, the test and every step after.
const GUIDED_PROMPT = [
  'Add a "Clear Completed" button to this Mac to-do app, in three edits:',
  '(1) In Sources/TodoCore.swift, add to class TodoStore a method `func clearCompleted()` that removes every item whose',
  '`done` is true and keeps the rest in order.',
  '(2) In Sources/App.swift, in applicationDidFinishLaunching, add an NSButton titled "Clear Completed" (a normal push',
  'button, like the system style already used) to the `root` stack view, whose action calls `store.clearCompleted()`, then',
  '`try? store.save()`, then `render()`.',
  '(3) In Tests/TodoCoreTests.swift, inside main(), add a check named "clearCompleted keeps only the active items" that',
  'builds a store with sample(), calls clearCompleted(), and checks only the item that is not done remains.',
  'Then run ./run-tests.sh, run ./build.sh, and run `open build/BimaxTodo.app`. Look at the app named BimaxTodo with',
  'LookAtAppTool, press the "Clear Completed" button once with PressInAppTool, and look again. Finally tell me which',
  'to-dos remain, the executable SHA-256 that ./build.sh printed, and the one the press reported.',
].join(' ');
const promptKind = arg('prompt', 'open');
const PROMPT = promptKind === 'guided' ? GUIDED_PROMPT : OPEN_PROMPT;

// The commands the played person allows, exactly. Anything else is denied.
const ALLOWED = [
  /^(\.\/|bash\s+)?run-tests\.sh$/,
  /^(\.\/|bash\s+)?build\.sh$/,
  /^open\s+(\.\/)?build\/BimaxTodo\.app$/,
  /^(cd\s+\S+\s*&&\s*)?(\.\/)?(run-tests|build)\.sh$/,
  /^chmod\s+\+x\s+(\.\/)?(run-tests|build)\.sh$/,
];
const allowedCommand = (command) => ALLOWED.some((re) => re.test(String(command).trim()));

function loadModules() {
  const esbuild = require(path.join(appRoot, 'node_modules', 'esbuild'));
  const outfile = path.join(os.tmpdir(), `bimax-x01-modules-${process.pid}.cjs`);
  esbuild.buildSync({
    stdin: {
      contents: "export * from './look.service'; export * from './look.driver'; export * from './look.manifest'; export * from './look.identity';",
      resolveDir: path.join(appRoot, 'src', 'main', 'computer'), loader: 'ts', sourcefile: 'proof-entry.ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error',
  });
  return require(outfile);
}

let finished = false;
const evidence = { promptKind, prompt: PROMPT, startedAt: new Date().toISOString(), toolCalls: [], hostCalls: [], hostResults: [], cards: [], engineRequests: [], errors: [] };
function finish(code, note) {
  if (finished) return;
  finished = true;
  evidence.finishedAt = new Date().toISOString();
  evidence.result = note;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
  console.log(`${note}\nevidence: ${outPath}`);
  app.exit(code);
}

app.whenReady().then(async () => {
  const cu = loadModules();
  // A fresh run folder: the fixture's source only, as a git repository so the change is a diff.
  const run = fs.mkdtempSync(path.join(os.homedir(), 'Library', 'Caches', 'bimax-x01-run-'));
  fs.cpSync(fixture, run, { recursive: true, filter: (src) => !src.includes(`${path.sep}build`) });
  const git = (...a) => execFileSync('git', ['-C', run, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.email=x01@bimax.local', '-c', 'user.name=X01 fixture', 'commit', '-q', '-m', 'fixture');
  evidence.runFolder = run;
  evidence.fixtureCommit = git('rev-parse', 'HEAD').trim();
  // No to-do app from an earlier run may be open: the one pressed must be the one built here.
  try { execFileSync('pkill', ['-f', 'BimaxTodo.app/Contents/MacOS/BimaxTodo']); } catch { /* none running */ }

  const lookDriver = cu.createLookDriver({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-x01-state-')), packaged: false, resourcesPath: '', appPath: appRoot });
  const service = cu.createLookService({
    enabled: () => true,
    pressEnabled: () => true,
    identify: cu.identifyProcess,
    driver: async () => lookDriver,
    ask: async (threadId, question, options) => {
      const answer = options[0]; // "Allow looking at …" / "Press “…”"
      evidence.cards.push({ question, options, answer });
      return answer;
    },
    audit: (entry) => { (evidence.audit ??= []).push(entry); },
  });

  const stateDir = fs.mkdtempSync(path.join(os.homedir(), 'Library', 'Caches', 'bimax-x01-state-'));
  const threadId = 'x01-thread';
  const env = {
    ...process.env, BIMAX_HEADLESS: '1', BIMAX_CWD: run, WORKSPACE_ROOT: run, BIMAX_THREAD_ROOT: run, BIMAX_THREAD_ID: threadId,
    BIMAX_STATE_DIR: stateDir, BIMAX_ENGINE_MODULE: target, BIMAX_COMPUTER_LOOK: '1', BIMAX_COMPUTER_PRESS: '1',
  };
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(target, { env, workerData: { bimaxEngineRoot: run, bimaxEnginePort: port2 }, transferList: [port2], stdout: true, stderr: true });
  worker.stdout.on('data', () => {});
  let stderrTail = '';
  worker.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-1500); });
  const send = (msg) => port1.postMessage(msg);
  let sent = false;
  let answered = false;

  const end = async (code, note) => {
    evidence.serviceCounts = service.counts(threadId) ?? null;
    evidence.driverActivity = lookDriver.activity(threadId);
    evidence.authorizedInputTools = cu.inputToolsIn(evidence.driverActivity.authorized, cu.INPUT_TOOLS);
    try { evidence.diff = git('diff', 'HEAD'); evidence.diffStat = git('diff', '--stat', 'HEAD'); } catch (e) { evidence.errors.push(`diff: ${e.message}`); }
    void worker.terminate();
    finish(code, note);
  };

  port1.on('message', async (frame) => {
    port1.postMessage({ t: '__ack', bytes: typeof frame === 'string' ? frame.length : 0 });
    let msg;
    try { msg = JSON.parse(String(frame)); } catch { return; }
    if (msg.t === 'ready' && !sent) { sent = true; send({ t: 'input', text: PROMPT }); return; }
    if (msg.t === 'host_call') {
      evidence.hostCalls.push({ capability: msg.capability, op: msg.op, args: msg.args });
      const result = await service.handle(threadId, msg);
      evidence.hostResults.push({ capability: msg.capability, op: msg.op, ok: result.ok, code: result.value?.code, error: result.error, text: String(result.value?.text ?? '').slice(0, 1500) });
      send({ ...result, t: 'host_result', id: msg.id });
      return;
    }
    if (msg.t === 'request') {
      const question = String(msg.question);
      // A shell command's card is "Run a command that can change files in …" with the command as the body's first line.
      const command = /^Run a command/.test(question) ? String(msg.body ?? '').split('\n')[0] : '';
      // Allowed: the engine's press card; edits to Swift source (never the scripts or data/todos.json, so the result
      // cannot be written by hand); the listed commands. Denied: everything else.
      const swiftEdit = /^(Edit|Replace the contents of|Create file) “[^”]+\.swift”$/.test(question);
      const allow = /press “/i.test(question) || swiftEdit || (command ? allowedCommand(command) : false);
      const choice = (msg.options || []).find((o) => (allow ? /^allow$/i : /^(deny|no|reject|cancel)/i).test(o)) ?? '';
      evidence.engineRequests.push({ question: String(msg.question).slice(0, 300), command: command.slice(0, 200), answered: choice });
      send({ t: 'reply', id: msg.id, value: choice });
      return;
    }
    if (msg.t === 'event' && msg.name === 'tool_call') {
      const call = msg.args?.[0] || {};
      const name = call.toolName ?? call.name;
      if (name && !evidence.toolCalls.some((c) => c.id === call.id)) evidence.toolCalls.push({ id: call.id, name, input: String(call.input ?? JSON.stringify(call.args ?? '')).slice(0, 300) });
    }
    if (msg.t === 'event' && msg.name === 'message') {
      const m = msg.args?.[0] || {};
      if (m.level === 'error') evidence.errors.push(String(m.content).slice(0, 400));
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) { evidence.answer = m.content.trim().slice(0, 1500); answered = true; }
    }
    if (msg.t === 'event' && msg.name === 'spinner_state' && msg.args?.[0] === 'idle' && sent && answered) {
      await end(0, `DONE — ${evidence.toolCalls.length} tool call(s), ${evidence.hostCalls.length} host call(s).`);
    }
  });
  worker.on('exit', (code) => { if (!finished) void end(1, `FAIL — engine exited (code ${code})\n${stderrTail}`); });
  setTimeout(() => { void end(1, `FAIL — timed out after ${LIMIT_MS / 60000} min`); }, LIMIT_MS);
});
