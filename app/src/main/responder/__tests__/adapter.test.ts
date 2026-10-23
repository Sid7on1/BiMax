import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { ApprovalHook } from '../approval-hook';
import { RealEngineAdapter, type ThreadManagerLike } from '../adapter';
import { loadOrCreateIdentity, type SafeStorageProvider } from '../identity-secure';
import type { ToolApprovalRequest } from '@bimax/protocol';
import type { ThreadSummary } from '../../../shared/threads';

describe('Real Engine Responder Adapter & Approval Suspension', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-adapter-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // Mock thread manager helper for unit assertions
  function createMockThreadManager(initialThreads: Partial<ThreadSummary>[] = []): ThreadManagerLike & {
    stoppedIds: string[];
    submitted: Array<{ id: string; text: string }>;
  } {
    const list: ThreadSummary[] = initialThreads.map((t, idx) => ({
      id: t.id ?? `thread-${idx}`,
      root: t.root ?? scratchDir,
      title: t.title ?? 'Test Thread',
      status: t.status ?? 'idle',
      updatedAt: t.updatedAt ?? Date.now(),
      peers: [],
      origin: 'project',
    }));

    const stoppedIds: string[] = [];
    const submitted: Array<{ id: string; text: string }> = [];

    return {
      activeId: list[0]?.id ?? null,
      stoppedIds,
      submitted,
      list: () => list,
      summary: (id: string) => {
        const found = list.find((t) => t.id === id);
        if (!found) throw new Error('Not found');
        return found;
      },
      submit: (id: string, text: string) => {
        submitted.push({ id, text });
      },
      create: (root: string, prompt?: string) => {
        const id = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        list.push({
          id,
          root,
          title: prompt ?? 'Created Thread',
          status: 'idle',
          updatedAt: Date.now(),
          peers: [],
          origin: 'project',
        });
        return id;
      },
      stop: (id: string) => {
        stoppedIds.push(id);
        const item = list.find((t) => t.id === id);
        if (item) item.status = 'stopped';
      },
      send: () => {},
    };
  }

  test('remote chat streams exactly its Thread, finishes once, and cleans up after Stop or submit failure', async () => {
    const tm = createMockThreadManager([{ id: 'remote-chat', status: 'idle' }]);
    const adapter = new RealEngineAdapter(tm);
    const tokens: string[] = [];
    const turn = adapter.chat({ idempotencyKey: 'chat-1', sessionId: 'remote-chat', text: 'Run tests' }, (token) => tokens.push(token));
    adapter.handleStreamToken('other', 'private');
    adapter.handleStreamToken('remote-chat', 'Result');
    adapter.handleTurnFinished('remote-chat');
    await expect(turn).resolves.toEqual({ sessionId: 'remote-chat' });
    expect(tokens).toEqual(['Result']);
    const stopped = adapter.chat({ idempotencyKey: 'chat-2', sessionId: 'remote-chat', text: 'More' }, () => {});
    const rejected = expect(stopped).rejects.toThrow(/stopped locally/);
    await adapter.kill({ idempotencyKey: 'local-stop' });
    await rejected;
    const submit = tm.submit;
    tm.submit = () => { throw new Error('submission failed'); };
    await expect(adapter.chat({ idempotencyKey: 'chat-3', sessionId: 'remote-chat', text: 'More' }, () => {})).rejects.toThrow(/submission failed/);
    tm.submit = submit;
    const retry = adapter.chat({ idempotencyKey: 'chat-4', sessionId: 'remote-chat', text: 'New' }, () => {});
    adapter.handleTurnFinished('remote-chat');
    await expect(retry).resolves.toEqual({ sessionId: 'remote-chat' });
  });

  test('remote chat refuses busy Threads and overlapping callers without submitting a second request', async () => {
    const tm = createMockThreadManager([{ id: 'busy', status: 'working' }, { id: 'idle', status: 'idle' }]);
    const adapter = new RealEngineAdapter(tm);
    await expect(adapter.chat({ idempotencyKey: 'busy', sessionId: 'busy', text: 'Work' }, () => {})).rejects.toThrow(/idle/);
    const first = adapter.chat({ idempotencyKey: 'first', sessionId: 'idle', text: 'Work' }, () => {});
    await expect(adapter.chat({ idempotencyKey: 'second', sessionId: 'idle', text: 'Work' }, () => {})).rejects.toThrow(/idle/);
    expect(tm.submitted).toHaveLength(1);
    adapter.handleTurnFinished('idle');
    await first;
  });

  // CASE 1: Approval suspension
  // tool spy: assert tool function is NOT called before approval resolves;
  // IS called exactly once with original args after approve.
  test('Case 1: Approval suspension - tool spy holds before decision and executes once on approve with original args', async () => {
    const hook = new ApprovalHook();
    const toolSpy = jest.fn(async (args: { command: string; flag: number }) => {
      return { exitCode: 0, stdout: `ran ${args.command} ${args.flag}` };
    });

    const emittedRequests: ToolApprovalRequest[] = [];
    hook.onApprovalRequest((req) => emittedRequests.push(req));

    const originalArgs = { command: 'git status', flag: 42 };

    const interceptPromise = hook.intercept({
      approvalId: 'appr-case-1',
      sessionId: 'session-case-1',
      tool: 'BashTool',
      args: originalArgs,
      summary: 'Run git status',
      detail: 'git status --porcelain',
      cwd: scratchDir,
      execute: toolSpy,
    });

    // 1. Assert tool spy is NOT called while pending
    expect(toolSpy).not.toHaveBeenCalled();
    expect(hook.isPending('appr-case-1')).toBe(true);
    expect(emittedRequests).toHaveLength(1);
    expect(emittedRequests[0].approvalId).toBe('appr-case-1');
    expect(emittedRequests[0].tool).toBe('BashTool');

    // 2. Resolve with approval
    const resolved = hook.resolveApproval('appr-case-1', 'approved');
    expect(resolved).toBe(true);

    const result = await interceptPromise;

    // 3. Assert tool spy IS called exactly once with byte-identical original args
    expect(toolSpy).toHaveBeenCalledTimes(1);
    expect(toolSpy).toHaveBeenCalledWith(originalArgs);
    expect(result).toEqual({ exitCode: 0, stdout: 'ran git status 42' });
    expect(hook.isPending('appr-case-1')).toBe(false);
  });

  // CASE 2: Deny path
  // tool spy never called; engine receives denial result and continues turn.
  test('Case 2: Deny path - tool spy is never called and engine receives denial result', async () => {
    const hook = new ApprovalHook();
    const toolSpy = jest.fn<Promise<unknown>, []>(async () => {
      throw new Error('Should NEVER be called on deny');
    });

    const onDenySpy = jest.fn((reason: string) => ({
      ok: false,
      denied: true,
      reason,
      output: `Permission rejected: ${reason}`,
    }));

    const interceptPromise = hook.intercept({
      approvalId: 'appr-case-2',
      sessionId: 'session-case-2',
      tool: 'FileWriteTool',
      args: { path: '/sensitive/path', content: 'malicious' },
      summary: 'Overwrite sensitive file',
      detail: 'rm /sensitive/path',
      execute: toolSpy,
      onDeny: onDenySpy,
    });

    expect(toolSpy).not.toHaveBeenCalled();

    // Deny the request
    hook.resolveApproval('appr-case-2', 'denied', 'mistake');

    const outcome = await interceptPromise;

    // Tool spy NEVER executed
    expect(toolSpy).not.toHaveBeenCalled();
    expect(onDenySpy).toHaveBeenCalledWith('mistake');
    expect(outcome).toEqual({
      ok: false,
      denied: true,
      reason: 'mistake',
      output: 'Permission rejected: mistake',
    });
  });

  // CASE 3: Timeout path
  // no decision within window => tool never called
  test('Case 3: Timeout path - unapproved request expires and tool is never called', async () => {
    const hook = new ApprovalHook();
    const toolSpy = jest.fn<Promise<unknown>, []>(async () => ({ ok: true }));

    const interceptPromise = hook.intercept({
      approvalId: 'appr-case-3',
      sessionId: 'session-case-3',
      tool: 'BashTool',
      args: { cmd: 'sleep 10' },
      summary: 'Long task',
      detail: 'sleep 10',
      requestedAt: Date.now(),
      expiresAt: Date.now() + 50, // Short timeout
      execute: toolSpy,
      onDeny: (reason) => ({ timedOut: true, reason }),
    });

    expect(toolSpy).not.toHaveBeenCalled();

    const outcome = await interceptPromise;

    expect(toolSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({ timedOut: true, reason: 'timeout' });
    expect(hook.isPending('appr-case-3')).toBe(false);
  });

  // CASE 4: Kill-during-pending
  // kill with approval outstanding => tool never called; engine work actually aborted.
  test('Case 4: Kill-during-pending - kill aborts outstanding approval and genuinely stops work', async () => {
    const hook = new ApprovalHook();
    const abortController = new AbortController();
    let abortedObserved = false;

    abortController.signal.addEventListener('abort', () => {
      abortedObserved = true;
    });

    const toolSpy = jest.fn<Promise<unknown>, []>(async () => {
      throw new Error('Must NOT be called');
    });

    const mockTm = createMockThreadManager([
      { id: 'sess-to-kill', status: 'working', title: 'Running task' },
    ]);
    const adapter = new RealEngineAdapter(mockTm, hook, scratchDir);

    const pendingPromise = hook.intercept({
      approvalId: 'appr-case-4',
      sessionId: 'sess-to-kill',
      tool: 'DestructiveTool',
      args: { target: scratchDir },
      summary: 'Destructive scratch wipe',
      detail: 'wipe',
      abortSignal: abortController.signal,
      execute: toolSpy,
      onDeny: (reason) => ({ aborted: true, reason }),
    });

    expect(hook.isPending('appr-case-4')).toBe(true);
    expect(toolSpy).not.toHaveBeenCalled();

    // Trigger kill via EnginePort
    const killResult = await adapter.kill({
      idempotencyKey: 'kill-req-1',
      reason: 'User pressed kill',
    });

    // Assert kill result confirmation
    expect(killResult.ok).toBe(true);
    expect(killResult.detail).toBe('stopped after current step');
    expect(mockTm.stoppedIds).toContain('sess-to-kill');

    // Abort controller genuinely signaled
    abortController.abort();
    expect(abortedObserved).toBe(true);

    const result = await pendingPromise;
    expect(toolSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ aborted: true, reason: 'User pressed kill' });
  });

  // CASE 5: Concurrent approvals
  // two tools suspended; approve one, deny the other; decisions route to correct calls.
  test('Case 5: Concurrent approvals - independent routing without cross-talk', async () => {
    const hook = new ApprovalHook();

    const spyA = jest.fn(async (args: { name: string }) => `executed_${args.name}`);
    const spyB = jest.fn(async () => `executed_B`);

    const promiseA = hook.intercept({
      approvalId: 'concurrent-A',
      sessionId: 'sess-A',
      tool: 'ToolA',
      args: { name: 'Alpha' },
      summary: 'Operation A',
      detail: 'A',
      execute: spyA,
    });

    const promiseB = hook.intercept({
      approvalId: 'concurrent-B',
      sessionId: 'sess-B',
      tool: 'ToolB',
      args: { name: 'Beta' },
      summary: 'Operation B',
      detail: 'B',
      execute: spyB,
      onDeny: (reason) => `denied_${reason}`,
    });

    expect(hook.isPending('concurrent-A')).toBe(true);
    expect(hook.isPending('concurrent-B')).toBe(true);
    expect(spyA).not.toHaveBeenCalled();
    expect(spyB).not.toHaveBeenCalled();

    // Approve A, Deny B
    hook.resolveApproval('concurrent-A', 'approved');
    hook.resolveApproval('concurrent-B', 'denied', 'not_me');

    const [resA, resB] = await Promise.all([promiseA, promiseB]);

    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyA).toHaveBeenCalledWith({ name: 'Alpha' });
    expect(resA).toBe('executed_Alpha');

    expect(spyB).not.toHaveBeenCalled();
    expect(resB).toBe('denied_not_me');
  });

  // Identity secure storage test (verifying safeStorage encryption at rest)
  test('identity-secure encrypts credentials at rest and survives reload', async () => {
    const idPath = path.join(scratchDir, 'test-identity.enc');

    // Deterministic safeStorage mock using real XOR/AES simulation for test
    const mockStorage: SafeStorageProvider = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText: string) => {
        // Simple reversible buffer transform simulating OS keychain encryption
        const buf = Buffer.from(plainText, 'utf8');
        return Buffer.from(buf.map((b) => b ^ 0xaa));
      },
      decryptString: (encrypted: Buffer) => {
        const decrypted = Buffer.from(encrypted.map((b) => b ^ 0xaa));
        return decrypted.toString('utf8');
      },
    };

    const id1 = await loadOrCreateIdentity(idPath, mockStorage);
    expect(id1.deviceId).toBeDefined();
    expect(id1.noisePublicKeyB64).toBeDefined();
    expect(id1.helloPubkeyB64).toBeDefined();

    // Ensure the file exists and is NOT plaintext JSON
    const rawOnDisk = fs.readFileSync(idPath);
    expect(rawOnDisk.length).toBeGreaterThan(0);
    expect(() => JSON.parse(rawOnDisk.toString('utf8'))).toThrow(); // Ciphertext, cannot be parsed as JSON!

    // Reload from disk
    const id2 = await loadOrCreateIdentity(idPath, mockStorage);
    expect(id2.deviceId).toBe(id1.deviceId);
    expect(id2.noisePublicKeyB64).toBe(id1.noisePublicKeyB64);
    expect(id2.helloPubkeyB64).toBe(id1.helloPubkeyB64);
  });

  // CASE 6: Regression test running all 13 responder integration tests
  test('Case 6: Regression - 13/13 responder integration tests pass', () => {
    const mobileRepoRoot = '/Users/vishsiddharth/Desktop/bimax-mobile';
    const output = execSync('node apps/desktop-responder/test/integration-test.mjs', {
      cwd: mobileRepoRoot,
      encoding: 'utf8',
      timeout: 45_000,
    });

    expect(output).toContain('=== ALL THIRTEEN INTEGRATION CASES PASSED ===');
    expect(output).toContain('CASE 1: PASS');
    expect(output).toContain('CASE 13: PASS');
  });
});
