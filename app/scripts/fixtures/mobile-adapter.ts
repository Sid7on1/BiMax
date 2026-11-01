import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ThreadManager } from '../../src/main/thread.manager';
import { RealEngineAdapter } from '../../src/main/responder/adapter';
import { ApprovalHook } from '../../src/main/responder/approval-hook';
import { ApprovalsGate } from 'desktop-responder';
// Aliased to the linked mobile checkout by the runner, never a test reimplementation.
import { buildApprovalDecision, signApprovalDecision } from 'mobile-phone-approvals';
import { generateEd25519Keypair } from '@bimax/core/crypto/keys';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'bimax-real-mobile-adapter-'));
  const delivered: Array<{ threadId: string; message: any }> = [];
  const requests: any[] = [];
  const disposed = new Set<string>();
  const phone = generateEd25519Keypair();
  const hook = new ApprovalHook();
  let adapter: RealEngineAdapter;
  const threads = new ThreadManager({
    engine: (threadId) => ({
      openProject() {},
      dispose() {
        disposed.add(threadId);
      },
      sendFromRenderer(message) {
        delivered.push({ threadId, message });
      },
    }),
    changed() {},
    selected() {},
    message() {},
    save() {},
    approval: (card) => adapter.handleThreadApproval(card),
    ended: (id) => hook.abortSession(id),
  });
  adapter = new RealEngineAdapter(threads, hook);
  const gate = new ApprovalsGate({
    enginePort: adapter,
    getPinnedPhoneHelloPubkey: () => Buffer.from(phone.publicKey).toString('base64'),
  });
  adapter.onApprovalRequest((request) => {
    const source = structuredClone(request);
    const stored = gate.registerRequest(source);
    source.sessionId = 'untrusted-mutation';
    assert.equal(stored.sessionId, request.sessionId);
    requests.push(stored);
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    const ids: string[] = [];
    for (const name of ['A', 'B']) {
      const directory = path.join(root, name);
      mkdirSync(directory);
      const id = threads.create(directory, '', 'project');
      ids.push(id);
      threads.start(id);
      threads.receive(id, { t: 'ready' });
      threads.select(id);
      await adapter.sendInstruction({ idempotencyKey: name, instruction: 'fixture only' });
      threads.receive(id, { t: 'request', id: 1, kind: 'prompt', question: name, options: ['Yes', 'No'] });
    }
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].approvalId, requests[1].approvalId);
    assert.equal(requests[0].sessionId, ids[0]);
    assert.equal(requests[1].sessionId, ids[1]);
    // Attempts to overwrite an existing capability cannot change its session or signed payload.
    assert.throws(() => gate.registerRequest({ ...requests[0], sessionId: ids[1] }), /different request/);
    const snapshot = { ...requests[0] };
    const signedA = signApprovalDecision(buildApprovalDecision(snapshot, 'approve'), phone.privateKey);
    assert.equal(gate.handleDecision({ ...signedA, sessionId: ids[1] }), false);
    assert.equal(gate.handleDecision({ ...signedA, signature: 'invalid' }), false);
    assert.equal(gate.handleDecision(signedA), true);
    assert.equal(gate.handleDecision(signedA), true); // acknowledged replay must never re-execute
    assert.equal(
      gate.handleDecision(signApprovalDecision(buildApprovalDecision(requests[1], 'deny'), phone.privateKey)),
      true,
    );
    await flush();
    const replies = delivered.filter((value) => value.message.t === 'reply');
    assert.deepEqual(
      replies,
      ids.map((threadId, i) => ({
        threadId,
        message: { t: 'reply', id: 1, value: i ? 'No' : 'Yes', approvalToken: requests[i].approvalId },
      })),
    );
    assert.throws(() => gate.registerRequest(snapshot), /consumed/);
    // A signed approval delivered immediately before Stop must not reach the engine.
    threads.receive(ids[0], { t: 'request', id: 2, kind: 'prompt', question: 'Stop fence', options: ['Yes', 'No'] });
    assert.equal(
      gate.handleDecision(signApprovalDecision(buildApprovalDecision(requests[2], 'approve'), phone.privateKey)),
      true,
    );
    threads.stop(ids[0], { keepInputs: false, reason: 'fixture Stop' });
    assert.equal(disposed.has(ids[0]), true);
    assert.equal(disposed.has(ids[1]), false);
    await flush();
    assert.equal(
      delivered.filter(
        (value) => value.message.t === 'reply' && value.message.id === 2 && value.message.value === 'Yes',
      ).length,
      0,
    );
    // Reading saved history must not select, start or submit a conversation.
    const selected = threads.activeId;
    const saved = threads.get(ids[0]);
    saved.state.items = [
      { kind: 'msg', msg: { id: 'u', role: 'user', content: 'Exact **user**', timestamp: new Date() } },
      { kind: 'msg', msg: { id: 'a', role: 'assistant', content: 'Exact α answer', timestamp: new Date() }, thought: 'Exact reasoning' },
    ];
    const beforeDelivered = delivered.length;
    const history = await adapter.getSessionHistory(ids[0]);
    assert.equal(threads.activeId, selected);
    assert.equal(delivered.length, beforeDelivered);
    assert.equal(threads.engine(ids[0]), undefined);
    assert.equal(history.messages[1].content, 'Exact α answer');
    assert.equal(history.messages[1].reasoning, 'Exact reasoning');
    await assert.rejects(adapter.getSessionHistory('unlisted'), /not found/i);
    const turn = adapter.chat({ idempotencyKey: 'resume-selected', sessionId: ids[0], text: 'resume saved chat' }, () => {});
    assert.ok(threads.engine(ids[0]));
    assert.equal(threads.activeId, selected);
    await assert.rejects(adapter.chat({ idempotencyKey: 'busy', sessionId: ids[0], text: 'second concurrent turn' }, () => {}), /idle/);
    adapter.handleTurnFinished(ids[0]);
    await turn;
    saved.state.items = [{ kind: 'msg', msg: { id:'large',role:'assistant',content:'x'.repeat(3 * 1024 * 1024 + 1),timestamp:new Date() } }];
    await assert.rejects(adapter.getSessionHistory(ids[0]), /limit/);
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 2,
        checks: [
          'real-phone-signature',
          'two-engine-request-1',
          'session-tamper-denied',
          'signature-tamper-denied',
          'single-execution-replay',
          'capability-overwrite-denied',
          'request-snapshot-immutable',
          'stop-before-execution',
          'saved-history-without-engine-or-selection',
          'exact-history-and-reasoning',
          'missing-history-refused',
          'stopped-selected-chat-resumes-without-switch',
          'concurrent-selected-chat-refused',
          'large-history-bounded',
        ],
        engineReplies: replies.length,
      }),
    );
  } finally {
    gate.destroy();
    threads.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
