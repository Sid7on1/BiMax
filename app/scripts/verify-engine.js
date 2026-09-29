#!/usr/bin/env electron
/**
 * Run the engine bundle Bimax actually ships, the way Bimax actually runs it, and require it to
 * answer.
 *
 * This exists because "the packaged artifact is untested" has bitten this repo repeatedly: v1.1.0
 * shipped a sidecar stub that exited 1, packaging.sidecar.test.ts threw ENOENT for weeks, and every
 * gate stayed green throughout because none of them ever executed the staged artifact. A unit test
 * that reads a shell script proves the script SAYS the right thing. This runs the real file the way the app does — a
 * worker thread inside this Electron process, over a MessagePort (record 64) — and speaks the real protocol to it.
 *
 * Four exchanges, none of which calls a model, so this is free and deterministic:
 *   ping        — the smallest possible round trip: the port carries a message and a reply comes back
 *   configGet   — a correlated request/response with a real body
 *   catalogGet  — ~36 KB outbound, which is what actually exercises the channel
 *   query       — the completions channel, i.e. the slash-command registry really loaded
 *
 * A fifth check, `folder`: an `@` query must suggest a file that exists only in the scratch project, i.e. the engine
 * really works in the task's folder. Under a worker thread that is not free — a worker cannot chdir — and it is exactly
 * what the first monolith probe got silently wrong (record 64).
 *
 * Two messages the engine sends on its own, `boot` and `health`, must arrive on the PROTOCOL channel. Both used to be
 * written straight to stdout, which over the monolith's port is only a log: every exchange above still passed while the
 * supervisor saw no start-up phase and no heartbeat, so its hang detection (armed by the first heartbeat) was off.
 *
 * Usage:  npx electron scripts/verify-engine.js [path/to/index.js] [--turn]
 * Default target is app/engine/index.js — what prepare-engine.sh builds and electron-builder packs.
 * There is one host since record 64's M4: the separate engine process (utilityProcess) this used to fork by default is
 * gone from the app and from the engine. `--worker`, which selected the worker, is still accepted and changes nothing.
 *
 * `--turn` additionally runs ONE real model turn. It is opt-in, not part of the build gate, because
 * it needs a configured provider key and costs money — a packaging gate that fails on a machine
 * without credentials, or that bills per build, is a gate people start skipping.
 */
const { app } = require('electron');
const { Worker, MessageChannel } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { existsSync, mkdtempSync } = fs;
const { tmpdir } = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const target = process.argv[2] && !process.argv[2].startsWith('-')
  ? path.resolve(process.argv[2])
  : path.join(appRoot, 'engine', 'index.js');

const wantsTurn = process.argv.includes('--turn');
let turnSent = false;
let tokens = 0;

const expected = new Map([
  ['pong', 'ping'],
  ['configResult', 'configGet'],
  ['catalogResult', 'catalogGet'],
  ['queryResult', 'query (slash-command completions)'],
  ['folder', "query '@VerifyProbe' found the project's own file"],
  ['boot', 'a start-up phase, on the protocol channel'],
  ['health', 'a heartbeat, on the protocol channel (arms the hang watchdog)'],
]);

let done = false;
const finish = (code, msg) => { if (done) return; done = true; console.log(msg); app.exit(code); };

app.whenReady().then(() => {
  if (!existsSync(target)) {
    return finish(1, `FAIL — no engine bundle at ${target}\n       run: npm --prefix app run prepare:engine`);
  }
  console.log(`verifying ${target}`);

  // A scratch project, so verification never reads or writes a real one.
  const project = mkdtempSync(path.join(tmpdir(), 'bimax-verify-'));

  fs.writeFileSync(path.join(project, 'VerifyProbeFile.md'), 'x');
  const env = { ...process.env, BIMAX_HEADLESS: '1', BIMAX_CWD: project, BIMAX_ENGINE_MODULE: target };
  // The monolith's channel (record 64, M3): one protocol message per port message, acknowledged as handled.
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(target, { env, workerData: { bimaxEngineRoot: project, bimaxEnginePort: port2 }, transferList: [port2], stdout: true, stderr: true });
  worker.stdout.on('data', () => { /* logs, never protocol */ });
  const frames = new EventEmitter();
  port1.on('message', (frame) => {
    frames.emit('frame', typeof frame === 'string' ? frame : '');
    port1.postMessage({ t: '__ack', bytes: typeof frame === 'string' ? frame.length : 0 });
  });
  const engine = {
    send: (msg) => port1.postMessage(msg),
    kill: () => { void worker.terminate(); },
  };
  console.log('  (hosted as a worker thread in this process over a MessagePort — the monolith)');

  const got = new Map();
  let bytes = 0;
  let asked = false;

  frames.on('frame', (frame) => {
    const text = frame.trim();
    if (!text) return;
    bytes += text.length;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.t === 'ready' && !asked) {
      asked = true;
      for (const m of [{ t: 'ping', id: 1 }, { t: 'configGet', id: 2 }, { t: 'catalogGet', id: 3 }, { t: 'query', id: 4, text: '/' }, { t: 'query', id: 5, text: '@VerifyProbe' }]) {
        engine.send(m);
      }
    }

    // The folder check is the id-5 query; its answer must name the file only the scratch project has.
    let key = msg.t;
    if (msg.t === 'queryResult' && msg.id === 5) {
      if (!JSON.stringify(msg).includes('VerifyProbeFile.md')) {
        engine.kill();
        return finish(1, `FAIL — the engine is not working in the project's folder: '@VerifyProbe' suggested ${JSON.stringify(msg).slice(0, 200)}`);
      }
      key = 'folder';
    }
    if (expected.has(key) && !got.has(key)) {
      got.set(key, true);
      console.log(`  ok  ${key.padEnd(14)} ${String(text.length).padStart(7)} bytes  (${expected.get(key)})`);
      if (got.size === expected.size) {
        if (!wantsTurn) {
          engine.kill();
          return finish(0, `PASS — engine bundle answered all ${expected.size} exchanges (${bytes} bytes outbound).`);
        }
        if (!turnSent) {
          turnSent = true;
          console.log('  …running one real model turn (--turn)');
          engine.send({ t: 'input', text: 'Reply with exactly the two words: TRANSPORT OK' });
        }
      }
    }

    // The turn itself: streamed tokens and a finished assistant message, which is the path the
    // product actually runs on and the one the four exchanges above do not touch.
    if (wantsTurn && turnSent && msg.t === 'event') {
      if (msg.name === 'stream_token') tokens += 1;
      if (msg.name === 'message') {
        const m = msg.args?.[0] || {};
        if (m.level === 'error') {
          engine.kill();
          return finish(1, `FAIL — engine reported an error during the turn: ${String(m.content).slice(0, 400)}`);
        }
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
          engine.kill();
          return finish(0, `  ok  turn           ${String(tokens).padStart(7)} tokens  (assistant: ${JSON.stringify(m.content.trim().slice(0, 60))})\n`
            + `PASS — engine bundle answered all ${expected.size} exchanges and completed a live turn.`);
        }
      }
    }
  });

  let stderrTail = '';
  worker.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-800); });

  worker.on('exit', (code) => finish(1,
    `FAIL — engine exited (code ${code}) after answering: ${[...got.keys()].join(', ') || '(nothing)'}\n--- stderr tail ---\n${stderrTail}`));

  setTimeout(() => {
    engine.kill();
    finish(1, `FAIL — timed out. missing: ${[...expected.keys()].filter((k) => !got.has(k)).join(', ')}\n--- stderr tail ---\n${stderrTail}`);
  }, wantsTurn ? 240_000 : 120_000);
});
