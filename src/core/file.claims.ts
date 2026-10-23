import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { getEventLedger } from '../mind/event.ledger';

/**
 * File claims (v2 §3.10 / §9.7 — the merge queue's path tier). An agent LEASES the
 * paths it is about to mutate; a second agent whose lease overlaps queues instead of
 * clobbering. Leases live in `.bimax/claims.json` so they work ACROSS PROCESSES (two
 * bimax sessions, a swarm and a heal, a dream worker and the user's session) — the
 * in-repo file plus atomic rename is the lock, TTL plus dead-PID pruning is the
 * liveness story (a crashed holder never wedges the repo).
 *
 * Honest tier: overlap is path/glob-level. The plan's AST tier ("same file but
 * disjoint symbols → allowed") is the documented next step — the conservative answer
 * (queue) is always safe, just occasionally slower.
 */

export interface Claim {
  id: string;
  agent: string;
  pid: number;
  paths: string[];   // concrete paths or globs (* ? **)
  at: number;
  ttlMs: number;
}

export interface AcquireResult {
  granted: boolean;
  id?: string;
  conflicts: { path: string; holder: string }[];
}

const DEFAULT_TTL_MS = 10 * 60_000;

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')       // placeholder so `**` survives the `*` pass
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    // eslint-disable-next-line no-control-regex -- NUL is our internal `**` placeholder sentinel
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`);
}

function literalPrefix(glob: string): string {
  const i = glob.search(/[*?]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/** Conservative overlap: concrete-vs-glob is exact; glob-vs-glob falls back to prefix containment. */
export function pathsOverlap(a: string, b: string): boolean {
  const an = a.replace(/\\/g, '/');
  const bn = b.replace(/\\/g, '/');
  const aGlob = /[*?]/.test(an);
  const bGlob = /[*?]/.test(bn);
  if (!aGlob && !bGlob) return an === bn;
  if (aGlob && !bGlob) return globToRegex(an).test(bn);
  if (!aGlob && bGlob) return globToRegex(bn).test(an);
  const ap = literalPrefix(an);
  const bp = literalPrefix(bn);
  return ap.startsWith(bp) || bp.startsWith(ap);
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** Block the current thread for `ms` without busy-spinning — used for lock backoff. */
function sleepSyncMs(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SAB unavailable — fall through, caller re-checks the deadline */ }
}

export class FileClaims {
  private filePath: string;
  private lockPath: string;
  // A crashed holder must never wedge the store, so a lock older than this is stolen. Critical
  // sections here are a single small read+write (milliseconds), so 5s is safely beyond any real hold.
  private static readonly STALE_LOCK_MS = 5_000;
  // Total time to wait for the lock before proceeding UNLOCKED. Falling back keeps behavior no worse
  // than the pre-lock code (a rare lost update) instead of blocking the agent loop indefinitely.
  private static readonly LOCK_WAIT_MS = 2_000;

  constructor(projectRoot: string = process.cwd()) {
    this.filePath = path.join(stateDir('.bimax', projectRoot), 'claims.json');
    this.lockPath = `${this.filePath}.lock`;
  }

  /**
   * Run `fn` while holding an exclusive cross-process lock so the read-modify-write is atomic.
   * The atomic rename in write() only stops a half-written FILE; it does NOT stop two processes
   * from both reading, both seeing no conflict, and both writing (lost update / double-grant). An
   * O_EXCL lockfile is the actual mutex. Best-effort: after LOCK_WAIT_MS we run unlocked rather
   * than wedge, and a stale lock (crashed holder) is stolen.
   */
  private withLock<T>(fn: () => T): T {
    try { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); } catch { /* best-effort */ }
    const deadline = Date.now() + FileClaims.LOCK_WAIT_MS;
    let fd: number;
    for (;;) {
      try { fd = fs.openSync(this.lockPath, 'wx'); break; }
      catch {
        try {
          const st = fs.statSync(this.lockPath);
          if (Date.now() - st.mtimeMs > FileClaims.STALE_LOCK_MS) { fs.unlinkSync(this.lockPath); continue; }
        } catch { continue; } // lock vanished between open and stat — retry immediately
        if (Date.now() >= deadline) return fn(); // give up locking; proceed rather than block forever
        sleepSyncMs(15);
      }
    }
    try { return fn(); }
    finally {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
    }
  }

  private read(): Claim[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  private write(claims: Claim[]): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(claims, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath); // atomic on POSIX — no half-written file is ever observed
    } catch { /* best-effort */ }
  }

  /** Pure prune: drop expired leases and leases whose holder process died. No I/O of its own. */
  private prune(all: Claim[]): Claim[] {
    const now = Date.now();
    return all.filter(c => now - c.at <= c.ttlMs && pidAlive(c.pid));
  }

  /** Live claims only: expired leases and leases whose holder process died are pruned. */
  live(): Claim[] {
    return this.withLock(() => {
      const all = this.read();
      const live = this.prune(all);
      if (live.length !== all.length) this.write(live);
      return live;
    });
  }

  /** Try to lease `paths` for `agent`. Overlap with another holder → not granted, holders named. */
  acquire(agent: string, paths: string[], opts?: { ttlMs?: number }): AcquireResult {
    const wanted = paths.filter(Boolean);
    if (wanted.length === 0) return { granted: true, id: undefined, conflicts: [] };
    return this.withLock(() => {
      const live = this.prune(this.read());
      const conflicts: { path: string; holder: string }[] = [];
      for (const c of live) {
        if (c.agent === agent) continue; // re-entrant: an agent never conflicts with itself
        for (const mine of wanted) {
          for (const theirs of c.paths) {
            if (pathsOverlap(mine, theirs)) conflicts.push({ path: mine, holder: c.agent });
          }
        }
      }
      if (conflicts.length > 0) {
        try { getEventLedger().append('file_claim', { agent, paths: wanted.slice(0, 20), granted: false, conflicts: conflicts.slice(0, 5) }); } catch { /* best-effort */ }
        return { granted: false, conflicts };
      }
      const claim: Claim = {
        id: `${agent}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        agent, pid: process.pid, paths: wanted, at: Date.now(), ttlMs: opts?.ttlMs ?? DEFAULT_TTL_MS,
      };
      this.write([...live, claim]);
      try { getEventLedger().append('file_claim', { agent, paths: wanted.slice(0, 20), granted: true, id: claim.id }); } catch { /* best-effort */ }
      return { granted: true, id: claim.id, conflicts: [] };
    });
  }

  /** Queue politely: retry acquire until granted or the timeout — the merge-queue verb. */
  async awaitAcquire(agent: string, paths: string[], opts?: { ttlMs?: number; timeoutMs?: number; pollMs?: number }): Promise<AcquireResult> {
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const pollMs = opts?.pollMs ?? 500;
    const start = Date.now();
    for (;;) {
      const res = this.acquire(agent, paths, opts);
      if (res.granted || Date.now() - start >= timeoutMs) return res;
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  release(idOrAgent: string): number {
    return this.withLock(() => {
      const live = this.prune(this.read());
      const keep = live.filter(c => c.id !== idOrAgent && c.agent !== idOrAgent);
      const released = live.length - keep.length;
      if (released > 0) {
        this.write(keep);
        try { getEventLedger().append('file_release', { idOrAgent, released }); } catch { /* best-effort */ }
      }
      return released;
    });
  }
}

let _global: FileClaims | null = null;
export function getFileClaims(): FileClaims {
  if (!_global) _global = new FileClaims(process.cwd());
  return _global;
}
export function __setFileClaims(f: FileClaims | null): void { _global = f; }
