#!/usr/bin/env electron
// Several engines BUSY at once, hosted as the app hosts them: worker threads inside this process (the monolith), or
// with --process as separate utilityProcess engines (the fallback) — record 64, M2 gate.
// Usage (from app/): npx electron benchmarks/engines/busy-engines.probe.js <engineBundle> <seconds> <project>... [--process]
// Give each run FRESH project copies: an engine that has indexed a folder once is not busy the second time. Engine
// state goes to a `state-<name>` folder beside each project (BIMAX_STATE_DIR), so the projects stay untouched.
// Measures, each second: process RSS + app.getAppMetrics working set, the MAIN thread's event-loop delay (the UI
// thread), ping round trip to each engine, and each engine's heartbeat (heap, its own loop delay, gaps between beats).
const { app, utilityProcess } = require('electron');
const asProcess = process.argv.includes('--process');
const { Worker, MessageChannel } = require('node:worker_threads');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');

const [bundle, secondsArg, ...projects] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seconds = Number(secondsArg) || 90;
const HEAP_MB = 768; // ENGINE_WORKER_HEAP_MB

app.whenReady().then(async () => {
  const t0 = Date.now();
  const mainLoop = monitorEventLoopDelay({ resolution: 10 });
  mainLoop.enable();
  const engines = projects.map((project, i) => {
    const state = path.join(path.dirname(project), `state-${path.basename(project)}`);
    fs.mkdirSync(state, { recursive: true });
    const env = { ...process.env, BIMAX_HEADLESS: '1', BIMAX_CWD: project, WORKSPACE_ROOT: project, BIMAX_ENGINE_MODULE: bundle,
      BIMAX_STATE_DIR: state, BIMAX_SKIP_KEY_ONBOARDING: '1' };
    let worker, port1;
    if (asProcess) {
      // Today's fallback transport: a utilityProcess, NDJSON on stdout, commands as lines over its port.
      const child = utilityProcess.fork(bundle, [], { env, cwd: project, serviceName: `Bimax Engine ${i}`, stdio: ['ignore', 'pipe', 'pipe'] });
      const lines = new (require('node:events').EventEmitter)();
      let pbuf = '';
      child.stdout.on('data', (c) => { pbuf += c.toString(); let n; while ((n = pbuf.indexOf('\n')) !== -1) { const l = pbuf.slice(0, n); pbuf = pbuf.slice(n + 1); if (l.startsWith('{')) lines.emit('message', l); } });
      port1 = { on: (ev, fn) => lines.on(ev, fn), postMessage: (m) => { if (m && m.t !== '__ack') child.postMessage(JSON.stringify(m) + '\n'); }, close: () => {} };
      worker = { stdout: new (require('node:stream').PassThrough)(), stderr: child.stderr, on: (ev, fn) => child.on(ev === 'error' ? 'error' : 'exit', fn), terminate: async () => child.kill() };
    } else {
      const ch = new MessageChannel();
      port1 = ch.port1;
      worker = new Worker(bundle, { env, workerData: { bimaxEngineRoot: project, bimaxEnginePort: ch.port2 }, transferList: [ch.port2],
        stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: HEAP_MB }, name: `Bimax Engine ${i}` });
    }
    const e = { i, project, worker, port: port1, readyAt: null, beats: [], maxGapMs: 0, lastBeat: null, pings: [], pending: new Map(),
      log: [], exited: null, heapPeak: 0, loopPeak: 0 };
    const logLine = (s) => { const t = ((Date.now() - t0) / 1000).toFixed(1); if (/Indexing|Graph saved|CodeIndex|code index|indexed|Error|error|FATAL/i.test(s)) e.log.push(`${t}s ${s.slice(0, 160)}`); };
    let buf = '';
    const onData = (c) => { buf += c.toString(); let n; while ((n = buf.indexOf('\n')) !== -1) { logLine(buf.slice(0, n)); buf = buf.slice(n + 1); } };
    worker.stdout.on('data', onData); worker.stderr.on('data', onData);
    worker.on('exit', (code) => { e.exited = { code, at: (Date.now() - t0) / 1000 }; });
    worker.on('error', (err) => { e.log.push(`ERROR ${err.message}`); });
    port1.on('message', (frame) => {
      if (typeof frame !== 'string') return;
      port1.postMessage({ t: '__ack', bytes: frame.length });
      let m; try { m = JSON.parse(frame); } catch { return; }
      const now = Date.now();
      if (m.t === 'ready' && !e.readyAt) e.readyAt = now - t0;
      if (m.t === 'health') {
        if (e.lastBeat) e.maxGapMs = Math.max(e.maxGapMs, now - e.lastBeat);
        e.lastBeat = now;
        e.heapPeak = Math.max(e.heapPeak, m.heapMb); e.loopPeak = Math.max(e.loopPeak, m.eventLoopDelayMs);
        e.beats.push({ at: now - t0, heapMb: m.heapMb, loop: m.eventLoopDelayMs });
      }
      if (m.t === 'pong' && e.pending.has(m.id)) { e.pings.push({ at: now - t0, rtt: now - e.pending.get(m.id) }); e.pending.delete(m.id); }
    });
    return e;
  });

  const samples = [];
  let pingId = 1;
  const timer = setInterval(async () => {
    const metrics = app.getAppMetrics();
    const workingSetMb = metrics.reduce((s, m) => s + (m.memory?.workingSetSize || 0), 0) / 1024;
    const mainWs = (metrics.find((m) => m.type === 'Browser')?.memory?.workingSetSize || 0) / 1024;
    samples.push({ at: Date.now() - t0, rssMb: process.memoryUsage().rss / 1048576, workingSetMb, mainWsMb: mainWs,
      mainLoopP99: mainLoop.percentile(99) / 1e6, mainLoopMax: mainLoop.max / 1e6 });
    mainLoop.reset();
    for (const e of engines) {
      if (e.exited || !e.readyAt) continue;
      // A ping still unanswered from last time counts as its age: a wedged engine must not look fast.
      for (const [id, sent] of e.pending) if (Date.now() - sent > 5000) { e.pings.push({ at: Date.now() - t0, rtt: Date.now() - sent, unanswered: true }); e.pending.delete(id); }
      const id = pingId++; e.pending.set(id, Date.now()); e.port.postMessage({ t: 'ping', id });
    }
  }, 1000);

  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(timer);
  const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
  const out = {
    transport: asProcess ? 'utilityProcess' : 'worker', engines: projects.length, seconds,
    memory: { rssPeakMb: q(samples.map((s) => s.rssMb), 1), rssMedianMb: q(samples.map((s) => s.rssMb), 0.5),
      workingSetPeakMb: q(samples.map((s) => s.workingSetMb), 1), browserWsPeakMb: q(samples.map((s) => s.mainWsMb), 1) },
    mainThread: { loopP99Median: q(samples.map((s) => s.mainLoopP99), 0.5), loopP99Worst: q(samples.map((s) => s.mainLoopP99), 1),
      loopMaxWorst: q(samples.map((s) => s.mainLoopMax), 1) },
    perEngine: engines.map((e) => ({ i: e.i, readyMs: e.readyAt, exited: e.exited, heapPeakMb: e.heapPeak, ownLoopPeakMs: e.loopPeak,
      heartbeats: e.beats.length, maxHeartbeatGapMs: e.maxGapMs,
      pingMedianMs: q(e.pings.map((p) => p.rtt), 0.5), pingP95Ms: q(e.pings.map((p) => p.rtt), 0.95), pingMaxMs: q(e.pings.map((p) => p.rtt), 1),
      unansweredPings: e.pings.filter((p) => p.unanswered).length, log: e.log.slice(0, 8) })),
  };
  console.log('PROBE_RESULT ' + JSON.stringify(out, null, 2));
  for (const e of engines) { try { e.port.close(); } catch {} void e.worker.terminate(); }
  setTimeout(() => app.exit(0), 500);
});
