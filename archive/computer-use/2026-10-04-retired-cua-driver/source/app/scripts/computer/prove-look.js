#!/usr/bin/env electron
/**
 * Record 65 stage 2 exit evidence: one whole observed session, end to end, with nothing faked but the person.
 *
 * Real: the engine bundle the app ships (app/engine/index.js, a worker thread over a MessagePort, as the app runs it),
 * a real model turn, the app's own look service and Cua Driver 0.31 embedded in this process, and the archived
 * BimaxCuFixture app. Played: the person, who answers the grant card ("allow" or "deny"). Counted, not claimed: the
 * driver's own activity observer, the service's counts, the fixture's status line before and after, every tool the
 * engine called and every host call it made.
 *
 *   npx electron scripts/computer/prove-look.js --mode allow|deny|off --out <evidence.json>
 *
 * Run it from a terminal that holds Accessibility (the driver attributes to the responsible process), with
 * BimaxCuFixture.app open and visible and the terminal in front. "off" runs the same turn with looking turned off:
 * the engine must have no such tool, make no host call, and the driver must never start.
 */
const { app } = require('electron');
const { Worker, MessageChannel } = require('node:worker_threads');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const mode = arg('mode', 'allow');
const outPath = path.resolve(arg('out', path.join(os.tmpdir(), `prove-look-${mode}.json`)));
const target = path.join(appRoot, 'engine', 'index.js');
const PROMPT = 'Use LookAtAppTool to look at the app named BimaxCuFixture, then tell me the exact text of its status line, '
  + "which starts with 'presses='. Do nothing else: no files, no shell, no other tools.";
const LIMIT_MS = 20 * 60 * 1000;

function loadLookModules() {
  const esbuild = require(path.join(appRoot, 'node_modules', 'esbuild'));
  const outfile = path.join(os.tmpdir(), `bimax-look-modules-${process.pid}.cjs`);
  esbuild.buildSync({
    stdin: {
      contents: "export * from './look.service'; export * from './look.driver'; export * from './look.manifest';",
      resolveDir: path.join(appRoot, 'src', 'main', 'computer'), loader: 'ts', sourcefile: 'proof-entry.ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error',
  });
  return require(outfile);
}

let finished = false;
const evidence = { mode, prompt: PROMPT, startedAt: new Date().toISOString(), toolCalls: [], hostCalls: [], cards: [], engineRequests: [], errors: [] };
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
  const look = loadLookModules();
  const driverStarted = { value: false };
  const lookDriver = mode === 'off' ? null : look.createLookDriver({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-look-state-')), packaged: false, resourcesPath: '', appPath: appRoot,
  });
  const driver = async () => { driverStarted.value = true; return lookDriver; };
  const service = look.createLookService({
    enabled: () => mode !== 'off',
    driver,
    ask: async (threadId, question, options, body) => {
      const answer = mode === 'allow' ? options[0] : options[1];
      evidence.cards.push({ threadId, question, options, body, answer });
      return answer;
    },
    audit: (entry) => { (evidence.audit ??= []).push(entry); },
  });

  // The fixture's status line, read by a separate reader so the task's own session counts stay its own.
  const readFixture = async () => {
    if (!lookDriver) return null;
    const fixture = (await lookDriver.runningApps()).find((a) => a.bundleId === 'ai.bimax.cu.fixture');
    if (!fixture) throw new Error('BimaxCuFixture.app is not open');
    const window = await lookDriver.look('proof-reader', fixture);
    return /presses=\d+ events=\d+ last=[a-z]+/.exec(window.markdown)?.[0] ?? null;
  };
  try { evidence.fixtureBefore = await readFixture(); } catch (e) { return finish(2, `INVALID — ${e?.inner?.reason ?? e.message}`); }

  const project = fs.mkdtempSync(path.join(os.homedir(), 'Library', 'Caches', 'bimax-look-proof-'));
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), 'Library', 'Caches', 'bimax-look-proof-state-'));
  const env = { ...process.env, BIMAX_HEADLESS: '1', BIMAX_CWD: project, WORKSPACE_ROOT: project, BIMAX_STATE_DIR: stateDir, BIMAX_ENGINE_MODULE: target };
  if (mode === 'off') delete env.BIMAX_COMPUTER_LOOK; else env.BIMAX_COMPUTER_LOOK = '1';

  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(target, { env, workerData: { bimaxEngineRoot: project, bimaxEnginePort: port2 }, transferList: [port2], stdout: true, stderr: true });
  worker.stdout.on('data', () => {});
  let stderrTail = '';
  worker.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-1200); });
  const send = (msg) => port1.postMessage(msg);
  const threadId = 'proof-thread';
  let sent = false;
  let answered = false;

  const end = async (code, note) => {
    try { evidence.fixtureAfter = await readFixture(); } catch (e) { evidence.errors.push(`fixture after: ${e.message}`); }
    evidence.serviceCounts = service.counts(threadId) ?? null;
    evidence.driverStarted = driverStarted.value;
    if (lookDriver) {
      evidence.driverActivity = { task: lookDriver.activity(threadId), reader: lookDriver.activity('proof-reader') };
      evidence.authorizedInputTools = look.inputToolsIn(evidence.driverActivity.task.authorized, look.INPUT_TOOLS);
    }
    void worker.terminate();
    finish(code, note);
  };

  port1.on('message', async (frame) => {
    port1.postMessage({ t: '__ack', bytes: typeof frame === 'string' ? frame.length : 0 });
    let msg;
    try { msg = JSON.parse(String(frame)); } catch { return; }
    if (msg.t === 'ready' && !sent) {
      sent = true;
      send({ t: 'input', text: PROMPT });
      return;
    }
    if (msg.t === 'host_call') {
      evidence.hostCalls.push({ op: msg.op, args: msg.args });
      const result = await service.handle(threadId, msg);
      send({ ...result, t: 'host_result', id: msg.id });
      return;
    }
    if (msg.t === 'request') {
      // Not the grant card (the app raises that itself): an engine approval. Only the look tool may be approved.
      const approve = /LookAtAppTool/i.test(`${msg.question} ${msg.body ?? ''}`);
      const choice = (msg.options || []).find((o) => (approve ? /^(allow|yes|approve)/i : /^(deny|no|reject|cancel)/i).test(o)) ?? (msg.options || [])[0] ?? '';
      evidence.engineRequests.push({ question: String(msg.question).slice(0, 300), options: msg.options, answered: choice });
      send({ t: 'reply', id: msg.id, value: choice });
      return;
    }
    if (msg.t === 'event' && msg.name === 'tool_call') {
      const call = msg.args?.[0] || {};
      const name = call.toolName ?? call.name;
      if (name && !evidence.toolCalls.some((c) => c.id === call.id)) evidence.toolCalls.push({ id: call.id, name });
    }
    if (msg.t === 'event' && msg.name === 'message') {
      const m = msg.args?.[0] || {};
      if (m.level === 'error') evidence.errors.push(String(m.content).slice(0, 400));
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) { evidence.answer = m.content.trim().slice(0, 600); answered = true; }
    }
    if (msg.t === 'event' && msg.name === 'spinner_state' && msg.args?.[0] === 'idle' && sent && answered) {
      await end(0, `DONE — mode ${mode}: ${evidence.toolCalls.length} tool call(s), ${evidence.hostCalls.length} host call(s).`);
    }
  });
  worker.on('exit', (code) => { if (!finished) void end(1, `FAIL — engine exited (code ${code})\n${stderrTail}`); });
  setTimeout(() => { void end(1, `FAIL — timed out after ${LIMIT_MS / 60000} min`); }, LIMIT_MS);
});
