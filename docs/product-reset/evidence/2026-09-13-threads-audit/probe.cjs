// Read-only product audit. Uses the real manager/storage and temporary fixture files.
// Assertions describe reproduced CURRENT defects, not acceptance of desired behavior.
// Run from repository root: node -r ts-node/register/transpile-only docs/product-reset/evidence/2026-09-13-threads-audit/probe.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ThreadManager } = require('../../../../app/src/main/thread.manager.ts');
const { ThreadStorage } = require('../../../../app/src/main/thread.storage.ts');
const { sandboxArgv, sandboxBin } = require('../../../../src/sandbox/exec.sandbox.ts');
const results = [];
function fixture(saved = []) {
  const engines = new Map();
  const snapshots = new Map();
  const manager = new ThreadManager({
    engine(id) {
      const e = { calls: [], openProject() {}, dispose() {}, sendFromRenderer(m) { e.calls.push(m); } };
      engines.set(id, e); return e;
    },
    save(v) { snapshots.set(v.summary.id, JSON.parse(JSON.stringify(v))); },
    selected() {}, changed() {}, message() {}, approval() {},
  }, saved);
  return { manager, engines, snapshots,
    ready(id) { manager.receive(id, { t: 'ready', protocol: 3 }); },
    idle(id) { manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', 'Ready'] }); },
  };
}
function record(id, observation) { results.push({ id, reproduced: true, observation }); }
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-strategy-audit-'));
  try {
    // Accepted-but-not-started work disappears from the persisted representation.
    const f = fixture(), id = f.manager.create('/fixture/a', 'first'); f.ready(id);
    f.manager.submit(id, 'UNIQUE_PENDING_MESSAGE');
    const saved = f.snapshots.get(id);
    assert.equal(JSON.stringify(saved).includes('UNIQUE_PENDING_MESSAGE'), false);
    const restored = fixture([saved]); restored.manager.submit(id, 'new message'); restored.ready(id);
    assert.deepEqual(restored.engines.get(id).calls, [{ t: 'input', text: 'new message' }]);
    record('T01', 'Accepted queued prompt absent from persisted snapshot and absent after restoration.');

    // Missing restore acknowledgement leaves the thread unable to dispatch queued input.
    saved.summary.sessionId = 'missing-session';
    const missing = fixture([saved]); missing.manager.submit(id, 'Continue'); missing.ready(id);
    missing.manager.receive(id, { t: 'event', name: 'message', args: [{ role: 'system', content: 'No session matching missing-session', id: 'err' }] });
    missing.idle(id);
    assert.deepEqual(missing.engines.get(id).calls, [{ t: 'resume', id: 'missing-session' }]);
    assert.equal(missing.manager.get(id).ready, false);
    record('T02', 'Resume error plus idle leaves ready=false and Continue undispatched; no manager timeout/failure transition.');

    // Fatal lifecycle event leaves a non-startable engine reference in the manager.
    const fatal = fixture(), fatalId = fatal.manager.create('/fixture/fatal', 'work'); fatal.ready(fatalId);
    const oldEngine = fatal.engines.get(fatalId);
    fatal.manager.lifecycle(fatalId, 'failed', 'restart budget exhausted');
    fatal.manager.start(fatalId);
    assert.equal(fatal.engines.get(fatalId), oldEngine);
    assert.equal(fatal.manager.get(fatalId).summary.status, 'stopped');
    record('T03', 'Thread start/Resume after terminal failed lifecycle does not create an engine; stale reference remains.');

    // ThreadManager has no process-drained acknowledgement before another writer dispatches.
    const writers = fixture(), a = writers.manager.create('/fixture/shared', 'writer A'), b = writers.manager.create('/fixture/shared', 'writer B');
    writers.ready(a); writers.ready(b);
    assert.equal(writers.engines.get(b).calls.length, 0);
    writers.manager.stop(a);
    assert.deepEqual(writers.engines.get(b).calls, [{ t: 'input', text: 'writer B' }]);
    record('T04', 'Second same-folder writer dispatches immediately when stop returns, without a child-exit/drain acknowledgement. Real lingering-process overlap is not exercised here.');

    // A real filesystem failure permanently rejects the serialized promise chain.
    const storePath = path.join(tmp, 'store'); const storage = new ThreadStorage(storePath);
    fs.rmdirSync(storePath); fs.writeFileSync(storePath, 'temporary obstruction');
    storage.save(saved); await assert.rejects(storage.flush());
    fs.unlinkSync(storePath); fs.mkdirSync(storePath);
    storage.save(saved); await assert.rejects(storage.flush());
    assert.equal(fs.readdirSync(storePath).length, 0);
    record('T05', 'One actual storage write failure prevents later flushes even after the filesystem is repaired.');

    // Prove scope limitation using only synthetic data owned by this probe.
    const root = path.join(tmp, 'workspace'); fs.mkdirSync(root);
    const outside = path.join(tmp, 'sibling-data.txt'); fs.writeFileSync(outside, 'AUDIT_FIXTURE_ONLY');
    const prior = process.env.BIMAX_THREAD_ROOT; process.env.BIMAX_THREAD_ROOT = root;
    try {
      const bin = sandboxBin(); assert.ok(bin, 'Real OS sandbox required');
      const quote = v => "'" + v.replace(/'/g, "'\\''") + "'";
      const output = execFileSync(bin, sandboxArgv('cat ' + quote(outside), root), { encoding: 'utf8' });
      assert.equal(output, 'AUDIT_FIXTURE_ONLY');
      record('T06', 'Real thread shell sandbox can read a synthetic sibling file outside its folder; it is a write boundary, not read confidentiality.');
    } finally { if (prior === undefined) delete process.env.BIMAX_THREAD_ROOT; else process.env.BIMAX_THREAD_ROOT = prior; }

    const files = ['app/src/main/thread.manager.ts', 'app/src/main/thread.storage.ts', 'app/src/main/thread.broker.ts', 'app/src/main/supervisor/supervisor.ts', 'src/sandbox/exec.sandbox.ts'];
    const sourceHashes = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
    console.log(JSON.stringify({ date: new Date().toISOString(), platform: process.platform, arch: process.arch,
      scope: 'Six targeted current-behavior probes; no live model, native CU, crash-kill, or competitive qualification.', sourceHashes, results }, null, 2));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
