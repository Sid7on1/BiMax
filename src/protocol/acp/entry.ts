import { StringDecoder } from 'string_decoder';
import { engineEvents } from '../../engine/events';
import { buildPersonas } from '../../engine/personas/factory';
import { saveConfig } from '../../engine/config';
import { HeadlessSession } from '../headless.session';
import { JsonRpcConnection, LineBuffer } from './jsonrpc';
import { AcpAgent } from './agent';
import { HeadlessAcpDriver } from './driver';
// Register every slash command for its side effect (self-registration on import) — otherwise a
// prompt like "/help" typed in the editor falls through as "Unknown command", same as headless.
import '../../engine/commands';

// The session driver (session supersede/reject rules) lives in ./driver.ts so it is unit-testable
// without booting personas/commands. Re-exported here for existing importers.
export { HeadlessAcpDriver } from './driver';

/**
 * Run Bimax as an ACP agent over stdio: newline-delimited JSON-RPC on stdin/stdout, so an editor
 * (Zed and other ACP clients) can embed the full Bimax engine. The counterpart of startHeadless,
 * but speaking ACP instead of Bimax's own NDJSON protocol. Activated by `BIMAX_ACP=1` / `--acp`.
 *
 * stdout carries ONLY protocol frames — console was redirected to a boot buffer in index.ts and is
 * never restored on this path, so nothing pollutes the JSON-RPC stream. Resolves when stdin closes.
 */
export async function startAcpAgent(container: any, _config: any): Promise<void> {
  const { toolRegistry, llmAdapter, governor, graphStore, codebaseIndexer } = container;

  // Persist the thread and fold in approvals/evidence/outcomes exactly as headless does, so tools,
  // /sessions, and the review domain behave identically inside the editor. These track state only;
  // the headless auto-continuation / recovery / heartbeat timers are intentionally NOT started —
  // an editor session is turn-driven, not autonomously self-continuing.
  const { startSessionRecorder } = require('../../engine/session.recorder');
  const sessionRecorder = startSessionRecorder();
  const { startReviewManager } = require('../../review/review.manager');
  const reviewManager = startReviewManager();
  const { startOutcomeManager } = require('../../outcome/outcome.manager');
  const outcomeManager = startOutcomeManager();

  const options = {
    toolRegistry,
    llmAdapter,
    governor,
    maxToolIterations: _config?.maxToolIterations,
    notificationBell: _config?.notificationBell,
    persona: null,
  };
  const personas = buildPersonas(toolRegistry, llmAdapter);
  const session = new HeadlessSession({ personas, options, graphStore, codebaseIndexer, saveConfig });

  // Inline diff-approval over ACP: a mutating tool's diff is surfaced as a veto_prompt, which the
  // AcpAgent bridges to session/request_permission so the editor renders the approval natively.
  const { registerDiffApprover } = require('../../engine/diffApproval');
  registerDiffApprover((summary: string, diff: string) => new Promise<boolean>((resolve) => {
    engineEvents.emit('veto_prompt', summary, ['Approve', 'Reject'], (answer: string) => resolve(/^(a|y|approve|accept)/i.test(answer)), false);
    void diff; // the diff body rides the summary for now; a richer ACP tool_call_update can carry it later
  }));

  // Wire the JSON-RPC connection to real stdio. stdout gets one frame per line.
  const conn = new JsonRpcConnection(
    (line) => { try { process.stdout.write(line + '\n'); } catch { /* editor gone */ } },
    (err) => { try { process.stderr.write(`[acp] ${err.message}\n`); } catch { /* ignore */ } },
  );
  // EXPERIMENTAL: the ACP bridge is explicitly opt-in (--acp / BIMAX_ACP=1) and marked as such.
  // Known limits are enforced, not hidden: one session/turn at a time, text+embedded-context
  // prompts only (no images), no per-session MCP configuration.
  try { process.stderr.write('[acp] Bimax ACP bridge is EXPERIMENTAL: single session, single concurrent turn, text-only prompts.\n'); } catch { /* ignore */ }
  const driver = new HeadlessAcpDriver(session, () => {
    const active: any = (personas as any).bimax;
    if (active) {
      active.messages = [];
      active.resetContextSession?.();
    }
  });
  new AcpAgent(conn, driver);

  // stdin → line-buffered frames. StringDecoder guards against a multibyte char split across chunks.
  const buffer = new LineBuffer();
  const utf8 = new StringDecoder('utf8');
  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : utf8.write(chunk);
    for (const line of buffer.push(text)) conn.handleLine(line);
  };
  process.stdin.on('data', onData);
  if (typeof process.stdin.resume === 'function') process.stdin.resume();

  await new Promise<void>((resolve) => {
    let done = false;
    const shutdown = () => {
      if (done) return;
      done = true;
      process.stdin.off('data', onData);
      const tail = buffer.flush();
      if (tail) conn.handleLine(tail); // process a final unterminated frame at EOF
      conn.close();
      try { outcomeManager.shutdown(); } catch { /* best-effort */ }
      try { reviewManager.shutdown(); } catch { /* best-effort */ }
      try { sessionRecorder.shutdown(); } catch { /* best-effort */ }
      resolve();
    };
    engineEvents.once('shutdown', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
  });
}
