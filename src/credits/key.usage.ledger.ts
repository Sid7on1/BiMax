import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * One request ledger per API key for the whole Mac — the shared half of the key pool.
 *
 * THE DEFECT THIS CLOSES. `ApiKeyManager` paced keys with in-memory state only, and every engine
 * builds its own manager: the project window, each live Bimax Thread, and each sub-agent worker
 * (a separate V8 isolate). A provider's per-key limit (NVIDIA's free tier: 40 requests a minute)
 * is a per-KEY budget, so N engines each spending "their" 40 was N×40 against one key — the pool
 * learned about the limit only from the 429s. It is the same shape as the spend ledger
 * (`src/governor/spend.ledger.ts`) and the sub-agent worker cap: a per-machine budget applied
 * per process. This file follows their proven pattern: an O_EXCL lock file, a read-modify-write
 * inside it, an atomic rename.
 *
 * WHAT IS STORED. A 16-hex-character SHA-256 prefix per key, never the key; the start times of
 * requests inside the last minute; and a cooldown a provider imposed (a 429, a hang), so one
 * engine's 429 stops the others from walking into the same wall.
 *
 * FAILURE POLICY. A ledger that cannot be locked or parsed must never stop a turn: the caller
 * falls back to its own in-memory pacing, which is exactly the behaviour before this file existed.
 */

export const KEY_LEDGER_ENV = 'BIMAX_KEY_LEDGER_PATH';
/** The window a provider's "requests per minute" limit is measured over. */
export const RPM_WINDOW_MS = 60_000;

const LOCK_STALE_MS = 5_000;
const LOCK_ATTEMPTS = 40;
/** A key unused for a day is dropped, so a rotated-out key does not live in the file forever. */
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

/** The identity a key is recorded under. Irreversible, and short enough that two keys never share it in practice. */
export function keyId(keyStr: string): string {
  return crypto.createHash('sha256').update(keyStr).digest('hex').slice(0, 16);
}

export interface KeyUsage {
  /** Requests started with this key inside the last RPM_WINDOW_MS, by every engine on the Mac. */
  recent: number;
  /** Epoch ms before which a provider asked for this key to be left alone (0 = none). */
  cooldownUntil: number;
  /** Start times inside the window, oldest first — tells the caller when the next slot opens. */
  starts: number[];
}

interface LedgerEntry { starts: number[]; cooldownUntil: number; seen: number }
interface LedgerFile { version: 1; keys: Record<string, LedgerEntry> }

export interface KeyUsageStore {
  /**
   * Atomically read every key's usage, let `choose` pick one of `ids` (or none), and record a
   * request start for the pick. Returns the usage `choose` saw. Throws only when the store is
   * unusable; the caller then paces from memory.
   */
  reserve(ids: string[], now: number, choose: (usage: Map<string, KeyUsage>) => string | null): { picked: string | null; usage: Map<string, KeyUsage> };
  /** Share a provider-imposed cooldown for one key with every engine on the Mac. */
  cooldown(id: string, untilMs: number, now: number): void;
}

/** Usage of one key. Callers prune first, so every start here is inside the window. */
function usageOf(entry: LedgerEntry | undefined, now: number): KeyUsage {
  const starts = [...(entry?.starts ?? [])].sort((a, b) => a - b);
  return { recent: starts.length, cooldownUntil: entry && entry.cooldownUntil > now ? entry.cooldownUntil : 0, starts };
}

function prune(file: LedgerFile, now: number): void {
  for (const [id, entry] of Object.entries(file.keys)) {
    entry.starts = entry.starts.filter((t) => now - t < RPM_WINDOW_MS);
    if (entry.cooldownUntil <= now) entry.cooldownUntil = 0;
    if (entry.starts.length === 0 && entry.cooldownUntil === 0 && now - entry.seen > FORGET_AFTER_MS) delete file.keys[id];
  }
}

function applyReserve(file: LedgerFile, ids: string[], now: number, choose: (usage: Map<string, KeyUsage>) => string | null) {
  prune(file, now);
  const usage = new Map(ids.map((id) => [id, usageOf(file.keys[id], now)]));
  const picked = choose(usage);
  if (picked) {
    const entry = file.keys[picked] ?? (file.keys[picked] = { starts: [], cooldownUntil: 0, seen: now });
    entry.starts.push(now);
    entry.seen = now;
  }
  return { picked, usage };
}

function applyCooldown(file: LedgerFile, id: string, untilMs: number, now: number): void {
  const entry = file.keys[id] ?? (file.keys[id] = { starts: [], cooldownUntil: 0, seen: now });
  entry.cooldownUntil = Math.max(entry.cooldownUntil, untilMs);
  entry.seen = now;
}

/** Process-local store: used when no file is configured, and as the tests' hermetic default. */
export class MemoryKeyUsageStore implements KeyUsageStore {
  private file: LedgerFile = { version: 1, keys: {} };
  reserve(ids: string[], now: number, choose: (usage: Map<string, KeyUsage>) => string | null) {
    return applyReserve(this.file, ids, now, choose);
  }
  cooldown(id: string, untilMs: number, now: number): void {
    applyCooldown(this.file, id, untilMs, now);
  }
}

function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* retry */ }
}

/** Cross-process store: one JSON file, updated under an exclusive lock and replaced atomically. */
export class FileKeyUsageStore implements KeyUsageStore {
  constructor(readonly filePath: string) {}

  private withLock<T>(fn: (file: LedgerFile) => T): T {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lock = `${this.filePath}.lock`;
    let fd: number | null = null;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try { fd = fs.openSync(lock, 'wx', 0o600); break; } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
        } catch { /* another process released it */ }
        sleepSync(3);
      }
    }
    if (fd === null) throw new Error('key usage ledger is busy');
    try {
      let file: LedgerFile = { version: 1, keys: {} };
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed?.version === 1 && parsed.keys && typeof parsed.keys === 'object') {
          for (const [id, raw] of Object.entries<any>(parsed.keys)) {
            if (!/^[0-9a-f]{16}$/.test(id) || !raw || typeof raw !== 'object') continue;
            file.keys[id] = {
              starts: Array.isArray(raw.starts) ? raw.starts.filter((t: unknown) => typeof t === 'number' && Number.isFinite(t)) : [],
              cooldownUntil: typeof raw.cooldownUntil === 'number' ? raw.cooldownUntil : 0,
              seen: typeof raw.seen === 'number' ? raw.seen : 0,
            };
          }
        }
      } catch { /* absent or corrupt → start empty; losing a minute of pacing is the cheap failure */ }
      const result = fn(file);
      const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      return result;
    } finally {
      try { fs.closeSync(fd); } catch { /* closed */ }
      try { fs.unlinkSync(lock); } catch { /* released */ }
    }
  }

  reserve(ids: string[], now: number, choose: (usage: Map<string, KeyUsage>) => string | null) {
    return this.withLock((file) => applyReserve(file, ids, now, choose));
  }

  cooldown(id: string, untilMs: number, now: number): void {
    this.withLock((file) => applyCooldown(file, id, untilMs, now));
  }
}

/**
 * The store for this process. The desktop points every engine it spawns at one file in its own
 * data folder; a terminal run shares `~/.breakglass/key-usage.json` (relocated by
 * `BIMAX_BREAKGLASS_DIR`, which is how tests stay off the real home directory).
 */
export function resolveKeyUsageStore(env: NodeJS.ProcessEnv = process.env): KeyUsageStore {
  const explicit = String(env[KEY_LEDGER_ENV] || '').trim();
  if (explicit === 'memory') return new MemoryKeyUsageStore();
  const dir = env.BIMAX_BREAKGLASS_DIR || path.join(os.homedir(), '.breakglass');
  return new FileKeyUsageStore(explicit || path.join(dir, 'key-usage.json'));
}
