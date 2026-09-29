import { BootMsg } from './protocol';
import { engineWorkerPort, postLifecycle } from './port.host';

/**
 * Startup-phase reporting for supervised (headless) launches. The protocol host only attaches at
 * the END of boot — everything before that (config load, graph load, tool wiring) used to be
 * silence on the wire, which is why the desktop could only show "Engine starting…" forever. These
 * writes go straight to stdout as NDJSON, safely: in headless mode stdout carries ONLY protocol
 * lines (boot logs are captured/diverted in index.ts), and each write is a single short line.
 *
 * An engine running as a worker thread inside the app (the monolith, record 64) has no protocol stdout: its messages
 * travel on the port the app handed it, and its stdout is only a log. There the phases go on the port. Written to
 * stdout they reached engine.log and never the supervisor, so the app could not show a single start-up phase.
 *
 * No-op outside headless mode so the CLI/print paths never see protocol JSON on their stdout.
 */

function headless(): boolean {
  return process.env.BIMAX_HEADLESS === '1' || process.argv.includes('--headless');
}

export function reportBootPhase(phase: BootMsg['phase'], detail?: string): void {
  if (!headless()) return;
  const msg: BootMsg = { t: 'boot', phase, pid: process.pid, ...(detail ? { detail } : {}) };
  const port = engineWorkerPort();
  if (port) {
    try { postLifecycle(port, msg); } catch { /* the app closed the port — it is shutting this engine down */ }
    return;
  }
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch { /* stdout gone — parent exited */ }
}
