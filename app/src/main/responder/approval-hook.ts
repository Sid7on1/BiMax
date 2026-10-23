import { randomUUID } from 'node:crypto';
import type { ToolApprovalRequest } from '@bimax/protocol';
import type { ApprovalVerdict } from 'desktop-responder';

/**
 * Descriptor for a tool call to be intercepted and suspended pending user authorization.
 */
export interface SuspendedToolCall<TArgs = unknown, TResult = unknown> {
  approvalId?: string;
  sessionId: string;
  tool: string;
  args: TArgs;
  summary: string;
  detail: string;
  cwd?: string;
  requestedAt?: number;
  expiresAt?: number;
  /**
   * The underlying tool execution function.
   * MUST NOT be called until 'approved' is delivered.
   */
  execute: (args: TArgs) => Promise<TResult>;
  /**
   * Generates the outcome returned to the engine when denied, timed out, or killed.
   */
  onDeny?: (reason: string) => Promise<TResult> | TResult;
  abortSignal?: AbortSignal;
}

interface PendingSuspension {
  approvalId: string;
  sessionId: string;
  tool: string;
  originalArgs: unknown;
  summary: string;
  detail: string;
  cwd?: string;
  requestedAt: number;
  expiresAt: number;
  execute: (args: unknown) => Promise<unknown>;
  onDeny?: (reason: string) => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export type ApprovalRequestListener = (req: ToolApprovalRequest) => void;

/**
 * Pre-execution approval suspension mechanism.
 *
 * Guarantees:
 * 1. The tool execution function is never invoked before a verified approval arrives.
 * 2. On 'approved', executes once with original, byte-identical arguments.
 * 3. On 'denied', timeout, or kill, the tool execution function is NEVER called.
 * 4. Concurrent requests are indexed strictly by approvalId without cross-talk.
 */
export class ApprovalHook {
  private pending = new Map<string, PendingSuspension>();
  private listeners = new Set<ApprovalRequestListener>();

  /**
   * Subscribe to approval requests to forward them over the responder protocol.
   */
  onApprovalRequest(cb: ApprovalRequestListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Suspend a tool call before execution. Returns a promise that resolves only when
   * approved and executed, or when denied with a fallback outcome.
   */
  async intercept<TArgs, TResult>(call: SuspendedToolCall<TArgs, TResult>): Promise<TResult> {
    const approvalId = call.approvalId ?? randomUUID();
    const now = Date.now();
    const requestedAt = call.requestedAt ?? now;
    const expiresAt = call.expiresAt ?? now + 120_000;
    const timeoutMs = Math.max(100, expiresAt - now);

    return new Promise<TResult>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;

      const timer = setTimeout(() => {
        this.resolveApproval(approvalId, 'denied', 'timeout');
      }, timeoutMs);

      const entry: PendingSuspension = {
        approvalId,
        sessionId: call.sessionId,
        tool: call.tool,
        originalArgs: call.args,
        summary: call.summary,
        detail: call.detail,
        cwd: call.cwd,
        requestedAt,
        expiresAt,
        execute: call.execute as (args: unknown) => Promise<unknown>,
        onDeny: call.onDeny as ((reason: string) => Promise<unknown> | unknown) | undefined,
        resolve: (val) => {
          if (abortHandler && call.abortSignal) {
            call.abortSignal.removeEventListener('abort', abortHandler);
          }
          resolve(val as TResult);
        },
        reject: (err) => {
          if (abortHandler && call.abortSignal) {
            call.abortSignal.removeEventListener('abort', abortHandler);
          }
          reject(err);
        },
        timer,
        settled: false,
      };

      if (call.abortSignal) {
        if (call.abortSignal.aborted) {
          clearTimeout(timer);
          entry.settled = true;
          if (call.onDeny) {
            Promise.resolve(call.onDeny('aborted')).then(resolve).catch(reject);
          } else {
            reject(new Error('Operation aborted prior to approval'));
          }
          return;
        }

        abortHandler = () => {
          this.resolveApproval(approvalId, 'denied', 'aborted');
        };
        call.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      this.pending.set(approvalId, entry);

      const request: ToolApprovalRequest = {
        approvalId,
        sessionId: call.sessionId,
        tool: call.tool,
        summary: call.summary,
        detail: call.detail,
        cwd: call.cwd,
        requestedAt,
        expiresAt,
      };

      for (const cb of this.listeners) {
        try {
          cb(request);
        } catch (e: unknown) {
          console.error('[ApprovalHook] Error in approval request listener:', e);
        }
      }
    });
  }

  /**
   * Delivers an authoritative decision from the responder gate.
   */
  resolveApproval(
    approvalId: string,
    verdict: ApprovalVerdict,
    denyReason?: 'not_me' | 'mistake' | string,
  ): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.settled) {
      return false;
    }

    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);

    if (verdict === 'approved') {
      Promise.resolve()
        .then(() => entry.execute(entry.originalArgs))
        .then((result) => entry.resolve(result))
        .catch((err) => entry.reject(err));
      return true;
    }

    const reason = denyReason ?? 'denied';
    if (entry.onDeny) {
      Promise.resolve()
        .then(() => entry.onDeny!(reason))
        .then((result) => entry.resolve(result))
        .catch((err) => entry.reject(err));
    } else {
      entry.reject(new Error(`Action declined: ${reason}`));
    }
    return true;
  }

  /**
   * Aborts all pending approvals for a session when the session is stopped or killed.
   */
  abortSession(sessionId: string, reason = 'session_killed'): number {
    let aborted = 0;
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.sessionId === sessionId && !entry.settled) {
        this.resolveApproval(id, 'denied', reason);
        aborted++;
      }
    }
    return aborted;
  }

  /**
   * Returns whether an approvalId is currently pending.
   */
  isPending(approvalId: string): boolean {
    const entry = this.pending.get(approvalId);
    return !!entry && !entry.settled;
  }

  /**
   * Returns list of currently pending approval IDs.
   */
  pendingApprovalIds(): string[] {
    return [...this.pending.keys()];
  }
}
