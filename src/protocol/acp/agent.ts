/**
 * The Bimax ACP agent: bridges Agent Client Protocol requests to Bimax's turn engine.
 *
 * This is the ACP counterpart of ProtocolHost (host.ts). Where ProtocolHost forwards Bimax's
 * `engineEvents` over Bimax's own wire protocol, this forwards them as ACP `session/update`
 * notifications, and maps inbound ACP methods (initialize / session-new / session-prompt /
 * session-cancel) onto a session driver. Tool-approval prompts (`veto_prompt`) are bridged to ACP's
 * `session/request_permission` so approvals render natively in the editor.
 *
 * The engine coupling is behind {@link AcpSessionDriver} so the whole bridge is unit-testable with a
 * fake driver + a plain EventEmitter — no LLM, no bootstrap. The live driver (backed by
 * HeadlessSession) is wired in the ACP entry point (Phase 2b).
 */

import { EventEmitter } from 'events';
import { JsonRpcConnection } from './jsonrpc';
import {
  ACP_PROTOCOL_VERSION, AgentMethod, ClientMethod,
  InitializeParams, InitializeResult, NewSessionParams, NewSessionResult,
  PromptParams, PromptResult, CancelParams, StopReason, McpServerConfig,
  RequestPermissionParams, RequestPermissionResult,
  promptText, agentMessageChunk, toolCallStart, toolCallUpdate,
} from './types';

/** Engine abstraction the agent drives. Backed by HeadlessSession in production, a fake in tests. */
export interface AcpSessionDriver {
  /** The engine event seam (Bimax's `engineEvents`) — the agent streams its events as updates. */
  readonly events: EventEmitter;
  /** Prepare a session for `cwd`; return its id. */
  newSession(params: { cwd: string; mcpServers?: McpServerConfig[] }): Promise<string> | string;
  /** Run ONE prompt turn to completion; resolve with a StopReason. Must honor `signal` for cancel. */
  prompt(sessionId: string, text: string, signal: AbortSignal): Promise<StopReason>;
  /** Cancel the in-flight turn for `sessionId` (no-op if idle). */
  cancel(sessionId: string): void;
  /** Optional: resume a previously-saved session. */
  loadSession?(params: { sessionId: string; cwd: string; mcpServers?: McpServerConfig[] }): Promise<void> | void;
}

export interface AcpAgentOptions {
  /** Advertised in `initialize`; defaults to loadSession only when the driver implements it. */
  capabilities?: InitializeResult['agentCapabilities'];
  /** Auth methods to advertise; default [] (no auth required). */
  authMethods?: InitializeResult['authMethods'];
}

export class AcpAgent {
  /** The session currently streaming, so global engineEvents route to the right sessionId. */
  private activeSessionId: string | null = null;
  private activeAbort: AbortController | null = null;
  /** Detach fns for the engineEvents listeners bound for the active turn. */
  private turnListeners: Array<() => void> = [];

  constructor(
    private readonly conn: JsonRpcConnection,
    private readonly driver: AcpSessionDriver,
    private readonly opts: AcpAgentOptions = {},
  ) {
    conn.on(AgentMethod.Initialize, (p) => this.onInitialize(p));
    conn.on(AgentMethod.Authenticate, () => null); // no auth required → accept and return null
    conn.on(AgentMethod.NewSession, (p) => this.onNewSession(p));
    conn.on(AgentMethod.LoadSession, (p) => this.onLoadSession(p));
    conn.on(AgentMethod.Prompt, (p) => this.onPrompt(p));
    conn.on(AgentMethod.Cancel, (p) => this.onCancel(p)); // notification
  }

  // ---- agent methods --------------------------------------------------------------------------

  private onInitialize(params: InitializeParams): InitializeResult {
    // Negotiate the protocol version: never claim newer than the client offered.
    const version = Math.min(ACP_PROTOCOL_VERSION, params?.protocolVersion ?? ACP_PROTOCOL_VERSION);
    return {
      protocolVersion: version,
      // Truthful capabilities only: the turn engine consumes TEXT and embedded resources; image
      // blocks are dropped by promptText, so image support is NOT advertised.
      agentCapabilities:
        this.opts.capabilities ?? {
          loadSession: typeof this.driver.loadSession === 'function',
          promptCapabilities: { image: false, embeddedContext: true },
          // Machine-readable: not isolated, not concurrent — a new session supersedes the last.
          sessions: { concurrent: false, isolated: false, model: 'single-supersede' },
        },
      authMethods: this.opts.authMethods ?? [],
    };
  }

  private async onNewSession(params: NewSessionParams): Promise<NewSessionResult> {
    // MCP server configuration is not implemented on this bridge — reject it explicitly rather
    // than silently accepting and ignoring it (the editor would believe its servers are active).
    if (params?.mcpServers?.length) {
      throw new Error('Bimax ACP does not support per-session MCP server configuration yet — remove mcpServers from session/new (configure MCP in Bimax itself instead)');
    }
    const sessionId = await this.driver.newSession({ cwd: params?.cwd ?? process.cwd() });
    return { sessionId };
  }

  private async onLoadSession(params: { sessionId: string; cwd: string; mcpServers?: McpServerConfig[] }): Promise<null> {
    if (this.driver.loadSession) await this.driver.loadSession(params);
    return null;
  }

  private async onPrompt(params: PromptParams): Promise<PromptResult> {
    const sessionId = params?.sessionId;
    // The engine is a single global session: a second concurrent prompt would interleave two
    // conversations through one agent loop. Reject it clearly instead of corrupting both.
    if (this.activeSessionId) {
      throw new Error(`a prompt is already running (session ${this.activeSessionId}) — Bimax ACP supports one turn at a time; cancel it or wait for it to finish`);
    }
    const text = promptText(params?.prompt ?? []);
    const abort = new AbortController();
    this.activeSessionId = sessionId;
    this.activeAbort = abort;
    this.bindTurnStreaming(sessionId);
    try {
      const stopReason = await this.driver.prompt(sessionId, text, abort.signal);
      // A cancel() flips the reason even if the driver reports a natural end.
      return { stopReason: abort.signal.aborted ? 'cancelled' : stopReason };
    } catch (err) {
      // Surface the failure as a final message chunk, then end the turn (don't reject the whole RPC —
      // ACP models a failed turn as end_turn/refusal with the error streamed, not a transport error).
      this.conn.notify(ClientMethod.SessionUpdate, agentMessageChunk(sessionId, `⚠ ${err instanceof Error ? err.message : String(err)}`));
      return { stopReason: 'refusal' };
    } finally {
      this.unbindTurnStreaming();
      this.activeSessionId = null;
      this.activeAbort = null;
    }
  }

  private onCancel(params: CancelParams): void {
    // session/cancel is a notification: abort the turn; onPrompt returns stopReason 'cancelled'.
    if (this.activeSessionId && params?.sessionId === this.activeSessionId) {
      this.activeAbort?.abort();
      this.driver.cancel(this.activeSessionId);
    }
  }

  // ---- streaming: engineEvents → session/update --------------------------------------------------

  /** Bind engineEvents listeners for the duration of one turn, routing to `sessionId`. */
  private bindTurnStreaming(sessionId: string): void {
    const events = this.driver.events;

    // Streamed answer tokens → agent_message_chunk (the incremental assistant text).
    const onToken = (token: string) => {
      if (typeof token === 'string' && token.length) {
        this.conn.notify(ClientMethod.SessionUpdate, agentMessageChunk(sessionId, token));
      }
    };
    events.on('stream_token', onToken);
    this.turnListeners.push(() => events.off('stream_token', onToken));

    // System messages (errors, ledger notes, governor vetoes) → a message chunk so they aren't lost.
    // Assistant 'message' events are the aggregate of already-streamed tokens, so they are skipped to
    // avoid duplicating the answer.
    const onMessage = (m: any) => {
      if (m?.role === 'system' && typeof m.content === 'string' && m.content.trim()) {
        this.conn.notify(ClientMethod.SessionUpdate, agentMessageChunk(sessionId, m.content));
      }
    };
    events.on('message', onMessage);
    this.turnListeners.push(() => events.off('message', onMessage));

    // Tool lifecycle → the editor's live tool timeline. Bimax emits `tool_call` (status running) on
    // start — TWICE for the same id (a streaming "partial" then the authoritative call), so the id
    // set dedupes the ACP `tool_call` to one declaration — and `tool_call_result` on completion,
    // which becomes a `tool_call_update` carrying the final status + output.
    const announced = new Set<string>();
    const onToolCall = (e: any) => {
      const id = String(e?.id ?? '');
      if (!id || announced.has(id)) return;
      announced.add(id);
      this.conn.notify(ClientMethod.SessionUpdate, toolCallStart(sessionId, id, String(e?.toolName ?? 'tool'), e?.input));
    };
    events.on('tool_call', onToolCall);
    this.turnListeners.push(() => events.off('tool_call', onToolCall));

    const onToolResult = (e: any) => {
      const id = String(e?.id ?? '');
      if (!id) return;
      // A result for a call we never announced (edge case) → declare it first so the update has a home.
      if (!announced.has(id)) {
        announced.add(id);
        this.conn.notify(ClientMethod.SessionUpdate, toolCallStart(sessionId, id, String(e?.toolName ?? 'tool'), e?.input));
      }
      this.conn.notify(ClientMethod.SessionUpdate, toolCallUpdate(sessionId, id, e?.status === 'error', String(e?.output ?? '')));
    };
    events.on('tool_call_result', onToolResult);
    this.turnListeners.push(() => events.off('tool_call_result', onToolResult));

    // Tool-approval gate: veto_prompt(question, options, resolve) → session/request_permission.
    const onVeto = (question: string, options: string[], resolve: (a: string) => void) => {
      void this.requestPermission(sessionId, question, options || [])
        .then(resolve)
        .catch(() => resolve('')); // editor gone / declined → empty answer (engine treats as deny)
    };
    events.on('veto_prompt', onVeto);
    this.turnListeners.push(() => events.off('veto_prompt', onVeto));

    // NOTE: power/update/log events are deliberately NOT forwarded as agent message chunks —
    // operational posture must never masquerade as assistant answer text in the editor.
  }

  private unbindTurnStreaming(): void {
    for (const off of this.turnListeners.splice(0)) {
      try { off(); } catch { /* detach is best-effort */ }
    }
  }

  /** Ask the editor to approve a tool call; resolve with the chosen option string (or '' on cancel). */
  private async requestPermission(sessionId: string, title: string, options: string[]): Promise<string> {
    const params: RequestPermissionParams = {
      sessionId,
      toolCall: { toolCallId: `perm-${Date.now()}`, title },
      options: options.map((name) => ({
        optionId: name,
        name,
        kind: /^(reject|deny|no|cancel)/i.test(name) ? 'reject_once' : 'allow_once',
      })),
    };
    const res = await this.conn.request<RequestPermissionResult>(ClientMethod.RequestPermission, params);
    if (res?.outcome?.outcome === 'selected') return res.outcome.optionId;
    return ''; // cancelled
  }
}
