import * as fs from 'fs';
import { engineEvents } from '../../engine/events';
import { AcpSessionDriver } from './agent';
import { StopReason, McpServerConfig } from './types';

/** The slice of HeadlessSession the driver needs — structural, so tests can pass a plain fake. */
export interface TurnEngine {
  readonly isBusy: boolean;
  dispatch(text: string): Promise<unknown>;
  interrupt(): void;
}

/**
 * Live ACP session driver: maps the protocol's session lifecycle onto the single turn engine.
 *
 * Bimax's engine is one global conversation (the agent loop, engineEvents, personas are singletons),
 * so sessions are neither isolated nor concurrent — the advertised capability meta says exactly
 * that (`sessions: { concurrent: false, isolated: false, model: 'single-supersede' }`):
 *   - a NEW session supersedes the previous one (history reset, old id invalidated);
 *   - a prompt against a superseded/unknown id is rejected, never silently interleaved;
 *   - a new session cannot be created mid-turn.
 */
export class HeadlessAcpDriver implements AcpSessionDriver {
  readonly events = engineEvents;
  private counter = 0;
  /** The one live session id. */
  private currentSessionId: string | null = null;

  constructor(
    private readonly session: TurnEngine,
    /** Resets the engine conversation history at a session boundary (injected by the entry). */
    private readonly resetHistory?: () => void,
  ) {}

  newSession(params: { cwd: string; mcpServers?: McpServerConfig[] }): string {
    if (this.session.isBusy) {
      throw new Error('a turn is currently running — cannot create a new session mid-turn; cancel it first');
    }
    // Honor the editor's workspace root so @-mentions, indexing, and tool paths resolve there.
    if (params?.cwd) {
      try { if (fs.existsSync(params.cwd) && fs.statSync(params.cwd).isDirectory()) process.chdir(params.cwd); } catch { /* keep current cwd */ }
    }
    try { this.resetHistory?.(); } catch { /* best-effort — a fresh session still starts */ }
    this.currentSessionId = `bimax-acp-${Date.now()}-${++this.counter}`;
    return this.currentSessionId;
  }

  async prompt(sessionId: string, text: string, signal: AbortSignal): Promise<StopReason> {
    if (sessionId !== this.currentSessionId) {
      throw new Error(`unknown or superseded session "${sessionId}" — Bimax ACP runs ONE active session at a time; create a new session and use its id`);
    }
    if (signal.aborted) return 'cancelled';
    // Bridge the ACP abort to the engine's cooperative interrupt for the duration of the turn.
    const onAbort = () => this.session.interrupt();
    signal.addEventListener('abort', onAbort);
    try {
      await this.session.dispatch(text); // resolves when the turn (or slash command) fully completes
      return signal.aborted ? 'cancelled' : 'end_turn';
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  cancel(_sessionId: string): void {
    this.session.interrupt();
  }
}
