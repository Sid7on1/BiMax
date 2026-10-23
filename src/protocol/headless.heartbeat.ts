import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Outbound } from './protocol';

/**
 * Liveness heartbeat for the supervising front-end (desktop): a `health` line every few seconds
 * carrying event-loop responsiveness, memory, and whether a turn is executing. The desktop uses
 * the stream (not its content) to detect a wedged engine — and `activeTurn` to avoid mistaking
 * legitimate long work for a hang. BIMAX_HEARTBEAT_MS tunes the cadence; 0 disables.
 *
 * Split out of startHeadless (flaw list C19). Returns the function that stops it, or a no-op when disabled.
 */
export function startHeartbeat(send: (msg: Outbound) => void, isBusy: () => boolean, env: NodeJS.ProcessEnv = process.env): () => void {
  const heartbeatMs = Number(env.BIMAX_HEARTBEAT_MS ?? 3000);
  if (!(heartbeatMs > 0)) return () => { /* disabled */ };
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const emitHeartbeat = () => {
    const mem = process.memoryUsage();
    const msg = {
      t: 'health' as const,
      uptimeMs: Math.round(process.uptime() * 1000),
      rssMb: Math.round(mem.rss / (1024 * 1024)),
      heapMb: Math.round(mem.heapUsed / (1024 * 1024)),
      eventLoopDelayMs: Math.round(loopDelay.percentile(99) / 1e6),
      activeTurn: isBusy(),
      phase: 'ready' as const,
    };
    loopDelay.reset();
    // On the host's queue, like every other message: in a worker thread (the monolith) stdout is a log, and a
    // heartbeat written there never reached the supervisor, whose hang detection only arms on the first one.
    try {
      send(msg);
    } catch {
      /* parent gone */
    }
  };
  // Establish liveness before optional background services (MCP/code-memory/headroom) get their
  // first timer turn. The supervisor can now detect and recover a connector that wedges startup.
  emitHeartbeat();
  const timer = setInterval(emitHeartbeat, heartbeatMs);
  timer.unref(); // the heartbeat must never keep a shutting-down engine alive
  return () => {
    clearInterval(timer);
    loopDelay.disable();
  };
}
