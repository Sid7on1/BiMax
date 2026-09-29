import { BootMsg } from './protocol';
import { engineWorkerPort, postLifecycle } from './port.host';

/**
 * Startup-phase reporting for supervised (headless) launches. The protocol host only attaches at
 * the END of boot — everything before that (config load, graph load, tool wiring) used to be
 * silence on the wire, which is why the desktop could only show "Engine starting…" forever.
 *
 * The engine is a worker thread inside the app (the monolith, record 64): its messages travel on the port the app
 * handed it, and its stdout is only a log, so the phases go on the port. (Written to stdout they once reached
 * engine.log and never the supervisor, so the app could not show a single start-up phase.) With no port there is no
 * one to tell; since record 64's M4 there is no stdout protocol to fall back to.
 *
 * No-op outside headless mode.
 */

function headless(): boolean {
  return process.env.BIMAX_HEADLESS === '1' || process.argv.includes('--headless');
}

export function reportBootPhase(phase: BootMsg['phase'], detail?: string): void {
  if (!headless()) return;
  const msg: BootMsg = { t: 'boot', phase, pid: process.pid, ...(detail ? { detail } : {}) };
  const port = engineWorkerPort();
  if (!port) return;
  try { postLifecycle(port, msg); } catch { /* the app closed the port — it is shutting this engine down */ }
}
