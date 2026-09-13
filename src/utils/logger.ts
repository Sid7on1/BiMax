import { stateDir } from './state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { getCorrelationId } from '../core/correlation';

const LOG_DIR = path.join(stateDir('.breakglass'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'agent.log');

// Ensure log directory exists synchronously to prevent early crash
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

let telemetryBus: any = null;

function writeToFile(level: string, message: string) {
  const ts = new Date().toISOString();
  const logEntry = JSON.stringify({ timestamp: ts, level, message }) + '\n';
  
  try {
    fs.appendFileSync(LOG_FILE, logEntry, 'utf-8');
  } catch (err: any) {
    // Fallback to stdout if disk write fails — never swallow silently
    try {
      process.stderr.write(`[LOGGER_DISK_FAILURE] ${err.message} | Original: ${logEntry}`);
    } catch (_) {
      // Last resort: nothing we can do
    }
  }

  try {
    if (telemetryBus) {
      telemetryBus.emit('SYSTEM_LOG', `[${level}] ${message}`);
    }
  } catch (e) {
    // Ignore during early boot
  }
}

function correlationPrefix(): string {
  const id = getCorrelationId();
  return id ? `[req:${id}] ` : '';
}

// stderr is best-effort console output; the file write below is the durable log. When the reader closes
// the pipe (e.g. the Go TUI exits), process.stderr.write throws EPIPE *synchronously* — uncaught, that
// FATALs the whole engine on a mere log line. Swallow write errors here so logging can never crash boot
// or shutdown.
function writeStderr(s: string): void {
  try { process.stderr.write(s); } catch { /* closed pipe (EPIPE) / EOF — drop the console copy, keep the file log */ }
}

export const Logger = {
  setEventBus: (bus: any) => {
    telemetryBus = bus;
  },
  // Write directly to stderr, never console.* — stdout is the NDJSON protocol pipe in headless mode,
  // and console.log/warn/error are patched at boot (capture stub), so going through them would either
  // swallow logs or, once console is restored, corrupt the protocol stream. stderr is always safe.
  info: (message: string) => {
    const prefix = correlationPrefix();
    writeStderr(`[INFO] ${new Date().toISOString()} - ${prefix}${message}\n`);
    writeToFile('INFO', `${prefix}${message}`);
  },
  warn: (message: string) => {
    const prefix = correlationPrefix();
    writeStderr(`\x1b[33m[WARN] ${new Date().toISOString()} - ${prefix}${message}\x1b[0m\n`);
    writeToFile('WARN', `${prefix}${message}`);
  },
  error: (message: string) => {
    const prefix = correlationPrefix();
    writeStderr(`\x1b[31m[ERROR] ${new Date().toISOString()} - ${prefix}${message}\x1b[0m\n`);
    writeToFile('ERROR', `${prefix}${message}`);
  },
};
