#!/usr/bin/env electron
/**
 * Run the engine bundle Bimax actually ships, the way Bimax actually runs it, and require it to
 * answer.
 *
 * This exists because "the packaged artifact is untested" has bitten this repo repeatedly: v1.1.0
 * shipped a sidecar stub that exited 1, packaging.sidecar.test.ts threw ENOENT for weeks, and every
 * gate stayed green throughout because none of them ever executed the staged artifact. A unit test
 * that reads a shell script proves the script SAYS the right thing. This forks the real file with
 * Electron's real utilityProcess and speaks the real protocol to it.
 *
 * Four exchanges, none of which calls a model, so this is free and deterministic:
 *   ping        — the smallest possible round trip: the port carries a line and a reply comes back
 *   configGet   — a correlated request/response with a real body
 *   catalogGet  — ~36 KB outbound, which is what actually exercises the pipe
 *   query       — the completions channel, i.e. the slash-command registry really loaded
 *
 * Usage:  npx electron scripts/verify-engine.js [path/to/index.js] [--turn]
 * Default target is app/engine/index.js — what prepare-engine.sh builds and electron-builder packs.
 *
 * `--turn` additionally runs ONE real model turn. It is opt-in, not part of the build gate, because
 * it needs a configured provider key and costs money — a packaging gate that fails on a machine
 * without credentials, or that bills per build, is a gate people start skipping.
 */
const { app, utilityProcess } = require('electron');
const { createInterface } = require('node:readline');
const { existsSync, mkdtempSync } = require('node:fs');
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

  const child = utilityProcess.fork(target, [], {
    env: { ...process.env, BIMAX_HEADLESS: '1', BIMAX_CWD: project },
    cwd: appRoot,
    serviceName: 'Bimax Engine Verify',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const got = new Map();
  let bytes = 0;
  let asked = false;

  createInterface({ input: child.stdout }).on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    bytes += text.length;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.t === 'ready' && !asked) {
      asked = true;
      for (const m of [{ t: 'ping', id: 1 }, { t: 'configGet', id: 2 }, { t: 'catalogGet', id: 3 }, { t: 'query', id: 4, text: '/' }]) {
        child.postMessage(JSON.stringify(m) + '\n');   // newline: the engine frames on it
      }
    }

    if (expected.has(msg.t) && !got.has(msg.t)) {
      got.set(msg.t, true);
      console.log(`  ok  ${msg.t.padEnd(14)} ${String(text.length).padStart(7)} bytes  (${expected.get(msg.t)})`);
      if (got.size === expected.size) {
        if (!wantsTurn) {
          child.kill();
          return finish(0, `PASS — engine bundle answered all ${expected.size} exchanges (${bytes} bytes outbound).`);
        }
        if (!turnSent) {
          turnSent = true;
          console.log('  …running one real model turn (--turn)');
          child.postMessage(JSON.stringify({ t: 'input', text: 'Reply with exactly the two words: TRANSPORT OK' }) + '\n');
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
          child.kill();
          return finish(1, `FAIL — engine reported an error during the turn: ${String(m.content).slice(0, 400)}`);
        }
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
          child.kill();
          return finish(0, `  ok  turn           ${String(tokens).padStart(7)} tokens  (assistant: ${JSON.stringify(m.content.trim().slice(0, 60))})\n`
            + `PASS — engine bundle answered all ${expected.size} exchanges and completed a live turn.`);
        }
      }
    }
  });

  let stderrTail = '';
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-800); });

  child.on('exit', (code) => finish(1,
    `FAIL — engine exited (code ${code}) after answering: ${[...got.keys()].join(', ') || '(nothing)'}\n--- stderr tail ---\n${stderrTail}`));

  setTimeout(() => {
    child.kill();
    finish(1, `FAIL — timed out. missing: ${[...expected.keys()].filter((k) => !got.has(k)).join(', ')}\n--- stderr tail ---\n${stderrTail}`);
  }, wantsTurn ? 240_000 : 120_000);
});
