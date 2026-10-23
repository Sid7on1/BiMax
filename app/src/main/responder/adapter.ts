import type {
  AgentStatus,
  AgentSessionInfo,
  CommandResult,
  KillResult,
  ToolApprovalRequest,
  AgentState,
} from '@bimax/protocol';
import type { ApprovalVerdict, EnginePort } from 'desktop-responder';
import { ApprovalHook } from './approval-hook';
import type { ThreadSummary, ThreadApproval } from '../../shared/threads';

// Verbatim copy of contract §14 EnginePort and ApprovalVerdict
export type { ApprovalVerdict, EnginePort };

/**
 * Minimal structural typing of ThreadManager matching app/src/main/thread.manager.ts
 */
export interface ThreadManagerLike {
  activeId: string | null;
  list(): ThreadSummary[];
  summary(id: string): ThreadSummary;
  submit(id: string, text: string, display?: string, echo?: boolean): void;
  create(root: string, prompt?: string, origin?: 'quick' | 'project', model?: string): string;
  stop(id: string, options?: { keepInputs?: boolean; reason?: string }): void;
  send(id: string, msg: unknown): void;
}

export interface AttachedFileInfo {
  fileId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  inboxPath?: string;
  receivedAt: number;
}

function mapThreadState(status: ThreadSummary['status']): AgentState {
  switch (status) {
    case 'working':
    case 'starting':
      return 'working';
    case 'needs-you':
      return 'waiting_approval';
    case 'idle':
    case 'stopped':
    default:
      return 'idle';
  }
}

/**
 * Real engine adapter connecting Bimax's main-process ThreadManager to the EnginePort contract (§14).
 * A thin mapping layer with zero protocol/crypto logic.
 */
export class RealEngineAdapter implements EnginePort {
  private statusListeners = new Set<(status: AgentStatus) => void>();
  private attachedFiles = new Map<string, AttachedFileInfo>();
  private activeTokenEmitters = new Map<string, (token: string) => void>();
  private activeTurnWaiters = new Map<string, { resolve: () => void; reject: (err: unknown) => void }>();
  private remotelyControlled = new Set<string>();

  constructor(
    private readonly threads: ThreadManagerLike,
    private readonly approvalHook: ApprovalHook = new ApprovalHook(),
    private readonly defaultWorkspaceDir?: string,
  ) {}

  /**
   * Internal hook: main process routes streamed tokens from the engine to active chat turns.
   */
  handleStreamToken(sessionId: string, token: string): void {
    const emitter = this.activeTokenEmitters.get(sessionId);
    if (emitter) {
      emitter(token);
    }
  }

  /**
   * Internal hook: main process notifies adapter that a turn settled idle or finished.
   */
  handleTurnFinished(sessionId: string, error?: string): void {
    this.remotelyControlled.delete(sessionId);
    const waiter = this.activeTurnWaiters.get(sessionId);
    if (waiter) {
      this.activeTurnWaiters.delete(sessionId);
      this.activeTokenEmitters.delete(sessionId);
      if (error) {
        waiter.reject(new Error(error));
      } else {
        waiter.resolve();
      }
    }
    void this.notifyStatusChanged();
  }

  /**
   * Intercepts ThreadApproval events from ThreadManager and bridges them into the ApprovalHook.
   */
  handleThreadApproval(approval: ThreadApproval): void {
    if (!this.remotelyControlled.has(approval.threadId)) return;
    const approvalId = String(approval.request.id);
    const allowOption = approval.request.options.find((opt) => /^(allow|yes|approve)/i.test(opt)) || approval.request.options[0] || 'Allow';
    const denyOption = approval.request.options.find((opt) => /^(deny|no|reject)/i.test(opt)) || 'Deny';

    void this.approvalHook.intercept({
      approvalId,
      sessionId: approval.threadId,
      tool: approval.title || 'TOOL_EXECUTION',
      args: { requestId: approval.request.id, token: approval.token },
      summary: approval.request.question,
      detail: approval.request.body || approval.request.question,
      cwd: approval.root,
      execute: async () => {
        this.threads.send(approval.threadId, {
          t: 'reply',
          id: approval.request.id,
          value: allowOption,
          approvalToken: approval.token,
        });
        return { ok: true };
      },
      onDeny: async () => {
        this.threads.send(approval.threadId, {
          t: 'reply',
          id: approval.request.id,
          value: denyOption,
          approvalToken: approval.token,
        });
        return { ok: false };
      },
    });
  }

  /**
   * Triggers a status change check and broadcasts to all status listeners.
   */
  async notifyStatusChanged(): Promise<void> {
    for (const sessionId of this.activeTurnWaiters.keys()) {
      let stopped: boolean;
      try { stopped = this.threads.summary(sessionId).status === 'stopped'; } catch { stopped = true; }
      if (stopped) this.handleTurnFinished(sessionId, 'Thread stopped before remote chat completed');
    }
    const status = await this.getStatus();
    for (const cb of this.statusListeners) {
      try {
        cb(status);
      } catch (err) {
        console.error('[RealEngineAdapter] Error in status change listener:', err);
      }
    }
  }

  getApprovalHook(): ApprovalHook {
    return this.approvalHook;
  }

  /** Current agent state for the status card. */
  async getStatus(): Promise<AgentStatus> {
    const list = this.threads.list();
    const activeId = this.threads.activeId;
    let target = activeId ? list.find((t) => t.id === activeId) : undefined;

    if (!target) {
      target = list.find((t) => t.status === 'working' || t.status === 'needs-you' || t.status === 'starting') ?? list[0];
    }

    if (!target) {
      return {
        state: 'idle',
        updatedAt: Date.now(),
      };
    }

    return {
      state: mapThreadState(target.status),
      sessionId: target.id,
      taskSummary: target.title,
      updatedAt: target.updatedAt || Date.now(),
    };
  }

  /** Sessions the phone may display/switch between. */
  async listSessions(): Promise<AgentSessionInfo[]> {
    return this.threads.list().map((s) => ({
      sessionId: s.id,
      title: s.title,
      status: mapThreadState(s.status),
      startedAt: s.updatedAt || Date.now(),
    }));
  }

  /** Fire-and-forget instruction; idempotent via idempotencyKey (§8). */
  async sendInstruction(input: {
    idempotencyKey: string;
    instruction: string;
  }): Promise<CommandResult> {
    const active = this.threads.activeId;
    if (!active && !this.defaultWorkspaceDir) throw new Error('Open a folder in Bimax before sending a remote instruction');
    const sessionId = active ?? this.threads.create(this.defaultWorkspaceDir!, input.instruction, 'project');
    this.remotelyControlled.add(sessionId);
    this.threads.submit(sessionId, input.instruction);
    void this.notifyStatusChanged();

    return {
      idempotencyKey: input.idempotencyKey,
      ok: true,
      summary: 'Instruction submitted to thread',
    };
  }

  /** Conversational turn; streams tokens via onToken (§9). */
  async chat(
    input: {
      idempotencyKey: string;
      sessionId?: string;
      text: string;
      fileIds?: string[];
    },
    onToken: (token: string) => void,
  ): Promise<{ sessionId: string }> {
    const existing = input.sessionId ?? this.threads.activeId;
    if (existing && (this.activeTurnWaiters.has(existing) || this.threads.summary(existing).status !== 'idle'))
      throw new Error('Wait for this Thread to become idle before starting remote chat');
    if (!existing && !this.defaultWorkspaceDir) throw new Error('Open a folder in Bimax before starting remote chat');
    const sessionId = existing ?? this.threads.create(this.defaultWorkspaceDir!, input.text, 'project');
    this.remotelyControlled.add(sessionId);

    this.activeTokenEmitters.set(sessionId, onToken);

    const turnPromise = new Promise<void>((resolve, reject) => {
      this.activeTurnWaiters.set(sessionId, { resolve, reject });
    });

    let messageText = input.text;
    if (input.fileIds && input.fileIds.length > 0) {
      const fileNotes = input.fileIds
        .map((fid) => {
          const file = this.attachedFiles.get(fid);
          return file ? `[Attached file: ${file.name} (${file.mime})]` : `[Attached file ID: ${fid}]`;
        })
        .join('\n');
      messageText = `${fileNotes}\n\n${messageText}`;
    }

    try {
      this.threads.submit(sessionId, messageText);
      void this.notifyStatusChanged();
      await turnPromise;
      return { sessionId };
    } finally {
      this.activeTurnWaiters.delete(sessionId);
      this.activeTokenEmitters.delete(sessionId);
    }
  }

  /** Cancel the running task (§11). */
  async kill(input: { idempotencyKey: string; reason?: string }): Promise<KillResult> {
    const list = this.threads.list();
    const running = list.filter((t) => t.status === 'working' || t.status === 'needs-you' || t.status === 'starting');
    for (const sessionId of [...this.activeTurnWaiters.keys()]) {
      this.approvalHook.abortSession(sessionId, input.reason ?? 'kill_request');
      this.handleTurnFinished(sessionId, 'Remote chat stopped locally');
    }

    if (running.length === 0) {
      return {
        idempotencyKey: input.idempotencyKey,
        ok: true,
        detail: 'nothing running',
        at: Date.now(),
      };
    }

    for (const t of running) {
      this.approvalHook.abortSession(t.id, input.reason ?? 'kill_request');
      this.threads.stop(t.id, { keepInputs: false, reason: input.reason ?? 'Killed via mobile' });
    }

    void this.notifyStatusChanged();

    return {
      idempotencyKey: input.idempotencyKey,
      ok: true,
      detail: 'stopped after current step',
      at: Date.now(),
    };
  }

  /** Register a verified-received file for later reference (§10). */
  async attachFile(input: {
    fileId: string;
    name: string;
    mime: string;
    sizeBytes: number;
  }): Promise<void> {
    this.attachedFiles.set(input.fileId, {
      fileId: input.fileId,
      name: input.name,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      receivedAt: Date.now(),
    });
  }

  /** Engine → responder: a tool needs user approval (§7). */
  onApprovalRequest(cb: (req: ToolApprovalRequest) => void): void {
    this.approvalHook.onApprovalRequest(cb);
  }

  /** Engine → responder: status changed (proactive push). */
  onStatusChanged(cb: (status: AgentStatus) => void): void {
    this.statusListeners.add(cb);
  }

  /** Responder → engine: deliver a VERIFIED approval decision. */
  resolveApproval(
    approvalId: string,
    verdict: ApprovalVerdict,
    denyReason?: 'not_me' | 'mistake',
  ): void {
    this.approvalHook.resolveApproval(approvalId, verdict, denyReason);
  }
}
